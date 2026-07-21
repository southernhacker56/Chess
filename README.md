# Chess Together

Real-time multiplayer chess. One player creates a game session and shares a
short room code (or invite link); a second player joins from any phone or
browser and the two play live, with every move synced instantly over
WebSockets.

## Features

- **Session-based multiplayer** — create a game, get a 5-character room code
  and shareable link, opponent joins from any device.
- **Real-time sync** via Socket.IO — moves, turn changes, check/checkmate,
  resignation, and draw offers all update instantly on both devices.
- **Server-authoritative rules** — full legal move validation, check,
  checkmate, stalemate, threefold repetition, insufficient material, and the
  fifty-move rule, powered by [chess.js](https://github.com/jhlywa/chess.js).
- **Mobile-first UI** — large tap targets, tap-to-select/tap-to-move (no
  finicky drag-and-drop required), safe-area padding for notches, board
  auto-orients to each player's side.
- **Reconnect support** — if a player's phone loses signal or the browser tab
  is closed, their session token (stored in `localStorage`) lets them rejoin
  the same game in progress. If a player stays disconnected too long, the
  game is forfeited to their opponent.
- **Resign, offer/accept draw, and rematch** (colors swap each rematch).

## Running it

```bash
npm install
npm start
```

The server listens on `http://localhost:3000` (override with `PORT`).

To play a game between two devices:

1. Open the URL on one phone/browser and tap **Create New Game**.
2. Share the 5-character room code (or tap **Copy Invite Link**) with the
   other player.
3. On the second device, open the URL, enter the code, and tap **Join**.
4. Play — tap a piece to see its legal moves highlighted, tap a highlighted
   square to move.

For two devices on the same Wi-Fi network to reach a server running on your
laptop, start the server, find your machine's LAN IP (e.g. `192.168.1.23`),
and open `http://192.168.1.23:3000` on both phones instead of `localhost`.

## Deploying so it's reachable from anywhere

The app is a normal long-running Node process with WebSockets, so it needs a
host that keeps a persistent server running (not a static-site or serverless
host). [Render](https://render.com) has a free tier that works well:

1. Push this repo to GitHub (already done if you're reading this there).
2. Go to [dashboard.render.com](https://dashboard.render.com) → **New** →
   **Blueprint**, and point it at this repo. Render will read `render.yaml`
   at the repo root and configure the service automatically (build:
   `npm install`, start: `npm start`).
3. Click **Apply** / **Deploy**. Render assigns a public URL like
   `https://chess-together.onrender.com` — share that with the other player
   instead of `localhost`.

Any other host that runs a persistent Node process (Railway, Fly.io, a VPS)
works the same way: `npm install && npm start`, and make sure it sets a
`PORT` env var (most do automatically) since `server.js` reads
`process.env.PORT`.

Note: Render's free tier spins the service down after periods of inactivity
and takes ~30-60s to wake back up on the next request — fine for casual
games, but worth knowing if the first load feels slow.

## Project layout

```
server.js            Express app + Socket.IO event handlers
src/gameManager.js    Game session/room state, chess.js integration, rules
public/index.html     App shell (home / lobby / game screens)
public/css/style.css  Mobile-first styling, light & dark theme
public/js/app.js      Client: board rendering, tap-to-move, socket wiring
```
