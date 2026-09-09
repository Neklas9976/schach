/* Search worker.
 *
 * Runs entirely off the main thread so the board stays responsive - a search
 * blocking the UI thread would freeze dragging and stall the clock's render
 * loop, which is exactly what we spent effort avoiding elsewhere.
 *
 * Move generation and rule handling are delegated to chess-engine.js rather
 * than reimplemented here. A second, subtly different rule implementation
 * inside the AI is a classic source of illegal-move bugs.
 */

// chess.js zuerst: chess-engine.js baut darauf auf und bricht ohne es
// sofort ab, statt mit halben Regeln weiterzurechnen.
importScripts('vendor/chess.js', 'chess-engine.js');

const E = self.ChessEngine;

/* ------------------------------------------------------------------ *
 * Evaluation
 * ------------------------------------------------------------------ */

const VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

// Piece-square tables, written from White's point of view (rank 8 first) and
// mirrored for Black. These are what stop the engine from shuffling pieces
// aimlessly when no material is on offer.
const PST = {
  p: [
    [  0,  0,  0,  0,  0,  0,  0,  0],
    [ 50, 50, 50, 50, 50, 50, 50, 50],
    [ 10, 10, 20, 30, 30, 20, 10, 10],
    [  5,  5, 10, 25, 25, 10,  5,  5],
    [  0,  0,  0, 20, 20,  0,  0,  0],
    [  5, -5,-10,  0,  0,-10, -5,  5],
    [  5, 10, 10,-20,-20, 10, 10,  5],
    [  0,  0,  0,  0,  0,  0,  0,  0]
  ],
  n: [
    [-50,-40,-30,-30,-30,-30,-40,-50],
    [-40,-20,  0,  0,  0,  0,-20,-40],
    [-30,  0, 10, 15, 15, 10,  0,-30],
    [-30,  5, 15, 20, 20, 15,  5,-30],
    [-30,  0, 15, 20, 20, 15,  0,-30],
    [-30,  5, 10, 15, 15, 10,  5,-30],
    [-40,-20,  0,  5,  5,  0,-20,-40],
    [-50,-40,-30,-30,-30,-30,-40,-50]
  ],
  b: [
    [-20,-10,-10,-10,-10,-10,-10,-20],
    [-10,  0,  0,  0,  0,  0,  0,-10],
    [-10,  0,  5, 10, 10,  5,  0,-10],
    [-10,  5,  5, 10, 10,  5,  5,-10],
    [-10,  0, 10, 10, 10, 10,  0,-10],
    [-10, 10, 10, 10, 10, 10, 10,-10],
    [-10,  5,  0,  0,  0,  0,  5,-10],
    [-20,-10,-10,-10,-10,-10,-10,-20]
  ],
  r: [
    [  0,  0,  0,  0,  0,  0,  0,  0],
    [  5, 10, 10, 10, 10, 10, 10,  5],
    [ -5,  0,  0,  0,  0,  0,  0, -5],
    [ -5,  0,  0,  0,  0,  0,  0, -5],
    [ -5,  0,  0,  0,  0,  0,  0, -5],
    [ -5,  0,  0,  0,  0,  0,  0, -5],
    [ -5,  0,  0,  0,  0,  0,  0, -5],
    [  0,  0,  0,  5,  5,  0,  0,  0]
  ],
  q: [
    [-20,-10,-10, -5, -5,-10,-10,-20],
    [-10,  0,  0,  0,  0,  0,  0,-10],
    [-10,  0,  5,  5,  5,  5,  0,-10],
    [ -5,  0,  5,  5,  5,  5,  0, -5],
    [  0,  0,  5,  5,  5,  5,  0, -5],
    [-10,  5,  5,  5,  5,  5,  0,-10],
    [-10,  0,  5,  0,  0,  0,  0,-10],
    [-20,-10,-10, -5, -5,-10,-10,-20]
  ],
  k: [
    [-30,-40,-40,-50,-50,-40,-40,-30],
    [-30,-40,-40,-50,-50,-40,-40,-30],
    [-30,-40,-40,-50,-50,-40,-40,-30],
    [-30,-40,-40,-50,-50,-40,-40,-30],
    [-20,-30,-30,-40,-40,-30,-30,-20],
    [-10,-20,-20,-20,-20,-20,-20,-10],
    [ 20, 20,  0,  0,  0, 20, 20],
    [ 20, 30, 10,  0,  0, 10, 30, 20]
  ],
  // Once the queens are gone the king should walk towards the centre instead
  // of hiding, so the endgame gets its own table.
  kEnd: [
    [-50,-40,-30,-20,-20,-30,-40,-50],
    [-30,-20,-10,  0,  0,-10,-20,-30],
    [-30,-10, 20, 30, 30, 20,-10,-30],
    [-30,-10, 30, 40, 40, 30,-10,-30],
    [-30,-10, 30, 40, 40, 30,-10,-30],
    [-30,-10, 20, 30, 30, 20,-10,-30],
    [-30,-30,  0,  0,  0,  0,-30,-30],
    [-50,-30,-30,-30,-30,-30,-30,-50]
  ]
};

// The king table above has one short row; normalise every table once at load
// so a malformed row can never produce NaN scores deep inside the search.
for (const key of Object.keys(PST)) {
  PST[key] = PST[key].map(row => {
    const fixed = row.slice(0, 8);
    while (fixed.length < 8) fixed.push(0);
    return fixed;
  });
}

function isEndgame(board) {
  let queens = 0, majors = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = board[r][c];
      if (!piece) continue;
      const type = piece.toLowerCase();
      if (type === 'q') queens++;
      else if (type === 'r' || type === 'b' || type === 'n') majors++;
    }
  }
  return queens === 0 || majors <= 4;
}

