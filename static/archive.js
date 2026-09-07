/**
 * The archive of finished games, and the statistics derived from it.
 *
 * Stored in localStorage as PGN plus a small header per game. PGN rather than
 * a private format because it is the one thing every other chess program can
 * read: an archive nobody else can open is a diary, not a record.
 *
 * The statistics are computed from the list every time instead of being kept
 * as running totals. Totals drift - a deleted game, a game saved twice, a
 * counter incremented on a path someone later added - and there is no way to
 * notice. Deriving them means the numbers cannot disagree with the games.
 */
(function (global) {
  'use strict';

  const KEY = 'chess-archive';

  // localStorage is a few megabytes for the whole origin. A game is well under
  // a kilobyte, so this cap is nowhere near the limit; it exists so an archive
  // left running for years does not quietly grow without bound.
  const MAX_GAMES = 200;

  function read() {
    try {
      const raw = localStorage.getItem(KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }

  function write(games) {
    try {
      localStorage.setItem(KEY, JSON.stringify(games));
      return true;
    } catch {
      // Quota, private mode, storage disabled. Losing the archive must never
      // take the game down with it.
      return false;
    }
  }

  /** Newest first, which is the order anyone wants to read a game list in. */
  function list() {
    return read().sort((a, b) => String(b.playedAt).localeCompare(String(a.playedAt)));
  }

  function find(id) {
    return read().find(game => game.id === id) || null;
  }

  function nextId() {
    return `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  /**
   * Adds a game, or replaces the one with the same id.
   *
   * Replacing matters because a game can finish more than once: take a move
   * back after mate and play on, and the archive must end up with the game as
   * it was actually completed, not two versions of it.
   */
  function save(record) {
    const games = read();
    const id = record.id || nextId();
    const entry = { ...record, id, playedAt: record.playedAt || new Date().toISOString() };

    const at = games.findIndex(game => game.id === id);
    if (at >= 0) games[at] = entry;
    else games.push(entry);

    // Oldest first, so slicing from the end keeps the most recent games.
    games.sort((a, b) => String(a.playedAt).localeCompare(String(b.playedAt)));
    const kept = games.slice(-MAX_GAMES);

    write(kept);
    return entry;
  }

  /** Merges fields into an existing game, e.g. accuracies once a review ran. */
  function update(id, patch) {
    const games = read();
    const at = games.findIndex(game => game.id === id);
    if (at < 0) return null;
    games[at] = { ...games[at], ...patch };
    write(games);
    return games[at];
  }

  function remove(id) {
    write(read().filter(game => game.id !== id));
  }

  function clear() {
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  }

  const EMPTY = {
    total: 0, rated: 0, wins: 0, draws: 0, losses: 0,
    winRate: null, averageAccuracy: null, bestAccuracy: null,
    currentStreak: 0, longestWinStreak: 0, byLevel: {}, openings: []
  };

  /**
   * Summarises a list of games. Pure - it never touches storage, so the
   * numbers can be checked against a list built in a test.
   *
   * Win/loss/draw counts only cover games against the computer. Two people at
   * one board have no "you" whose record this would be, and counting those
   * would make the tally meaningless.
   */
  function stats(games) {
    if (!Array.isArray(games) || !games.length) return { ...EMPTY };

    const ordered = [...games].sort((a, b) => String(a.playedAt).localeCompare(String(b.playedAt)));
    const summary = { ...EMPTY, total: ordered.length, byLevel: {}, openings: [] };

    const accuracies = [];
    const openingCounts = new Map();
    let streak = 0;

    for (const game of ordered) {
      if (game.opening) openingCounts.set(game.opening, (openingCounts.get(game.opening) || 0) + 1);

      if (typeof game.accuracy === 'number') accuracies.push(game.accuracy);

      if (!game.outcome) continue;  // human vs human
      summary.rated++;

      if (game.outcome === 'win') summary.wins++;
      else if (game.outcome === 'loss') summary.losses++;
      else summary.draws++;

      // A streak counts consecutive wins and is broken by anything else, so a
      // draw does not quietly extend it.
      streak = game.outcome === 'win' ? streak + 1 : 0;
      summary.longestWinStreak = Math.max(summary.longestWinStreak, streak);

      const level = game.level == null ? 'unbekannt' : String(game.level);
      const bucket = summary.byLevel[level] || (summary.byLevel[level] = { games: 0, wins: 0, draws: 0, losses: 0 });
      bucket.games++;
      if (game.outcome === 'win') bucket.wins++;
      else if (game.outcome === 'loss') bucket.losses++;
      else bucket.draws++;
    }

    summary.currentStreak = streak;
    if (summary.rated) {
      // Draws count as half, the way a score is kept in chess.
      summary.winRate = (summary.wins + summary.draws / 2) / summary.rated * 100;
    }
    if (accuracies.length) {
      summary.averageAccuracy = accuracies.reduce((sum, value) => sum + value, 0) / accuracies.length;
      summary.bestAccuracy = Math.max(...accuracies);
    }

    summary.openings = [...openingCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));

    return summary;
  }

  const api = { KEY, MAX_GAMES, list, find, save, update, remove, clear, stats };

  if (typeof window !== 'undefined') window.ChessArchive = api;
  else (typeof self !== 'undefined' ? self : globalThis).ChessArchive = api;
})(typeof window !== 'undefined' ? window : self);
