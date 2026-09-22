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
const START_CHIPS = 1000;        // starting balance + broke-player refill (virtual)
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

function newPlayer(name, colorIdx) {
  return {
    id: crypto.randomBytes(8).toString('hex'),
    token: crypto.randomBytes(16).toString('hex'),
    name: String(name || 'Player').trim().slice(0, 16) || 'Player',
    color: AVATAR_COLORS[colorIdx % AVATAR_COLORS.length],
    ws: null,
    connected: false,
    disconnectedAt: null,
    isHost: false,
    ready: false,
    balance: START_CHIPS,
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
function send(p, obj) {
  if (p.ws && p.ws.readyState === 1) {
    try { p.ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
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
  const name = String(msg.name || '').trim();
  if (!name) return sendError(ws, 'Please enter your name.');
  const code = makeCode();
  const room = newRoom(code);
  const player = newPlayer(name, 0);
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
  const code = String(msg.code || '').trim().toUpperCase();
  const room = rooms.get(code);
  if (!room) return sendError(ws, 'Room not found. Check the code and try again.');

  // Reconnect with a previously issued token: seat + hand are restored.
  if (msg.token) {
    const rec = tokenIndex.get(msg.token);
    if (rec && rec.code === code) {
      const player = room.players.get(rec.playerId);
      if (player) {
        attach(ws, room, player);
        feed(room, `${player.name} reconnected.`);
        sendState(room);
        return;
      }
    }
    // Unknown/expired token: fall through to fresh join.
  }

  const name = String(msg.name || '').trim();
  if (!name) return sendError(ws, 'Please enter your name.');
  if (room.players.size >= MAX_PLAYERS) return sendError(ws, 'This room is full (10 players).');
  const taken = [...room.players.values()].some(p => p.name.toLowerCase() === name.toLowerCase());
  if (taken) return sendError(ws, 'That name is taken in this room. Pick another.');

  const player = newPlayer(name, room.order.length);
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
  if (!p.ready && p.balance < BOOT) {
    sendError(ws, `You need at least ${BOOT} chips to play. Hit Refill.`);
    return;
  }
  p.ready = !p.ready;
  feed(room, `${p.name} is ${p.ready ? 'ready' : 'not ready'}.`);
  sendState(room);
}

/* ------------------------------ rounds ------------------------------- */
function startRound(room) {
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
  }
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
  if (p.balance < BOOT) return 'You need chips to play — hit Refill first.';
  p.ready = true;
  room.lastResult = null;
  feed(room, `${p.name} wants to play again.`);
  sendState(room);
  return null;
}

function doRefill(room, p) {
  if (room.phase !== 'lobby') return 'Refill is only available in the lobby.';
  if (p.balance >= BOOT) return 'You still have chips.';
  p.balance += START_CHIPS;
  feed(room, `${p.name} refilled ${START_CHIPS} chips.`);
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

/* --------------------------- tick & timeouts ------------------------- */
function tick() {
  const now = Date.now();
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
    case 'refill':        fail(doRefill(room, player)); break;
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
  BOOT, START_CHIPS, MAX_PLAYERS, TURN_MS,
};
