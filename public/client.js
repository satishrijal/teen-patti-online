/* Teen Patti Online — client. Virtual chips only, no real money. */
(() => {
'use strict';

const $ = (s) => document.querySelector(s);
const TURN_MS = 30000; // must match server

/* ------------------------------- audio ------------------------------ */
const AudioFX = {
  ctx: null,
  get muted() { return localStorage.getItem('tp_muted') === '1'; },
  set muted(v) { localStorage.setItem('tp_muted', v ? '1' : '0'); },
  ensure() {
    if (!this.ctx) {
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* no audio */ }
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  },
  tone(freq, dur, type = 'sine', vol = 0.15, when = 0) {
    if (this.muted || !this.ctx) return;
    try {
      const t = this.ctx.currentTime + when;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(this.ctx.destination);
      o.start(t); o.stop(t + dur + 0.05);
    } catch (e) { /* ignore */ }
  },
  click() { this.tone(620, 0.06, 'square', 0.07); },
  deal()  { for (let i = 0; i < 3; i++) this.tone(520 - i * 130, 0.09, 'triangle', 0.13, i * 0.1); },
  chips() { this.tone(2300, 0.04, 'square', 0.05); this.tone(1750, 0.05, 'square', 0.05, 0.06); },
  turn()  { this.tone(880, 0.12, 'sine', 0.15); this.tone(1174, 0.16, 'sine', 0.13, 0.1); },
  tick()  { this.tone(1250, 0.05, 'square', 0.06); },
  win()   { [523, 659, 784, 1046, 1318].forEach((f, i) => this.tone(f, 0.16, 'triangle', 0.15, i * 0.11)); },
  lose()  { this.tone(220, 0.22, 'sawtooth', 0.09); },
};
document.addEventListener('pointerdown', () => AudioFX.ensure(), { passive: true });

/* --------------------------- background music -------------------------- */
/* Optional looping music. Drop an MP3 at public/music/background.mp3 and it
 * plays (volume 0.3, looped) once the user first taps/clicks anywhere —
 * browsers block audio before a user gesture. No file = no music, no
 * errors: the Audio element's error event simply marks it unavailable and
 * hides the toggle button. Music mute is independent of the SFX mute. */
const Music = {
  el: null,
  available: true, // flipped to false if background.mp3 fails to load
  started: false,
  get muted() { return localStorage.getItem('tp_music_muted') === '1'; },
  set muted(v) { localStorage.setItem('tp_music_muted', v ? '1' : '0'); },
  ensureEl() {
    if (this.el || !this.available) return this.el;
    try {
      const a = new Audio();
      a.preload = 'none'; // don't fetch anything until the user gestures
      a.loop = true;
      a.volume = 0.3; // sit behind the game sounds
      a.addEventListener('error', () => {
        this.available = false;
        this.el = null;
        this.setMutedUI(); // hides the toggle button
      });
      a.src = 'music/background.mp3';
      this.el = a;
    } catch (e) { this.available = false; }
    return this.el;
  },
  start() {
    // Called on the first user gesture (and on unmute). Browsers allow
    // audio.play() inside a gesture handler.
    if (this.started || this.muted || !this.available) return;
    const a = this.ensureEl();
    if (!a) return;
    this.started = true;
    try {
      const p = a.play();
      if (p && p.catch) p.catch(() => { this.started = false; });
    } catch (e) { this.started = false; }
  },
  setMutedUI() {
    const btn = $('#btn-music');
    if (!btn) return;
    if (!this.available) { btn.hidden = true; return; }
    btn.hidden = false;
    btn.textContent = this.muted ? '🔇' : '🎵';
  },
  toggle() {
    this.muted = !this.muted;
    if (this.muted) {
      if (this.el) { try { this.el.pause(); } catch (e) {} }
    } else {
      this.started = false; // allow start() to (re)try playback
      this.start();
    }
    this.setMutedUI();
  },
};
document.addEventListener('pointerdown', () => Music.start(), { passive: true });

/* -------------------------------- cards ----------------------------- */
const SUIT_SYM = { S: '♠', H: '♥', D: '♦', C: '♣' };
function cardEl(code, small = false, dealt = false, delay = 0) {
  const s = code.slice(-1), r = code.slice(0, -1);
  const d = document.createElement('div');
  d.className = 'card' + (small ? ' small' : '') + ((s === 'H' || s === 'D') ? ' red' : '') + (dealt ? ' dealt' : '');
  if (dealt) d.style.animationDelay = `${delay}ms`;
  d.innerHTML = `<div class="rank">${r}</div><div class="suit">${SUIT_SYM[s]}</div>`;
  return d;
}
function cardBack(small = false, dealt = false, delay = 0) {
  const d = document.createElement('div');
  d.className = 'card back' + (small ? ' small' : '') + (dealt ? ' dealt' : '');
  if (dealt) d.style.animationDelay = `${delay}ms`;
  return d;
}

/* ------------------------------ connection -------------------------- */
let ws = null;
let state = null;      // latest server snapshot
let prevState = null;
let lastDealtRound = 0;
let lastTickSec = -1;
let dismissedResult = '';
let retryDelay = 1000;
let intentionalClose = false;
let auth = null; // { token, username, isAdmin } once logged in

function session() {
  try { return JSON.parse(localStorage.getItem('tp_session') || 'null'); } catch (e) { return null; }
}
function saveSession(s) { localStorage.setItem('tp_session', JSON.stringify(s)); }
function clearSession() { localStorage.removeItem('tp_session'); }

// Login session token (7-day expiry server-side).
function authToken() { try { return localStorage.getItem('tp_auth') || null; } catch (e) { return null; } }
function saveAuthToken(t) { try { localStorage.setItem('tp_auth', t); } catch (e) {} }
function clearAuth() { try { localStorage.removeItem('tp_auth'); } catch (e) {} auth = null; }

function connect() {
  if (ws && ws.readyState !== 3) return; // already open or connecting
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    retryDelay = 1000;
    const t = authToken();
    if (t) {
      // Resume the login session first; room rejoin happens after auth_ok.
      send({ type: 'auth', token: t });
    } else {
      showScreen('login');
    }
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    route(msg);
  };
  ws.onclose = () => {
    if (intentionalClose) return;
    toast('Connection lost — retrying…');
    setTimeout(() => {
      retryDelay = Math.min(retryDelay * 1.5, 10000);
      connect();
    }, retryDelay);
  };
}
function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  else toast('Not connected yet…', true);
}

