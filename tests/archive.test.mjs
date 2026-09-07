import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const archiveCode = fs.readFileSync(new URL('../static/archive.js', import.meta.url), 'utf8');

/** A fresh module with its own storage, so tests cannot leak into each other. */
function loadArchive({ store = new Map(), failWrites = false } = {}) {
  const sandbox = {
    window: {},
    localStorage: {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => {
        if (failWrites) throw new Error('QuotaExceededError');
        store.set(key, value);
      },
      removeItem: key => store.delete(key)
    }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(archiveCode, sandbox);
  return { A: sandbox.window.ChessArchive, store };
}

const game = (patch = {}) => ({
  playedAt: '2026-01-01T10:00:00.000Z',
  result: '1-0',
  outcome: 'win',
  mode: 'human-vs-computer',
  level: 4,
  moves: 30,
  pgn: '1. e4 e5 1-0',
  ...patch
});

/* ---------------------------------------------------------- storage --- */

test('a saved game comes back with an id and a timestamp', () => {
  const { A } = loadArchive();
  const saved = A.save({ result: '1-0', pgn: '1. e4 1-0' });
  assert.ok(saved.id);
  assert.ok(saved.playedAt);
  assert.equal(A.list().length, 1);
});

test('games are listed newest first', () => {
  const { A } = loadArchive();
  A.save(game({ playedAt: '2026-01-01T10:00:00.000Z', pgn: 'first' }));
  A.save(game({ playedAt: '2026-03-01T10:00:00.000Z', pgn: 'third' }));
  A.save(game({ playedAt: '2026-02-01T10:00:00.000Z', pgn: 'second' }));
  assert.deepEqual([...A.list().map(g => g.pgn)], ['third', 'second', 'first']);
});

test('saving with an existing id replaces that game instead of adding one', () => {
  // A game can finish twice: take the mate back, play on, finish again. The
  // archive must hold the game as completed, not two versions of it.
  const { A } = loadArchive();
  const first = A.save(game({ moves: 30 }));
  A.save({ ...first, moves: 42, result: '0-1', outcome: 'loss' });
  const all = A.list();
  assert.equal(all.length, 1);
  assert.equal(all[0].moves, 42);
  assert.equal(all[0].outcome, 'loss');
});

test('a review can add its accuracies to a game that is already saved', () => {
  const { A } = loadArchive();
  const saved = A.save(game());
  A.update(saved.id, { accuracy: 91.4 });
  assert.equal(A.find(saved.id).accuracy, 91.4);
  assert.equal(A.list().length, 1);
});

test('updating a game that is not there changes nothing', () => {
  const { A } = loadArchive();
  A.save(game());
  assert.equal(A.update('does-not-exist', { accuracy: 50 }), null);
  assert.equal(A.list().length, 1);
});

test('the oldest games fall off once the cap is reached', () => {
  const { A } = loadArchive();
  for (let i = 0; i < A.MAX_GAMES + 12; i++) {
    A.save(game({ playedAt: `2026-01-01T${String(i % 24).padStart(2, '0')}:00:00.${String(i).padStart(3, '0')}Z`, moves: i }));
  }
  const all = A.list();
  assert.equal(all.length, A.MAX_GAMES);
  // The very first games must be the ones that went.
  assert.equal(all.some(g => g.moves === 0), false);
});

test('deleting removes only the game asked for', () => {
  const { A } = loadArchive();
  const keep = A.save(game({ pgn: 'keep' }));
  const drop = A.save(game({ pgn: 'drop' }));
  A.remove(drop.id);
  assert.deepEqual([...A.list().map(g => g.pgn)], ['keep']);
  assert.ok(A.find(keep.id));
});

test('clearing empties the archive', () => {
  const { A } = loadArchive();
  A.save(game());
  A.clear();
  assert.deepEqual([...A.list()], []);
});

test('a storage that refuses writes does not throw', () => {
  // Private mode, a full quota, storage switched off. Losing the archive must
  // never take the game down with it.
  const { A } = loadArchive({ failWrites: true });
  assert.doesNotThrow(() => A.save(game()));
  assert.deepEqual([...A.list()], []);
});

test('corrupted storage reads as an empty archive', () => {
  const store = new Map([['chess-archive', '{not json']]);
  const { A } = loadArchive({ store });
  assert.deepEqual([...A.list()], []);
  assert.doesNotThrow(() => A.save(game()));
});

test('storage holding the wrong shape is ignored rather than trusted', () => {
  const store = new Map([['chess-archive', '"a string"']]);
  const { A } = loadArchive({ store });
  assert.deepEqual([...A.list()], []);
});

/* ------------------------------------------------------- statistics --- */

test('an empty archive reports zeros, not nulls that break arithmetic', () => {
  const { A } = loadArchive();
  const s = A.stats([]);
  assert.equal(s.total, 0);
  assert.equal(s.wins, 0);
  assert.equal(s.winRate, null);
  assert.deepEqual({ ...s.byLevel }, {});
});

test('wins, draws and losses are counted', () => {
  const { A } = loadArchive();
  const s = A.stats([
    game({ outcome: 'win' }), game({ outcome: 'win' }),
    game({ outcome: 'draw' }), game({ outcome: 'loss' })
  ]);
  assert.equal(s.total, 4);
  assert.equal(s.wins, 2);
  assert.equal(s.draws, 1);
  assert.equal(s.losses, 1);
});

test('a draw counts half, the way a chess score does', () => {
  const { A } = loadArchive();
  assert.equal(A.stats([game({ outcome: 'win' }), game({ outcome: 'loss' })]).winRate, 50);
  assert.equal(A.stats([game({ outcome: 'draw' }), game({ outcome: 'draw' })]).winRate, 50);
});

test('games between two people are archived but not counted as a record', () => {
  // There is no "you" in a game at one board, so a win there would belong to
  // nobody and would make the tally meaningless.
  const { A } = loadArchive();
  const s = A.stats([
    game({ outcome: 'win' }),
    game({ mode: 'human-vs-human', outcome: null, level: null })
  ]);
  assert.equal(s.total, 2, 'both are in the archive');
  assert.equal(s.rated, 1, 'only one has a result that is yours');
  assert.equal(s.wins, 1);
});

test('results are broken down by difficulty', () => {
  const { A } = loadArchive();
  const s = A.stats([
    game({ level: 4, outcome: 'win' }),
    game({ level: 4, outcome: 'loss' }),
    game({ level: 8, outcome: 'loss' })
  ]);
  assert.equal(s.byLevel['4'].games, 2);
  assert.equal(s.byLevel['4'].wins, 1);
  assert.equal(s.byLevel['8'].losses, 1);
});

test('a win streak is broken by a draw as well as by a loss', () => {
  const { A } = loadArchive();
  const at = n => `2026-01-0${n}T10:00:00.000Z`;
  const s = A.stats([
    game({ playedAt: at(1), outcome: 'win' }),
    game({ playedAt: at(2), outcome: 'win' }),
    game({ playedAt: at(3), outcome: 'draw' }),
    game({ playedAt: at(4), outcome: 'win' })
  ]);
  assert.equal(s.longestWinStreak, 2);
  assert.equal(s.currentStreak, 1);
});

test('the streak is read in the order the games were played, not stored', () => {
  const { A } = loadArchive();
  const s = A.stats([
    game({ playedAt: '2026-01-09T10:00:00.000Z', outcome: 'loss' }),
    game({ playedAt: '2026-01-01T10:00:00.000Z', outcome: 'win' }),
    game({ playedAt: '2026-01-05T10:00:00.000Z', outcome: 'win' })
  ]);
  assert.equal(s.longestWinStreak, 2);
  assert.equal(s.currentStreak, 0, 'the most recent game was a loss');
});

test('accuracy is averaged over the games that were actually reviewed', () => {
  const { A } = loadArchive();
  const s = A.stats([
    game({ accuracy: 90 }),
    game({ accuracy: 80 }),
    game({})            // never reviewed
  ]);
  assert.equal(s.averageAccuracy, 85);
  assert.equal(s.bestAccuracy, 90);
});

test('an archive with no reviews reports no accuracy rather than zero', () => {
  const { A } = loadArchive();
  const s = A.stats([game(), game()]);
  assert.equal(s.averageAccuracy, null);
  assert.equal(s.bestAccuracy, null);
});

test('the most played openings are listed', () => {
  const { A } = loadArchive();
  const s = A.stats([
    game({ opening: 'Sizilianisch' }),
    game({ opening: 'Sizilianisch' }),
    game({ opening: 'Französisch' })
  ]);
  assert.equal(s.openings[0].name, 'Sizilianisch');
  assert.equal(s.openings[0].count, 2);
  assert.equal(s.openings.length, 2);
});

test('statistics are derived from the list, never from stored counters', () => {
  // Counters drift: a deleted game, a game saved twice, a path someone adds
  // later that forgets to increment. Deriving means they cannot disagree.
  const { A } = loadArchive();
  A.save(game({ outcome: 'win' }));
  const loss = A.save(game({ outcome: 'loss' }));
  assert.equal(A.stats(A.list()).losses, 1);
  A.remove(loss.id);
  assert.equal(A.stats(A.list()).losses, 0);
  assert.equal(A.stats(A.list()).wins, 1);
});
