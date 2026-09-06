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