function route(msg) {
  if (msg.type === 'state') {
    prevState = state;
    state = msg;
    if (state.you && state.you.token) {
      saveSession({ code: state.room.code, token: state.you.token, name: state.you.name });
    }
    detectEvents();
    render();
  } else if (msg.type === 'auth_ok') {
    onAuthOk(msg);
  } else if (msg.type === 'auth_fail') {
    clearAuth();
    showScreen('login');
    loginError(msg.message);
  } else if (msg.type === 'logged_out') {
    clearAuth();
    clearSession();
    state = null; prevState = null;
    showScreen('login');
    toast('Logged out.');
  } else if (msg.type === 'sideshow_request') {
    AudioFX.turn();
    openSideshowModal(msg);
  } else if (msg.type === 'error') {
    toast(msg.message, true);
    AudioFX.lose();
  } else if (msg.type === 'kicked') {
    clearSession();
    toast('You were removed from the room.', true);
    showScreen('home');
    refreshRejoin();
  }
}

// Run fn as soon as the socket is open (connecting first if needed).
function whenOpen(fn) {
  if (ws && ws.readyState === 1) return fn();
  connect();
  const iv = setInterval(() => {
    if (ws && ws.readyState === 1) { clearInterval(iv); fn(); }
  }, 100);
  setTimeout(() => clearInterval(iv), 8000);
}

