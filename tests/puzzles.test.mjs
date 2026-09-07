import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

/**
 * The puzzle module holds the part of the trainer that has to be right: what
 * counts as solved, what a mistake costs, and which puzzle comes next. None of
 * that touches the DOM, so all of it is checkable here.
 */

const code = fs.readFileSync(new URL('../static/puzzles.js', import.meta.url), 'utf8');
const appCode = fs.readFileSync(new URL('../static/app.js', import.meta.url), 'utf8');

/** A localStorage that behaves like the real one, including throwing. */
function fakeStorage(broken = false) {
  const map = new Map();
  return {
    getItem: key => { if (broken) throw new Error('quota'); return map.has(key) ? map.get(key) : null; },
    setItem: (key, value) => { if (broken) throw new Error('quota'); map.set(key, String(value)); },
    removeItem: key => { map.delete(key); }
  };
}

function load(options = {}) {
  const sandbox = { localStorage: options.storage || fakeStorage(), document: undefined, fetch: undefined };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox);
  return sandbox.window.ChessPuzzles;
}

const SAMPLE = [
  { id: 'a', fen: '8/8/8/8/8/8/8/K6k w - - 0 1', moves: ['a1b1'], rating: 800, themes: ['fork'] },
  { id: 'b', fen: '8/8/8/8/8/8/8/K6k w - - 0 1', moves: ['a1b1', 'h1g1', 'b1c1'], rating: 1200, themes: ['long'] },
  { id: 'c', fen: '8/8/8/8/8/8/8/K6k w - - 0 1', moves: ['a1b1'], rating: 1600, themes: ['mateIn1'], mateIn: 1 },
  { id: 'd', fen: '8/8/8/8/8/8/8/K6k w - - 0 1', moves: ['a1b1'], rating: 2000, themes: ['sacrifice'] }
];

test('a catalogue keeps only entries that can actually be solved', () => {
  const puzzles = load();
  const list = puzzles.setCatalogue([
    ...SAMPLE,
    { id: 'kaputt', fen: '8/8/8/8/8/8/8/K6k w - - 0 1', moves: [] },
    { id: 'auchkaputt', moves: ['a1b1'] },
    null
  ]);
  assert.equal(list.length, SAMPLE.length);
});

test('a puzzle without themes still carries one', () => {
  const puzzles = load();
  const [only] = puzzles.setCatalogue([{ id: 'x', fen: 'f', moves: ['a1b1'] }]);
  assert.deepEqual([...only.themes], ['advantage']);
});

test('the expected move solves a one-move puzzle', () => {
  const puzzles = load();
  puzzles.setCatalogue(SAMPLE);
  const session = puzzles.createSession(puzzles.byId('a'));
  assert.equal(session.expected(), 'a1b1');
  assert.equal(session.submit('a1b1').result, 'solved');
  assert.equal(session.finished, true);
});

test('a wrong move is refused without advancing the solution', () => {
  const puzzles = load();
  puzzles.setCatalogue(SAMPLE);
  const session = puzzles.createSession(puzzles.byId('b'));
  const wrong = session.submit('a1a2');
  assert.equal(wrong.result, 'wrong');
  assert.equal(wrong.reply, null);
  assert.equal(session.mistakes, 1);
  // Still waiting for the same move - a mistake must never skip a step.
  assert.equal(session.expected(), 'a1b1');
});

test('a correct move hands back the reply the board has to play', () => {
  const puzzles = load();
  puzzles.setCatalogue(SAMPLE);
  const session = puzzles.createSession(puzzles.byId('b'));
  const first = session.submit('a1b1');
  assert.equal(first.result, 'correct');
  assert.equal(first.reply, 'h1g1');
  // The reply is played by the program, so the next thing asked of the player
  // is the move after it, not the reply itself.
  assert.equal(session.expected(), 'b1c1');
  assert.equal(session.submit('b1c1').result, 'solved');
});

test('a different mate counts as solved', () => {
  // Positions often have more than one mate. Marking one of them wrong
  // because the generator happened to record the other would be plainly
  // incorrect, so a mating move ends a mate puzzle whatever its notation.
  const puzzles = load();
  puzzles.setCatalogue(SAMPLE);
  const session = puzzles.createSession(puzzles.byId('c'));
  assert.equal(session.submit('a1a2', { mates: true }).result, 'solved');
});

test('a move that merely checks does not pass for the solution', () => {
  const puzzles = load();
  puzzles.setCatalogue(SAMPLE);
  const session = puzzles.createSession(puzzles.byId('c'));
  assert.equal(session.submit('a1a2', { mates: false }).result, 'wrong');
});

