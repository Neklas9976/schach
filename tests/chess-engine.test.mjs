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
