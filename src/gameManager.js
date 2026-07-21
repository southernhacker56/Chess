const { Chess } = require('chess.js');
const { customAlphabet } = require('nanoid');

const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const makeRoomCode = customAlphabet(ROOM_CODE_ALPHABET, 5);
const makeToken = customAlphabet(
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  24
);

const DISCONNECT_FORFEIT_MS = 2 * 60 * 1000;

class GameManager {
  constructor() {
    /** @type {Map<string, Game>} */
    this.games = new Map();
    /** @type {Map<string, {roomCode: string, color: string}>} */
    this.tokens = new Map();
  }

  createGame() {
    let code;
    do {
      code = makeRoomCode();
    } while (this.games.has(code));

    const game = {
      code,
      chess: new Chess(),
      players: { white: null, black: null },
      status: 'waiting', // waiting | active | over
      result: null, // { reason, winner }
      drawOfferBy: null,
      rematchOffer: { white: false, black: false },
      createdAt: Date.now(),
    };
    this.games.set(code, game);
    return game;
  }

  getGame(code) {
    return this.games.get(code);
  }

  /** Registers a brand-new player (creator or joiner) and returns their seat info. */
  seatPlayer(game, { name, preferredColor } = {}) {
    let color;
    if (preferredColor && !game.players[preferredColor]) {
      color = preferredColor;
    } else if (!game.players.white) {
      color = 'white';
    } else if (!game.players.black) {
      color = 'black';
    } else {
      return null; // game full
    }

    const token = makeToken();
    game.players[color] = {
      token,
      name: name || (color === 'white' ? 'White' : 'Black'),
      socketId: null,
      connected: false,
      disconnectedAt: null,
    };
    this.tokens.set(token, { roomCode: game.code, color });

    if (game.players.white && game.players.black) {
      game.status = 'active';
    }

    return { token, color };
  }

  resolveToken(token) {
    const entry = this.tokens.get(token);
    if (!entry) return null;
    const game = this.games.get(entry.roomCode);
    if (!game) return null;
    return { game, color: entry.color, player: game.players[entry.color] };
  }

  markConnected(game, color, socketId) {
    const player = game.players[color];
    if (!player) return;
    player.socketId = socketId;
    player.connected = true;
    player.disconnectedAt = null;
  }

  markDisconnected(game, color) {
    const player = game.players[color];
    if (!player) return;
    player.connected = false;
    player.disconnectedAt = Date.now();
    player.socketId = null;
  }

  opponentColor(color) {
    return color === 'white' ? 'black' : 'white';
  }

  applyMove(game, color, move) {
    if (game.status !== 'active') {
      return { ok: false, error: 'Game is not active.' };
    }
    if (game.chess.turn() !== color[0]) {
      return { ok: false, error: 'Not your turn.' };
    }
    let result;
    try {
      result = game.chess.move({
        from: move.from,
        to: move.to,
        promotion: move.promotion || 'q',
      });
    } catch (err) {
      return { ok: false, error: 'Illegal move.' };
    }
    if (!result) {
      return { ok: false, error: 'Illegal move.' };
    }

    game.drawOfferBy = null;

    if (game.chess.isGameOver()) {
      game.status = 'over';
      game.result = this.deriveGameOverResult(game);
    }

    return { ok: true, move: result };
  }

  deriveGameOverResult(game) {
    const chess = game.chess;
    if (chess.isCheckmate()) {
      const winner = chess.turn() === 'w' ? 'black' : 'white';
      return { reason: 'checkmate', winner };
    }
    if (chess.isStalemate()) {
      return { reason: 'stalemate', winner: null };
    }
    if (chess.isThreefoldRepetition()) {
      return { reason: 'repetition', winner: null };
    }
    if (chess.isInsufficientMaterial()) {
      return { reason: 'insufficient-material', winner: null };
    }
    if (chess.isDraw()) {
      return { reason: 'fifty-move-rule', winner: null };
    }
    return { reason: 'draw', winner: null };
  }

  resign(game, color) {
    if (game.status !== 'active') return { ok: false, error: 'Game is not active.' };
    game.status = 'over';
    game.result = { reason: 'resignation', winner: this.opponentColor(color) };
    return { ok: true };
  }

  offerDraw(game, color) {
    if (game.status !== 'active') return { ok: false, error: 'Game is not active.' };
    game.drawOfferBy = color;
    return { ok: true };
  }

  respondDraw(game, color, accept) {
    if (game.status !== 'active' || !game.drawOfferBy) {
      return { ok: false, error: 'No draw offer pending.' };
    }
    if (game.drawOfferBy === color) {
      return { ok: false, error: 'Cannot respond to your own offer.' };
    }
    if (accept) {
      game.status = 'over';
      game.result = { reason: 'agreement', winner: null };
    } else {
      game.drawOfferBy = null;
    }
    return { ok: true };
  }

  requestRematch(game, color) {
    game.rematchOffer[color] = true;
    if (game.rematchOffer.white && game.rematchOffer.black) {
      game.chess = new Chess();
      game.status = 'active';
      game.result = null;
      game.drawOfferBy = null;
      game.rematchOffer = { white: false, black: false };
      // swap colors so both players alternate sides
      const white = game.players.white;
      const black = game.players.black;
      game.players.white = black;
      game.players.black = white;
      this.tokens.set(game.players.white.token, { roomCode: game.code, color: 'white' });
      this.tokens.set(game.players.black.token, { roomCode: game.code, color: 'black' });
      return { ok: true, rematchStarted: true };
    }
    return { ok: true, rematchStarted: false };
  }

  publicState(game) {
    return {
      code: game.code,
      fen: game.chess.fen(),
      turn: game.chess.turn() === 'w' ? 'white' : 'black',
      status: game.status,
      result: game.result,
      inCheck: game.chess.isCheck(),
      history: game.chess.history({ verbose: true }).map((m) => ({
        san: m.san,
        from: m.from,
        to: m.to,
        color: m.color,
      })),
      drawOfferBy: game.drawOfferBy,
      players: {
        white: game.players.white
          ? { name: game.players.white.name, connected: game.players.white.connected }
          : null,
        black: game.players.black
          ? { name: game.players.black.name, connected: game.players.black.connected }
          : null,
      },
    };
  }

  legalMoves(game, square) {
    return game.chess.moves({ square, verbose: true }).map((m) => ({
      from: m.from,
      to: m.to,
      promotion: m.promotion,
      captured: !!m.captured,
      san: m.san,
    }));
  }

  /** Removes games abandoned long past the forfeit window to avoid unbounded memory growth. */
  sweepStaleGames() {
    const now = Date.now();
    for (const [code, game] of this.games) {
      const bothGone =
        (!game.players.white || game.players.white.disconnectedAt) &&
        (!game.players.black || game.players.black.disconnectedAt);
      const staleSince = Math.max(
        game.players.white?.disconnectedAt || 0,
        game.players.black?.disconnectedAt || 0,
        game.createdAt
      );
      if (bothGone && now - staleSince > DISCONNECT_FORFEIT_MS * 15) {
        for (const color of ['white', 'black']) {
          const p = game.players[color];
          if (p) this.tokens.delete(p.token);
        }
        this.games.delete(code);
      }
    }
  }
}

module.exports = { GameManager, DISCONNECT_FORFEIT_MS };
