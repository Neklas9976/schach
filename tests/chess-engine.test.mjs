import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
const code = fs.readFileSync(new URL('../static/chess-engine.js', import.meta.url), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(code, sandbox);
const E = sandbox.window.ChessEngine;

test('start position has 20 legal moves', () => {
  const s=E.createInitialState();
  assert.equal(E.legalMoves(s).length,20);
});

test('e2-e4 is legal and changes turn', () => {
  const s=E.createInitialState();
  const m=E.findLegalMove(s,[6,4],[4,4]);
  assert.ok(m); const n=E.applyMove(s,m);
  assert.equal(n.board[4][4],'P'); assert.equal(n.board[6][4],null); assert.equal(n.turn,'black'); assert.equal(n.ep[0],5); assert.equal(n.ep[1],4);
});

test('illegal pawn move e2-e5 is rejected', () => {
  const s=E.createInitialState();
  assert.equal(E.findLegalMove(s,[6,4],[3,4]),null);
});

test('castling is available after clearing the path', () => {
  let s=E.createInitialState();
  for (const [from,to] of [[ [7,6],[5,5] ],[ [6,6],[4,6] ],[ [7,5],[6,6] ]]) { const m=E.findLegalMove(s,from,to); if(!m){break;} s=E.applyMove(s,m); if(s.turn==='black'){ const bm=E.legalMoves(s).find(x=>x.from[0]===1&&x.from[1]===6&&x.to[0]===3&&x.to[1]===6); if(bm)s=E.applyMove(s,bm); }}
  // Direct minimal custom position is clearer for the rule itself.
  s={board:Array.from({length:8},()=>Array(8).fill(null)),turn:'white',castling:{K:true,Q:false,k:false,q:false},ep:null,halfmove:0,fullmove:1};
  s.board[7][4]='K';s.board[7][7]='R';s.board[0][4]='k';
  const castle=E.findLegalMove(s,[7,4],[7,6]);
  assert.ok(castle); const n=E.applyMove(s,castle); assert.equal(n.board[7][6],'K'); assert.equal(n.board[7][5],'R');
});

test('en passant is legal', () => {
  let s=E.createInitialState();
  // Build a legal-ish position directly for focused rule testing.
  s={board:Array.from({length:8},()=>Array(8).fill(null)),turn:'black',castling:{K:false,Q:false,k:false,q:false},ep:null,halfmove:0,fullmove:1};
  s.board[7][4]='K';s.board[0][4]='k';s.board[3][4]='P';s.board[1][3]='p';
  const first={from:[1,3],to:[3,3],piece:'p'}; s=E.applyMove(s,first);
  const ep=E.findLegalMove(s,[3,4],[2,3]); assert.ok(ep); const n=E.applyMove(s,ep); assert.equal(n.board[2][3],'P');assert.equal(n.board[3][3],null);
});

test('promotion produces four candidate moves', () => {
  const s={board:Array.from({length:8},()=>Array(8).fill(null)),turn:'white',castling:{K:false,Q:false,k:false,q:false},ep:null,halfmove:0,fullmove:1};
  s.board[7][4]='K';s.board[0][4]='k';s.board[1][0]='P';
  const ms=E.legalMoves(s).filter(m=>m.from[0]===1&&m.from[1]===0&&m.to[0]===0&&m.to[1]===0);
  assert.equal(ms.length,4);
  assert.equal(JSON.stringify(ms.map(m=>m.promotion).sort()), JSON.stringify(['b','n','q','r']));
});

test('fool\'s mate is checkmate', () => {
  let s=E.createInitialState();
  for (const [from,to] of [ [[6,5],[5,5]], [[1,4],[3,4]], [[6,6],[4,6]], [[0,3],[4,7]] ]) {
    const m=E.findLegalMove(s,from,to); assert.ok(m); s=E.applyMove(s,m);
  }
  const st=E.status(s,{}); assert.equal(st.type,'checkmate'); assert.equal(st.winner,'black');
});

test('black can make a legal move that gives white check', () => {
  let s=E.createInitialState();
  for (const [from,to] of [
    ['e2','e4'],['e7','e5'],['f2','f3'],['d8','h4']
  ]) {
    const m=E.findLegalMove(s,E.parseSquare(from),E.parseSquare(to));
    assert.ok(m, `${from}-${to} should be legal`);
    s=E.applyMove(s,m);
  }
  const st=E.status(s,{});
  assert.equal(st.type,'check');
  assert.equal(st.inCheck,true);
  assert.equal(s.turn,'white');
});

test('a black checking move is accepted and the next side still has legal moves', () => {
  let s=E.createInitialState();
  for (const [from,to] of [
    ['e2','e4'],['e7','e5'],['f2','f3'],['d8','h4']
  ]) {
    const m=E.findLegalMove(s,E.parseSquare(from),E.parseSquare(to));
    assert.ok(m, `${from}-${to} should be legal`);
    s=E.applyMove(s,m);
  }
  assert.equal(E.status(s,{}).type,'check');
  assert.equal(s.turn,'white');
  assert.ok(E.legalMoves(s).length>0);
  assert.ok(E.findLegalMove(s,E.parseSquare('g2'),E.parseSquare('g3')));
});

/* --------------------------------------------------------------- premoves --- */

const sq = name => E.parseSquare(name);
const names = targets => [...targets.map(t => E.squareName(t[0], t[1]))].sort();

test('a premove ignores whose turn it is', () => {
  // The whole point: the move is entered while the opponent is still to move.
  const s = E.createInitialState();
  s.turn = 'black';
  assert.equal(E.legalMoves(s).some(m => m.from[0] === 6 && m.from[1] === 4), false,
    'the rules offer White nothing here, which is exactly the situation a premove is for');
  assert.deepEqual(names(E.premoveTargets(s, sq('e2'))), ['d3', 'e3', 'e4', 'f3']);
});

test('enemy pieces do not block a premove', () => {
  // Anticipating that they move out of the way is what a premove is for.
  // Bc1 is hemmed in by the black pawn on d2; the bishop must still be
  // offered the whole diagonal past it.
  const s = E.fromFen('4k3/8/8/8/8/8/3p4/2B2K2 w - - 0 1');
  const targets = names(E.premoveTargets(s, sq('c1')));
  assert.ok(targets.includes('d2'), 'it may capture the pawn');
  assert.ok(targets.includes('h6'), 'and the ray must run on past it');
  // The rules themselves stop at the pawn, which is the difference being tested.
  const legal = E.legalMoves(s).filter(m => m.from[0] === 7 && m.from[1] === 2);
  assert.equal(legal.some(m => E.squareName(...m.to) === 'h6'), false);
});

test('own pieces still block a premove', () => {
  // With one queued premove they cannot have moved by the time it runs.
  const s = E.fromFen('4k3/8/8/8/8/8/3P4/3B1K2 w - - 0 1');
  const targets = names(E.premoveTargets(s, sq('d1')));
  assert.equal(targets.includes('d2'), false, 'cannot land on its own pawn');
  assert.equal(targets.includes('d3'), false, 'and cannot pass through it');
});

test('a pawn may be premoved to either diagonal even with nothing there', () => {
  // The capture a premove waits for is the reply that has not happened yet.
  const s = E.fromFen('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1');
  assert.deepEqual(names(E.premoveTargets(s, sq('e2'))), ['d3', 'e3', 'e4', 'f3']);
});

test('a blocked pawn is offered no push at all', () => {
  const s = E.fromFen('4k3/8/8/8/8/4N3/4P3/4K3 w - - 0 1');
  assert.deepEqual(names(E.premoveTargets(s, sq('e2'))), ['d3', 'f3']);
});

test('a pawn on the edge is not offered a diagonal off the board', () => {
  const s = E.fromFen('4k3/8/8/8/8/8/P7/4K3 w - - 0 1');
  assert.deepEqual(names(E.premoveTargets(s, sq('a2'))), ['a3', 'a4', 'b3']);
});

test('castling is offered from the home square and settled later', () => {
  // Whether it is actually available depends on the opponent's reply, so the
  // rights are not consulted here - findLegalMove decides on execution.
  const s = E.fromFen('4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1');
  const targets = names(E.premoveTargets(s, sq('e1')));
  assert.ok(targets.includes('g1'), 'kingside');
  assert.ok(targets.includes('c1'), 'queenside');
});

test('a king that has left home is not offered castling', () => {
  const s = E.fromFen('4k3/8/8/8/8/8/8/R4K1R w - - 0 1');
  const targets = names(E.premoveTargets(s, sq('f1')));
  assert.equal(targets.includes('c1'), false);
});

test('a knight premove reaches every square its own pieces leave free', () => {
  const s = E.fromFen('4k3/8/8/8/4N3/8/8/4K3 w - - 0 1');
  assert.deepEqual(names(E.premoveTargets(s, sq('e4'))), ['c3', 'c5', 'd2', 'd6', 'f2', 'f6', 'g3', 'g5']);
});

test('an empty square offers no premove', () => {
  assert.deepEqual([...E.premoveTargets(E.createInitialState(), sq('e4'))], []);
});

test('every premove target is a square on the board', () => {
  // A target off the edge would be read as undefined deep in the move
  // pipeline, where the cause is very hard to see.
  const s = E.createInitialState();
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    for (const [tr, tc] of E.premoveTargets(s, [r, c])) {
      assert.ok(tr >= 0 && tr < 8 && tc >= 0 && tc < 8, `off-board target from ${E.squareName(r, c)}`);
    }
  }
});

