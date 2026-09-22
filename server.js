'use strict';
/*
 * Teen Patti Online — real-time multiplayer server.
 * -------------------------------------------------
 * Virtual chips only. There is no real-money wagering, purchasing,
 * or cash-out anywhere in this game.
 *
 * Stack: plain Node http server (serves ./public) + `ws` WebSockets.
 * Run locally:  npm install && npm start
 * Deploy:       any Node host (see README.md) — honors process.env.PORT.
 *
 * Security model: the deck and every hand live server-side only.
 * Clients receive their OWN cards (after "See Cards") and NEVER
 * anyone else's. Every action is validated server-side.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ------------------------------- config ------------------------------ */
const PORT = process.env.PORT || 3000;
const BOOT = 10;                 // ante (chips) every seated player posts each round
const MAX_PLAYERS = 10;          // seats per room
const TURN_MS = 30 * 1000;       // turn countdown; auto-pack on timeout
const SIDESHOW_MS = 15 * 1000;   // side-show accept/decline window
const RECONNECT_MS = 120 * 1000; // seat + hand held this long after disconnect
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // unambiguous chars
const AVATAR_COLORS = [
  '#e74c3c', '#8e44ad', '#2980b9', '#16a085', '#f39c12',
  '#d35400', '#2c3e50', '#27ae60', '#c0392b', '#7f8c8d',
];
const PUBLIC_DIR = path.join(__dirname, 'public');

/* --------------------------- accounts config ------------------------- */
// Virtual-chip accounts. The admin (Satish) creates logins for friends and
// loads chips onto them from the /admin panel. Play money only.
const DATA_DIR = process.env.TP_DATA_DIR || path.join(__dirname, 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme123';
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // login sessions last 7 days
const MAX_LOGIN_FAILS = 5;                   // then a temporary lockout
const LOGIN_LOCK_MS = 60 * 1000;             // lockout duration
const MAX_CHIPS = 1000000000;                // sanity cap on chip amounts

/* -------------------------------- cards ------------------------------ */
const SUITS = ['S', 'H', 'D', 'C']; // spades, hearts, diamonds, clubs
const RANK_LABEL = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_PLURAL = ['Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens',
  'Eights', 'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces'];

// Card: { r: 0..12 (2..A), s: 0..3 }. Never leaves the server except to owner.
function newDeck() {
  const d = [];
  for (let s = 0; s < 4; s++) for (let r = 0; r < 13; r++) d.push({ r, s });
  return d;
}

// Fisher–Yates with cryptographic randomness.
function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
  }
  return deck;
}

// Compact wire format, e.g. "AS", "10D", "7C".
function cardCode(c) { return RANK_LABEL[c.r] + SUITS[c.s]; }

/* --------------------------- hand evaluation ------------------------- */
/* Categories: 6 trail/trio > 5 pure sequence > 4 sequence > 3 flush/color
 *             > 2 pair > 1 high card. A-2-3 is the LOWEST sequence.        */
function evaluateHand(cards) {
  const rs = cards.map(c => c.r).sort((a, b) => a - b);
  const flush = cards[0].s === cards[1].s && cards[1].s === cards[2].s;
  const wheel = rs[0] === 0 && rs[1] === 1 && rs[2] === 12; // A-2-3
  const straight = (rs[0] + 1 === rs[1] && rs[1] + 1 === rs[2]) || wheel;
  const seqHigh = !straight ? -2 : (wheel ? -1 : rs[2]); // -1 => lowest straight
  const seqLabel = seqHigh === -1
    ? 'A-2-3'
    : `${RANK_LABEL[seqHigh - 2]}-${RANK_LABEL[seqHigh - 1]}-${RANK_LABEL[seqHigh]}`;

  let category, tiebreak, name;
  if (rs[0] === rs[1] && rs[1] === rs[2]) {
    category = 6; tiebreak = rs[0];
    name = `Trail of ${RANK_PLURAL[rs[0]]}`;
  } else if (flush && straight) {
    category = 5; tiebreak = seqHigh;
    name = `Pure Sequence (${seqLabel})`;
  } else if (straight) {
    category = 4; tiebreak = seqHigh;
    name = `Sequence (${seqLabel})`;
  } else if (flush) {
    category = 3; tiebreak = rs[2] * 169 + rs[1] * 13 + rs[0];
    name = `Flush (${RANK_LABEL[rs[2]]} high)`;
  } else if (rs[0] === rs[1] || rs[1] === rs[2]) {
    const pr = rs[1]; // middle card is always part of the pair in sorted order
    const kicker = rs[0] === rs[1] ? rs[2] : rs[0];
    category = 2; tiebreak = pr * 13 + kicker;
    name = `Pair of ${RANK_PLURAL[pr]}`;
  } else {
    category = 1; tiebreak = rs[2] * 169 + rs[1] * 13 + rs[0];
    name = `High Card (${RANK_LABEL[rs[2]]})`;
  }
  return { category, tiebreak, name };
}

// 1 if a wins, -1 if b wins, 0 on an exact tie.
function compareHands(a, b) {
  const A = evaluateHand(a), B = evaluateHand(b);
  if (A.category !== B.category) return A.category > B.category ? 1 : -1;
  if (A.tiebreak !== B.tiebreak) return A.tiebreak > B.tiebreak ? 1 : -1;
  return 0;
}

/* ------------------------------ accounts ----------------------------- */
/* Player accounts with login + admin-managed chip balances.
 * Stored in data/accounts.json, written atomically (tmp file + rename)
 * so a crash mid-write can never corrupt the file.
 * Passwords are salted scrypt hashes — hashes never leave the server.  */
