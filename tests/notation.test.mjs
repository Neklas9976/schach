import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const engineCode = fs.readFileSync(new URL('../static/chess-engine.js', import.meta.url), 'utf8');
const notationCode = fs.readFileSync(new URL('../static/notation.js', import.meta.url), 'utf8');

const sandbox = { window: {} };
sandbox.globalThis = sandbox;
vm.runInNewContext(engineCode, sandbox);
vm.runInNewContext(notationCode, sandbox);

const E = sandbox.window.ChessEngine;
const N = sandbox.window.ChessNotation;

// Values built inside the vm context carry that realm's prototypes, which
// assert.deepEqual treats as a mismatch. Copying into host objects compares
// the data rather than the realm.
const sansOf = plies => [...plies.map(p => p.san)];
const plain = obj => ({ ...obj });

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Plays a list of SAN moves and returns the ply entries plus the final state. */
function play(sans, fen = null) {
  let state = fen ? E.fromFen(fen) : E.createInitialState();
  const plies = [];
  for (const san of sans) {
    const hit = N.resolveSan(state, san);
    assert.ok(hit, `"${san}" must be legal`);
    plies.push({ san: hit.san });
    state = hit.next;
  }
  return { plies, state };
}

/* ---------------------------------------------------------------- FEN --- */

test('the initial position round-trips through FEN', () => {
  assert.equal(E.toFen(E.createInitialState()), START_FEN);
  assert.equal(E.toFen(E.fromFen(START_FEN)), START_FEN);
});

test('FEN carries the halfmove clock and move number', () => {
  // fenKey deliberately drops both, so this is the difference between the
  // repetition key and a FEN that can restore a game.
  const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 7 42';
  const state = E.fromFen(fen);
  assert.equal(state.halfmove, 7);
  assert.equal(state.fullmove, 42);
  assert.equal(state.turn, 'black');
  assert.equal(E.toFen(state), fen);
});

test('FEN restores castling rights and the en passant square', () => {
  const fen = 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w Kq c6 0 2';
  const state = E.fromFen(fen);
  assert.deepEqual(plain(state.castling), { K: true, Q: false, k: false, q: true });
  assert.deepEqual([...state.ep], [2, 2]);
  assert.equal(E.toFen(state), fen);
});

test('a position from FEN generates the same moves as one that was played', () => {
  // The real test of a parser: the resulting state must be usable, not merely
  // shaped correctly.
  const played = play(['e4', 'c5', 'Nf3']).state;
  const parsed = E.fromFen(E.toFen(played));
  assert.equal(E.legalMoves(parsed).length, E.legalMoves(played).length);
  assert.equal(E.toFen(parsed), E.toFen(played));
});

test('en passant survives the FEN round trip as a playable move', () => {
  const { state } = play(['e4', 'a6', 'e5', 'd5']);
  const parsed = E.fromFen(E.toFen(state));
  const ep = E.legalMoves(parsed).find(m => m.isEnPassant);
  assert.ok(ep, 'exd6 e.p. must still be available after re-parsing');
});

test('malformed FEN is rejected with a reason', () => {
  const cases = [
    ['', /Text|unvollständig/],
    ['8/8/8/8/8/8/8 w - - 0 1', /acht Reihen/],
    ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1', /Zugrecht/],
    ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w XY - 0 1', /Rochaderechte/],
    ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq e9 0 1', /en-passant/],
    ['rnbqkbnr/ppppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', /statt 8 Felder/],
    ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQ1BNR w KQkq - 0 1', /Könige/]
  ];
  for (const [fen, pattern] of cases) {
    assert.throws(() => E.fromFen(fen), pattern, `"${fen}" must be rejected`);
  }
});

test('a position with the side not to move in check is rejected', () => {
  // White to move while the black king stands in check from Re7. Black would
  // have had to leave themselves in check, so no legal game reaches this.
  assert.throws(() => E.fromFen('4k3/4R3/8/8/8/8/8/4K3 w - - 0 1'), /Schach/);
});

test('a legal check against the side to move is accepted', () => {
  // The mirror case must still load: after 1.f3 e5 2.g4 Qh4# it is White to
  // move and White is in check. Rejecting this would break loading real games.
  const mated = E.fromFen('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3');
  assert.equal(E.status(mated, {}).type, 'checkmate');
});

/* ---------------------------------------------------------------- PGN --- */

test('a played game exports as PGN and reads back identically', () => {
  const sans = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7'];
  const { plies } = play(sans);
  const pgn = N.toPgn({ moves: plies, headers: { White: 'Ich', Black: 'Stockfish' }, result: '*' });

  assert.match(pgn, /\[White "Ich"\]/);
  assert.match(pgn, /1\. e4 e5 2\. Nf3/);

  const parsed = N.fromPgn(pgn);
  assert.equal(parsed.plies.length, sans.length);
  assert.deepEqual(sansOf(parsed.plies), sansOf(plies));
  assert.equal(parsed.headers.Black, 'Stockfish');
});

