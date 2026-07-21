const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { GameManager, DISCONNECT_FORFEIT_MS } = require('./src/gameManager');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const games = new GameManager();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({ ok: true, activeGames: games.games.size }));

setInterval(() => games.sweepStaleGames(), 60 * 1000).unref();

function broadcastState(game) {
  io.to(game.code).emit('state', games.publicState(game));
}

function seatSocket(socket, game, color) {
  socket.data.token = game.players[color].token;
  socket.data.roomCode = game.code;
  socket.data.color = color;
  socket.join(game.code);
  games.markConnected(game, color, socket.id);
}

io.on('connection', (socket) => {
  socket.on('create_game', ({ name } = {}, ack) => {
    const game = games.createGame();
    const seat = games.seatPlayer(game, { name, preferredColor: 'white' });
    seatSocket(socket, game, seat.color);
    ack?.({ ok: true, roomCode: game.code, token: seat.token, color: seat.color });
    broadcastState(game);
  });

  socket.on('join_game', ({ roomCode, name } = {}, ack) => {
    const code = String(roomCode || '').trim().toUpperCase();
    const game = games.getGame(code);
    if (!game) {
      ack?.({ ok: false, error: 'Game not found. Check the code and try again.' });
      return;
    }
    if (game.players.white && game.players.black) {
      ack?.({ ok: false, error: 'This game already has two players.' });
      return;
    }
    const seat = games.seatPlayer(game, { name });
    if (!seat) {
      ack?.({ ok: false, error: 'This game already has two players.' });
      return;
    }
    seatSocket(socket, game, seat.color);
    ack?.({ ok: true, roomCode: game.code, token: seat.token, color: seat.color });
    broadcastState(game);
  });

  socket.on('rejoin_game', ({ token } = {}, ack) => {
    const resolved = games.resolveToken(token);
    if (!resolved) {
      ack?.({ ok: false, error: 'Session expired.' });
      return;
    }
    const { game, color } = resolved;
    seatSocket(socket, game, color);
    ack?.({ ok: true, roomCode: game.code, token, color });
    broadcastState(game);
  });

  socket.on('request_moves', ({ square } = {}, ack) => {
    const { roomCode } = socket.data;
    const game = roomCode && games.getGame(roomCode);
    if (!game) {
      ack?.({ ok: false, error: 'Not in a game.' });
      return;
    }
    ack?.({ ok: true, moves: games.legalMoves(game, square) });
  });

  socket.on('move', (move = {}, ack) => {
    const { roomCode, color } = socket.data;
    const game = roomCode && games.getGame(roomCode);
    if (!game || !color) {
      ack?.({ ok: false, error: 'Not in a game.' });
      return;
    }
    const outcome = games.applyMove(game, color, move);
    if (!outcome.ok) {
      ack?.({ ok: false, error: outcome.error });
      return;
    }
    ack?.({ ok: true });
    broadcastState(game);
  });

  socket.on('resign', (_payload, ack) => {
    const { roomCode, color } = socket.data;
    const game = roomCode && games.getGame(roomCode);
    if (!game || !color) return ack?.({ ok: false, error: 'Not in a game.' });
    const outcome = games.resign(game, color);
    ack?.(outcome);
    if (outcome.ok) broadcastState(game);
  });

  socket.on('offer_draw', (_payload, ack) => {
    const { roomCode, color } = socket.data;
    const game = roomCode && games.getGame(roomCode);
    if (!game || !color) return ack?.({ ok: false, error: 'Not in a game.' });
    const outcome = games.offerDraw(game, color);
    ack?.(outcome);
    if (outcome.ok) broadcastState(game);
  });

  socket.on('respond_draw', ({ accept } = {}, ack) => {
    const { roomCode, color } = socket.data;
    const game = roomCode && games.getGame(roomCode);
    if (!game || !color) return ack?.({ ok: false, error: 'Not in a game.' });
    const outcome = games.respondDraw(game, color, !!accept);
    ack?.(outcome);
    if (outcome.ok) broadcastState(game);
  });

  socket.on('request_rematch', (_payload, ack) => {
    const { roomCode, color } = socket.data;
    const game = roomCode && games.getGame(roomCode);
    if (!game || !color) return ack?.({ ok: false, error: 'Not in a game.' });
    const outcome = games.requestRematch(game, color);
    ack?.(outcome);
    broadcastState(game);
  });

  socket.on('disconnect', () => {
    const { roomCode, color } = socket.data;
    const game = roomCode && games.getGame(roomCode);
    if (!game || !color) return;
    games.markDisconnected(game, color);
    broadcastState(game);

    setTimeout(() => {
      const player = game.players[color];
      if (!player || player.connected) return;
      if (game.status === 'active' && player.disconnectedAt) {
        game.status = 'over';
        game.result = { reason: 'disconnect', winner: games.opponentColor(color) };
        broadcastState(game);
      }
    }, DISCONNECT_FORFEIT_MS);
  });
});

server.listen(PORT, () => {
  console.log(`Chess server listening on http://localhost:${PORT}`);
});