test('solving raises the rating, failing lowers it', () => {
  const puzzles = load();
  const up = puzzles.nextRating(1000, 1400, true);
  const down = puzzles.nextRating(1000, 1400, false);
  assert.ok(up > 1000, `expected a gain, got ${up}`);
  assert.ok(down < 1000, `expected a loss, got ${down}`);
  // A hard puzzle is worth more than an easy one, and costs less to miss.
  assert.ok(puzzles.nextRating(1000, 1600, true) > puzzles.nextRating(1000, 900, true));
  assert.ok(puzzles.nextRating(1000, 1600, false) > puzzles.nextRating(1000, 900, false));
});

test('the rating stays inside the scale', () => {
  const puzzles = load();
  let rating = 400;
  for (let i = 0; i < 200; i++) rating = puzzles.nextRating(rating, 400, false);
  assert.ok(rating >= 400, `fell through the floor: ${rating}`);
  for (let i = 0; i < 400; i++) rating = puzzles.nextRating(rating, 2800, true);
  assert.ok(rating <= 2800, `went through the ceiling: ${rating}`);
});

test('a hint costs the rating point, not the puzzle', () => {
  const puzzles = load();
  puzzles.setCatalogue(SAMPLE);
  const puzzle = puzzles.byId('a');
  const session = puzzles.createSession(puzzle);
  session.hint();
  session.submit('a1b1');
  const before = puzzles.readProgress().rating;
  const after = puzzles.record(puzzle, session.outcome(true));
  // Solved with help: it counts as an attempt and moves the rating the way a
  // failure would, because the player did not find it themselves.
  assert.ok(after.rating < before, 'a hinted solve must not be rewarded');
  assert.equal(after.correct, 1);
  assert.equal(after.streak, 0);
  assert.equal(after.solved[puzzle.id], undefined);
});

test('a clean solve is remembered, a failure breaks the streak', () => {
  const puzzles = load();
  puzzles.setCatalogue(SAMPLE);
  let progress = puzzles.record(puzzles.byId('a'), { solved: true, usedHint: false, mistakes: 0 });
  progress = puzzles.record(puzzles.byId('b'), { solved: true, usedHint: false, mistakes: 0 });
  assert.equal(progress.streak, 2);
  assert.equal(progress.bestStreak, 2);
  progress = puzzles.record(puzzles.byId('c'), { solved: false, usedHint: false, mistakes: 1 });
  assert.equal(progress.streak, 0);
  // The best streak is a record, so a failure must not erase it.
  assert.equal(progress.bestStreak, 2);
  assert.equal(Object.keys(progress.solved).length, 2);
});

test('progress survives being written and read back', () => {
  const storage = fakeStorage();
  const first = load({ storage });
  first.setCatalogue(SAMPLE);
  first.record(first.byId('a'), { solved: true, usedHint: false, mistakes: 0 });
  const second = load({ storage });
  assert.equal(second.readProgress().rating, first.readProgress().rating);
  assert.equal(Object.keys(second.readProgress().solved).length, 1);
});

test('training still works when nothing can be stored', () => {
  // A private window, a full quota, storage switched off: the trainer has to
  // keep running and simply forget, not refuse to start.
  const puzzles = load({ storage: fakeStorage(true) });
  puzzles.setCatalogue(SAMPLE);
  assert.doesNotThrow(() => puzzles.record(puzzles.byId('a'), { solved: true, usedHint: false, mistakes: 0 }));
  assert.equal(puzzles.readProgress().rating, 1000);
});

test('the next puzzle is one the player has not solved', () => {
  const puzzles = load();
  puzzles.setCatalogue(SAMPLE);
  puzzles.record(puzzles.byId('a'), { solved: true, usedHint: false, mistakes: 0 });
  for (let i = 0; i < 30; i++) {
    assert.notEqual(puzzles.pick({ rating: 800 }).id, 'a');
  }
});

test('having solved everything starts the set over instead of stopping', () => {
  const puzzles = load();
  puzzles.setCatalogue(SAMPLE);
  for (const p of SAMPLE) puzzles.record(puzzles.byId(p.id), { solved: true, usedHint: false, mistakes: 0 });
  assert.ok(puzzles.pick({}), 'the trainer must not run dry');
});

test('the selection follows the rating', () => {
  const puzzles = load();
  puzzles.setCatalogue(SAMPLE);
  // With only four puzzles the pool holds all of them, so the *nearest* is
  // what has to be checked, not the random draw.
  const beginner = puzzles.pick({ rating: 700, random: () => 0 });
  const advanced = puzzles.pick({ rating: 2100, random: () => 0 });
  assert.equal(beginner.id, 'a');
  assert.equal(advanced.id, 'd');
});

test('a chosen theme is honoured', () => {
  const puzzles = load();
  puzzles.setCatalogue(SAMPLE);
  for (let i = 0; i < 20; i++) {
    assert.deepEqual([...puzzles.pick({ theme: 'mateIn1' }).themes], ['mateIn1']);
  }
});