function loginError(text) {
  const e = $('#login-error');
  if (!e) return;
  e.textContent = text; e.hidden = false;
}

function onAuthOk(msg) {
  auth = { token: msg.token, username: msg.username, isAdmin: !!msg.isAdmin };
  saveAuthToken(msg.token);
  const badge = $('#auth-user');
  badge.textContent = '👤 ' + msg.username;
  badge.hidden = false;
  $('#btn-logout').hidden = false;
  $('#home-username').textContent = msg.username;
  $('#home-balance').textContent = msg.balance;
  const le = $('#login-error');
  if (le) le.hidden = true;
  showScreen('home');
  refreshRejoin();
  // Auto-rejoin the previous room after a dropped connection / refresh.
  const s = session();
  if (s && s.token && s.code) {
    send({ type: 'join_room', code: s.code, token: s.token });
  }
}

// Compare old vs new state to trigger sounds / animations.
function detectEvents() {
  if (!prevState || !state) return;
  if (prevState.room.code !== state.room.code) { lastDealtRound = 0; return; }
  if (state.room.phase === 'playing' && state.room.roundNumber !== lastDealtRound) {
    lastDealtRound = state.room.roundNumber;
    if (prevState.room.phase === 'playing' || prevState.room.result) AudioFX.deal();
  }
  // Bets flying to the pot.
  if (state.room.phase === 'playing' && prevState.room.phase === 'playing') {
    for (const p of state.players) {
      const q = prevState.players.find(x => x.id === p.id);
      if (q && p.betInRound > q.betInRound) {
        flyChip(p.id);
        AudioFX.chips();
      }
    }
  }
  // My turn started.
  const wasMine = prevState.room.turnPlayerId === prevState.you.id;
  const isMine = state.room.turnPlayerId === state.you.id &&
    state.room.phase === 'playing' && state.you.inRound && !state.you.packed;
  if (isMine && !wasMine) { AudioFX.turn(); lastTickSec = -1; }
  // Round result.
  if (state.room.result && (!prevState.room.result ||
      prevState.room.result.roundNumber !== state.room.result.roundNumber)) {
    const iWon = state.room.result.winners.some(w => w.id === state.you.id);
    setTimeout(() => (iWon ? AudioFX.win() : AudioFX.click()), 400);
  }
}

/* --------------------------------- UI ------------------------------- */
function showScreen(name) {
  for (const s of ['login', 'home', 'lobby', 'table']) $('#screen-' + s).hidden = s !== name;
  $('#btn-leave').hidden = (name === 'home' || name === 'login');
}
function toast(text, isErr = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = text;
  $('#toast-root').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; }, 2600);
  setTimeout(() => t.remove(), 3100);
}
function openModal(html) {
  closeModal();
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal">${html}</div>`;
  $('#modal-root').appendChild(back);
  return back;
}
function closeModal() { $('#modal-root').innerHTML = ''; }

/* ------------------------------ login ------------------------------- */
function initLogin() {
  const attempt = () => {
    const username = $('#in-login-user').value.trim();
    const password = $('#in-login-pass').value;
    if (!username || !password) return loginError('Enter your username and password.');
    AudioFX.ensure(); AudioFX.click();
    whenOpen(() => send({ type: 'login', username, password }));
  };
  $('#btn-login').addEventListener('click', attempt);
  $('#in-login-user').addEventListener('keydown', e => { if (e.key === 'Enter') $('#in-login-pass').focus(); });
  $('#in-login-pass').addEventListener('keydown', e => { if (e.key === 'Enter') attempt(); });
}

