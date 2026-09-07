(() => {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Difficulty levels
   * ------------------------------------------------------------------ *
   * `randomness` is a centipawn window: the engine picks at random among all
   * root moves within that window of the best score. It is what makes low
   * levels feel like a beatable opponent instead of a weaker-but-still-perfect
   * machine, and it is why level 1 will happily hang a piece.
   *
   * `skill` and `elo` only apply to Stockfish. Skill Level alone is not enough
   * to make the lower levels playable: even at Skill 0 Stockfish still plays
   * around 1350 Elo, so levels 1-7 additionally cap the strength through
   * UCI_Elo. `elo: null` means "no cap" and is what makes level 8 the real
   * full-strength engine.
   */
  const LEVELS = [
    { id: 1, label: 'Stufe 1 – Anfänger',      maxDepth: 1, maxTimeMs:  200, randomness: 150, skill:  0, elo: 1320 },
    { id: 2, label: 'Stufe 2 – Sehr leicht',   maxDepth: 2, maxTimeMs:  350, randomness:  90, skill:  2, elo: 1450 },
    { id: 3, label: 'Stufe 3 – Leicht',        maxDepth: 2, maxTimeMs:  600, randomness:  40, skill:  4, elo: 1600 },
    { id: 4, label: 'Stufe 4 – Mittel',        maxDepth: 3, maxTimeMs: 1000, randomness:  12, skill:  7, elo: 1800 },
    { id: 5, label: 'Stufe 5 – Fortgeschritten',maxDepth: 4, maxTimeMs: 1500, randomness:  0, skill: 10, elo: 2000 },
    { id: 6, label: 'Stufe 6 – Stark',         maxDepth: 5, maxTimeMs: 2500, randomness:  0, skill: 14, elo: 2300 },
    { id: 7, label: 'Stufe 7 – Sehr stark',    maxDepth: 6, maxTimeMs: 4000, randomness:  0, skill: 17, elo: 2600 },
    { id: 8, label: 'Stufe 8 – Maximum',       maxDepth: 8, maxTimeMs: 6000, randomness:  0, skill: 20, elo: null }
  ];

  const MODES = {
    HUMAN: 'human-vs-human',
    COMPUTER: 'human-vs-computer'
  };

  const DEFAULTS = {
    mode: MODES.HUMAN,
    level: 4,
    humanColor: 'white',
    // Only the starting point. If a native engine turns out to be installed,
    // autoSelectBackend() upgrades this before the first move - see there for
    // why the default cannot simply be 'server'.
    backend: 'builtin',
    // True once the player picked an engine themselves. Auto-selection must
    // never overrule that choice, not even after a restart.
    backendPinned: false
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

  /**
   * Builds a FEN string; required by Stockfish, unused by the built-in engine.
   *
   * Delegates to the engine rather than serialising the board again here. A
   * second FEN writer is the same trap as a second move generator: the two
   * drift, and the engine ends up analysing a position the board is not in.
   */
  function toFen(state) {
    const engine = (typeof window !== 'undefined' ? window : globalThis).ChessEngine;
    return engine.toFen(state);
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
            skill: level.skill,
            elo: level.elo
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
    backend: read('ai-backend', DEFAULTS.backend),
    backendPinned: read('ai-backend-pinned', DEFAULTS.backendPinned)
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

  // Set while a status request is in flight, so callers that ask at the same
  // moment share one answer.
  let statusInFlight = null;

  /**
   * Reports whether the native engine is reachable.
   *
   * Three different things ask this on every page load - the automatic backend
   * choice, the engine hint and the evaluation-bar hint. Concurrent callers
   * share the one request rather than each making their own: three round trips
   * for one answer, and three answers that can disagree with each other if the
   * engine changes state in between.
   *
   * Deliberately not cached beyond that. A stale "no engine" would survive
   * dropping Stockfish into place, which is exactly the moment the answer has
   * to change.
   */
  function serverEngineStatus() {
    if (statusInFlight) return statusInFlight;
    statusInFlight = (async () => {
      try {
        const response = await fetch('/api/engine/status');
        if (!response.ok) return { available: false, reason: 'Server nicht erreichbar' };
        return await response.json();
      } catch (error) {
        return { available: false, reason: 'Server nicht erreichbar' };
      } finally {
        // Cleared in a microtask so everything awaiting this turn shares it,
        // while the next question still reaches the server.
        Promise.resolve().then(() => { statusInFlight = null; });
      }
    })();
    return statusInFlight;
  }

  function notify(name, detail) {
    if (typeof window === 'undefined') return;
    if (typeof window.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') return;
    window.dispatchEvent(new CustomEvent(name, { detail }));
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
      write('ai-backend-pinned', settings.backendPinned);
      // Guarded on the capability actually used, not merely on `window`
      // existing: settings must remain usable in any host that lacks the DOM
      // event constructors.
      notify('chess-ai-settings-changed', api.getSettings());
    },

    /** Records an engine the player picked themselves, never to be overridden. */
    chooseBackend(name) {
      api.dispose();
      api.update({ backend: name, backendPinned: true });
    },

    /**
     * Switches to the native engine when one is installed.
     *
     * The default cannot simply be 'server': most installations have no engine
     * binary, and a default that fails on the first move is worse than one that
     * is merely weaker. So the app starts on the always-available built-in
     * engine and upgrades itself once the server confirms a native engine is
     * actually there. Resolves to the backend in use afterwards.
     */
    async autoSelectBackend() {
      if (settings.backendPinned) return settings.backend;
      const status = await serverEngineStatus();
      if (!status.available) return settings.backend;
      if (settings.backend !== 'server') {
        api.dispose();
        api.update({ backend: 'server' });
      }
      return settings.backend;
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
        let raw;
        try {
          raw = await activeBackend().bestMove(state, level);
        } catch (error) {
          // An external engine can disappear mid-game: the binary is deleted,
          // the process crashes, the server is restarted. Losing the game to a
          // dead subprocess would be the worst outcome, so the built-in engine
          // - which cannot fail this way - takes over and the player is told.
          if (settings.backend === 'builtin') throw error;
          const failed = settings.backend;
          api.dispose();
          api.update({ backend: 'builtin' });
          notify('chess-ai-backend-fallback', { from: failed, to: 'builtin', error });
          raw = await activeBackend().bestMove(state, findLevel(settings.level));
        }
        if (!raw) return null;

        const from = raw.move ? raw.move.from : raw.from;
        const to = raw.move ? raw.move.to : raw.to;
        const promotion = raw.move ? raw.move.promotion : raw.promotion;

        const candidates = window.ChessEngine.movesBetween(state, from, to);
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
