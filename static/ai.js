(() => {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Difficulty levels
   * ------------------------------------------------------------------ *
   * `randomness` is a centipawn window: the engine picks at random among all
   * root moves within that window of the best score. It is what makes low
   * levels feel like a beatable opponent instead of a weaker-but-still-perfect
   * machine, and it is why level 1 will happily hang a piece.
   */
  const LEVELS = [
    { id: 1, label: 'Stufe 1 – Anfänger',      maxDepth: 1, maxTimeMs:  200, randomness: 150, skill:  0 },
    { id: 2, label: 'Stufe 2 – Sehr leicht',   maxDepth: 2, maxTimeMs:  350, randomness:  90, skill:  2 },
    { id: 3, label: 'Stufe 3 – Leicht',        maxDepth: 2, maxTimeMs:  600, randomness:  40, skill:  4 },
    { id: 4, label: 'Stufe 4 – Mittel',        maxDepth: 3, maxTimeMs: 1000, randomness:  12, skill:  7 },
    { id: 5, label: 'Stufe 5 – Fortgeschritten',maxDepth: 4, maxTimeMs: 1500, randomness:  0, skill: 10 },
    { id: 6, label: 'Stufe 6 – Stark',         maxDepth: 5, maxTimeMs: 2500, randomness:  0, skill: 14 },
    { id: 7, label: 'Stufe 7 – Sehr stark',    maxDepth: 6, maxTimeMs: 4000, randomness:  0, skill: 17 },
    { id: 8, label: 'Stufe 8 – Maximum',       maxDepth: 8, maxTimeMs: 6000, randomness:  0, skill: 20 }
  ];

  const MODES = {
    HUMAN: 'human-vs-human',
    COMPUTER: 'human-vs-computer'
  };

  const DEFAULTS = {
    mode: MODES.HUMAN,
    level: 4,
    humanColor: 'white',
    backend: 'builtin'
  };

  function findLevel(id) {
    return LEVELS.find(l => l.id === Number(id)) || LEVELS[3];
  }

  /* ------------------------------------------------------------------ *
   * Notation helpers (shared by both backends)
   * ------------------------------------------------------------------ */

  const FILES = 'abcdefgh';

  function toUci(move) {
    const from = FILES[move.from[1]] + (8 - move.from[0]);
    const to = FILES[move.to[1]] + (8 - move.to[0]);
    const promo = move.promotion ? move.promotion.toLowerCase() : '';
    return from + to + promo;
  }

  function parseUciSquare(text) {
    return [8 - Number(text[1]), FILES.indexOf(text[0])];
  }

  /** Builds a FEN string; required by Stockfish, unused by the built-in engine. */
  function toFen(state) {
    let fen = '';
    for (let r = 0; r < 8; r++) {
      let empty = 0;
      for (let c = 0; c < 8; c++) {
        const piece = state.board[r][c];
        if (!piece) { empty++; continue; }
        if (empty) { fen += empty; empty = 0; }
        fen += piece;
      }
      if (empty) fen += empty;
      if (r < 7) fen += '/';
    }

    const castling = ['K', 'Q', 'k', 'q'].filter(k => state.castling[k]).join('') || '-';
    const ep = state.ep ? FILES[state.ep[1]] + (8 - state.ep[0]) : '-';
    return `${fen} ${state.turn === 'white' ? 'w' : 'b'} ${castling} ${ep} ${state.halfmove} ${state.fullmove}`;
  }

  /* ------------------------------------------------------------------ *
   * Backends
   * ------------------------------------------------------------------ */

  /** The bundled search worker. Always available, no download required. */
  function createBuiltinBackend() {
    let worker = null;
    let nextId = 1;
    const pending = new Map();

    function ensureWorker() {
      if (worker) return worker;
      worker = new Worker('/static/ai-worker.js');
      worker.onmessage = event => {
        const { type, id, result, message } = event.data || {};
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        if (type === 'result') entry.resolve(result);
        else entry.reject(new Error(message || 'Suche fehlgeschlagen'));
      };
      worker.onerror = error => {
        // A worker that dies must not leave callers hanging forever.
        for (const entry of pending.values()) entry.reject(error);
        pending.clear();
        worker = null;
      };
      return worker;
    }

    return {
      name: 'builtin',
      async bestMove(state, level) {
        const target = ensureWorker();
        const id = nextId++;
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          target.postMessage({
            type: 'search',
            id,
            state,
            options: { maxDepth: level.maxDepth, maxTimeMs: level.maxTimeMs, randomness: level.randomness }
          });
        });
      },
      dispose() {
        if (worker) { worker.terminate(); worker = null; }
        pending.clear();
      }
    };
  }

  /**
   * Stockfish over the standard UCI protocol.
   *
   * Not bundled: the engine binary is several megabytes and carries its own
   * licence (GPL), so it is loaded only if the user drops `stockfish.js` into
   * /static/ themselves. Everything needed to drive it is implemented here.
   */
  function createStockfishBackend() {
    let engine = null;
    let ready = null;

    function send(command) {
      engine.postMessage(command);
    }

    function init() {
      if (ready) return ready;
      ready = new Promise((resolve, reject) => {
        try {
          engine = new Worker('/static/stockfish.js');
        } catch (error) {
          reject(new Error('stockfish.js konnte nicht geladen werden'));
          return;
        }

        const timeout = setTimeout(() => reject(new Error('Stockfish antwortet nicht')), 10000);
        engine.onmessage = event => {
          const line = typeof event.data === 'string' ? event.data : '';
          if (line.startsWith('uciok')) {
            clearTimeout(timeout);
            resolve();
          }
        };
        engine.onerror = () => {
          clearTimeout(timeout);
          reject(new Error('stockfish.js konnte nicht gestartet werden'));
        };
        send('uci');
      });
      return ready;
    }

    return {
      name: 'stockfish',
      async bestMove(state, level) {
        await init();
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Stockfish hat nicht geantwortet')), level.maxTimeMs + 8000);

          engine.onmessage = event => {
            const line = typeof event.data === 'string' ? event.data : '';
            if (!line.startsWith('bestmove')) return;
            clearTimeout(timeout);

            const token = line.split(/\s+/)[1];
            if (!token || token === '(none)') { resolve(null); return; }

            resolve({
              uci: token,
              from: parseUciSquare(token.slice(0, 2)),
              to: parseUciSquare(token.slice(2, 4)),
              promotion: token[4] || null
            });
          };

          send('ucinewgame');
          send(`setoption name Skill Level value ${level.skill}`);
          send(`position fen ${toFen(state)}`);
          send(`go movetime ${level.maxTimeMs}`);
        });
      },
      dispose() {
        if (engine) { engine.terminate(); engine = null; ready = null; }
      }
    };
  }

  /**
   * Native engine (Stockfish) driven by the Flask server on this machine.
   *
   * A browser cannot execute a native binary, but the local server can, so the
   * UCI conversation happens server-side and only the resulting move crosses
   * back over HTTP. This gives full native strength, which is substantially
   * above what a WASM build reaches.
   */
  function createServerBackend() {
    return {
      name: 'server',
      async status() {
        const response = await fetch('/api/engine/status');
        if (!response.ok) throw new Error('Server nicht erreichbar');
        return response.json();
      },
      async bestMove(state, level) {
        const response = await fetch('/api/engine/bestmove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fen: toFen(state),
            movetime: level.maxTimeMs,
            skill: level.skill
          })
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.error || `Engine-Fehler (HTTP ${response.status})`);
        }
        if (!data.bestmove) return null;

        const token = data.bestmove;
        return {
          uci: token,
          from: parseUciSquare(token.slice(0, 2)),
          to: parseUciSquare(token.slice(2, 4)),
          promotion: token[4] || null,
          info: { depth: data.depth, scoreCp: data.score_cp, mate: data.mate }
        };
      },
      dispose() { /* the server owns the process lifetime */ }
    };
  }

  /* ------------------------------------------------------------------ *
   * Controller
   * ------------------------------------------------------------------ */

  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(`chess-${key}`);
      return raw == null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  }

  function write(key, value) {
    try { localStorage.setItem(`chess-${key}`, JSON.stringify(value)); } catch { /* ignore */ }
  }

  const settings = {
    mode: read('ai-mode', DEFAULTS.mode),
    level: read('ai-level', DEFAULTS.level),
    humanColor: read('ai-human-color', DEFAULTS.humanColor),
    backend: read('ai-backend', DEFAULTS.backend)
  };

  let backend = null;
  let thinking = false;

  function activeBackend() {
    if (backend && backend.name === settings.backend) return backend;
    if (backend) backend.dispose();
    if (settings.backend === 'server') backend = createServerBackend();
    else if (settings.backend === 'stockfish') backend = createStockfishBackend();
    else backend = createBuiltinBackend();
    return backend;
  }

  /** Reports whether the native engine is reachable, for the settings hint. */
  async function serverEngineStatus() {
    try {
      const response = await fetch('/api/engine/status');
      if (!response.ok) return { available: false, reason: 'Server nicht erreichbar' };
      return await response.json();
    } catch (error) {
      return { available: false, reason: 'Server nicht erreichbar' };
    }
  }

  const api = {
    LEVELS,
    MODES,
    findLevel,
    toUci,
    toFen,
    parseUciSquare,

    getSettings() { return { ...settings, levelConfig: findLevel(settings.level) }; },
    serverEngineStatus,

    isComputerGame() { return settings.mode === MODES.COMPUTER; },
    computerColor() { return settings.humanColor === 'white' ? 'black' : 'white'; },
    isComputerTurn(turn) { return api.isComputerGame() && turn === api.computerColor(); },
    isThinking() { return thinking; },

    update(patch) {
      Object.assign(settings, patch);
      write('ai-mode', settings.mode);
      write('ai-level', settings.level);
      write('ai-human-color', settings.humanColor);
      write('ai-backend', settings.backend);
      // Guarded on the capability actually used, not merely on `window`
      // existing: settings must remain usable in any host that lacks the DOM
      // event constructors.
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
        window.dispatchEvent(new CustomEvent('chess-ai-settings-changed', { detail: api.getSettings() }));
      }
    },

    /**
     * Resolves to a move object from chess-engine.js, or null when there is
     * nothing to play. Both backends are normalised through findLegalMove so
     * an engine can never inject a move the rules do not allow.
     */
    async requestMove(state) {
      if (thinking) return null;
      thinking = true;
      try {
        const level = findLevel(settings.level);
        const raw = await activeBackend().bestMove(state, level);
        if (!raw) return null;

        const from = raw.move ? raw.move.from : raw.from;
        const to = raw.move ? raw.move.to : raw.to;
        const promotion = raw.move ? raw.move.promotion : raw.promotion;

        const candidates = window.ChessEngine.legalMoves(state).filter(m =>
          m.from[0] === from[0] && m.from[1] === from[1] &&
          m.to[0] === to[0] && m.to[1] === to[1]
        );
        if (candidates.length === 0) return null;
        if (candidates.length === 1) return candidates[0];

        // Promotion: match the requested piece, defaulting to a queen.
        const wanted = (promotion || 'q').toLowerCase();
        return candidates.find(m => (m.promotion || '').toLowerCase() === wanted) || candidates[0];
      } finally {
        thinking = false;
      }
    },

    dispose() {
      if (backend) { backend.dispose(); backend = null; }
    }
  };

  if (typeof window !== 'undefined') window.ChessAI = api;
  else (typeof self !== 'undefined' ? self : globalThis).ChessAI = api;
})();
