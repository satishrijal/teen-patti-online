# 🎴 Teen Patti Online

Real-time multiplayer Teen Patti (the classic 3-card Indian card game) that you host yourself.
Players log in with accounts you create, you load virtual chips onto them from an
admin panel, and everyone plays at private tables with room codes — right in the
browser, no app install needed.

**Virtual chips only.** There is no real-money wagering, purchasing, or cash-out anywhere
in this game — balances are just for fun and only the admin can load chips.

## Accounts & login (new)

- The **admin** (you) creates a username + password for each friend in the admin panel.
- Players open the game URL, log in, and their chip balance follows their account.
- New accounts start with **0 chips** — you load chips onto them from the admin panel.
- Chips won/lost at the table are written back to the account after every round,
  so balances persist across game nights.
- There is no self-registration and no free refill button: **you are the banker.**
- Login sessions last 7 days. 5 wrong passwords → 60-second lockout for that username.

## Admin backend

Open **`https://your-app-url/admin`** (or `http://localhost:3000/admin` locally)
and log in with the admin account. From there you can:

- 👥 See every account with its chip balance and status
- ➕ Create new player accounts (username + password)
- 🪙 **Add chips** to anyone, or **set** an exact balance (updates their seat live,
  even mid-lobby)
- 🔑 Reset anyone's password
- ⛔ Disable / re-enable accounts (disabled players are logged out immediately)
- 🗑️ Delete accounts

### Admin credentials

On first run the server creates the admin account from environment variables:

| Variable     | Default        |
|--------------|----------------|
| `ADMIN_USER` | `admin`        |
| `ADMIN_PASS` | `changeme123`  |

If you leave the default password, the server prints a loud warning on startup.
**Change it:** on Render, go to Dashboard → your service → **Environment**,
add `ADMIN_USER` and `ADMIN_PASS`, and redeploy. Locally, just set them before
`npm start`:

```bash
ADMIN_USER=satish ADMIN_PASS='pick-something-strong' npm start
```