const accounts = new Map();   // lower(username) -> account
const sessions = new Map();    // session token -> { user, expiresAt }
const loginFails = new Map();  // lower(username) -> { count, lockedUntil }

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}

function verifyPassword(password, stored) {
  const parts = String(stored).split(':');
  if (parts.length !== 2) return false;
  try {
    const salt = Buffer.from(parts[0], 'hex');
    const expected = Buffer.from(parts[1], 'hex');
    const actual = crypto.scryptSync(password, salt, 64);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (e) { return false; }
}

function loadAccounts() {
  accounts.clear();
  try {
    const raw = fs.readFileSync(ACCOUNTS_FILE, 'utf8');
    const list = JSON.parse(raw);
    if (Array.isArray(list)) {
      for (const a of list) {
        if (a && typeof a.username === 'string' && typeof a.hash === 'string') {
          accounts.set(a.username.toLowerCase(), {
            username: a.username,
            hash: a.hash,
            isAdmin: !!a.isAdmin,
            balance: Math.max(0, Math.floor(a.balance) || 0),
            createdAt: a.createdAt || Date.now(),
            disabled: !!a.disabled,
          });
        }
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Could not load accounts:', e.message);
    // Missing file = first run; it will be created on first save.
  }
}

// Atomic write: write to a temp file, then rename over the real one.
function persistAccounts() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = ACCOUNTS_FILE + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify([...accounts.values()], null, 2));
  fs.renameSync(tmp, ACCOUNTS_FILE);
}

// Public view of an account — the password hash is NEVER included.
function publicUser(a) {
  return {
    username: a.username,
    isAdmin: !!a.isAdmin,
    balance: a.balance,
    createdAt: a.createdAt,
    disabled: !!a.disabled,
  };
}

function validateCredentials(username, password) {
  const u = String(username || '').trim();
  const p = String(password || '');
  if (!/^[A-Za-z0-9_]{3,16}$/.test(u)) {
    return 'Username must be 3–16 characters: letters, numbers, underscore.';
  }
  if (p.length < 4) return 'Password must be at least 4 characters.';
  return null;
}

// Create the admin account on first run from env vars.
function bootstrapAdmin() {
  const key = ADMIN_USER.toLowerCase();
  if (!accounts.has(key)) {
    accounts.set(key, {
      username: ADMIN_USER,
      hash: hashPassword(ADMIN_PASS),
      isAdmin: true,
      balance: 0,
      createdAt: Date.now(),
      disabled: false,
    });
    persistAccounts();
    console.log(`Admin account created: "${ADMIN_USER}".`);
  }
  if (!process.env.ADMIN_PASS || process.env.ADMIN_PASS === 'changeme123') {
    console.warn('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    console.warn('!! WARNING: the admin account is using the DEFAULT password !!');
    console.warn('!! Set ADMIN_USER and ADMIN_PASS env vars and restart.     !!');
    console.warn('!! On Render: Dashboard -> your service -> Environment.    !!');
    console.warn('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  }
}

// Copy the account's current chip balance onto every in-room seat it holds,
// then refresh those rooms. Used after admin chip changes.
function applyBalanceToRooms(userKey) {
  const acct = accounts.get(userKey);
  if (!acct) return;
  const touched = new Set();
  for (const room of rooms.values()) {
    for (const p of room.players.values()) {
      if (p.accountName === userKey) {
        p.balance = acct.balance;
        touched.add(room);
      }
    }
  }
  for (const room of touched) sendState(room);
}

// Copy an in-room player's balance back onto their account (no disk write).
function syncBalanceToAccount(p) {
  if (!p || !p.accountName) return;
  const acct = accounts.get(p.accountName);
  if (acct) acct.balance = Math.max(0, Math.floor(p.balance));
}

// Drop every login session + socket + room seat for an account.
function kickAccountEverywhere(userKey, reason) {
  for (const [t, s] of sessions) if (s.user === userKey) sessions.delete(t);
  for (const room of [...rooms.values()]) {
    for (const p of [...room.players.values()]) {
      if (p.accountName === userKey) removePlayer(room, p.id, reason);
    }
  }
}

/* -------------------------------- rooms ------------------------------ */
const rooms = new Map();      // roomCode -> room
const tokenIndex = new Map(); // player token -> { code, playerId } (for reconnect)

function makeCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}

function newRoom(code) {
  return {
    code,
    players: new Map(), // id -> player
    order: [],          // player ids in join order (seat order)
    hostId: null,
    phase: 'lobby',     // 'lobby' | 'playing'
    round: null,        // active round state (see startRound)
    roundNumber: 0,
    dealerId: null,     // rotates each round
    lastResult: null,   // shown after a round ends until next Play Again
    feed: [],           // betting activity, newest last
  };
}

function newPlayer(name, colorIdx, balance, accountName) {
  return {
    id: crypto.randomBytes(8).toString('hex'),
    token: crypto.randomBytes(16).toString('hex'),
    name: String(name || 'Player').trim().slice(0, 16) || 'Player',
    accountName: accountName || null, // lower(username); chips live on the account
    color: AVATAR_COLORS[colorIdx % AVATAR_COLORS.length],
    ws: null,
    connected: false,
    disconnectedAt: null,
    isHost: false,
    ready: false,
    balance: Math.max(0, Math.floor(balance) || 0), // loaded from the account
    // per-round fields:
    inRound: false,
    packed: false,
    seen: false,
    hand: null,
    betInRound: 0,
    allIn: false,
    lastAction: '',
  };
}

function feed(room, text) {
  room.feed.push({ t: Date.now(), text });
  if (room.feed.length > 80) room.feed.shift();
}

// Players still contesting the pot, in turn order.
function activePlayers(room) {
  const r = room.round;
  if (!r) return [];
  return r.turnOrder
    .map(id => room.players.get(id))
    .filter(p => p && p.inRound && !p.packed);
}

/* ------------------------------ messaging ---------------------------- */
function send(target, obj) {
  // Accepts either a player object (uses player.ws) or a raw WebSocket.
  const sock = target && target.ws ? target.ws : target;
  if (sock && sock.readyState === 1) {
    try { sock.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
  }
}

function sendError(ws, message) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', message }));
}

// Public (safe) view of a player — cards are NEVER included here.
function playerView(p) {
  return {
    id: p.id, name: p.name, color: p.color,
    isHost: p.isHost, ready: p.ready, connected: p.connected,
    balance: p.balance, inRound: p.inRound, packed: p.packed,
    seen: p.seen, betInRound: p.betInRound, allIn: p.allIn,
    lastAction: p.lastAction,
  };
}

// Personalized snapshot. `you.cards` carries the player's OWN hand only
// after they have seen it; everyone else's cards are never sent.
function sendState(room) {
  for (const p of room.players.values()) {
    if (!p.ws || p.ws.readyState !== 1) continue;
    const r = room.round;
    send(p, {
      type: 'state',
      room: {
        code: room.code,
        phase: room.phase,
        hostId: room.hostId,
        pot: r ? r.pot : 0,
        stake: r ? r.stake : 0,
        boot: BOOT,
        turnPlayerId: r ? r.turnOrder[r.turnIdx] || null : null,
        turnEndsAt: r ? r.turnEndsAt : null,
        roundNumber: room.roundNumber,
        dealerId: room.dealerId,
        activeCount: activePlayers(room).length,
        sideshow: r && r.sideshow ? {
          fromId: r.sideshow.fromId,
          fromName: (room.players.get(r.sideshow.fromId) || {}).name || '',
          toId: r.sideshow.toId,
          expiresAt: r.sideshow.expiresAt,
        } : null,
        result: room.lastResult,
      },
      players: room.order
        .map(id => room.players.get(id))
        .filter(Boolean)
        .map(playerView),
      you: {
        id: p.id, name: p.name, token: p.token, color: p.color,
        isHost: p.isHost, ready: p.ready, balance: p.balance,
        inRound: p.inRound, packed: p.packed, seen: p.seen,
        cards: (p.seen && p.inRound && p.hand) ? p.hand.map(cardCode) : null,
      },
      feed: room.feed.slice(-30),
    });
  }
}

function migrateHost(room) {
  if (room.hostId && room.players.has(room.hostId)) {
    const h = room.players.get(room.hostId);
    if (h.connected) return; // current host still around
  }
  const next = room.order
    .map(id => room.players.get(id))
    .find(p => p && p.connected);
  for (const p of room.players.values()) p.isHost = false;
  if (next) {
    next.isHost = true;
    room.hostId = next.id;
    feed(room, `${next.name} is now the host.`);
  } else {
    room.hostId = null;
  }
}

function removePlayer(room, playerId, reason) {
  const p = room.players.get(playerId);
  if (!p) return;
  const r = room.round;

  if (r && p.inRound && !p.packed) {
    // Their contributed chips stay in the pot; they simply leave the hand.
    p.packed = true;
    p.lastAction = 'left';
    feed(room, `${p.name} ${reason || 'left'} and packed.`);
  } else {
    feed(room, `${p.name} ${reason || 'left'}.`);
  }
  if (p.ws && p.ws.readyState === 1) {
    try { p.ws.send(JSON.stringify({ type: 'kicked', reason: reason || 'removed' })); } catch (e) {}
    try { p.ws.close(); } catch (e) {}
  }
  // Chips live on the player's account: write the seat's balance back.
  syncBalanceToAccount(p);
  persistAccounts();
  room.players.delete(playerId);
  tokenIndex.delete(p.token);
  room.order = room.order.filter(id => id !== playerId);

  if (r) {
    const idx = r.turnOrder.indexOf(playerId);
    if (idx !== -1) {
      r.turnOrder.splice(idx, 1);
      if (r.turnOrder.length === 0) { endRound(room, { reason: 'abandoned' }); return; }
      if (r.turnOrder[r.turnIdx] === playerId || idx === r.turnIdx) {
        // Removed player held the turn: point at the next player, then select them.
        r.turnIdx = (idx - 1 + r.turnOrder.length) % r.turnOrder.length;
      }
    }
    if (r.sideshow && (r.sideshow.fromId === playerId || r.sideshow.toId === playerId)) {
      r.sideshow = null;
      r.turnEndsAt = Date.now() + TURN_MS;
    }
    const act = activePlayers(room);
    if (room.phase === 'playing' && room.round) {
      if (act.length <= 1) { endRound(room, { winner: act[0] || null, reason: 'default' }); return; }
      if (r.turnOrder[r.turnIdx] === undefined || (room.players.get(r.turnOrder[r.turnIdx]) || {}).packed) {
        advanceTurn(room);
      }
    }
  }
  migrateHost(room);
  if (room.players.size === 0) { rooms.delete(room.code); return; }
  sendState(room);
}

/* --------------------------- auth (login) ---------------------------- */
// Sockets must authenticate before doing anything else. Two ways in:
//   {type:"login", username, password}  -> fresh login, returns auth_ok
//   {type:"auth", token}                -> resume with a saved session token

function bindAccount(ws, acct, token) {
  ws.account = { user: acct.username.toLowerCase(), username: acct.username, isAdmin: !!acct.isAdmin };
  ws.sessionToken = token;
  send(ws, {
    type: 'auth_ok', token,
    username: acct.username, isAdmin: !!acct.isAdmin, balance: acct.balance,
  });
}

function onLogin(ws, msg) {
  const name = String(msg.username || '').trim();
  const password = String(msg.password || '');
  const key = name.toLowerCase();
  const now = Date.now();

  // Brute-force protection: 5 bad attempts -> 60s lockout for that username.
  const lf = loginFails.get(key);
  if (lf && lf.lockedUntil > now) {
    const secs = Math.ceil((lf.lockedUntil - now) / 1000);
    return send(ws, { type: 'auth_fail', message: `Too many failed attempts. Try again in ${secs}s.` });
  }

  const acct = accounts.get(key);
  const ok = acct && !acct.disabled && verifyPassword(password, acct.hash);
  if (!ok) {
    const e = loginFails.get(key) || { count: 0, lockedUntil: 0 };
    e.count += 1;
    if (e.count >= MAX_LOGIN_FAILS) { e.count = 0; e.lockedUntil = now + LOGIN_LOCK_MS; }
    loginFails.set(key, e);
    const reason = (acct && acct.disabled)
      ? 'This account is disabled. Ask the admin.'
      : 'Invalid username or password.';
    return send(ws, { type: 'auth_fail', message: reason });
  }

  loginFails.delete(key);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { user: key, expiresAt: now + SESSION_TTL_MS });
  bindAccount(ws, acct, token);
}

function onAuthToken(ws, msg) {
  const token = String(msg.token || '');
  const s = sessions.get(token);
  if (!s) return send(ws, { type: 'auth_fail', message: 'Session expired. Please log in again.' });
  if (s.expiresAt < Date.now()) {
    sessions.delete(token);
    return send(ws, { type: 'auth_fail', message: 'Session expired. Please log in again.' });
  }
  const acct = accounts.get(s.user);
  if (!acct || acct.disabled) {
    sessions.delete(token);
    return send(ws, { type: 'auth_fail', message: 'Account unavailable. Please log in again.' });
  }
  bindAccount(ws, acct, token);
}

function onLogout(ws) {
  // Write chips back and leave any room before dropping the session.
  const ref = ws.playerRef;
  const acctUser = ws.account && ws.account.user;
  if (ref) {
    const room = rooms.get(ref.roomCode);
    const p = room && room.players.get(ref.playerId);
    if (room && p && (!p.accountName || p.accountName === acctUser)) {
      removePlayer(room, p.id, 'logged out');
    }
  }
  if (ws.sessionToken) sessions.delete(ws.sessionToken);
  ws.account = null;
  ws.sessionToken = null;
  ws.playerRef = null;
  send(ws, { type: 'logged_out' });
}

// Reload a seated player's balance from their account (admin may have
// topped it up while they waited). No-op if the account is gone.
function refreshBalance(p) {
  if (!p || !p.accountName) return;
  const acct = accounts.get(p.accountName);
  if (acct) p.balance = acct.balance;
}

/* --------------------------- join / lobby ---------------------------- */
function attach(ws, room, player) {
  if (player.ws && player.ws !== ws && player.ws.readyState === 1) {
    try { player.ws.close(); } catch (e) {}
  }
  player.ws = ws;
  player.connected = true;
  player.disconnectedAt = null;
  ws.playerRef = { roomCode: room.code, playerId: player.id };
}

function onCreateRoom(ws, msg) {
  const acct = ws.account && accounts.get(ws.account.user);
  if (!acct) return sendError(ws, 'Account not found. Please log in again.');
  const name = acct.username; // room name = account username (unique by design)
  const code = makeCode();
  const room = newRoom(code);
  const player = newPlayer(name, 0, acct.balance, ws.account.user);
  player.isHost = true;
  room.players.set(player.id, player);
  room.order.push(player.id);
  room.hostId = player.id;
  rooms.set(code, room);
  tokenIndex.set(player.token, { code, playerId: player.id });
  attach(ws, room, player);
  feed(room, `${player.name} created the room.`);
  sendState(room);
}

function onJoinRoom(ws, msg) {
  const acct = ws.account && accounts.get(ws.account.user);
  if (!acct) return sendError(ws, 'Account not found. Please log in again.');
  const code = String(msg.code || '').trim().toUpperCase();
  const room = rooms.get(code);
  if (!room) return sendError(ws, 'Room not found. Check the code and try again.');

  // Reconnect with a previously issued token: seat + hand are restored,
  // but only if the seat belongs to this account.
  if (msg.token) {
    const rec = tokenIndex.get(msg.token);
    if (rec && rec.code === code) {
      const player = room.players.get(rec.playerId);
      if (player && player.accountName === ws.account.user) {
        attach(ws, room, player);
        feed(room, `${player.name} reconnected.`);
        sendState(room);
        return;
      }
    }
    // Unknown/expired token, or another account's seat: fresh join below.
  }

  const name = acct.username;
  if (room.players.size >= MAX_PLAYERS) return sendError(ws, 'This room is full (10 players).');
  const taken = [...room.players.values()].some(p => p.name.toLowerCase() === name.toLowerCase());
  if (taken) return sendError(ws, 'You are already in this room on another connection.');

  const player = newPlayer(name, room.order.length, acct.balance, ws.account.user);
  room.players.set(player.id, player);
  room.order.push(player.id);
  tokenIndex.set(player.token, { code, playerId: player.id });
  attach(ws, room, player);
  if (room.phase === 'playing') feed(room, `${player.name} joined (sits out until next round).`);
  else feed(room, `${player.name} joined the room.`);
  sendState(room);
}

function onToggleReady(ws) {
  const ref = ws.playerRef;
  if (!ref) return;
  const room = rooms.get(ref.roomCode);
  const p = room && room.players.get(ref.playerId);
  if (!room || !p || room.phase !== 'lobby') return;
  refreshBalance(p); // the admin may have loaded chips while this player waited
  if (!p.ready && p.balance < BOOT) {
    sendError(ws, `You need at least ${BOOT} chips to play. Ask the admin to load chips for you.`);
    return;
  }
  p.ready = !p.ready;
  feed(room, `${p.name} is ${p.ready ? 'ready' : 'not ready'}.`);
  sendState(room);
}

/* ------------------------------ rounds ------------------------------- */
function startRound(room) {
  // Balances live on accounts: reload them so admin top-ups apply.
  for (const p of room.players.values()) refreshBalance(p);
  const contenders = room.order
    .map(id => room.players.get(id))
    .filter(p => p && p.connected && p.ready && p.balance >= BOOT);
  if (contenders.length < 2) return false;

  const deck = shuffle(newDeck());
  const round = {
    number: room.roundNumber + 1,
    pot: 0,
    stake: BOOT,      // current blind-bet amount
    turnOrder: [],    // player ids, dealer rotates
    turnIdx: 0,
    turnEndsAt: null,
    sideshow: null,   // { fromId, toId, expiresAt, savedTurnMs }
  };
  room.roundNumber = round.number;

  for (const p of contenders) {
    p.inRound = true; p.packed = false; p.seen = false;
    p.betInRound = 0; p.allIn = false; p.lastAction = '';
    p.hand = [deck.pop(), deck.pop(), deck.pop()];
    p.balance -= BOOT;
    p.betInRound += BOOT;
    round.pot += BOOT;
  }

  // Dealer rotates; action starts with the player after the dealer.
  const ids = contenders.map(p => p.id);
  let dealerIdx = 0;
  if (room.dealerId) {
    const prev = ids.indexOf(room.dealerId);
    dealerIdx = prev === -1 ? 0 : (prev + 1) % ids.length;
  }
  room.dealerId = ids[dealerIdx];
  round.turnOrder = ids;
  round.turnIdx = dealerIdx; // advanceTurn moves to the next seat
  room.round = round;
  room.phase = 'playing';
  room.lastResult = null;

  feed(room, `— Round ${round.number} — ${BOOT}-chip boot ante, everyone starts BLIND.`);
  advanceTurn(room);
  sendState(room);
  return true;
}

// Select the next active (non-packed, in-round) player. Offline players
// are auto-packed immediately instead of making everyone wait.
function advanceTurn(room) {
  const r = room.round;
  if (!r) return;
  const n = r.turnOrder.length;
  for (let i = 1; i <= n; i++) {
    const idx = (r.turnIdx + i) % n;
    const p = room.players.get(r.turnOrder[idx]);
    if (p && p.inRound && !p.packed) {
      if (!p.connected) {
        p.packed = true;
        p.lastAction = 'auto-pack (offline)';
        feed(room, `${p.name} is offline and auto-packed.`);
        continue;
      }
      r.turnIdx = idx;
      r.turnEndsAt = Date.now() + TURN_MS;
      return;
    }
  }
  r.turnEndsAt = null;
}

// Called after any action that can change who is still in the hand.
function afterAction(room) {
  if (!room.round) return;
  const act = activePlayers(room);
  if (act.length <= 1) {
    endRound(room, { winner: act[0] || null, reason: 'default' });
    return;
  }
  advanceTurn(room);
  sendState(room);
}

function endRound(room, opts) {
  const r = room.round;
  const winners = opts.winners || (opts.winner ? [opts.winner] : []);
  const pot = r ? r.pot : 0;

  if (winners.length > 0 && pot > 0) {
    const share = Math.floor(pot / winners.length);
    let remainder = pot - share * winners.length;
    winners.forEach((w, i) => {
      const amt = share + (i === 0 ? remainder : 0);
      w.balance += amt;
      w._won = amt;
    });
  } else if (pot > 0) {
    // Nobody left standing (e.g. everyone removed): refund each bet.
    for (const p of room.players.values()) {
      if (p.betInRound > 0) p.balance += p.betInRound;
    }
  }

  room.lastResult = {
    roundNumber: r ? r.number : room.roundNumber,
    reason: opts.reason || 'default', // 'default' | 'showdown' | 'abandoned'
    winners: winners.map(w => ({ id: w.id, name: w.name, amount: w._won || 0 })),
    hands: (opts.hands || []).map(h => ({
      playerId: h.player.id, name: h.player.name,
      cards: h.player.hand.map(cardCode), handName: h.eval.name,
    })),
  };
  for (const p of room.players.values()) delete p._won;

  const winText = winners.length
    ? `${winners.map(w => w.name).join(' & ')} won ${pot} chips` +
      (opts.hands && opts.hands.length
        ? ` with ${opts.hands.find(h => h.player.id === winners[0].id).eval.name}` : '') + '.'
    : 'Round ended with no winner — bets refunded.';
  feed(room, `— Round over: ${winText}`);

  for (const p of room.players.values()) {
    p.inRound = false; p.packed = false; p.seen = false;
    p.hand = null; p.betInRound = 0; p.allIn = false;
    p.lastAction = ''; p.ready = false;
    // Chips live on accounts: write every seat's balance back now.
    syncBalanceToAccount(p);
  }
  persistAccounts();
  room.round = null;
  room.phase = 'lobby';
  sendState(room);
}

/* ------------------------------ actions ------------------------------ */
function currentPlayer(room) {
  const r = room.round;
  if (!r) return null;
  return room.players.get(r.turnOrder[r.turnIdx]) || null;
}

function requireTurn(room, p) {
  if (room.phase !== 'playing' || !room.round) return 'No round in progress.';
  if (!p.inRound || p.packed) return 'You are not in this hand.';
  if (room.round.sideshow) return 'Waiting on a side show…';
  const cp = currentPlayer(room);
  if (!cp || cp.id !== p.id) return 'Not your turn.';
  return null;
}

// kind: 'blind' | 'blind2' | 'chaal' | 'chaal2'
function doBet(room, p, kind) {
  const problem = requireTurn(room, p);
  if (problem) return problem;
  const r = room.round;
  const isBlind = !p.seen;
  const okKinds = isBlind ? ['blind', 'blind2'] : ['chaal', 'chaal2'];
  if (!okKinds.includes(kind)) {
    return isBlind ? 'Blind players bet the blind amount.' : 'Seen players must chaal (2× the blind amount).';
  }
  const mult = { blind: 1, blind2: 2, chaal: 2, chaal2: 4 }[kind];
  const full = r.stake * mult;
  const amount = Math.min(full, p.balance); // short stack => all-in
  if (amount <= 0) return 'You have no chips left.';
  p.balance -= amount;
  r.pot += amount;
  p.betInRound += amount;
  if (amount < full) {
    p.allIn = true; // partial all-in: stake does not rise
  } else if (kind === 'blind2' || kind === 'chaal2') {
    r.stake *= 2;
  }
  p.lastAction = `${kind === 'blind' || kind === 'blind2' ? 'Blind' : 'Chaal'} ${amount}${p.allIn ? ' (all-in)' : ''}`;
  feed(room, `${p.name}: ${p.lastAction}. Pot is ${r.pot}.`);
  afterAction(room);
  return null;
}

function doSeeCards(room, p) {
  if (room.phase !== 'playing' || !room.round) return 'No round in progress.';
  if (!p.inRound || p.packed) return 'You are not in this hand.';
  if (p.seen) return 'You already saw your cards.';
  p.seen = true;
  p.lastAction = 'saw cards';
  feed(room, `${p.name} saw their cards (now SEEN).`);
  sendState(room); // state carries p's own cards to p only
  return null;
}

function doPack(room, p) {
  if (room.phase !== 'playing' || !room.round) return 'No round in progress.';
  if (!p.inRound || p.packed) return 'You are not in this hand.';
  p.packed = true;
  p.lastAction = 'packed';
  feed(room, `${p.name} packed.`);
  if (room.round.sideshow &&
      (room.round.sideshow.fromId === p.id || room.round.sideshow.toId === p.id)) {
    room.round.sideshow = null;
  }
  const cp = currentPlayer(room);
  if (cp && cp.id === p.id) afterAction(room);
  else {
    if (activePlayers(room).length <= 1) {
      const act = activePlayers(room);
      endRound(room, { winner: act[0] || null, reason: 'default' });
    } else sendState(room);
  }
  return null;
}

// Previous active player in turn order (circular), excluding requester.
function previousActive(room, requester) {
  const r = room.round;
  const n = r.turnOrder.length;
  const start = r.turnOrder.indexOf(requester.id);
  for (let i = 1; i < n; i++) {
    const p = room.players.get(r.turnOrder[(start - i + n * 2) % n]);
    if (p && p.inRound && !p.packed && p.id !== requester.id) return p;
  }
  return null;
}

function doSideshowRequest(room, p) {
  const problem = requireTurn(room, p);
  if (problem) return problem;
  if (!p.seen) return 'Only seen players can ask for a side show.';
  const r = room.round;
  if (activePlayers(room).length < 3) return 'Side show needs 3+ players in the hand.';
  const target = previousActive(room, p);
  if (!target) return 'No one to side-show with.';
  if (!target.seen) return 'Side show is only between seen players.';
  r.sideshow = {
    fromId: p.id, toId: target.id,
    expiresAt: Date.now() + SIDESHOW_MS,
    savedTurnMs: Math.max(1000, r.turnEndsAt - Date.now()),
  };
  r.turnEndsAt = null; // pause the turn clock while the target decides
  p.lastAction = `asked ${target.name} for a side show`;
  feed(room, `${p.name} asked ${target.name} for a side show…`);
  send(target, {
    type: 'sideshow_request',
    fromId: p.id, fromName: p.name, expiresAt: r.sideshow.expiresAt,
  });
  sendState(room);
  return null;
}

function resolveSideshow(room, accepted) {
  const r = room.round;
  if (!r || !r.sideshow) return;
  const s = r.sideshow;
  r.sideshow = null;
  const from = room.players.get(s.fromId);
  const to = room.players.get(s.toId);

  if (accepted && from && to && from.inRound && !from.packed && to.inRound && !to.packed) {
    const cmp = compareHands(from.hand, to.hand); // 1 => requester wins
    if (cmp === 0) {
      feed(room, `Side show: dead tie — both stay in.`);
    } else {
      const realLoser = cmp > 0 ? to : from;
      const realWinner = cmp > 0 ? from : to;
      realLoser.packed = true;
      realLoser.lastAction = 'lost side show';
      feed(room, `Side show: ${realLoser.name} packed (beaten by ${realWinner.name}).`);
    }
    // Requester's turn is consumed either way.
    if (from && !from.packed) {
      const idx = r.turnOrder.indexOf(from.id);
      if (idx !== -1) r.turnIdx = idx;
    }
    const act = activePlayers(room);
    if (act.length <= 1) { endRound(room, { winner: act[0] || null, reason: 'default' }); return; }
    advanceTurn(room);
  } else {
    if (to) feed(room, `${to.name} declined the side show.`);
    r.turnEndsAt = Date.now() + s.savedTurnMs; // resume the clock
  }
  sendState(room);
}

function doSideshowResponse(room, p, accepted) {
  const r = room.round;
  if (!r || !r.sideshow) return 'No pending side show.';
  if (r.sideshow.toId !== p.id) return 'That side show is not for you.';
  resolveSideshow(room, !!accepted);
  return null;
}

// Two players left, seen player demands a showdown on their turn.
function doShow(room, p) {
  const problem = requireTurn(room, p);
  if (problem) return problem;
  if (!p.seen) return 'See your cards before asking for a show.';
  const act = activePlayers(room);
  if (act.length !== 2) return 'Show is allowed only with 2 players left.';
  const other = act.find(x => x.id !== p.id);
  const evP = evaluateHand(p.hand), evO = evaluateHand(other.hand);
  const cmp = compareHands(p.hand, other.hand);
  const winners = cmp > 0 ? [p] : cmp < 0 ? [other] : [p, other];
  feed(room, `${p.name} asked for a SHOW!`);
  endRound(room, {
    winners,
    reason: 'showdown',
    hands: [
      { player: p, eval: evP },
      { player: other, eval: evO },
    ],
  });
  return null;
}

function doPlayAgain(room, p) {
  if (room.phase !== 'lobby') return 'Finish the round first.';
  refreshBalance(p);
  if (p.balance < BOOT) return 'You need chips to play — ask the admin to load some.';
  p.ready = true;
  room.lastResult = null;
  feed(room, `${p.name} wants to play again.`);
  sendState(room);
  return null;
}

function doStartGame(room, p) {
  if (!p.isHost) return 'Only the host can start the game.';
  if (room.phase !== 'lobby') return 'A round is already in progress.';
  const ready = room.order
    .map(id => room.players.get(id))
    .filter(x => x && x.connected && x.ready && x.balance >= BOOT);
  if (ready.length < 2) return 'Need at least 2 ready players to start.';
  startRound(room);
  return null;
}

function doRemovePlayer(room, p, targetId) {
  if (!p.isHost) return 'Only the host can remove players.';
  if (targetId === p.id) return 'Use Leave if you want to exit.';
  if (!room.players.has(targetId)) return 'Player not found.';
  removePlayer(room, targetId, 'was removed by the host');
  return null;
}

/* ------------------------------ admin -------------------------------- */
// Every admin_* message requires an authenticated admin socket.
// Non-admin sockets are rejected here, no exceptions.
function handleAdmin(ws, msg) {
  const acct = ws.account && accounts.get(ws.account.user);
  if (!acct || !acct.isAdmin) return sendError(ws, 'Admin access required.');

  const deny = (message) => send(ws, { type: 'admin_error', message });
  const done = (notice) => sendAdminList(ws, notice);
  const target = (msg.username || '').trim().toLowerCase();
  const tAcct = target ? accounts.get(target) : null;

  switch (msg.type) {
    case 'admin_list_users':
      return sendAdminList(ws);

    case 'admin_create_user': {
      const err = validateCredentials(msg.username, msg.password);
      if (err) return deny(err);
      const key = String(msg.username).trim().toLowerCase();
      if (accounts.has(key)) return deny('That username is already taken.');
      accounts.set(key, {
        username: String(msg.username).trim(),
        hash: hashPassword(String(msg.password)),
        isAdmin: false,
        balance: 0, // new accounts start with 0; the admin loads chips
        createdAt: Date.now(),
        disabled: false,
      });
      persistAccounts();
      return done(`Created account "${msg.username.trim()}".`);
    }

    case 'admin_reset_password': {
      if (!tAcct) return deny('User not found.');
      if (typeof msg.newPassword !== 'string' || msg.newPassword.length < 4) {
        return deny('New password must be at least 4 characters.');
      }
      tAcct.hash = hashPassword(msg.newPassword);
      persistAccounts();
      return done(`Password reset for "${tAcct.username}".`);
    }

    case 'admin_add_chips': {
      if (!tAcct) return deny('User not found.');
      const amount = msg.amount;
      if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_CHIPS) {
        return deny('Amount must be a positive whole number.');
      }
      tAcct.balance = Math.min(MAX_CHIPS, tAcct.balance + amount);
      persistAccounts();
      applyBalanceToRooms(target); // live-update their seat if they're in a room
      return done(`Added ${amount} chips to "${tAcct.username}" (now ${tAcct.balance}).`);
    }

    case 'admin_set_balance': {
      if (!tAcct) return deny('User not found.');
      const amount = msg.amount;
      if (!Number.isInteger(amount) || amount < 0 || amount > MAX_CHIPS) {
        return deny('Balance must be a whole number between 0 and ' + MAX_CHIPS + '.');
      }
      tAcct.balance = amount;
      persistAccounts();
      applyBalanceToRooms(target);
      return done(`Set "${tAcct.username}" balance to ${amount}.`);
    }

    case 'admin_set_disabled': {
      if (!tAcct) return deny('User not found.');
      if (target === ws.account.user) return deny('You cannot disable your own account.');
      tAcct.disabled = !!msg.disabled;
      persistAccounts();
      if (tAcct.disabled) kickAccountEverywhere(target, 'account disabled');
      return done(`"${tAcct.username}" ${tAcct.disabled ? 'disabled' : 're-enabled'}.`);
    }

    case 'admin_delete_user': {
      if (!tAcct) return deny('User not found.');
      if (target === ws.account.user) return deny('You cannot delete your own account.');
      kickAccountEverywhere(target, 'account deleted');
      accounts.delete(target);
      persistAccounts();
      return done(`Deleted account "${tAcct.username}".`);
    }

    default:
      return sendError(ws, 'Unknown admin action.');
  }
}

// Never includes password hashes.
function sendAdminList(ws, notice) {
  const users = [...accounts.values()]
    .map(publicUser)
    .sort((a, b) => a.username.localeCompare(b.username));
  send(ws, { type: 'admin_users', users, notice: notice || null });
}

/* --------------------------- tick & timeouts ------------------------- */
function tick() {
  const now = Date.now();
  // Drop expired login sessions.
  for (const [t, s] of sessions) {
    if (s.expiresAt <= now) sessions.delete(t);
  }
  for (const room of [...rooms.values()]) {
    const r = room.round;
    if (room.phase === 'playing' && r) {
      if (r.sideshow && now >= r.sideshow.expiresAt) {
        resolveSideshow(room, false); // no answer => declined
      } else if (!r.sideshow && r.turnEndsAt && now >= r.turnEndsAt) {
        const cp = currentPlayer(room);
        if (cp && cp.inRound && !cp.packed) {
          cp.packed = true;
          cp.lastAction = 'timed out';
          feed(room, `${cp.name} ran out of time and auto-packed.`);
        }
        afterAction(room);
      }
    }
    // Sweep seats held past the reconnect window.
    for (const p of [...room.players.values()]) {
      if (!p.connected && p.disconnectedAt && now - p.disconnectedAt > RECONNECT_MS) {
        removePlayer(room, p.id, 'lost connection');
      }
    }
  }
}

/* ------------------------------ routing ------------------------------ */
function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }

  // Auth first: these work without (and before) a login.
  switch (msg.type) {
    case 'login': return onLogin(ws, msg);
    case 'auth':  return onAuthToken(ws, msg);
    case 'logout': return onLogout(ws);
    default: break;
  }
  if (!ws.account) return sendError(ws, 'Please log in to continue.');

  // Admin backend messages (each validated with an isAdmin check).
  if (String(msg.type).startsWith('admin_')) return handleAdmin(ws, msg);

  const ref = ws.playerRef;
  const room = ref ? rooms.get(ref.roomCode) : null;
  const player = room ? room.players.get(ref.playerId) : null;

  switch (msg.type) {
    case 'create_room': return onCreateRoom(ws, msg);
    case 'join_room':   return onJoinRoom(ws, msg);
    default: break;
  }
  if (!room || !player) return sendError(ws, 'Join a room first.');

  const fail = (problem) => { if (problem) sendError(ws, problem); };
  switch (msg.type) {
    case 'toggle_ready':    onToggleReady(ws); break;
    case 'start_game':    fail(doStartGame(room, player)); break;
    case 'bet':           fail(doBet(room, player, msg.kind)); break;
    case 'see_cards':     fail(doSeeCards(room, player)); break;
    case 'pack':          fail(doPack(room, player)); break;
    case 'sideshow':      fail(doSideshowRequest(room, player)); break;
    case 'sideshow_response': fail(doSideshowResponse(room, player, msg.accept)); break;
    case 'show':          fail(doShow(room, player)); break;
    case 'play_again':    fail(doPlayAgain(room, player)); break;
    case 'remove_player': fail(doRemovePlayer(room, player, msg.targetId)); break;
    case 'leave':         removePlayer(room, player.id, 'left'); break;
    default: sendError(ws, 'Unknown action.');
  }
}

