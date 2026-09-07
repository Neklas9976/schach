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

  /**
   * Resolves a file inside static/ against the page.
   *
   * Never an absolute "/static/..." path: published under a project page the
   * site lives at /<repo>/, where a leading slash points at the domain root
   * and every asset 404s. Resolved against the document it is correct both
   * there and when a local server hands the page out at "/".
   */
  function assetPath(name) {
    if (typeof document === 'undefined') return `static/${name}`;
    return new URL(`static/${name}`, document.baseURI).href;
  }

  /** Same reasoning for the local server's endpoints. */
  function apiPath(name) {
    if (typeof document === 'undefined') return `api/engine/${name}`;
    return new URL(`api/engine/${name}`, document.baseURI).href;
  }

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
      worker = new Worker(assetPath('ai-worker.js'));
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
   * Stockfish compiled to WebAssembly, running in the visitor's browser.
   *
   * This is what makes the published site work without a server: the opponent,
   * the evaluation bar, the hint and the game review all run here. It is
   * shipped with the project (`static/stockfish.js` + `.wasm`, ~430 KB), which
   * is why the project is under the GPL - see LICENSE.
   */
  function createStockfishBackend() {
    let engine = null;
    let ready = null;
    // UCI is one stateful session. Two overlapping searches would interleave
    // their output and neither caller could tell which `bestmove` was theirs -
    // and the review asks for one position after another as fast as it can.
    let queue = Promise.resolve();

    function send(command) {
      engine.postMessage(command);
    }

    function init() {
      if (ready) return ready;
      ready = new Promise((resolve, reject) => {
        try {
          engine = new Worker(assetPath('stockfish.js'));
        } catch (error) {
          reject(new Error('Stockfish konnte nicht geladen werden'));
          return;
        }

        // The first call also compiles the WebAssembly module, which on a cold
        // cache and a slow machine is a good deal longer than a search.
        const timeout = setTimeout(() => reject(new Error('Stockfish antwortet nicht')), 30000);
        engine.onmessage = event => {
          const line = typeof event.data === 'string' ? event.data : '';
          if (line.startsWith('uciok')) {
            clearTimeout(timeout);
            resolve();
          }
        };
        engine.onerror = () => {
          clearTimeout(timeout);
          reject(new Error('Stockfish konnte nicht gestartet werden'));
        };
        send('uci');
      });
      return ready;
    }

    /**
     * One search, in the same shape the server endpoint returns, so callers do
     * not care which engine answered them.
     */
    function search({ fen, movetime, skill = 20, elo = null }) {
      const run = async () => {
        await init();
        return new Promise((resolve, reject) => {
          const info = { depth: null, score_cp: null, mate: null };
          const timeout = setTimeout(() => {
            engine.onmessage = null;
            reject(new Error('Stockfish hat nicht geantwortet'));
          }, movetime + 20000);

          engine.onmessage = event => {
            const line = typeof event.data === 'string' ? event.data : '';

            if (line.startsWith('info ')) {
              const tokens = line.split(/\s+/);
              const depthAt = tokens.indexOf('depth');
              if (depthAt >= 0) info.depth = Number(tokens[depthAt + 1]) || info.depth;
              const scoreAt = tokens.indexOf('score');
              if (scoreAt >= 0) {
                const kind = tokens[scoreAt + 1];
                const value = Number(tokens[scoreAt + 2]);
                if (Number.isFinite(value)) {
                  if (kind === 'cp') { info.score_cp = value; info.mate = null; }
                  else if (kind === 'mate') { info.mate = value; info.score_cp = null; }
                }
              }
              return;
            }

            if (!line.startsWith('bestmove')) return;
            clearTimeout(timeout);
            engine.onmessage = null;
            const token = line.split(/\s+/)[1];
            resolve({ bestmove: (!token || token === '(none)') ? null : token, ...info });
          };

          send('ucinewgame');
          send(`setoption name Skill Level value ${skill}`);
          // Restated every time, "off" included: UCI options live as long as
          // the process, so a capped level would otherwise stick.
          if (elo == null) send('setoption name UCI_LimitStrength value false');
          else {
            send('setoption name UCI_LimitStrength value true');
            send(`setoption name UCI_Elo value ${elo}`);
          }
          send(`position fen ${fen}`);
          send(`go movetime ${movetime}`);
        });
      };

      // Chained whether or not the previous search succeeded; a failure must
      // not wedge the queue for the rest of the session.
      const result = queue.then(run, run);
      queue = result.catch(() => {});
      return result;
    }

    return {
      name: 'stockfish',
      search,
      async bestMove(state, level) {
        const answer = await search({
          fen: toFen(state), movetime: level.maxTimeMs, skill: level.skill, elo: level.elo
        });
        if (!answer.bestmove) return null;
        const token = answer.bestmove;
        return {
          uci: token,
          from: parseUciSquare(token.slice(0, 2)),
          to: parseUciSquare(token.slice(2, 4)),
          promotion: token[4] || null,
          info: { depth: answer.depth, scoreCp: answer.score_cp, mate: answer.mate }
        };
      },
      dispose() {
        if (engine) { engine.terminate(); engine = null; ready = null; queue = Promise.resolve(); }
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
        const response = await fetch(apiPath('status'));
        if (!response.ok) throw new Error('Server nicht erreichbar');
        return response.json();
      },
      async bestMove(state, level) {
        const response = await fetch(apiPath('bestmove'), {
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
        const response = await fetch(apiPath('status'));
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

  /* ------------------------------------------------------------------ *
   * Analysis
   * ------------------------------------------------------------------ *
   * The evaluation bar, the hint and the game review all ask one question:
   * "how good is this position, and what is the best move?" They go through
   * here rather than talking to an engine themselves, so the published site -
   * which has no server at all - answers them from the browser instead.
   */

  // Deliberately its own engine, never the one playing the game. UCI is a
  // single stateful session: sharing would put an evaluation in front of the
  // opponent's move and stall the board on every turn.
  let analysisEngine = null;
  // Resolved once. The review asks dozens of questions in a row and a probe
  // before each would be a round trip that always gives the same answer.
  let analysisSource = null;

  async function resolveAnalysisSource() {
    if (analysisSource) return analysisSource;
    const status = await serverEngineStatus();
    analysisSource = status.available ? 'server' : 'wasm';
    return analysisSource;
  }

  /**
   * Scores one position. Resolves to the same shape either engine returns:
   * `{ bestmove, depth, score_cp, mate }`, with the score from the side to
   * move, exactly as UCI reports it.
   *
   * Never weakened by the difficulty setting - a bar that judges the position
   * the way a deliberately handicapped opponent would says nothing.
   */
  async function analyse(fen, movetimeMs = 300) {
    if (await resolveAnalysisSource() === 'server') {
      const response = await fetch(apiPath('evaluate'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fen, movetime: movetimeMs })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Engine-Fehler (HTTP ${response.status})`);
      return data;
    }

    if (!analysisEngine) analysisEngine = createStockfishBackend();
    return analysisEngine.search({ fen, movetime: movetimeMs, skill: 20, elo: null });
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
    analyse,
    /** Which engine answers analysis, once decided. Null until first asked. */
    analysisSource: () => analysisSource,

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
     * Picks the strongest opponent this installation can actually provide.
     *
     * Order: the local server's native Stockfish, then the WebAssembly build
     * that ships with the app, then the built-in search. The built-in engine is
     * last because it is by far the weakest - it is the floor that guarantees
     * a game rather than a preference.
     *
     * The stored default stays 'builtin' rather than 'stockfish' so a browser
     * that cannot start the WebAssembly worker still has a working opponent;
     * requestMove falls back on its own if the upgrade turns out not to run.
     * Resolves to the backend in use afterwards.
     */
    async autoSelectBackend() {
      if (settings.backendPinned) return settings.backend;
      const status = await serverEngineStatus();
      const wanted = status.available ? 'server' : 'stockfish';
      if (settings.backend !== wanted) {
        api.dispose();
        api.update({ backend: wanted });
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
    },

    /** Frees the analysis engine too; the board keeps its own separately. */
    disposeAll() {
      api.dispose();
      if (analysisEngine) { analysisEngine.dispose(); analysisEngine = null; }
    }
  };

  if (typeof window !== 'undefined') window.ChessAI = api;
  else (typeof self !== 'undefined' ? self : globalThis).ChessAI = api;
})();