test('a legal move is always among the premove targets for that piece', () => {
  // The premove filter may be optimistic, but it must never be narrower than
  // the rules - that would refuse a move the player is entitled to queue.
  for (const fen of [
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3',
    'r3k2r/pppq1ppp/2n1bn2/3pp3/3PP3/2N1BN2/PPPQ1PPP/R3K2R w KQkq - 0 1'
  ]) {
    const state = E.fromFen(fen);
    for (const move of E.legalMoves(state)) {
      const targets = E.premoveTargets(state, move.from);
      const found = targets.some(t => t[0] === move.to[0] && t[1] === move.to[1]);
      assert.ok(found, `${E.squareName(...move.from)}-${E.squareName(...move.to)} missing in ${fen}`);
    }
  }
});

/* ----------------------------------------------------- moves between --- */

test('a promotion is four legal moves over the same two squares', () => {
  const s = E.fromFen('6k1/1P6/8/8/8/8/6K1/8 w - - 0 1');
  const moves = E.movesBetween(s, sq('b7'), sq('b8'));
  assert.equal(moves.length, 4);
  assert.deepEqual([...moves.map(m => m.promotion)].sort(), ['b', 'n', 'q', 'r']);
});

test('findLegalMove needs the promotion piece, movesBetween does not', () => {
  // Regression: the board resolved a click with findLegalMove and no piece,
  // which matches no promotion at all - so pushing a pawn to the last rank
  // did nothing and the promotion dialog was unreachable. Anything that
  // starts from a pair of squares has to ask movesBetween.
  const s = E.fromFen('6k1/1P6/8/8/8/8/6K1/8 w - - 0 1');
  assert.equal(E.findLegalMove(s, sq('b7'), sq('b8')), null);
  assert.equal(E.findLegalMove(s, sq('b7'), sq('b8'), 'q').promotion, 'q');
  assert.equal(E.movesBetween(s, sq('b7'), sq('b8')).length, 4);
});