function onDisconnect(ws) {
  const ref = ws.playerRef;
  if (!ref) return;
  const room = rooms.get(ref.roomCode);
  if (!room) return;
  const p = room.players.get(ref.playerId);
  if (!p || p.ws !== ws) return;
  p.connected = false;
  p.ws = null;
  p.disconnectedAt = Date.now();
  feed(room, `${p.name} disconnected (seat held for 2 min).`);
  if (p.isHost) migrateHost(room);
  if (room.players.size === 0) { rooms.delete(room.code); return; }
  sendState(room);
}

/* ------------------------------ http --------------------------------- */
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function requestHandler(req, res) {
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  if (p === '/admin' || p === '/admin/') p = '/admin.html'; // admin backend panel
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA fallback: unknown paths serve the app.
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(d2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ------------------------------ startup ------------------------------ */
function startServer() {
  const WebSocket = require('ws'); // lazy so unit tests don't need it
  loadAccounts();
  bootstrapAdmin();
  const server = http.createServer(requestHandler);
  const wss = new WebSocket.Server({ server });
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      try { handleMessage(ws, raw.toString()); }
      catch (e) { console.error('message error:', e.message); sendError(ws, 'Server error.'); }
    });
    ws.on('close', () => { try { onDisconnect(ws); } catch (e) { console.error(e.message); } });
    ws.on('error', () => {});
  });
  setInterval(tick, 500);
  server.listen(PORT, () => console.log(`Teen Patti server listening on port ${PORT}`));
}

if (require.main === module) startServer();

module.exports = {
  evaluateHand, compareHands, cardCode, newDeck, shuffle,
  BOOT, MAX_PLAYERS, TURN_MS,
};
