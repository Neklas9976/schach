import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('../static/clock.js', import.meta.url), 'utf8');
// No `document` in the sandbox: clock.js must stay usable as pure logic.
const sandbox = { window: {}, globalThis: {}, performance: { now: () => 0 } };
sandbox.globalThis = sandbox;
vm.runInNewContext(code, sandbox);
const C = sandbox.window.ChessClock;

function emptyBoard() {
  return Array.from({ length: 8 }, () => Array(8).fill(null));
}

function boardWith(pieces) {
  const b = emptyBoard();
  b[0][4] = 'k';
  b[7][4] = 'K';
  for (const [r, c, p] of pieces) b[r][c] = p;
  return b;
}

test('clock module loads without a DOM', () => {
  assert.ok(C, 'ChessClock must be exposed even in a non-browser context');
  assert.equal(typeof C.formatTime, 'function');
});

test('time is formatted mm:ss above ten seconds', () => {
  assert.equal(C.formatTime(600_000), '10:00');
  assert.equal(C.formatTime(65_000), '1:05');
  assert.equal(C.formatTime(10_000), '0:10');
});

test('time switches to tenths under ten seconds', () => {
  assert.equal(C.formatTime(9_900), '9.9');
  assert.equal(C.formatTime(1_050), '1.0');
});

test('remaining time is rounded down, never up', () => {
  // A clock must never display time the player does not actually have.
  assert.equal(C.formatTime(9_999), '9.9');
  assert.equal(C.formatTime(59_999), '0:59');
});

test('time never renders as negative', () => {
  assert.equal(C.formatTime(-500), '0.0');
});

test('long time controls include hours', () => {
  assert.equal(C.formatTime(3_600_000), '1:00:00');
});

test('a lone king cannot mate', () => {
  assert.equal(C.hasMatingMaterial(boardWith([]), 'white'), false);
});

test('king and single minor piece cannot mate', () => {
  assert.equal(C.hasMatingMaterial(boardWith([[4, 4, 'B']]), 'white'), false);
  assert.equal(C.hasMatingMaterial(boardWith([[4, 4, 'N']]), 'white'), false);
});

test('a single pawn counts as mating material', () => {
  // A pawn can promote, so it is always sufficient.
  assert.equal(C.hasMatingMaterial(boardWith([[4, 4, 'P']]), 'white'), true);
});

test('two knights count as mating material under FIDE rules', () => {
  // Mate cannot be forced, but it is reachable, so a flag fall is a loss.
  assert.equal(C.hasMatingMaterial(boardWith([[4, 4, 'N'], [4, 6, 'N']]), 'white'), true);
});

test('material is counted per colour, not for the whole board', () => {
  const board = boardWith([[4, 4, 'q']]);
  assert.equal(C.hasMatingMaterial(board, 'black'), true);
  assert.equal(C.hasMatingMaterial(board, 'white'), false);
});

test('flag fall against sufficient material is a win', () => {
  const board = boardWith([[4, 4, 'Q']]);
  const result = C.resolveFlag(board, 'black');
  // Compared field by field: objects created inside the vm sandbox belong to
  // a different realm, so deepStrictEqual would fail on the prototype alone.
  assert.equal(result.type, 'timeout');
  assert.equal(result.winner, 'white');
  assert.equal(result.flagged, 'black');
});

test('flag fall against a bare king is a draw', () => {
  const result = C.resolveFlag(emptyBoard(), 'black');
  assert.equal(result.type, 'timeout-draw');
  assert.equal(result.winner, null);
  assert.equal(result.flagged, 'black');
});

test('unlimited control reports the clock as disabled', () => {
  C.reset('unlimited');
  assert.equal(C.isEnabled(), false);
  assert.equal(C.remainingFor('white'), null);
});

test('a timed control starts both sides on the full base time', () => {
  C.reset('5+3');
  assert.equal(C.isEnabled(), true);
  assert.equal(C.remainingFor('white'), 300_000);
  assert.equal(C.remainingFor('black'), 300_000);
});

test('the clock does not run before the first move', () => {
  C.reset('3+2');
  assert.equal(C.isRunning(), false);
  assert.equal(C.activeColor(), null);
});

test('the first move hands the clock over without paying increment', () => {
  C.reset('3+2');
  C.onMoveMade('white', 'black');
  assert.equal(C.activeColor(), 'black');
  assert.equal(C.isRunning(), true);
  // White was never on the clock for move one, so no increment is credited.
  assert.equal(C.remainingFor('white'), 180_000);
});

test('increment is credited to the side that actually moved', () => {
  C.reset('3+2');
  C.onMoveMade('white', 'black');
  C.onMoveMade('black', 'white');
  // performance.now() is frozen at 0 in this sandbox, so no time elapses and
  // the increment is the only change - which is exactly what we want to assert.
  assert.equal(C.remainingFor('black'), 182_000);
  assert.equal(C.remainingFor('white'), 180_000);
});

test('clock state survives a snapshot and restore round trip', () => {
  C.reset('10+0');
  C.onMoveMade('white', 'black');
  const snap = C.getState();
  C.reset('1+0');
  assert.equal(C.remainingFor('white'), 60_000);
  C.restoreState(snap);
  assert.equal(C.control.id, '10+0');
  assert.equal(C.remainingFor('white'), 600_000);
  assert.equal(C.activeColor(), 'black');
});

test('an unlimited clock never reports a flag', () => {
  C.reset('unlimited');
  C.onMoveMade('white', 'black');
  assert.equal(C.poll(), null);
});