/* ------------------------------ home -------------------------------- */
function refreshRejoin() {
  const s = session();
  const box = $('#rejoin-box');
  if (s && s.code && s.token) {
    box.hidden = false;
    $('#btn-rejoin').textContent = `↩ Rejoin room ${s.code} as ${s.name}`;
  } else box.hidden = true;
}
function initHome() {
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    AudioFX.click();
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    $('#tab-create').hidden = t.dataset.tab !== 'create';
    $('#tab-join').hidden = t.dataset.tab !== 'join';
  }));
  const doCreate = () => {
    if (!auth) return homeError('Please log in first.');
    AudioFX.ensure(); AudioFX.click();
    whenOpen(() => send({ type: 'create_room' }));
  };
  const doJoin = (code, token) => {
    if (!auth) return homeError('Please log in first.');
    AudioFX.ensure(); AudioFX.click();
    whenOpen(() => send({ type: 'join_room', code, token }));
  };
  $('#btn-create').addEventListener('click', doCreate);
  $('#btn-join').addEventListener('click', () => {
    const code = $('#in-join-code').value.trim().toUpperCase();
    if (code.length !== 6) return homeError('Room code is 6 characters.');
    doJoin(code);
  });
  $('#btn-rejoin').addEventListener('click', () => {
    const s = session();
    if (s) doJoin(s.code, s.token);
  });
  $('#btn-forget').addEventListener('click', () => { clearSession(); refreshRejoin(); });
  $('#in-join-code').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-join').click(); });
}
function homeError(text) {
  const e = $('#home-error');
  e.textContent = text; e.hidden = false;
  setTimeout(() => { e.hidden = true; }, 3500);
}

