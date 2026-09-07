import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const engineCode = fs.readFileSync(new URL('../static/chess-engine.js', import.meta.url), 'utf8');
const aiCode = fs.readFileSync(new URL('../static/ai.js', import.meta.url), 'utf8');
const workerCode = fs.readFileSync(new URL('../static/ai-worker.js', import.meta.url), 'utf8');

const sandbox = { window: {}, localStorage: undefined };
sandbox.globalThis = sandbox;
vm.runInNewContext(engineCode, sandbox);
vm.runInNewContext(aiCode, sandbox);

const E = sandbox.window.ChessEngine;
const AI = sandbox.window.ChessAI;

test('the engine loads without a window object', () => {
  // chess-engine.js must work inside a Web Worker, where `window` is absent.
  const workerSandbox = { self: {} };
  workerSandbox.self.self = workerSandbox.self;
  vm.runInNewContext(engineCode, workerSandbox);
  assert.ok(workerSandbox.self.ChessEngine, 'engine must attach to self in a worker');
});

test('AI settings survive without localStorage', () => {
  // The sandbox deliberately has no localStorage; reading settings must not throw.
  assert.ok(AI.getSettings());
  assert.equal(typeof AI.getSettings().level, 'number');
});

test('every difficulty level is fully configured', () => {
  assert.equal(AI.LEVELS.length, 8);
  for (const level of AI.LEVELS) {
    assert.ok(level.maxDepth >= 1, `level ${level.id} needs a search depth`);
    assert.ok(level.maxTimeMs > 0, `level ${level.id} needs a time budget`);
    assert.ok(level.skill >= 0 && level.skill <= 20, `level ${level.id} skill must be a valid UCI value`);
  }
});

test('difficulty rises monotonically', () => {
  // A level that is not stronger than the one below it would make the
  // strength selector meaningless.
  for (let i = 1; i < AI.LEVELS.length; i++) {
    assert.ok(AI.LEVELS[i].maxDepth >= AI.LEVELS[i - 1].maxDepth);
    assert.ok(AI.LEVELS[i].randomness <= AI.LEVELS[i - 1].randomness);
  }
});

test('an unknown level falls back instead of crashing', () => {
  assert.ok(AI.findLevel(999));
  assert.ok(AI.findLevel(undefined));
});

test('the computer plays the colour the human did not choose', () => {
  AI.update({ mode: AI.MODES.COMPUTER, humanColor: 'white' });
  assert.equal(AI.computerColor(), 'black');
  assert.equal(AI.isComputerTurn('black'), true);
  assert.equal(AI.isComputerTurn('white'), false);

  AI.update({ humanColor: 'black' });
  assert.equal(AI.computerColor(), 'white');
});

test('no turn belongs to the computer in a human-vs-human game', () => {
  AI.update({ mode: AI.MODES.HUMAN });
  assert.equal(AI.isComputerTurn('white'), false);
  assert.equal(AI.isComputerTurn('black'), false);
});

test('moves convert to UCI notation', () => {
  const state = E.createInitialState();
  const move = E.findLegalMove(state, [6, 4], [4, 4]);
  assert.equal(AI.toUci(move), 'e2e4');
});

test('promotions carry the piece suffix in UCI', () => {
  assert.equal(AI.toUci({ from: [1, 0], to: [0, 0], promotion: 'Q' }), 'a7a8q');
});

test('UCI squares parse back to board coordinates', () => {
  assert.deepEqual([...AI.parseUciSquare('e2')], [6, 4]);
  assert.deepEqual([...AI.parseUciSquare('a8')], [0, 0]);
  assert.deepEqual([...AI.parseUciSquare('h1')], [7, 7]);
});

