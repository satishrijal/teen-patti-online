# 🎴 Teen Patti Online

Real-time multiplayer Teen Patti (the classic 3-card Indian card game) that you host yourself.
Create a private room, share the 6-character room code, and play with up to 10 friends —
right in the browser, no app install needed.

**Virtual chips only.** There is no real-money wagering, purchasing, or cash-out anywhere
in this game — balances are just for fun and can be refilled for free.

## How it plays

- **Rooms & lobby** — the host creates a room and gets a code (e.g. `XK7Q2P`).
  Friends join with the code + a unique name. Lobby shows everyone, ready status,
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
- **Table feel** — green felt oval table, avatars, chip stacks, pot in the center,
  card-dealing + chip-fly animations, turn glow with a 30-second countdown ring
  (auto-pack on timeout), betting feed, and WebAudio sound effects (mutable).
- **Resilience** — if you disconnect, your seat and hand are held for 2 minutes;
  reopen the link and you rejoin automatically. Host migrates if the host drops.
- **After a round** — winning cards + hand ranking (Trail, Pure Sequence, Sequence,
  Flush, Pair, High Card) are revealed, then **Play Again** sends everyone back
  to the lobby with balances kept. Broke players can refill 1000 chips free.

## Run it locally

Requires **Node.js 18+**.

```bash
npm install
npm start
```

Open http://localhost:3000 — create a room, then open the same URL in another
browser window (or on your phone via your computer's LAN IP) and join with the code.

## Deploy to Render (free tier) — step by step

1. **Put the code on GitHub**
   - Create a new repository on github.com (e.g. `teen-patti-online`).
   - Upload these files/folders: `server.js`, `package.json`, `public/`, `README.md`.
     (Easiest: drag-and-drop on github.com, or `git push` from your machine.)

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

3. **Launch** — click **Create Web Service**, wait for the deploy to finish
   (a minute or two), then open your service URL, e.g.
   `https://teen-patti-online.onrender.com`.

> **Free-tier note:** Render spins free services down after inactivity, so the
> first visit after a while can take ~30–60 seconds to wake up. Rooms live in
> server memory, so a restart clears active rooms (players just create a new one).

## How friends join

1. You open your Render URL and tap **Create Room**.
2. Share the 6-character room code (there's a 📋 Copy button in the lobby).
3. Friends open the same URL on their phones, tap **Join Room**, enter the code + name.
4. Everyone taps **I'm Ready ✓**, host taps **▶ Start Game**. That's it!

## Project layout

```
server.js          # game server: rooms, betting engine, hand evaluator, WebSocket protocol
package.json       # deps (ws), start script, Node engine
public/
  index.html       # single-page app shell
  style.css        # felt-table theme, cards, animations, mobile layout
  client.js        # UI, seat layout, sounds (WebAudio), countdown, modals
```

## WebSocket protocol (for the curious)

Client → server: `create_room`, `join_room` (with optional `token` for reconnect),
`toggle_ready`, `start_game`, `bet` (`blind`/`blind2`/`chaal`/`chaal2`),
`see_cards`, `pack`, `sideshow`, `sideshow_response`, `show`,
`play_again`, `refill`, `remove_player`, `leave`.

Server → client: `state` (personalized snapshot — your cards only, never others'),
`sideshow_request`, `error`, `kicked`.

## Known simplifications

- No side pots: a short-stacked all-in stays eligible for the whole pot (casual tables play this way).
- A blind player must See Cards before demanding a show.
- Side shows are only between two seen players.
