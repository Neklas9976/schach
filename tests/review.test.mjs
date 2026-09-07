import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const reviewCode = fs.readFileSync(new URL('../static/review.js', import.meta.url), 'utf8');
const openingsCode = fs.readFileSync(new URL('../static/openings.js', import.meta.url), 'utf8');

const sandbox = { window: {} };
sandbox.globalThis = sandbox;
vm.runInNewContext(reviewCode, sandbox);
vm.runInNewContext(openingsCode, sandbox);

const R = sandbox.window.ChessReview;
const O = sandbox.window.ChessOpenings;

/* ------------------------------------------------------------ scoring --- */

test('an equal position is a coin flip', () => {
  assert.equal(Math.round(R.winProbability(0)), 50);
});

test('win probability rises with the advantage and is symmetric', () => {
  assert.ok(R.winProbability(100) > R.winProbability(0));
  assert.ok(R.winProbability(-100) < R.winProbability(0));
  assert.ok(Math.abs((R.winProbability(300) - 50) + (R.winProbability(-300) - 50)) < 1e-9);
});

test('mate outranks any material advantage', () => {
  assert.ok(R.toCentipawns({ mate: 5 }) > R.toCentipawns({ cp: 2000 }));
  assert.ok(R.toCentipawns({ mate: -5 }) < R.toCentipawns({ cp: -2000 }));
});

test('a faster mate scores higher than a slower one', () => {
  // Otherwise an engine that finds M1 would look no better than one at M8.
  assert.ok(R.toCentipawns({ mate: 1 }) > R.toCentipawns({ mate: 8 }));
  assert.ok(R.toCentipawns({ mate: -1 }) < R.toCentipawns({ mate: -8 }));
});

/* ----------------------------------------------------- classification --- */

const move = (patch = {}) => R.classifyMove({ mover: 'white', before: { cp: 0 }, after: { cp: 0 }, ...patch });

test('a book move is named as such and never scored', () => {
  const result = move({ isBook: true, after: { cp: -300 } });
  assert.equal(result.key, 'book');
});

test('playing the engine move is the best move', () => {
  assert.equal(move({ bestMove: 'e2e4', playedMove: 'e2e4' }).key, 'best');
});

test('a losing move is graded by how much it gave away', () => {
  // The centipawn figures are chosen to land inside each band once converted
  // to win probability, which is what the thresholds are expressed in.
  assert.equal(move({ after: { cp: -20 } }).key, 'excellent');
  assert.equal(move({ after: { cp: -80 } }).key, 'good');
  assert.equal(move({ after: { cp: -150 } }).key, 'inaccuracy');
  assert.equal(move({ after: { cp: -280 } }).key, 'mistake');
  assert.equal(move({ after: { cp: -600 } }).key, 'blunder');
});

test('the same centipawn loss weighs less in a decided position', () => {
  // 200 centipawns thrown away from equality is a real mistake; the same
  // amount at +9 changes nothing about the outcome and must not be graded
  // the same way. This is the whole reason for scoring in win probability.
  const fromEqual = move({ before: { cp: 0 }, after: { cp: -200 } });
  const fromWinning = move({ before: { cp: 900 }, after: { cp: 700 } });
  assert.equal(fromEqual.cpLoss, fromWinning.cpLoss, 'the same centipawns are lost in both');
  assert.ok(fromEqual.lostWinPercent > fromWinning.lostWinPercent * 3);
  assert.equal(fromEqual.key, 'inaccuracy');
  assert.equal(fromWinning.key, 'good');
});

test('black is judged from black’s side of the board', () => {
  // White-relative evaluations going down is good news for Black.
  const good = R.classifyMove({ mover: 'black', before: { cp: 0 }, after: { cp: -600 } });
  const bad = R.classifyMove({ mover: 'black', before: { cp: 0 }, after: { cp: 600 } });
  assert.equal(good.lostWinPercent, 0);
  assert.equal(bad.key, 'blunder');
  // The identical swing graded for White must come out the other way round.
  assert.equal(R.classifyMove({ mover: 'white', before: { cp: 0 }, after: { cp: 600 } }).lostWinPercent, 0);
});

test('a move that improves the evaluation is never penalised', () => {
  assert.equal(move({ after: { cp: 400 } }).lostWinPercent, 0);
});

test('a sound sacrifice that is also best is a brilliancy', () => {
  const result = move({ bestMove: 'd1h5', playedMove: 'd1h5', sacrifice: true, after: { cp: 20 } });
  assert.equal(result.key, 'brilliant');
});

