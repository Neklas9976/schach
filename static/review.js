/**
 * Game review: turning engine evaluations into per-move judgements.
 *
 * This is deliberately a transparent approximation of what chess.com shows,
 * not a copy of it. Their classifier and accuracy score are proprietary and
 * undocumented, so anything claiming to reproduce them exactly would be
 * guessing. What is implemented here is the published, checkable approach:
 * convert each evaluation to a win probability, measure how much of it a move
 * gave away, and label the result. Every threshold is a named constant so it
 * can be argued with.
 *
 * Pure functions only - no DOM, no network. The orchestration (asking the
 * engine for evaluations, drawing the result) lives in app.js.
 */
(function (global) {
  'use strict';

  /**
   * Centipawns to win probability, in percent, from the mover's point of view.
   *
   * The logistic constant is the one fitted by Lichess against a large game
   * database. Win probability, not raw centipawns, is what makes a judgement
   * fair: giving away 100 centipawns matters enormously at +0.2 and barely at
   * all at +9, and a centipawn-only rule would call both the same mistake.
   */
  function winProbability(cp) {
    return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
  }

  // A forced mate is not a finite score. Treating it as a very large centipawn
  // value keeps one comparison path instead of special-casing every caller;
  // the value is far beyond any material advantage, so it always sorts first.
  const MATE_SCORE = 10000;

  /**
   * Normalises an engine reply to centipawns from White's perspective.
   * `mate` counts moves to mate and keeps its sign.
   */
  function toCentipawns(evaluation) {
    if (!evaluation) return null;
    if (evaluation.mate != null) {
      return evaluation.mate > 0 ? MATE_SCORE - evaluation.mate : -MATE_SCORE - evaluation.mate;
    }
    if (evaluation.cp != null) return evaluation.cp;
    return null;
  }

  /** Flips a White-relative score to the given player's perspective. */
  function forMover(cp, mover) {
    return mover === 'white' ? cp : -cp;
  }

  const LABELS = {
    book:        { key: 'book',        label: 'Buchzug',        symbol: '📖', tone: 'neutral' },
    brilliant:   { key: 'brilliant',   label: 'Glanzzug',       symbol: '!!', tone: 'brilliant' },
    great:       { key: 'great',       label: 'Starker Zug',    symbol: '!',  tone: 'great' },
    best:        { key: 'best',        label: 'Bester Zug',     symbol: '★',  tone: 'best' },
    excellent:   { key: 'excellent',   label: 'Ausgezeichnet',  symbol: '✓',  tone: 'good' },
    good:        { key: 'good',        label: 'Gut',            symbol: '✓',  tone: 'good' },
    inaccuracy:  { key: 'inaccuracy',  label: 'Ungenauigkeit',  symbol: '?!', tone: 'warn' },
    mistake:     { key: 'mistake',     label: 'Fehler',         symbol: '?',  tone: 'bad' },
    blunder:     { key: 'blunder',     label: 'Grober Fehler',  symbol: '??', tone: 'worst' }
  };

  // Thresholds in lost win probability (percentage points), not centipawns.
  // The inaccuracy/mistake/blunder boundaries are the widely used 10/20/30
  // scale; the excellent split above them separates "found the idea" from
  // "played something reasonable".
  const THRESHOLDS = {
    excellent: 2,
    good: 10,
    inaccuracy: 20,
    mistake: 30
  };

  /**
   * Judges a single move.
   *
   * `before` is the evaluation of the position the mover faced, `after` the
   * evaluation of what they left behind - both from White's perspective, both
   * as {cp} or {mate}. `bestMove`/`playedMove` are UCI strings when known.
   */
  function classifyMove({ before, after, mover, isBook = false, bestMove = null, playedMove = null, sacrifice = false }) {
    const beforeCp = toCentipawns(before);
    const afterCp = toCentipawns(after);
    if (beforeCp == null || afterCp == null) return { ...LABELS.good, lostWinPercent: 0, cpLoss: 0, unknown: true };

    const beforeWp = winProbability(forMover(beforeCp, mover));
    const afterWp = winProbability(forMover(afterCp, mover));
    // A move can only lose ground for the player who made it: an improvement
    // means the engine's preferred line was not better, not that the player
    // gained something the position did not contain.
    const lost = Math.max(0, beforeWp - afterWp);
    const cpLoss = Math.max(0, forMover(beforeCp, mover) - forMover(afterCp, mover));

    const base = { lostWinPercent: lost, cpLoss };

    if (isBook) return { ...LABELS.book, ...base };

    const wasBest = !!bestMove && !!playedMove && bestMove === playedMove;

    // A sacrifice that is still the best move, in a position that stays at
    // least equal, is the one case worth singling out - it is the move a
    // player would not have found by counting material.
    if (wasBest && sacrifice && lost <= THRESHOLDS.excellent && forMover(afterCp, mover) > -100) {
      return { ...LABELS.brilliant, ...base };
    }
    if (wasBest) return { ...LABELS.best, ...base };

    if (lost <= THRESHOLDS.excellent) return { ...LABELS.excellent, ...base };
    if (lost <= THRESHOLDS.good) return { ...LABELS.good, ...base };
    if (lost <= THRESHOLDS.inaccuracy) return { ...LABELS.inaccuracy, ...base };
    if (lost <= THRESHOLDS.mistake) return { ...LABELS.mistake, ...base };
    return { ...LABELS.blunder, ...base };
  }

  /**
   * Accuracy for one move, 0-100.
   *
   * The exponential fit is Lichess's published mapping from lost win
   * probability to a percentage. It is steep near zero on purpose: the
   * difference between giving away nothing and giving away three points of
   * win probability is what separates strong play from ordinary play.
   */
  function moveAccuracy(lostWinPercent) {
    const value = 103.1668 * Math.exp(-0.04354 * lostWinPercent) - 3.1669;
    return Math.max(0, Math.min(100, value));
  }

  /**
   * Accuracy over a list of moves by one player.
   *
   * A plain mean is used rather than a volatility-weighted one. The weighted
   * version needs a window over the whole game and produces numbers that are
   * hard to explain when someone asks why a move counted for so much; an
   * honest mean of per-move accuracies is defensible on its own.
   */
  function accuracyOf(moves) {
    const scored = moves.filter(m => !m.unknown);
    if (!scored.length) return null;
    const total = scored.reduce((sum, m) => sum + moveAccuracy(m.lostWinPercent), 0);
    return total / scored.length;
  }

  /** Counts each label, for the summary table. */
  function summarise(moves) {
    const counts = {};
    for (const key of Object.keys(LABELS)) counts[key] = 0;
    for (const move of moves) if (counts[move.key] != null) counts[move.key]++;
    return counts;
  }

  /**
   * Formats an evaluation the way a board shows it: "+1.4", "-0.8", "M3".
   * Always from White's perspective, which is the convention every eval bar
   * and engine output uses.
   */
  function formatScore(evaluation) {
    if (!evaluation) return '';
    if (evaluation.mate != null) {
      if (evaluation.mate === 0) return '#';
      return `${evaluation.mate > 0 ? '' : '-'}M${Math.abs(evaluation.mate)}`;
    }
    if (evaluation.cp == null) return '';
    const negative = evaluation.cp < 0;
    const magnitude = Math.abs(evaluation.cp);
    // Rounded on the integer centipawn value rather than on cp/100. The double
    // nearest 0.85 is slightly below it, so (0.85).toFixed(1) is "0.8" - an
    // evaluation of -85 would be shown as -0.8 and the bar would disagree with
    // the number printed on it.
    const text = magnitude >= 1000
      ? String(Math.round(magnitude / 100))
      : (Math.round(magnitude / 10) / 10).toFixed(1);
    return `${negative ? '-' : '+'}${text}`;
  }

  /**
   * How full the white side of the eval bar should be, 0-1.
   *
   * Clamped well before the extremes: a bar that empties completely at +5
   * stops telling you anything about the difference between +5 and +12, and a
   * mate score would otherwise pin it flat for the rest of the game.
   */
  function barFraction(evaluation) {
    const cp = toCentipawns(evaluation);
    if (cp == null) return 0.5;
    if (cp >= MATE_SCORE - 1000) return 1;
    if (cp <= -(MATE_SCORE - 1000)) return 0;
    return Math.max(0.03, Math.min(0.97, winProbability(cp) / 100));
  }

  const api = {
    LABELS, THRESHOLDS, MATE_SCORE,
    winProbability, toCentipawns, classifyMove, moveAccuracy, accuracyOf, summarise,
    formatScore, barFraction
  };

  if (typeof window !== 'undefined') window.ChessReview = api;
  else (typeof self !== 'undefined' ? self : globalThis).ChessReview = api;
})(typeof window !== 'undefined' ? window : self);