/* ------------------------------- lobby ------------------------------ */
function renderLobby() {
  showScreen('lobby');
  closeModal();
  const me = state.you;
  $('#lobby-code').textContent = state.room.code;
  const n = state.players.length;
  $('#lobby-count').textContent = `(${n}/${10})`;

  const ul = $('#lobby-players');
  ul.innerHTML = '';
  for (const p of state.players) {
    const li = document.createElement('li');
    if (!p.connected) li.classList.add('offline');
    li.innerHTML = `
      <div class="avatar" style="background:${p.color}">${escapeHtml(p.name[0] || '?').toUpperCase()}</div>
      <div class="pname">${escapeHtml(p.name)}${p.isHost ? '<span class="host-badge">👑 host</span>' : ''}${!p.connected ? ' <span style="color:#ff8a7a;font-size:.75rem">(offline)</span>' : ''}</div>
      <div class="chips">🪙 ${p.balance}</div>
      <div class="ready-pill ${p.ready ? 'on' : ''}">${p.ready ? 'READY' : 'not ready'}</div>`;
    if (me.isHost && p.id !== me.id) {
      const rm = document.createElement('button');
      rm.className = 'remove-btn'; rm.title = 'Remove player'; rm.textContent = '✕';
      rm.addEventListener('click', () => {
        if (confirm(`Remove ${p.name} from the room?`)) { AudioFX.click(); send({ type: 'remove_player', targetId: p.id }); }
      });
      li.appendChild(rm);
    }
    ul.appendChild(li);
  }

  const readyBtn = $('#btn-ready');
  readyBtn.textContent = me.ready ? "Not Ready ✕" : "I'm Ready ✓";
  readyBtn.classList.toggle('primary', !me.ready);
  const broke = me.balance < state.room.boot;
  readyBtn.disabled = broke && !me.ready;
  readyBtn.hidden = false;

  const startBtn = $('#btn-start');
  startBtn.hidden = !me.isHost;
  const readyCount = state.players.filter(p => p.ready && p.connected && p.balance >= state.room.boot).length;
  startBtn.disabled = readyCount < 2;
  $('#lobby-hint').textContent = broke
    ? 'You are out of chips — ask the admin to load chips for you.'
    : readyCount < 2
      ? `Waiting for players… ${readyCount} ready (need 2+).`
      : me.isHost ? `${readyCount} ready — start when everyone is set!` : 'Waiting for the host to start…';

  const hb = $('#home-balance');
  if (hb) hb.textContent = me.balance;

  // Result modal after a round.
  const res = state.room.result;
  const key = res ? state.room.code + ':' + res.roundNumber : '';
  if (res && dismissedResult !== key) openResultModal(res, key);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------- table ------------------------------ */
function isMyTurn() {
  return state && state.room.phase === 'playing' &&
    state.room.turnPlayerId === state.you.id &&
    state.you.inRound && !state.you.packed;
}

function renderTable() {
  showScreen('table');
  const r = state.room, me = state.you;
  $('#pot-amount').textContent = r.pot;
  $('#stake-amount').textContent = r.stake;

  // Seat order: me first (bottom), then everyone else in room order.
  const others = state.players.filter(p => p.id !== me.id);
  const seats = [state.players.find(p => p.id === me.id), ...others].filter(Boolean);
  const wrap = $('#seats');
  wrap.innerHTML = '';
  const n = seats.length;
  seats.forEach((p, k) => {
    const ang = Math.PI / 2 + (k * 2 * Math.PI) / n; // 90° = bottom
    const x = 50 + 42 * Math.cos(ang);
    const y = 52 + 40 * Math.sin(ang);
    const d = document.createElement('div');
    d.className = 'seat' + (p.packed && p.inRound ? ' packed-seat' : '') + (!p.connected ? ' offline-seat' : '');
    d.dataset.pid = p.id;
    d.style.left = x.toFixed(1) + '%';
    d.style.top = y.toFixed(1) + '%';

    let badge;
    if (!p.inRound) badge = '<div class="sbadge watch">WATCHING</div>';
    else if (p.packed) badge = '<div class="sbadge packed">PACKED</div>';
    else if (p.seen) badge = '<div class="sbadge seen">SEEN</div>';
    else badge = '<div class="sbadge blind">BLIND</div>';

    const bet = p.inRound && p.betInRound > 0 ? `<div class="sbet">🪙${p.betInRound}</div>` : '';
    const dealer = r.dealerId === p.id ? '<div class="dealer-btn">D</div>' : '';
    const backs = p.inRound && !p.packed
      ? `<div class="mini-cards">${cardBack(true).outerHTML}${cardBack(true).outerHTML}${cardBack(true).outerHTML}</div>` : '';
    const hostMark = p.isHost ? '👑' : '';
    d.innerHTML = `
      <div class="timer-ring"></div>
      <div class="avatar" style="background:${p.color}">${escapeHtml(p.name[0] || '?').toUpperCase()}</div>
      ${bet}${dealer}
      <div class="sname">${hostMark}${escapeHtml(p.name)}</div>
      <div class="sbal">🪙 ${p.balance}</div>
      ${badge}${backs}`;
    wrap.appendChild(d);
  });

  renderMyHand();
  renderActions();
  renderFeed();
}

let animatedRound = 0; // round number whose deal animation already played

function renderMyHand() {
  const me = state.you;
  const box = $('#my-cards');
  box.innerHTML = '';
  const animate = state.room.phase === 'playing' && state.room.roundNumber !== animatedRound;
  if (state.room.phase === 'playing') animatedRound = state.room.roundNumber;
  if (me.cards && me.cards.length === 3) {
    me.cards.forEach((c, i) => box.appendChild(cardEl(c, false, animate, i * 130)));
  } else if (me.inRound && !me.packed) {
    for (let i = 0; i < 3; i++) box.appendChild(cardBack(false, animate, i * 130));
    const lbl = document.createElement('div');
    lbl.className = 'cards-label';
    lbl.textContent = 'Your cards are face-down (BLIND)';
    box.appendChild(lbl);
  } else {
    const lbl = document.createElement('div');
    lbl.className = 'cards-label';
    lbl.textContent = state.room.phase === 'playing' ? 'You are sitting this one out' : 'Waiting for the round…';
    box.appendChild(lbl);
  }
}

function actionBtn(label, cls, fn, disabled = false) {
  const b = document.createElement('button');
  b.className = 'btn ' + cls;
  b.textContent = label;
  b.disabled = disabled;
  b.addEventListener('click', () => { AudioFX.ensure(); AudioFX.click(); fn(); });
  return b;
}

function renderActions() {
  const bar = $('#action-bar');
  bar.innerHTML = '';
  const r = state.room, me = state.you;
  if (r.phase !== 'playing' || !me.inRound || me.packed) return;

  const stake = r.stake;
  const canAfford = (amt) => me.balance > 0;

  if (r.sideshow) {
    const note = document.createElement('div');
    note.className = 'hint';
    note.style.width = '100%';
    note.textContent = r.sideshow.fromId === me.id
      ? `Waiting for ${r.sideshow.toId === me.id ? '' : state.players.find(p => p.id === r.sideshow.toId)?.name} to answer your side show…`
      : 'Side show in progress…';
    bar.appendChild(note);
    return;
  }

  if (!me.seen) {
    bar.appendChild(actionBtn('👁 See Cards', '', () => send({ type: 'see_cards' })));
  }
  if (isMyTurn()) {
    if (!me.seen) {
      bar.appendChild(actionBtn(`Blind 🪙${stake}`, 'blind-btn', () => send({ type: 'bet', kind: 'blind' }), !canAfford(stake)));
      bar.appendChild(actionBtn(`Blind 2× 🪙${stake * 2}`, 'blind-btn', () => send({ type: 'bet', kind: 'blind2' }), !canAfford(stake)));
    } else {
      bar.appendChild(actionBtn(`Chaal 🪙${stake * 2}`, 'chaal-btn', () => send({ type: 'bet', kind: 'chaal' }), !canAfford(stake * 2)));
      bar.appendChild(actionBtn(`Chaal 2× 🪙${stake * 4}`, 'chaal-btn', () => send({ type: 'bet', kind: 'chaal2' }), !canAfford(stake * 2)));
    }
    if (me.seen && r.activeCount >= 3) {
      const prev = previousActiveClient();
      bar.appendChild(actionBtn(
        prev ? `🔀 Side Show (${prev.name})` : '🔀 Side Show',
        '', () => send({ type: 'sideshow' }), !prev || !prev.seen
      ));
    }
    if (me.seen && r.activeCount === 2) {
      bar.appendChild(actionBtn('⚔️ SHOW', 'show-btn', () => {
        if (confirm('Demand a showdown? Both hands will be revealed.')) send({ type: 'show' });
      }));
    }
  }
  bar.appendChild(actionBtn('📦 Pack', 'pack-btn', () => {
    if (confirm('Pack (fold) this hand?')) send({ type: 'pack' });
  }));
}

// Mirror of the server's "previous active player" for the side-show button label.
function previousActiveClient() {
  const r = state.room, me = state.you;
  const ids = state.players.filter(p => p.inRound && !p.packed).map(p => p.id);
  if (ids.length < 3) return null;
  // Use turn-order-agnostic fallback: the closest seated player before me in list order.
  const order = state.players.map(p => p.id);
  let idx = order.indexOf(me.id);
  for (let i = 1; i < order.length; i++) {
    const p = state.players.find(x => x.id === order[(idx - i + order.length * 2) % order.length]);
    if (p && p.inRound && !p.packed && p.id !== me.id) return p;
  }
  return null;
}

function renderFeed() {
  const box = $('#feed-items');
  box.innerHTML = '';
  for (const f of state.feed) {
    const d = document.createElement('div');
    d.textContent = f.text;
    box.appendChild(d);
  }
  const feed = $('#feed');
  feed.scrollTop = feed.scrollHeight;
}

// Chip flies from a seat to the pot.
function flyChip(playerId) {
  const seat = document.querySelector(`.seat[data-pid="${playerId}"]`);
  const pot = $('#pot-amount');
  if (!seat || !pot) return;
  const a = seat.getBoundingClientRect(), b = pot.getBoundingClientRect();
  const chip = document.createElement('div');
  chip.className = 'chip-fly';
  chip.textContent = '🪙';
  chip.style.left = (a.left + a.width / 2 - 12) + 'px';
  chip.style.top = (a.top + a.height / 2 - 12) + 'px';
  document.body.appendChild(chip);
  const dx = (b.left + b.width / 2) - (a.left + a.width / 2);
  const dy = (b.top + b.height / 2) - (a.top + a.height / 2);
  const anim = chip.animate(
    [{ transform: 'translate(0,0) scale(1)', opacity: 1 },
     { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 40}px) scale(1.1)`, opacity: 1, offset: 0.55 },
     { transform: `translate(${dx}px, ${dy}px) scale(.6)`, opacity: 0.9 }],
    { duration: 550, easing: 'cubic-bezier(.3,.7,.4,1)' }
  );
  anim.onfinish = () => {
    chip.remove();
    const pa = $('#pot-area');
    pa.classList.remove('pulse'); void pa.offsetWidth; pa.classList.add('pulse');
  };
}

/* ------------------------------- modals ----------------------------- */
let sideshowTimer = null;
function openSideshowModal(msg) {
  closeModal();
  const back = openModal(`
    <h2>🔀 Side Show</h2>
    <p><b>${escapeHtml(msg.fromName)}</b> wants a side show with you.<br>
    If you accept, hands are compared privately — the weaker hand packs.</p>
    <p class="hint">Decide in <span id="ss-count">15</span>s…</p>
    <div class="modal-actions">
      <button class="btn pack-btn" id="ss-no">Decline</button>
      <button class="btn primary" id="ss-yes">Accept</button>
    </div>`);
  const done = (accept) => {
    clearInterval(sideshowTimer);
    closeModal();
    send({ type: 'sideshow_response', accept });
  };
  back.querySelector('#ss-yes').addEventListener('click', () => { AudioFX.click(); done(true); });
  back.querySelector('#ss-no').addEventListener('click', () => { AudioFX.click(); done(false); });
  const end = msg.expiresAt;
  sideshowTimer = setInterval(() => {
    const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
    const el = back.querySelector('#ss-count');
    if (el) el.textContent = left;
    if (left <= 0) { clearInterval(sideshowTimer); closeModal(); }
  }, 250);
}

function openResultModal(res, key) {
  const me = state.you;
  const winners = res.winners.map(w =>
    `<div>🏆 <b>${escapeHtml(w.name)}</b> <span class="chips">+🪙${w.amount}</span></div>`).join('');
  const hands = res.hands.map(h => {
    const isW = res.winners.some(w => w.id === h.playerId);
    return `<div class="result-hand ${isW ? 'winner' : ''}">
      <div class="rname">${isW ? '🏆 ' : ''}${escapeHtml(h.name)}</div>
      <div class="result-cards">${h.cards.map(c => cardEl(c, true).outerHTML).join('')}</div>
      <div class="rhand">${escapeHtml(h.handName)}</div>
    </div>`;
  }).join('');
  const iWon = res.winners.some(w => w.id === me.id);
  const back = openModal(`
    <h2>${res.reason === 'showdown' ? '⚔️ Showdown!' : '🎉 Round ' + res.roundNumber + ' Over'}</h2>
    ${winners || '<p>No winner — bets refunded.</p>'}
    ${hands}
    <p class="hint">${iWon ? 'Nice hand! The pot is yours.' : 'Better luck next round.'}</p>
    <div class="modal-actions">
      <button class="btn" id="res-lobby">Lobby</button>
      <button class="btn gold" id="res-again">🔄 Play Again</button>
    </div>`);
  back.querySelector('#res-lobby').addEventListener('click', () => {
    AudioFX.click(); dismissedResult = key; closeModal();
  });
  back.querySelector('#res-again').addEventListener('click', () => {
    AudioFX.click(); dismissedResult = key; closeModal();
    send({ type: 'play_again' });
  });
}

/* --------------------------- countdown loop -------------------------- */
setInterval(() => {
  if (!state || state.room.phase !== 'playing') return;
  const ends = state.room.turnEndsAt;
  document.querySelectorAll('.seat').forEach(s => {
    s.classList.remove('active-turn');
    const ring = s.querySelector('.timer-ring');
    if (ring) ring.style.background = 'none';
  });
  const banner = $('#turn-banner');
  if (!ends) { banner.hidden = true; return; }
  const seat = document.querySelector(`.seat[data-pid="${state.room.turnPlayerId}"]`);
  const remain = Math.max(0, ends - Date.now());
  if (seat) {
    seat.classList.add('active-turn');
    const ring = seat.querySelector('.timer-ring');
    if (ring) {
      const frac = Math.max(0, Math.min(1, remain / TURN_MS));
      ring.style.background =
        `conic-gradient(var(--gold) ${frac * 360}deg, rgba(255,255,255,.07) 0deg)`;
    }
  }
  if (isMyTurn()) {
    const secs = Math.ceil(remain / 1000);
    banner.hidden = false;
    banner.textContent = `🎯 YOUR TURN — ${secs}s`;
    if (secs <= 5 && secs !== lastTickSec && secs > 0) { lastTickSec = secs; AudioFX.tick(); }
  } else {
    banner.hidden = true;
  }
}, 200);

/* -------------------------------- render ----------------------------- */
function render() {
  if (!state) return;
  if (state.room.phase === 'lobby') renderLobby();
  else renderTable();
}

/* --------------------------------- init ------------------------------ */
function init() {
  initLogin();
  initHome();
  refreshRejoin();

  $('#btn-mute').addEventListener('click', (e) => {
    AudioFX.ensure();
    AudioFX.muted = !AudioFX.muted;
    e.currentTarget.textContent = AudioFX.muted ? '🔇' : '🔊';
    if (!AudioFX.muted) AudioFX.click();
  });
  if (AudioFX.muted) $('#btn-mute').textContent = '🔇';

  $('#btn-music').addEventListener('click', () => {
    AudioFX.ensure();
    Music.toggle();
    AudioFX.click();
  });
  Music.setMutedUI();

  $('#btn-leave').addEventListener('click', () => {
    if (!confirm('Leave this room?')) return;
    intentionalClose = true;
    try { send({ type: 'leave' }); } catch (e) {}
    try { ws && ws.close(); } catch (e) {}
    clearSession();
    state = null; prevState = null;
    setTimeout(() => { intentionalClose = false; connect(); }, 500);
    showScreen('home');
    refreshRejoin();
  });

  $('#btn-logout').addEventListener('click', () => {
    if (!confirm('Log out?')) return;
    intentionalClose = true;
    try { send({ type: 'logout' }); } catch (e) {}
    try { ws && ws.close(); } catch (e) {}
    clearAuth();
    clearSession();
    state = null; prevState = null;
    $('#auth-user').hidden = true;
    $('#btn-logout').hidden = true;
    setTimeout(() => { intentionalClose = false; }, 500);
    showScreen('login');
  });

  $('#btn-ready').addEventListener('click', () => { AudioFX.click(); send({ type: 'toggle_ready' }); });
  $('#btn-start').addEventListener('click', () => { AudioFX.click(); send({ type: 'start_game' }); });
  $('#btn-copy-code').addEventListener('click', () => {
    const code = $('#lobby-code').textContent;
    const done = () => toast('Room code copied!');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(done).catch(() => toast('Code: ' + code));
    } else toast('Code: ' + code);
  });
  $('#btn-feed-toggle').addEventListener('click', () => {
    $('#feed').classList.toggle('open');
  });

  connect();
  showScreen('login');
}

document.addEventListener('DOMContentLoaded', init);
})();