test('a theme nothing matches falls back to the whole set', () => {
  const puzzles = load();
  puzzles.setCatalogue(SAMPLE);
  assert.ok(puzzles.pick({ theme: 'gibtesnicht' }));
});

test('the same puzzle does not come round twice in a row', () => {
  const puzzles = load();
  puzzles.setCatalogue(SAMPLE);
  for (let i = 0; i < 30; i++) {
    assert.notEqual(puzzles.pick({ exclude: 'b', rating: 1200 }).id, 'b');
  }
});

test('giving up hands back what is left of the solution', () => {
  const puzzles = load();
  puzzles.setCatalogue(SAMPLE);
  const session = puzzles.createSession(puzzles.byId('b'));
  session.submit('a1b1');
  assert.deepEqual([...session.giveUp()], ['b1c1']);
  assert.equal(session.usedHint, true);
  assert.equal(session.finished, true);
});

test('every theme the generator emits has a German label', () => {
  const puzzles = load();
  for (const theme of puzzles.THEME_ORDER) {
    assert.notEqual(puzzles.THEME_LABELS[theme], undefined, `no label for ${theme}`);
  }
  // Unknown ones fall back to their own name rather than showing "undefined".
  assert.equal(puzzles.themeLabel('etwasneues'), 'etwasneues');
});

test('statistics are derived from the catalogue, never counted up separately', () => {
  const puzzles = load();
  puzzles.setCatalogue(SAMPLE);
  puzzles.record(puzzles.byId('a'), { solved: true, usedHint: false, mistakes: 0 });
  const stats = puzzles.stats();
  assert.equal(stats.total, SAMPLE.length);
  assert.equal(stats.solved, 1);
  assert.equal(stats.remaining, SAMPLE.length - 1);
});

/* --- how the board treats a puzzle ------------------------------------- */

test('a puzzle silences everything that would give the answer away', () => {
  // The evaluation bar is the solution in one number: it jumps the moment the
  // right move lands. The engine must not play either - the replies are fixed.
  assert.match(appCode, /function evalEnabled\(\)\{[\s\S]{0,420}if\(puzzleMode\|\|onlineMode\) return false;/);
  assert.match(appCode, /async function maybeRequestComputerMove\(\)\{[\s\S]{0,260}if\(puzzleMode\|\|onlineMode\) return;/);
});

test('a puzzle is not a game: no clock, no result dialog, no archive entry', () => {
  assert.match(appCode, /if\(window\.ChessClock && !puzzleMode && !onlineMode\)\{/);
  assert.match(appCode, /function showGameOver\(st\)\{[\s\S]{0,420}if\(puzzleMode\|\|onlineMode\) return;/);
  assert.match(appCode, /function archiveFinishedGame\(outcome,reason\)\{\s*if\(puzzleMode\|\|onlineMode\) return null;/);
});

test('during a puzzle only the solving side may be moved', () => {
  // Both input paths go through inputColor, so the restriction belongs there
  // and nowhere else.
  assert.match(appCode, /function inputColor\(\)\{[\s\S]{0,600}if\(puzzleMode\)\{/);
  assert.match(appCode, /return state\.turn===puzzleMode\.side\?puzzleMode\.side:null;/);
});

test('the move that was played is available after it lands', () => {
  // The move list only carries from/to and the notation; telling a promotion
  // to a queen from one to a knight needs the move itself.
  assert.match(appCode, /movesLog\.push\(\{from:move\.from,to:move\.to,notation\}\);\s*lastCommittedMove=move;/);
});

test('a wrong move is taken back by exactly one ply', () => {
  // undo() steps back two against the computer, which would rewind the
  // opponent's move as well and leave the puzzle in a position it never had.
  assert.match(appCode, /function puzzleTakeBack\(\)\{/);
  assert.match(appCode, /const previous=history\.pop\(\);/);
});

test('training gives the game back instead of eating it', () => {
  // Starting a puzzle loads a position, and loadGame clears everything. A
  // player who presses "Puzzle" in the middle of a game would otherwise lose
  // it without a word.
  assert.match(appCode, /function captureGame\(\)\{/);
  assert.match(appCode, /function restoreGame\(saved\)\{/);
  assert.match(appCode, /if\(saved\) restoreGame\(saved\);\s*else newGame\(\);/);
  // Kept once on entering, not re-taken for every following puzzle - the
  // second capture would save a puzzle position as "the game".
  assert.match(appCode, /const carried=puzzleMode\?puzzleMode\.savedGame\s*:\(\(movesLog\.length&&!gameEnded\)\?captureGame\(\):null\);/);
});