> ⚠️ **Where accounts live:** accounts are stored in `data/accounts.json` on the
> server's disk. On **Render's free tier the disk is ephemeral** — if the service
> restarts or you redeploy, accounts and balances reset and you'll recreate them.
> (Your friends' chips are safe on your own computer when running locally.)
> The future upgrade path is a Postgres database; for now, re-creating a handful
> of friend accounts after a redeploy takes a minute.

## How it plays

- **Rooms & lobby** — log in, create a room, and get a code (e.g. `XK7Q2P`).
  Friends log in and join with the code. Lobby shows everyone, ready status,
  and 👑 host badge. Host starts when 2+ players are ready.
- **Traditional rules** — 3 face-down cards each, everyone starts **BLIND**.
  Tap **See Cards** any time to peek privately. Blind bets 1× the stake,
  seen players must **Chaal** 2×. Blind may double the blind.
- **Actions** — Blind Bet, Chaal, See Cards, Pack/Fold, **Side Show**
  (seen vs. the previous seen player, accepted/declined privately),
  and **Show** (showdown when 2 players remain; blind players must see cards first).
- **Fairness** — the deck is shuffled server-side (Fisher–Yates with cryptographic
  randomness) and hands are evaluated server-side. Clients **never** receive other
  players' cards; every action is validated for turn order, amounts, and eligibility.
  Passwords are salted scrypt hashes that never leave the server.
- **Table feel** — green felt oval table, avatars, chip stacks, pot in the center,
  card-dealing + chip-fly animations, turn glow with a 30-second countdown ring
  (auto-pack on timeout), betting feed, and WebAudio sound effects (mutable).
- **Resilience** — if you disconnect, your seat and hand are held for 2 minutes;
  reopen the link and you rejoin automatically (login session + room seat both
  restore). Host migrates if the host drops.
- **After a round** — winning cards + hand ranking (Trail, Pure Sequence, Sequence,
  Flush, Pair, High Card) are revealed, then **Play Again** sends everyone back
  to the lobby with balances kept. Out of chips? Ask the admin to load more.

## Run it locally

Requires **Node.js 18+**.

```bash
npm install
npm start
```

Open http://localhost:3000 — log in as `admin` / `changeme123` (change it!),
create player accounts at http://localhost:3000/admin, load them with chips,
then log in as a player and create a room. Open a second browser window,
log in as another player, and join with the code.

## Deploy to Render (free tier) — step by step

1. **Put the code on GitHub**
   - Create a new repository on github.com (e.g. `teen-patti-online`).
   - Upload these files/folders: `server.js`, `package.json`, `public/`, `README.md`.
     (Easiest: drag-and-drop on github.com, or `git push` from your machine.)
   - Do **not** upload `data/` or `node_modules/`.

2. **Create the Web Service**
   - Go to [dashboard.render.com](https://dashboard.render.com) → **New +** → **Web Service**.
   - Connect your GitHub repo.
   - Settings:
     - **Name:** `teen-patti-online` (or anything)
     - **Runtime:** `Node`
     - **Build Command:** `npm install`
     - **Start Command:** `npm start`
     - **Plan:** Free
   - Render sets the `PORT` env var automatically — the server already honors it.

3. **Set your admin credentials** — Dashboard → your service → **Environment** →
   add `ADMIN_USER` and `ADMIN_PASS`, then redeploy (or set them before the
   first deploy).

4. **Launch** — click **Create Web Service**, wait for the deploy to finish
   (a minute or two), then open your service URL, e.g.
   `https://teen-patti-online.onrender.com`.

> **Free-tier notes:** Render spins free services down after inactivity, so the
> first visit after a while can take ~30–60 seconds to wake up. Rooms live in
> server memory, so a restart clears active rooms (players just create a new one).
> Accounts live in `data/` on disk, which is also wiped on restart/redeploy —
> see the warning above.

## Game night flow

1. You open `/admin`, create an account for each friend, and load them with chips
   (e.g. 10,000 each — go big, it's play money).
2. Share the game URL + each friend's username/password privately.
3. Friends log in on their phones. You create a room, share the 6-letter code
   (📋 Copy button in the lobby), they join.
4. Everyone taps **I'm Ready ✓**, you tap **▶ Start Game**. That's it!
5. Someone goes bust mid-night? Load them more chips from `/admin` — their
   balance updates live, even while they're sitting in the lobby.

## Project layout

```
server.js          # game server: accounts/auth, admin backend, rooms, betting
                   # engine, hand evaluator, WebSocket protocol
package.json       # deps (ws), start script, Node engine
data/              # auto-created: accounts.json (never commit real data)
public/
  index.html       # single-page app shell (login -> home -> lobby -> table)
  style.css        # felt-table theme, cards, animations, mobile layout
  client.js        # UI, seat layout, sounds (WebAudio), countdown, modals
  admin.html       # admin backend panel (served at /admin)
```

## WebSocket protocol (for the curious)

Client → server: `login`, `auth` (session token), `logout`, `create_room`,
`join_room` (with optional `token` for reconnect), `toggle_ready`, `start_game`,
`bet` (`blind`/`blind2`/`chaal`/`chaal2`), `see_cards`, `pack`, `sideshow`,
`sideshow_response`, `show`, `play_again`, `remove_player`, `leave`,
plus admin-only: `admin_list_users`, `admin_create_user`, `admin_reset_password`,
`admin_add_chips`, `admin_set_balance`, `admin_set_disabled`, `admin_delete_user`.

Server → client: `auth_ok`, `auth_fail`, `logged_out`, `state` (personalized
snapshot — your cards only, never others'), `sideshow_request`, `admin_users`,
`admin_error`, `error`, `kicked`.

## Known simplifications

- No side pots: a short-stacked all-in stays eligible for the whole pot (casual tables play this way).
- A blind player must See Cards before demanding a show.
- Side shows are only between two seen players.
- Accounts live in a JSON file on disk (see the Render ephemerality note above).
- One account = one seat per room; playing the same account in two rooms at once
  can make the last-written balance win.
