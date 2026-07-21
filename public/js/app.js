(() => {
  'use strict';

  const PIECE_GLYPH = {
    p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚',
    P: '♙', N: '♘', B: '♗', R: '♖', Q: '♕', K: '♔',
  };
  const PROMO_ORDER = ['q', 'r', 'b', 'n'];
  const SESSION_KEY = 'chess_session_v1';

  const el = (id) => document.getElementById(id);
  const screens = {
    home: el('screen-home'),
    lobby: el('screen-lobby'),
    game: el('screen-game'),
  };

  function showScreen(name) {
    Object.values(screens).forEach((s) => s.classList.remove('active'));
    screens[name].classList.add('active');
  }

  let toastTimer = null;
  function toast(message, ms = 2600) {
    const t = el('toast');
    t.textContent = message;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  const socket = io({ transports: ['websocket', 'polling'] });

  const session = {
    roomCode: null,
    token: null,
    color: null,
  };
  let gameState = null;
  let selectedSquare = null;
  let legalDestinations = new Map(); // destSquare -> [{promotion, ...}]
  let pendingMove = false;

  function saveSession() {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch (_) { /* storage unavailable, ignore */ }
  }
  function clearSession() {
    session.roomCode = null;
    session.token = null;
    session.color = null;
    try { localStorage.removeItem(SESSION_KEY); } catch (_) { /* ignore */ }
  }
  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  // ---------- Board rendering ----------

  function parseFenBoard(fen) {
    const rows = fen.split(' ')[0].split('/');
    return rows.map((row) => {
      const cells = [];
      for (const ch of row) {
        if (/\d/.test(ch)) {
          for (let i = 0; i < Number(ch); i++) cells.push(null);
        } else {
          cells.push(ch);
        }
      }
      return cells;
    });
  }

  function squareName(rankIdx, fileIdx) {
    return String.fromCharCode(97 + fileIdx) + (8 - rankIdx);
  }

  function findKingSquare(board, color) {
    const target = color === 'white' ? 'K' : 'k';
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        if (board[r][f] === target) return squareName(r, f);
      }
    }
    return null;
  }

  function renderBoard() {
    const boardEl = el('board');
    boardEl.innerHTML = '';
    if (!gameState) return;

    const board = parseFenBoard(gameState.fen);
    const orientation = session.color === 'black' ? 'black' : 'white';
    const lastMove = gameState.history[gameState.history.length - 1];
    const checkedKingSquare = gameState.inCheck ? findKingSquare(board, gameState.turn) : null;

    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        let rankIdx, fileIdx;
        if (orientation === 'white') {
          rankIdx = r; fileIdx = c;
        } else {
          rankIdx = 7 - r; fileIdx = 7 - c;
        }
        const name = squareName(rankIdx, fileIdx);
        const piece = board[rankIdx][fileIdx];
        const isLight = (rankIdx + fileIdx) % 2 === 0;

        const sq = document.createElement('div');
        sq.className = `square ${isLight ? 'light' : 'dark'}`;
        sq.dataset.square = name;

        if (selectedSquare === name) sq.classList.add('selected');
        if (lastMove && (lastMove.from === name || lastMove.to === name)) sq.classList.add('last-move');
        if (checkedKingSquare === name) sq.classList.add('in-check');

        if (piece) {
          const span = document.createElement('span');
          span.className = `piece ${piece === piece.toUpperCase() ? 'white' : 'black'}`;
          span.textContent = PIECE_GLYPH[piece];
          sq.appendChild(span);
        }

        if (legalDestinations.has(name)) {
          const marker = document.createElement('div');
          marker.className = piece ? 'capture-ring' : 'move-dot';
          sq.appendChild(marker);
        }

        if (c === 0) {
          const rankLabel = document.createElement('span');
          rankLabel.className = 'coord rank';
          rankLabel.textContent = 8 - rankIdx;
          sq.appendChild(rankLabel);
        }
        if (r === 7) {
          const fileLabel = document.createElement('span');
          fileLabel.className = 'coord file';
          fileLabel.textContent = String.fromCharCode(97 + fileIdx);
          sq.appendChild(fileLabel);
        }

        sq.addEventListener('click', () => onSquareTap(name));
        boardEl.appendChild(sq);
      }
    }
  }

  function clearSelection() {
    selectedSquare = null;
    legalDestinations = new Map();
    renderBoard();
  }

  function onSquareTap(name) {
    if (pendingMove) return;
    if (!gameState || gameState.status !== 'active') return;
    if (!session.color || gameState.turn !== session.color) {
      if (selectedSquare) clearSelection();
      return;
    }

    if (legalDestinations.has(name)) {
      const options = legalDestinations.get(name);
      const needsPromotion = options.some((m) => m.promotion);
      if (needsPromotion) {
        showPromoPicker(session.color, (promo) => sendMove(selectedSquare, name, promo));
      } else {
        sendMove(selectedSquare, name);
      }
      return;
    }

    const board = parseFenBoard(gameState.fen);
    const rankIdx = 8 - Number(name[1]);
    const fileIdx = name.charCodeAt(0) - 97;
    const piece = board[rankIdx][fileIdx];
    const isMine = piece && (session.color === 'white' ? piece === piece.toUpperCase() : piece === piece.toLowerCase());

    if (isMine) {
      selectSquare(name);
    } else {
      clearSelection();
    }
  }

  function selectSquare(name) {
    selectedSquare = name;
    legalDestinations = new Map();
    renderBoard();
    socket.emit('request_moves', { square: name }, (res) => {
      if (!res?.ok || selectedSquare !== name) return;
      const map = new Map();
      res.moves.forEach((m) => {
        const list = map.get(m.to) || [];
        list.push(m);
        map.set(m.to, list);
      });
      legalDestinations = map;
      renderBoard();
    });
  }

  function sendMove(from, to, promotion) {
    pendingMove = true;
    socket.emit('move', { from, to, promotion }, (res) => {
      pendingMove = false;
      if (!res?.ok) toast(res?.error || 'Illegal move.');
      clearSelection();
    });
  }

  function showPromoPicker(color, onPick) {
    const picker = el('promo-picker');
    picker.innerHTML = '';
    picker.classList.remove('hidden');
    PROMO_ORDER.forEach((code) => {
      const glyph = color === 'white' ? PROMO_GLYPH_WHITE(code) : PROMO_GLYPH_BLACK(code);
      const div = document.createElement('div');
      div.className = 'promo-piece';
      div.textContent = glyph;
      div.addEventListener('click', () => {
        picker.classList.add('hidden');
        onPick(code);
      });
      picker.appendChild(div);
    });
  }
  function PROMO_GLYPH_WHITE(code) { return PIECE_GLYPH[code.toUpperCase()]; }
  function PROMO_GLYPH_BLACK(code) { return PIECE_GLYPH[code]; }

  // ---------- Status / chrome rendering ----------

  function resultText(result) {
    if (!result) return '';
    const winnerLabel = result.winner ? (result.winner === session.color ? 'You' : 'Opponent') : null;
    switch (result.reason) {
      case 'checkmate': return `Checkmate — ${winnerLabel} won.`;
      case 'resignation': return `${winnerLabel} won by resignation.`;
      case 'disconnect': return `${winnerLabel} won — opponent disconnected.`;
      case 'stalemate': return 'Draw by stalemate.';
      case 'repetition': return 'Draw by threefold repetition.';
      case 'insufficient-material': return 'Draw — insufficient material.';
      case 'fifty-move-rule': return 'Draw by the fifty-move rule.';
      case 'agreement': return 'Draw by agreement.';
      default: return 'Game over.';
    }
  }

  function renderChrome() {
    if (!gameState) return;
    const mine = session.color;
    const oppColor = mine === 'white' ? 'black' : 'white';

    el('room-pill').textContent = `#${gameState.code}`;
    el('name-self').textContent = gameState.players[mine]?.name || 'You';
    el('name-opponent').textContent = gameState.players[oppColor]?.name || 'Opponent';

    el('dot-self').classList.toggle('online', !!gameState.players[mine]?.connected);
    el('dot-opponent').classList.toggle('online', !!gameState.players[oppColor]?.connected);
    el('dot-self').classList.toggle('turn', gameState.status === 'active' && gameState.turn === mine);
    el('dot-opponent').classList.toggle('turn', gameState.status === 'active' && gameState.turn === oppColor);

    const bar = el('status-bar');
    bar.classList.remove('your-turn', 'check');
    if (gameState.status === 'waiting') {
      bar.textContent = 'Waiting for opponent to join…';
    } else if (gameState.status === 'active') {
      const isMyTurn = gameState.turn === mine;
      bar.textContent = isMyTurn ? 'Your move' : `Waiting for ${gameState.players[oppColor]?.name || 'opponent'}…`;
      if (isMyTurn) bar.classList.add('your-turn');
      if (gameState.inCheck) {
        bar.textContent += ' — Check!';
        bar.classList.add('check');
      }
    } else if (gameState.status === 'over') {
      bar.textContent = resultText(gameState.result);
    }

    const drawBanner = el('draw-banner');
    if (gameState.status === 'active' && gameState.drawOfferBy && gameState.drawOfferBy !== mine) {
      drawBanner.classList.remove('hidden');
      el('draw-banner-text').textContent = 'Opponent offered a draw.';
    } else {
      drawBanner.classList.add('hidden');
    }
    el('btn-draw').disabled = gameState.status !== 'active' || gameState.drawOfferBy === mine;
    el('btn-draw').textContent = gameState.drawOfferBy === mine ? 'Draw Offered' : 'Offer Draw';
    el('btn-resign').disabled = gameState.status !== 'active';

    renderHistory();

    if (gameState.status === 'over') {
      el('gameover-title').textContent = gameState.result?.winner === mine ? 'You Won!'
        : gameState.result?.winner === oppColor ? 'You Lost'
        : 'Draw';
      el('gameover-detail').textContent = resultText(gameState.result);
      el('rematch-status').textContent = '';
      el('modal-gameover').classList.remove('hidden');
    } else {
      el('modal-gameover').classList.add('hidden');
    }
  }

  function renderHistory() {
    const list = el('history-list');
    list.innerHTML = '';
    const hist = gameState.history;
    for (let i = 0; i < hist.length; i += 2) {
      const num = i / 2 + 1;
      const white = hist[i];
      const black = hist[i + 1];
      const numEl = document.createElement('li');
      numEl.className = 'move-num';
      numEl.textContent = `${num}.`;
      const whiteEl = document.createElement('li');
      whiteEl.textContent = white ? white.san : '';
      const blackEl = document.createElement('li');
      blackEl.textContent = black ? black.san : '';
      list.appendChild(numEl);
      list.appendChild(whiteEl);
      list.appendChild(blackEl);
    }
    el('panel-history').scrollTop = el('panel-history').scrollHeight;
  }

  socket.on('state', (state) => {
    gameState = state;
    if (state.status === 'waiting') {
      el('lobby-code').textContent = state.code;
      showScreen('lobby');
    } else {
      showScreen('game');
      renderBoard();
      renderChrome();
    }
  });

  socket.on('connect', () => {
    const saved = loadSession();
    if (saved?.token) {
      socket.emit('rejoin_game', { token: saved.token }, (res) => {
        if (res?.ok) {
          session.roomCode = res.roomCode;
          session.token = res.token;
          session.color = res.color;
          saveSession();
          showScreen('game');
        } else {
          clearSession();
        }
      });
    }
  });

  socket.on('disconnect', () => {
    if (screens.game.classList.contains('active')) {
      toast('Connection lost. Trying to reconnect…', 5000);
    }
  });

  // ---------- Home screen actions ----------

  el('btn-create').addEventListener('click', () => {
    const name = el('name-input').value.trim().slice(0, 20);
    el('btn-create').disabled = true;
    socket.emit('create_game', { name }, (res) => {
      el('btn-create').disabled = false;
      if (!res?.ok) {
        el('home-error').textContent = res?.error || 'Could not create game.';
        return;
      }
      session.roomCode = res.roomCode;
      session.token = res.token;
      session.color = res.color;
      saveSession();
      el('lobby-code').textContent = res.roomCode;
      showScreen('lobby');
    });
  });

  el('btn-join').addEventListener('click', () => {
    const code = el('code-input').value.trim().toUpperCase();
    const name = el('name-input').value.trim().slice(0, 20);
    if (!code) {
      el('home-error').textContent = 'Enter a game code.';
      return;
    }
    el('btn-join').disabled = true;
    socket.emit('join_game', { roomCode: code, name }, (res) => {
      el('btn-join').disabled = false;
      if (!res?.ok) {
        el('home-error').textContent = res?.error || 'Could not join game.';
        return;
      }
      session.roomCode = res.roomCode;
      session.token = res.token;
      session.color = res.color;
      saveSession();
      showScreen('game');
    });
  });

  el('code-input').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  // ---------- Lobby actions ----------

  el('btn-copy-link').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}?code=${session.roomCode}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Invite link copied!');
    } catch (_) {
      toast(url, 5000);
    }
  });

  el('btn-cancel-lobby').addEventListener('click', () => {
    clearSession();
    location.reload();
  });

  // ---------- Game screen actions ----------

  el('btn-resign').addEventListener('click', () => {
    if (!confirm('Resign this game?')) return;
    socket.emit('resign', {}, (res) => {
      if (!res?.ok) toast(res?.error || 'Could not resign.');
    });
  });

  el('btn-draw').addEventListener('click', () => {
    socket.emit('offer_draw', {}, (res) => {
      if (!res?.ok) toast(res?.error || 'Could not offer draw.');
    });
  });

  el('btn-draw-accept').addEventListener('click', () => {
    socket.emit('respond_draw', { accept: true });
  });
  el('btn-draw-decline').addEventListener('click', () => {
    socket.emit('respond_draw', { accept: false });
  });

  el('btn-history').addEventListener('click', () => el('panel-history').classList.remove('hidden'));
  el('btn-history-close').addEventListener('click', () => el('panel-history').classList.add('hidden'));

  el('btn-menu').addEventListener('click', () => {
    if (confirm('Leave this game?')) {
      clearSession();
      location.href = location.pathname;
    }
  });

  el('btn-rematch').addEventListener('click', () => {
    el('rematch-status').textContent = 'Waiting for opponent to accept…';
    socket.emit('request_rematch', {}, (res) => {
      if (!res?.ok) toast(res?.error || 'Could not request rematch.');
    });
  });

  el('btn-leave').addEventListener('click', () => {
    clearSession();
    location.href = location.pathname;
  });

  // ---------- Bootstrapping ----------

  (function init() {
    const params = new URLSearchParams(location.search);
    const codeParam = params.get('code');
    if (codeParam) el('code-input').value = codeParam.toUpperCase();

    const saved = loadSession();
    if (!saved?.token) {
      showScreen('home');
    }
    // If a saved session exists, we wait for the 'connect' handler to attempt rejoin.
  })();
})();