test('throwing material away while losing is not a brilliancy', () => {
  const result = move({ bestMove: 'd1h5', playedMove: 'd1h5', sacrifice: true, before: { cp: -400 }, after: { cp: -500 } });
  assert.equal(result.key, 'best');
});

test('a sacrifice the engine did not want is judged on the result', () => {
  const result = move({ bestMove: 'e2e4', playedMove: 'd1h5', sacrifice: true, after: { cp: -800 } });
  assert.equal(result.key, 'blunder');
});

test('a missing evaluation degrades instead of throwing', () => {
  const result = R.classifyMove({ mover: 'white', before: null, after: { cp: 0 } });
  assert.equal(result.unknown, true);
});

/* -------------------------------------------------------- accuracy ------ */

test('perfect play scores 100', () => {
  assert.equal(Math.round(R.accuracyOf([{ lostWinPercent: 0 }, { lostWinPercent: 0 }])), 100);
});

test('accuracy falls as moves give more away', () => {
  const good = R.accuracyOf([{ lostWinPercent: 1 }]);
  const poor = R.accuracyOf([{ lostWinPercent: 25 }]);
  assert.ok(good > 90, `expected a high score, got ${good}`);
  assert.ok(poor < 45, `expected a low score, got ${poor}`);
});

test('accuracy ignores moves that could not be evaluated', () => {
  const value = R.accuracyOf([{ lostWinPercent: 0 }, { lostWinPercent: 50, unknown: true }]);
  assert.equal(Math.round(value), 100);
});

test('a game with nothing to score has no accuracy rather than zero', () => {
  assert.equal(R.accuracyOf([]), null);
  assert.equal(R.accuracyOf([{ lostWinPercent: 0, unknown: true }]), null);
});

test('the summary counts every label', () => {
  const counts = R.summarise([{ key: 'best' }, { key: 'best' }, { key: 'blunder' }]);
  assert.equal(counts.best, 2);
  assert.equal(counts.blunder, 1);
  assert.equal(counts.mistake, 0);
});

/* ------------------------------------------------------------ display --- */

test('scores are formatted the way a board shows them', () => {
  assert.equal(R.formatScore({ cp: 0 }), '+0.0');
  assert.equal(R.formatScore({ cp: 140 }), '+1.4');
  // -85 must not print as -0.8: the double nearest 0.85 rounds down.
  assert.equal(R.formatScore({ cp: -85 }), '-0.9');
  assert.equal(R.formatScore({ cp: 1250 }), '+13');
  assert.equal(R.formatScore({ mate: 3 }), 'M3');
  assert.equal(R.formatScore({ mate: -2 }), '-M2');
  assert.equal(R.formatScore(null), '');
});

test('the eval bar is centred at equality and never fully empty', () => {
  assert.equal(R.barFraction({ cp: 0 }), 0.5);
  assert.ok(R.barFraction({ cp: 500 }) > 0.5);
  assert.ok(R.barFraction({ cp: -500 }) < 0.5);
  // A bar pinned to the very edge stops showing any further change.
  assert.ok(R.barFraction({ cp: -3000 }) >= 0.03);
  assert.equal(R.barFraction({ mate: 1 }), 1);
  assert.equal(R.barFraction({ mate: -1 }), 0);
});

test('an unknown evaluation leaves the bar centred', () => {
  assert.equal(R.barFraction(null), 0.5);
});

/* ----------------------------------------------------------- openings --- */

test('openings are named by their longest known line', () => {
  assert.equal(O.lookup(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']).name, 'Spanische Partie');
  assert.equal(O.lookup(['e4', 'c5']).name, 'Sizilianische Verteidigung');
  assert.equal(O.lookup(['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'Bg7']).eco, 'E60');
});

test('a game past the book keeps the last name it reached', () => {
  const hit = O.lookup(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7', 'Re1', 'b5']);
  assert.equal(hit.name, 'Spanisch: Morphy-Verteidigung');
  assert.equal(hit.plies, 8);
});

test('an unknown opening is reported as unknown', () => {
  assert.equal(O.lookup(['h4', 'h5', 'a4']), null);
  assert.equal(O.lookup([]), null);
});

test('book moves are only book while they are still in the line', () => {
  const game = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'Qh4'];
  assert.equal(O.isBookMove(game, 0), true);
  assert.equal(O.isBookMove(game, 4), true);
  // 5...Qh4 is not theory, and analysis must be free to call it what it is.
  assert.equal(O.isBookMove(game, 5), false);
});
