'use strict';
/*
 * store.js — account + session storage for Teen Patti Online.
 * ------------------------------------------------------------
 * Two backends behind one interface:
 *
 *   • PostgreSQL — active when the DATABASE_URL env var is set.
 *     Neon (free tier, no expiry) is recommended: accounts and chip
 *     balances survive restarts and redeploys forever.
 *     Neon requires SSL, so the pool is created with
 *     ssl: { rejectUnauthorized: false }.
 *
 *   • JSON file (data/accounts.json) — zero-config fallback for local
 *     development. Behaves exactly like the original phase-2 storage.
 *
 * The Store keeps live in-memory caches (accounts, sessions) so the game
 * engine stays synchronous; every mutation is written through to the active
 * backend. Write-through failures are logged, never thrown, so a database
 * hiccup can never crash a live game.
 *
 * Backend interface (both classes implement it):
 *   init()                          — connect + prepare (create tables)
 *   loadAll()                       — { accounts: [...], sessions: [...] }
 *   upsertAccount(account)          — insert or update one account
 *   deleteAccount(lowerUsername)    — remove one account (+ its sessions)
 *   upsertSession(token, session)   — insert or refresh one login session
 *   deleteSession(token)            — remove one login session
 *   persistAll(accountsMap)         — full flush (JSON file write; no-op on pg)
 *
 * Virtual chips only — no real-money anything, anywhere.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.TP_DATA_DIR || path.join(__dirname, 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');

// The app stores password hashes as "saltHex:hashHex" (see hashPassword in
// server.js). Postgres keeps the two parts in separate columns.
function splitHash(stored) {
  const s = String(stored || '');
  const i = s.indexOf(':');
  if (i === -1) return { salt: '', password_hash: s };
  return { salt: s.slice(0, i), password_hash: s.slice(i + 1) };
}

function joinHash(salt, passwordHash) {
  return `${salt || ''}:${passwordHash || ''}`;
}

// Validate + normalize one account record coming from any source.
function cleanAccount(a) {
  if (!a || typeof a.username !== 'string' || typeof a.hash !== 'string') return null;
  return {
    username: a.username,
    hash: a.hash,
    isAdmin: !!a.isAdmin,
    balance: Math.max(0, Math.floor(a.balance) || 0),
    createdAt: Number(a.createdAt) || Date.now(),
    disabled: !!a.disabled,
  };
}

/* ------------------------------- JSON backend ------------------------------ */
class JsonBackend {
  constructor() { this.name = 'json'; }

  async init() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // Read + validate the accounts file. Returns null when there is no file
  // yet (first run) so callers can distinguish "empty" from "broken".
  static readJsonAccounts() {
    try {
      const raw = fs.readFileSync(ACCOUNTS_FILE, 'utf8');
      const list = JSON.parse(raw);
      if (!Array.isArray(list)) return null;
      const out = [];
      for (const a of list) {
        const c = cleanAccount(a);
        if (c) out.push(c);
      }
      return out;
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('Could not read accounts file:', e.message);
      return null;
    }
  }

  async loadAll() {
    return { accounts: JsonBackend.readJsonAccounts() || [], sessions: [] };
  }

  async upsertAccount() { /* durability comes from persistAll */ }
  async deleteAccount() { /* durability comes from persistAll */ }
  async upsertSession() { /* login sessions were never persisted to disk */ }
  async deleteSession() { /* login sessions were never persisted to disk */ }

  async persistAll(accountsMap) {
    // Atomic write: temp file + rename so a crash can't corrupt the file.
    const tmp = ACCOUNTS_FILE + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify([...accountsMap.values()], null, 2));
    fs.renameSync(tmp, ACCOUNTS_FILE);
  }
}

/* ----------------------------- PostgreSQL backend --------------------------- */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  username      TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
  balance       INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disabled      BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_lower_username_ux
  ON accounts (lower(username));
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  username   TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);
`;

class PgBackend {
  // poolOverride is for tests (e.g. a pg-mem pool). Otherwise a real pg
  // Pool is built lazily from the connection string.
  constructor(connectionString, poolOverride) {
    this.name = 'postgres';
    this.connectionString = connectionString;
    this.pool = poolOverride || null;
  }

  async init() {
    if (!this.pool) {
      const { Pool } = require('pg'); // lazy: JSON mode never needs the dep
      this.pool = new Pool({
        connectionString: this.connectionString,
        ssl: { rejectUnauthorized: false }, // required by Neon
      });
    }
    await this.pool.query(SCHEMA);
  }

  rowToAccount(r) {
    return {
      username: r.username,
      hash: joinHash(r.salt, r.password_hash),
      isAdmin: !!r.is_admin,
      balance: Number(r.balance) || 0,
      createdAt: new Date(r.created_at).getTime(),
      disabled: !!r.disabled,
    };
  }

  async loadAll() {
    const ar = await this.pool.query(
      'SELECT username, password_hash, salt, is_admin, balance, created_at, disabled FROM accounts'
    );
    const sr = await this.pool.query(
      'SELECT token, username, expires_at FROM sessions WHERE expires_at > NOW()'
    );
    return {
      accounts: ar.rows.map((r) => this.rowToAccount(r)),
      sessions: sr.rows.map((r) => ({
        token: r.token,
        username: r.username,
        expiresAt: new Date(r.expires_at).getTime(),
      })),
    };
  }

  async upsertAccount(a) {
    const c = cleanAccount(a);
    if (!c) throw new Error('invalid account');
    const { salt, password_hash } = splitHash(c.hash);
    try {
      await this.pool.query(
        `INSERT INTO accounts (username, password_hash, salt, is_admin, balance, created_at, disabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [c.username, password_hash, salt, c.isAdmin, c.balance, new Date(c.createdAt), c.disabled]
      );
    } catch (e) {
      if (e && e.code === '23505') {
        // Username (case-insensitively) already exists — update in place.
        // The original display-name casing is kept.
        await this.pool.query(
          `UPDATE accounts
              SET password_hash = $2, salt = $3, is_admin = $4,
                  balance = $5, disabled = $6
            WHERE lower(username) = lower($1)`,
          [c.username, password_hash, salt, c.isAdmin, c.balance, c.disabled]
        );
      } else {
        throw e;
      }
    }
  }

  async deleteAccount(lowerUsername) {
    await this.pool.query('DELETE FROM sessions WHERE username = $1', [lowerUsername]);
    await this.pool.query('DELETE FROM accounts WHERE lower(username) = lower($1)', [lowerUsername]);
  }

  async upsertSession(token, sess) {
    try {
      await this.pool.query(
        'INSERT INTO sessions (token, username, expires_at) VALUES ($1, $2, $3)',
        [token, sess.user, new Date(sess.expiresAt)]
      );
    } catch (e) {
      if (e && e.code === '23505') {
        await this.pool.query(
          'UPDATE sessions SET username = $2, expires_at = $3 WHERE token = $1',
          [token, sess.user, new Date(sess.expiresAt)]
        );
      } else {
        throw e;
      }
    }
  }

  async deleteSession(token) {
    await this.pool.query('DELETE FROM sessions WHERE token = $1', [token]);
  }

  async persistAll() { /* write-through already persisted every change */ }
}