test('PGN import replays the moves onto real positions', () => {
  const parsed = N.fromPgn('1. e4 e5 2. Nf3 Nc6 3. Bb5 *');
  assert.equal(parsed.plies.length, 5);
  // The last entry must carry the position after 3.Bb5, not merely the text.
  assert.equal(E.toFen(parsed.plies[4].state), 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3');
});

test('comments, variations and glyphs are ignored', () => {
  // Nested variations are the case a single non-greedy regex gets wrong: it
  // closes at the inner ")" and feeds the remainder back in as real moves.
  const pgn = '1. e4 {a good start} e5 (1... c5 (1... e6 2. d4) 2. Nf3) 2. Nf3 $1 Nc6 ; trailing\n*';
  const parsed = N.fromPgn(pgn);
  assert.deepEqual(sansOf(parsed.plies), ['e4', 'e5', 'Nf3', 'Nc6']);
});

test('castling written with zeros is accepted', () => {
  const parsed = N.fromPgn('1. e4 e5 2. Nf3 Nf6 3. Bc4 Bc5 4. 0-0 0-0 *');
  assert.equal(parsed.plies.length, 8);
  assert.equal(parsed.plies[6].san, 'O-O');
  assert.equal(parsed.plies[7].san, 'O-O');
});

test('an illegal move in a PGN is reported with its move number', () => {
  // Bb4 is not on any diagonal either bishop can reach.
  assert.throws(() => N.fromPgn('1. e4 e5 2. Bb4 *'), /Zug 2\. Bb4/);
});

test('a game starting from a FEN keeps that position', () => {
  const fen = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1';
  const pgn = N.toPgn({ moves: play(['e4'], fen).plies, startFen: fen, result: '*' });
  assert.match(pgn, /\[SetUp "1"\]/);
  assert.match(pgn, /\[FEN "4k3/);

  const parsed = N.fromPgn(pgn);
  assert.equal(parsed.startFen, fen);
  assert.equal(parsed.plies.length, 1);
  assert.equal(parsed.plies[0].san, 'e4');
});

test('a game continuing from a black-to-move position is numbered correctly', () => {
  const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
  const pgn = N.toPgn({ moves: play(['c5'], fen).plies, startFen: fen, result: '*' });
  assert.match(pgn, /1\.\.\. c5/, 'black-to-move must open with the ellipsis form');
  assert.deepEqual(sansOf(N.fromPgn(pgn).plies), ['c5']);
});

test('the standard start position adds no SetUp tag', () => {
  const pgn = N.toPgn({ moves: play(['e4']).plies, startFen: START_FEN });
  assert.equal(/SetUp/.test(pgn), false);
});

test('movetext wraps at 80 columns', () => {
  const sans = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7', 'Re1', 'b5', 'Bb3', 'd6', 'c3', 'O-O'];
  const pgn = N.toPgn({ moves: play(sans).plies });
  const movetext = pgn.split('\n\n')[1];
  for (const line of movetext.split('\n')) assert.ok(line.length <= 80, `line too long: ${line}`);
  assert.ok(movetext.split('\n').length > 1, 'this game must actually need wrapping');
});

test('checkmate is written with # and read back', () => {
  const { plies } = play(['f3', 'e5', 'g4', 'Qh4']);
  assert.equal(plies[3].san, 'Qh4#');
  assert.deepEqual(sansOf(N.fromPgn(N.toPgn({ moves: plies, result: '0-1' })).plies), sansOf(plies));
});

test('a result token is picked up from the movetext', () => {
  assert.equal(N.fromPgn('1. f3 e5 2. g4 Qh4# 0-1').result, '0-1');
});

test('results map from the engine status', () => {
  assert.equal(N.resultFor({ type: 'checkmate', winner: 'white' }), '1-0');
  assert.equal(N.resultFor({ type: 'checkmate', winner: 'black' }), '0-1');
  assert.equal(N.resultFor({ type: 'stalemate' }), '1/2-1/2');
  assert.equal(N.resultFor({ type: 'ongoing' }), '*');
  assert.equal(N.resultFor(null, 'white'), '0-1', 'a flag fall is a loss for the player who ran out');
});

test('promotion notation survives a round trip', () => {
  const fen = '4k3/P7/8/8/8/8/8/4K3 w - - 0 1';
  const { plies } = play(['a8=Q'], fen);
  assert.equal(plies[0].san, 'a8=Q+');
  const parsed = N.fromPgn(N.toPgn({ moves: plies, startFen: fen }));
  assert.equal(parsed.plies[0].san, 'a8=Q+');
});

test('a promotion written without the equals sign is still understood', () => {
  const parsed = N.fromPgn('[SetUp "1"]\n[FEN "4k3/P7/8/8/8/8/8/4K3 w - - 0 1"]\n\n1. a8Q *');
  assert.equal(parsed.plies[0].san, 'a8=Q+');
});

test('header values are never mistaken for moves', () => {
  // A player called "Bc4" is contrived, but an Event named "e4 Open" is not.
  const parsed = N.fromPgn('[Event "e4 Open"]\n[White "Bc4"]\n\n1. d4 d5 *');
  assert.deepEqual(sansOf(parsed.plies), ['d4', 'd5']);
});