test('an ordinary move is exactly one move between its squares', () => {
  const s = E.createInitialState();
  assert.equal(E.movesBetween(s, sq('e2'), sq('e4')).length, 1);
  assert.equal(E.movesBetween(s, sq('e2'), sq('e5')).length, 0);
});

/* ------------------------------------------------- castling gesture --- */

test('dropping the king on its own rook means castling', () => {
  // How castling is entered on most boards. Written as e1-h1 it matches no
  // legal move at all, so the board silently did nothing - which is exactly
  // the "first attempt did not work, second one did" report.
  const s = E.fromFen('r3k2r/pppq1ppp/2n1bn2/3pp3/3PP3/2N1BN2/PPPQ1PPP/R3K2R w KQkq - 0 1');
  assert.deepEqual([...E.castlingTarget(s, sq('e1'), sq('h1'))], [...sq('g1')]);
  assert.deepEqual([...E.castlingTarget(s, sq('e1'), sq('a1'))], [...sq('c1')]);
});

test('the gesture only renames the square, it never grants the move', () => {
  // Rights already gone: the gesture still resolves, and the move generator
  // is what refuses it. Legality must stay in one place.
  const s = E.fromFen('r3k2r/pppq1ppp/2n1bn2/3pp3/3PP3/2N1BN2/PPPQ1PPP/R3K2R w kq - 0 1');
  const target = E.castlingTarget(s, sq('e1'), sq('h1'));
  assert.deepEqual([...target], [...sq('g1')]);
  assert.equal(E.movesBetween(s, sq('e1'), target).length, 0, 'without rights there is no move');
});

test('an ordinary king move is not mistaken for the gesture', () => {
  const s = E.fromFen('r3k2r/pppq1ppp/2n1bn2/3pp3/3PP3/2N1BN2/PPPQ1PPP/R3K2R w KQkq - 0 1');
  assert.equal(E.castlingTarget(s, sq('e1'), sq('f1')), null);
  assert.equal(E.castlingTarget(s, sq('e1'), sq('g1')), null, 'the real target is not a gesture');
  // A rook that is not on its corner is not a castling partner either.
  const moved = E.fromFen('r3k2r/pppq1ppp/2n1bn2/3pp3/3PP3/2N1BN2/PPPQ1PPP/1R2K2R w Kkq - 0 1');
  assert.equal(E.castlingTarget(moved, sq('e1'), sq('b1')), null);
});

test('a piece that is not a king is never a castling gesture', () => {
  const s = E.fromFen('r3k2r/pppq1ppp/2n1bn2/3pp3/3PP3/2N1BN2/PPPQ1PPP/R3K2R w KQkq - 0 1');
  assert.equal(E.castlingTarget(s, sq('d2'), sq('h1')), null);
});

test('the rook corner is offered as a premove target too', () => {
  // Otherwise the gesture works during your turn but not when queued, which
  // is worse than not having it: the same drag would mean two different things.
  const s = E.fromFen('r3k2r/pppq1ppp/2n1bn2/3pp3/3PP3/2N1BN2/PPPQ1PPP/R3K2R w KQkq - 0 1');
  const targets = names(E.premoveTargets(s, sq('e1')));
  assert.ok(targets.includes('h1'), 'kingside corner');
  assert.ok(targets.includes('a1'), 'queenside corner');
});