/** Static evaluation in centipawns, always from White's point of view. */
function evaluate(state) {
  const board = state.board;
  const endgame = isEndgame(board);
  let score = 0;

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = board[r][c];
      if (!piece) continue;

      const white = piece === piece.toUpperCase();
      const type = piece.toLowerCase();
      const table = (type === 'k' && endgame) ? PST.kEnd : PST[type];
      // Black reads the same table from the mirrored rank.
      const positional = table[white ? r : 7 - r][c];
      const value = VALUE[type] + positional;
      score += white ? value : -value;
    }
  }

  return score;
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

const MATE = 100000;

let deadline = 0;
let aborted = false;
let nodes = 0;

function timeUp() {
  // Checking the clock on every node would dominate the profile, so it is
  // sampled instead. The search is time-boxed, not time-exact.
  if ((nodes & 1023) !== 0) return aborted;
  if (Date.now() >= deadline) aborted = true;
  return aborted;
}

/** Most Valuable Victim / Least Valuable Attacker, plus promotions first. */
function scoreMove(move) {
  let score = 0;
  if (move.captured) {
    score += 10 * VALUE[move.captured.toLowerCase()] - VALUE[move.piece.toLowerCase()];
  }
  if (move.isEnPassant) score += 10 * VALUE.p - VALUE.p;
  if (move.promotion) score += VALUE[move.promotion.toLowerCase()] || VALUE.q;
  if (move.isCastle) score += 60;
  return score;
}

function orderMoves(moves) {
  return moves
    .map(move => ({ move, score: scoreMove(move) }))
    .sort((a, b) => b.score - a.score)
    .map(entry => entry.move);
}

/**
 * Searches only forcing moves past the horizon. Without this the engine
 * happily "wins" a queen on the last ply and never sees the recapture.
 */
function quiescence(state, alpha, beta, colorSign) {
  nodes++;
  if (timeUp()) return colorSign * evaluate(state);

  const standPat = colorSign * evaluate(state);
  if (standPat >= beta) return beta;
  if (standPat > alpha) alpha = standPat;

  const captures = orderMoves(
    E.legalMoves(state).filter(m => m.captured || m.isEnPassant || m.promotion)
  );

  for (const move of captures) {
    const next = E.applyMove(state, move);
    const score = -quiescence(next, -beta, -alpha, -colorSign);
    if (aborted) return alpha;
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }

  return alpha;
}

function negamax(state, depth, alpha, beta, colorSign, ply) {
  nodes++;
  if (timeUp()) return colorSign * evaluate(state);

  const moves = E.legalMoves(state);

  if (moves.length === 0) {
    // Mate scores are adjusted by ply so the engine prefers the fastest mate
    // and delays being mated for as long as possible.
    if (E.isInCheck(state, state.turn)) return -MATE + ply;
    return 0; // stalemate
  }
  if (state.halfmove >= 100) return 0;

  if (depth === 0) return quiescence(state, alpha, beta, colorSign);

  let best = -Infinity;
  for (const move of orderMoves(moves)) {
    const next = E.applyMove(state, move);
    const score = -negamax(next, depth - 1, -beta, -alpha, -colorSign, ply + 1);
    if (aborted) return best === -Infinity ? alpha : best;
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break; // fail-high cutoff
  }

  return best;
}

/**
 * Iterative deepening: each depth is searched to completion, and the best move
 * of the last *finished* depth is kept. This is what makes the search safely
 * interruptible - stopping mid-depth can never return a half-evaluated move.
 */
function search(state, options) {
  const { maxDepth, maxTimeMs, randomness } = options;

  deadline = Date.now() + maxTimeMs;
  aborted = false;
  nodes = 0;

  const colorSign = state.turn === 'white' ? 1 : -1;
  const rootMoves = orderMoves(E.legalMoves(state));
  if (rootMoves.length === 0) return null;

  let bestMove = rootMoves[0];
  let bestScore = -Infinity;
  let reachedDepth = 0;

  for (let depth = 1; depth <= maxDepth; depth++) {
    let localBest = null;
    let localScore = -Infinity;
    const scored = [];

    let alpha = -Infinity;
    for (const move of rootMoves) {
      const next = E.applyMove(state, move);
      const score = -negamax(next, depth - 1, -Infinity, -alpha, -colorSign, 1);
      if (aborted) break;

      scored.push({ move, score });
      if (score > localScore) { localScore = score; localBest = move; }
      if (score > alpha) alpha = score;
    }

    if (aborted) break;

    reachedDepth = depth;
    bestMove = localBest || bestMove;
    bestScore = localScore;

    // Weaker levels deliberately pick from among near-best moves so they feel
    // human rather than always producing the same machine-perfect reply.
    if (randomness > 0 && scored.length > 1) {
      const window = randomness;
      const candidates = scored.filter(entry => entry.score >= localScore - window);
      bestMove = candidates[Math.floor(Math.random() * candidates.length)].move;
    }

    if (Math.abs(bestScore) > MATE - 1000) break; // forced mate found
    if (Date.now() >= deadline) break;
  }

  return { move: bestMove, score: bestScore, depth: reachedDepth, nodes };
}

/* ------------------------------------------------------------------ *
 * Worker protocol
 * ------------------------------------------------------------------ */

self.onmessage = event => {
  const { type, id, state, options } = event.data || {};
  if (type !== 'search') return;

  try {
    const result = search(state, options);
    self.postMessage({ type: 'result', id, result });
  } catch (error) {
    self.postMessage({ type: 'error', id, message: String(error && error.message || error) });
  }
};