test('the start position produces the standard FEN', () => {
  const fen = AI.toFen(E.createInitialState());
  assert.equal(fen, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
});

test('FEN reflects the side to move and the en passant square', () => {
  const state = E.createInitialState();
  const next = E.applyMove(state, E.findLegalMove(state, [6, 4], [4, 4]));
  const fen = AI.toFen(next);
  assert.match(fen, / b /, 'black must be to move after 1.e4');
  assert.match(fen, / e3 /, 'the en passant square must be recorded');
});

test('FEN reports lost castling rights', () => {
  const state = E.createInitialState();
  state.castling = { K: false, Q: false, k: true, q: false };
  assert.match(AI.toFen(state), / k /);

  state.castling = { K: false, Q: false, k: false, q: false };
  assert.match(AI.toFen(state), / - /);
});

test('the search worker only depends on the shared engine for rules', () => {
  // The AI must never carry its own move generator: a second rule
  // implementation is how engines start producing illegal moves.
  assert.match(workerCode, /importScripts\(['"]chess-engine\.js['"]\)/);
  assert.equal(/function\s+generateMoves|function\s+isLegal/.test(workerCode), false);
  assert.match(workerCode, /E\.legalMoves\(/);
  assert.match(workerCode, /E\.applyMove\(/);
});

test('the search is time-boxed so it can never hang the game', () => {
  assert.match(workerCode, /deadline/);
  assert.match(workerCode, /Date\.now\(\)\s*>=\s*deadline/);
});

test('every piece-square table is a full 8x8 grid', () => {
  // A short row would silently produce undefined - and therefore NaN scores -
  // deep inside the search, where it is very hard to notice.
  const workerSandbox = { self: {}, importScripts: () => {}, ChessEngine: {} };
  workerSandbox.self.ChessEngine = {};
  workerSandbox.self.onmessage = null;
  vm.runInNewContext(workerCode + '\n;self.__PST = PST;', workerSandbox);

  for (const [name, table] of Object.entries(workerSandbox.self.__PST)) {
    assert.equal(table.length, 8, `${name} must have 8 ranks`);
    for (const row of table) {
      assert.equal(row.length, 8, `${name} must have 8 files per rank`);
      for (const value of row) assert.equal(Number.isFinite(value), true, `${name} contains a non-numeric score`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * Engine selection
 * ------------------------------------------------------------------ *
 * These load ai.js into a fresh sandbox per test. The module reads its
 * settings once at load time, so a shared instance could not express
 * "what happens on a cold start with a native engine installed".
 */

function loadAI({ engineAvailable = false, serverFails = false, builtinFails = false, stored = {} } = {}) {
  const storage = new Map(Object.entries(stored).map(([k, v]) => [k, JSON.stringify(v)]));
  const events = [];
  const requests = [];

  const sandbox = {
    window: {},
    localStorage: {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, v)
    },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    async fetch(url, init) {
      if (url === '/api/engine/status') {
        requests.push({ url });
        return {
          ok: true,
          json: async () => (engineAvailable
            ? { available: true, path: '/opt/sf/stockfish.exe', file: 'stockfish.exe', name: 'Stockfish 19' }
            : { available: false, reason: 'Keine Engine gefunden.' })
        };
      }
      if (url === '/api/engine/bestmove') {
        requests.push(JSON.parse(init.body));
        if (serverFails) return { ok: false, status: 503, json: async () => ({ error: 'Engine weg' }) };
        return { ok: true, json: async () => ({ bestmove: 'e2e4', depth: 20, score_cp: 31, mate: null }) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
    // Stands in for ai-worker.js: answers 1.e2e4, or dies like a real worker.
    Worker: class {
      constructor() { this.onmessage = null; this.onerror = null; }
      postMessage(msg) {
        Promise.resolve().then(() => {
          if (builtinFails) { this.onerror(new Error('Worker abgestürzt')); return; }
          this.onmessage({
            data: { type: 'result', id: msg.id, result: { move: { from: [6, 4], to: [4, 4], promotion: null } } }
          });
        });
      }
      terminate() {}
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.window.dispatchEvent = event => { events.push(event); return true; };

  vm.runInNewContext(engineCode, sandbox);
  vm.runInNewContext(aiCode, sandbox);
  return { AI: sandbox.window.ChessAI, E: sandbox.window.ChessEngine, events, requests, storage };
}

test('every level carries a Stockfish strength cap in the engine range', () => {
  for (const level of AI.LEVELS) {
    if (level.elo === null) continue;
    assert.ok(level.elo >= 1320 && level.elo <= 3190, `level ${level.id} elo must be a value Stockfish accepts`);
  }
  assert.equal(AI.LEVELS[AI.LEVELS.length - 1].elo, null, 'the top level must play uncapped');
});

test('the strength cap rises with the level', () => {
  const capped = AI.LEVELS.filter(l => l.elo !== null);
  for (let i = 1; i < capped.length; i++) {
    assert.ok(capped[i].elo > capped[i - 1].elo, `level ${capped[i].id} must be stronger than the one below`);
  }
});

test('a cold start switches to the native engine when one is installed', async () => {
  // Why this exists at all: defaulting straight to 'server' would break every
  // installation without a binary, so the upgrade has to be a probe.
  const { AI: ai } = loadAI({ engineAvailable: true });
  assert.equal(ai.getSettings().backend, 'builtin');
  assert.equal(await ai.autoSelectBackend(), 'server');
  assert.equal(ai.getSettings().backend, 'server');
});

test('a cold start stays on the built-in engine when none is installed', async () => {
  const { AI: ai } = loadAI({ engineAvailable: false });
  assert.equal(await ai.autoSelectBackend(), 'builtin');
});

test('auto-selection never overrules an engine the player picked', async () => {
  const { AI: ai } = loadAI({
    engineAvailable: true,
    stored: { 'chess-ai-backend': 'builtin', 'chess-ai-backend-pinned': true }
  });
  assert.equal(await ai.autoSelectBackend(), 'builtin');
});

test('choosing an engine by hand pins it across restarts', () => {
  const { AI: ai, storage } = loadAI();
  ai.chooseBackend('server');
  assert.equal(ai.getSettings().backend, 'server');
  assert.equal(storage.get('chess-ai-backend-pinned'), 'true');
});

test('the native engine is asked for the level\u2019s strength cap', async () => {
  const { AI: ai, E: engine, requests } = loadAI({ engineAvailable: true });
  ai.chooseBackend('server');
  ai.update({ mode: ai.MODES.COMPUTER, level: 4 });
  await ai.requestMove(engine.createInitialState());

  const searches = requests.filter(r => r.fen);
  assert.equal(searches.length, 1);
  assert.equal(searches[0].elo, ai.findLevel(4).elo);
  assert.equal(searches[0].skill, ai.findLevel(4).skill);
});

test('a native engine that fails hands the game to the built-in one', async () => {
  // A crashed subprocess or a restarted server must not cost the player the
  // game: the move still has to arrive, from whichever engine still works.
  const { AI: ai, E: engine, events } = loadAI({ engineAvailable: true, serverFails: true });
  ai.chooseBackend('server');
  ai.update({ mode: ai.MODES.COMPUTER });

  const move = await ai.requestMove(engine.createInitialState());
  assert.ok(move, 'the built-in engine must supply a move after the native one failed');
  assert.deepEqual([...move.from], [6, 4]);
  assert.equal(ai.getSettings().backend, 'builtin');
  assert.ok(events.some(e => e.type === 'chess-ai-backend-fallback'), 'the player must be told');
});

test('a failing built-in engine surfaces instead of falling back to itself', async () => {
  // The fallback must not become a loop: builtin is the last resort, so its
  // failure has to reach the caller, which turns it into a visible message.
  const { AI: ai, E: engine } = loadAI({ builtinFails: true });
  ai.update({ mode: ai.MODES.COMPUTER });

  await assert.rejects(ai.requestMove(engine.createInitialState()));
  assert.equal(ai.getSettings().backend, 'builtin');
  // The guard must be released, or the game would never ask again.
  assert.equal(ai.isThinking(), false);
});

test('callers asking for the engine status at once share one request', () => {
  // Three separate things ask on every page load. Three round trips for one
  // answer is wasteful, and three answers can disagree with each other.
  const { AI: ai, requests } = loadAI({ engineAvailable: true });
  const answers = Promise.all([ai.serverEngineStatus(), ai.serverEngineStatus(), ai.serverEngineStatus()]);
  assert.equal(requests.filter(r => r.url === '/api/engine/status').length, 1);
  return answers.then(all => {
    assert.equal(all.length, 3);
    for (const status of all) assert.equal(status.available, true);
  });
});

test('a later question still reaches the server', () => {
  // Caching the answer would survive dropping Stockfish into place, which is
  // the one moment the answer has to change.
  const { AI: ai, requests } = loadAI({ engineAvailable: false });
  const count = () => requests.filter(r => r.url === '/api/engine/status').length;
  return ai.serverEngineStatus()
    .then(() => new Promise(resolve => setTimeout(resolve, 0)))
    .then(() => ai.serverEngineStatus())
    .then(() => assert.equal(count(), 2));
});