/* ---------------------------------- Store ----------------------------------- */
class Store {
  constructor(backend) {
    this.backend = backend;
    this.accounts = new Map(); // lower(username) -> account (live cache)
    this.sessions = new Map(); // token -> { user, expiresAt } (live cache)
  }

  get backendName() { return this.backend.name; }

  async init() {
    try {
      await this.backend.init();
    } catch (e) {
      // Never let a bad DATABASE_URL take the game down: fall back to the
      // JSON file and say so loudly in the logs.
      console.error(
        `PostgreSQL init failed (${e.message}) — falling back to local JSON storage.`
      );
      this.backend = new JsonBackend();
      await this.backend.init();
    }
    const { accounts, sessions } = await this.backend.loadAll();
    for (const a of accounts) this.accounts.set(a.username.toLowerCase(), a);
    for (const s of sessions) this.sessions.set(s.token, { user: s.username, expiresAt: s.expiresAt });
    if (this.backend.name === 'postgres') await this.maybeMigrateFromJson();
    if (this.backend.name === 'postgres') {
      console.log('Account storage: PostgreSQL (DATABASE_URL is set) — accounts survive restarts.');
    } else {
      console.log(
        'Account storage: local JSON file (data/accounts.json). ' +
        'Set DATABASE_URL to use Postgres/Neon for persistence across restarts.'
      );
    }
  }

  // One-time rescue: empty Postgres + an old accounts.json on disk (e.g.
  // carried over from local dev) → import everyone so nobody is recreated.
  async maybeMigrateFromJson() {
    if (this.accounts.size > 0) return 0;
    const list = JsonBackend.readJsonAccounts();
    if (!list || list.length === 0) return 0;
    let n = 0;
    for (const a of list) {
      const key = a.username.toLowerCase();
      if (this.accounts.has(key)) continue;
      this.accounts.set(key, a);
      await this.backend.upsertAccount(a);
      n++;
    }
    console.log(`Migrated ${n} account(s) from data/accounts.json to PostgreSQL.`);
    return n;
  }

  // ---- synchronous cache reads (what the game engine uses) ----
  getAccount(lowerUsername) { return this.accounts.get(lowerUsername); }
  listAccounts() { return [...this.accounts.values()]; }
  getSession(token) { return this.sessions.get(token); }

  // ---- write-through mutations (never reject; failures are logged) ----
  // The SAME object reference stays in the cache, so in-place mutations by
  // the game engine (e.g. balance updates) can't diverge from the cache.
  saveAccount(acct) {
    if (!acct || typeof acct.username !== 'string') return Promise.resolve();
    acct.balance = Math.max(0, Math.floor(acct.balance) || 0);
    this.accounts.set(acct.username.toLowerCase(), acct);
    return this.backend
      .upsertAccount(acct)
      .catch((e) => console.error('store.saveAccount failed:', e.message));
  }

  deleteAccount(lowerUsername) {
    this.accounts.delete(lowerUsername);
    return this.backend
      .deleteAccount(lowerUsername)
      .catch((e) => console.error('store.deleteAccount failed:', e.message));
  }

  createSession(token, sess) {
    this.sessions.set(token, sess);
    return this.backend
      .upsertSession(token, sess)
      .catch((e) => console.error('store.createSession failed:', e.message));
  }

  deleteSession(token) {
    this.sessions.delete(token);
    return this.backend
      .deleteSession(token)
      .catch((e) => console.error('store.deleteSession failed:', e.message));
  }

  async persist() {
    try {
      await this.backend.persistAll(this.accounts);
    } catch (e) {
      console.error('store.persist failed:', e.message);
    }
  }
}

function createStore() {
  const backend = process.env.DATABASE_URL
    ? new PgBackend(process.env.DATABASE_URL)
    : new JsonBackend();
  return new Store(backend);
}

module.exports = { createStore, Store, JsonBackend, PgBackend };
