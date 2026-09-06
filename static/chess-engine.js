(function (global) {
  'use strict';

  const FILES = 'abcdefgh';
  const START = [
    ['r','n','b','q','k','b','n','r'],
    ['p','p','p','p','p','p','p','p'],
    [null,null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null,null],
    ['P','P','P','P','P','P','P','P'],
    ['R','N','B','Q','K','B','N','R']
  ];

  const PIECE_NAMES = { p:'Bauer', n:'Springer', b:'Läufer', r:'Turm', q:'Dame', k:'König' };
  const VALUES = { p:1, n:3, b:3, r:5, q:9, k:100 };

  function cloneBoard(board) { return board.map(row => row.slice()); }
  function cloneState(state) {
    return {
      board: cloneBoard(state.board),
      turn: state.turn,
      castling: { ...state.castling },
      ep: state.ep ? [...state.ep] : null,
      halfmove: state.halfmove,
      fullmove: state.fullmove
    };
  }
  function colorOf(piece) { return piece === piece.toUpperCase() ? 'white' : 'black'; }
  function typeOf(piece) { return piece ? piece.toLowerCase() : null; }
  function opponent(color) { return color === 'white' ? 'black' : 'white'; }
  function inBounds(r,c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }
  function squareName(r,c) { return `${FILES[c]}${8-r}`; }
  function parseSquare(s) { return [8-Number(s[1]), FILES.indexOf(s[0])]; }

  function createInitialState() {
    return {
      board: cloneBoard(START),
      turn: 'white',
      castling: { K:true, Q:true, k:true, q:true },
      ep: null,
      halfmove: 0,
      fullmove: 1
    };
  }

  function findKing(state, color) {
    const king = color === 'white' ? 'K' : 'k';
    for (let r=0;r<8;r++) for (let c=0;c<8;c++) if (state.board[r][c] === king) return [r,c];
    return null;
  }

  function isSquareAttacked(state, targetR, targetC, byColor) {
    const pawn = byColor === 'white' ? 'P' : 'p';
    const pawnRow = byColor === 'white' ? targetR + 1 : targetR - 1;
    for (const dc of [-1,1]) {
      const c = targetC + dc;
      if (inBounds(pawnRow,c) && state.board[pawnRow][c] === pawn) return true;
    }

    const knight = byColor === 'white' ? 'N' : 'n';
    for (const [dr,dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
      const r=targetR+dr,c=targetC+dc;
      if (inBounds(r,c) && state.board[r][c] === knight) return true;
    }

    const bishop = byColor === 'white' ? 'B' : 'b';
    const rook = byColor === 'white' ? 'R' : 'r';
    const queen = byColor === 'white' ? 'Q' : 'q';
    for (const [dr,dc] of [[-1,-1],[-1,1],[1,-1],[1,1]]) {
      let r=targetR+dr,c=targetC+dc;
      while (inBounds(r,c)) {
        const p=state.board[r][c];
        if (p) { if (p===bishop || p===queen) return true; break; }
        r+=dr; c+=dc;
      }
    }
    for (const [dr,dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      let r=targetR+dr,c=targetC+dc;
      while (inBounds(r,c)) {
        const p=state.board[r][c];
        if (p) { if (p===rook || p===queen) return true; break; }
        r+=dr; c+=dc;
      }
    }

    const king = byColor === 'white' ? 'K' : 'k';
    for (let dr=-1;dr<=1;dr++) for (let dc=-1;dc<=1;dc++) {
      if (!dr && !dc) continue;
      const r=targetR+dr,c=targetC+dc;
      if (inBounds(r,c) && state.board[r][c]===king) return true;
    }
    return false;
  }

  function isInCheck(state, color) {
    const king = findKing(state, color);
    return !!king && isSquareAttacked(state, king[0], king[1], opponent(color));
  }

  function pushRayMoves(state, moves, r,c, dr,dc) {
    const piece=state.board[r][c], color=colorOf(piece);
    let tr=r+dr,tc=c+dc;
    while(inBounds(tr,tc)) {
      const target=state.board[tr][tc];
      if (!target) moves.push({from:[r,c],to:[tr,tc],piece});
      else { if (colorOf(target)!==color && typeOf(target)!=='k') moves.push({from:[r,c],to:[tr,tc],piece,captured:target}); break; }
      tr+=dr;tc+=dc;
    }
  }

  function pseudoMoves(state, r,c) {
    const piece=state.board[r][c]; if (!piece) return [];
    const color=colorOf(piece), type=typeOf(piece), moves=[];
    if (color !== state.turn) return moves;

    if (type==='p') {
      const dir=color==='white'?-1:1, start=color==='white'?6:1, promotionRow=color==='white'?0:7;
      const one=r+dir;
      if (inBounds(one,c) && !state.board[one][c]) {
        if (one===promotionRow) ['q','r','b','n'].forEach(prom => moves.push({from:[r,c],to:[one,c],piece,promotion:prom}));
        else moves.push({from:[r,c],to:[one,c],piece});
        const two=r+2*dir;
        if (r===start && !state.board[two][c]) moves.push({from:[r,c],to:[two,c],piece});
      }
      for (const dc of [-1,1]) {
        const tr=r+dir,tc=c+dc; if(!inBounds(tr,tc)) continue;
        const target=state.board[tr][tc];
        if (target && colorOf(target)!==color && typeOf(target)!=='k') {
          if (tr===promotionRow) ['q','r','b','n'].forEach(prom => moves.push({from:[r,c],to:[tr,tc],piece,captured:target,promotion:prom}));
          else moves.push({from:[r,c],to:[tr,tc],piece,captured:target});
        } else if (state.ep && state.ep[0]===tr && state.ep[1]===tc) {
          const captured=state.board[r][tc];
          if (captured && typeOf(captured)==='p' && colorOf(captured)!==color) moves.push({from:[r,c],to:[tr,tc],piece,captured,isEnPassant:true});
        }
      }
      return moves;
    }

    if (type==='n') {
      for (const [dr,dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
        const tr=r+dr,tc=c+dc;if(!inBounds(tr,tc))continue;const t=state.board[tr][tc];
        if(!t || (colorOf(t)!==color && typeOf(t)!=='k')) moves.push({from:[r,c],to:[tr,tc],piece,captured:t||null});
      }
      return moves;
    }

    if (type==='b' || type==='q') for (const [dr,dc] of [[-1,-1],[-1,1],[1,-1],[1,1]]) pushRayMoves(state,moves,r,c,dr,dc);
    if (type==='r' || type==='q') for (const [dr,dc] of [[-1,0],[1,0],[0,-1],[0,1]]) pushRayMoves(state,moves,r,c,dr,dc);

    if (type==='k') {
      for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){
        if(!dr&&!dc)continue;const tr=r+dr,tc=c+dc;if(!inBounds(tr,tc))continue;const t=state.board[tr][tc];
        if(!t || (colorOf(t)!==color && typeOf(t)!=='k')) moves.push({from:[r,c],to:[tr,tc],piece,captured:t||null});
      }
      const enemy=opponent(color);
      if (color==='white' && r===7 && c===4 && !isInCheck(state,'white')) {
        if (state.castling.K && state.board[7][5]===null && state.board[7][6]===null && state.board[7][7]==='R' && !isSquareAttacked(state,7,5,enemy) && !isSquareAttacked(state,7,6,enemy)) moves.push({from:[7,4],to:[7,6],piece,isCastle:true,rookFrom:[7,7],rookTo:[7,5]});
        if (state.castling.Q && state.board[7][1]===null && state.board[7][2]===null && state.board[7][3]===null && state.board[7][0]==='R' && !isSquareAttacked(state,7,3,enemy) && !isSquareAttacked(state,7,2,enemy)) moves.push({from:[7,4],to:[7,2],piece,isCastle:true,rookFrom:[7,0],rookTo:[7,3]});
      }
      if (color==='black' && r===0 && c===4 && !isInCheck(state,'black')) {
        if (state.castling.k && state.board[0][5]===null && state.board[0][6]===null && state.board[0][7]==='r' && !isSquareAttacked(state,0,5,enemy) && !isSquareAttacked(state,0,6,enemy)) moves.push({from:[0,4],to:[0,6],piece,isCastle:true,rookFrom:[0,7],rookTo:[0,5]});
        if (state.castling.q && state.board[0][1]===null && state.board[0][2]===null && state.board[0][3]===null && state.board[0][0]==='r' && !isSquareAttacked(state,0,3,enemy) && !isSquareAttacked(state,0,2,enemy)) moves.push({from:[0,4],to:[0,2],piece,isCastle:true,rookFrom:[0,0],rookTo:[0,3]});
      }
    }
    return moves;
  }

  function applyMove(state, move) {
    const next=cloneState(state), [fr,fc]=move.from, [tr,tc]=move.to;
    const piece=next.board[fr][fc];
    next.board[fr][fc]=null;
    let capture=next.board[tr][tc] || null;
    if (move.isEnPassant) { capture=next.board[fr][tc]; next.board[fr][tc]=null; }
    next.board[tr][tc]=move.promotion ? (piece===piece.toUpperCase()?move.promotion.toUpperCase():move.promotion) : piece;
    if (move.isCastle) { next.board[move.rookTo[0]][move.rookTo[1]]=next.board[move.rookFrom[0]][move.rookFrom[1]]; next.board[move.rookFrom[0]][move.rookFrom[1]]=null; }

    const type=typeOf(piece);
    if (piece==='K'){next.castling.K=false;next.castling.Q=false;}
    if (piece==='k'){next.castling.k=false;next.castling.q=false;}
    if (fr===7&&fc===0||tr===7&&tc===0) next.castling.Q=false;
    if (fr===7&&fc===7||tr===7&&tc===7) next.castling.K=false;
    if (fr===0&&fc===0||tr===0&&tc===0) next.castling.q=false;
    if (fr===0&&fc===7||tr===0&&tc===7) next.castling.k=false;

    next.ep=null;
    if (type==='p' && Math.abs(tr-fr)===2) next.ep=[(fr+tr)/2,fc];
    next.halfmove=(type==='p'||capture)?0:state.halfmove+1;
    next.fullmove=state.fullmove+(state.turn==='black'?1:0);
    next.turn=opponent(state.turn);
    return next;
  }

  function legalMoves(state, color=state.turn) {
    const working = color===state.turn ? state : {...cloneState(state),turn:color};
    const moves=[];
    for(let r=0;r<8;r++)for(let c=0;c<8;c++){
      const p=working.board[r][c]; if(!p||colorOf(p)!==color)continue;
      for(const m of pseudoMoves(working,r,c)){
        const next=applyMove(working,m);
        if(!isInCheck(next,color)) moves.push(m);
      }
    }
    return moves;
  }

  function findLegalMove(state, from, to, promotion=null) {
    return legalMoves(state).find(m=>m.from[0]===from[0]&&m.from[1]===from[1]&&m.to[0]===to[0]&&m.to[1]===to[1]&&((m.promotion||null)===(promotion||null))) || null;
  }

  function fenKey(state) {
    const rows=state.board.map(row=>{
      let out='',empty=0;
      for(const p of row){if(!p)empty++;else{if(empty){out+=empty;empty=0;}out+=p;}}
      if(empty)out+=empty;return out;
    }).join('/');
    const castle=Object.keys(state.castling).filter(k=>state.castling[k]).join('')||'-';
    const ep=state.ep?squareName(state.ep[0],state.ep[1]):'-';
    return `${rows} ${state.turn[0]} ${castle} ${ep}`;
  }

  function insufficientMaterial(state) {
    const pieces=[];
    for(let r=0;r<8;r++)for(let c=0;c<8;c++){const p=state.board[r][c];if(p&&typeOf(p)!=='k')pieces.push({p,r,c});}
    if (pieces.length===0) return true;
    if (pieces.some(x=>['p','q','r'].includes(typeOf(x.p)))) return false;
    if (pieces.length===1) return ['b','n'].includes(typeOf(pieces[0].p));
    if (pieces.every(x=>typeOf(x.p)==='b')) {
      const colors=new Set(pieces.map(x=>(x.r+x.c)%2));
      return colors.size===1;
    }
    return false;
  }

  function status(state, repetitionMap={}) {
    const inCheck=isInCheck(state,state.turn);
    const moves=legalMoves(state);
    if (moves.length===0) {
      if (inCheck) return {type:'checkmate',winner:opponent(state.turn),inCheck:true,legalMoves:0};
      return {type:'stalemate',winner:null,inCheck:false,legalMoves:0};
    }
    if (state.halfmove>=100) return {type:'fifty-move',winner:null,inCheck,legalMoves:moves.length};
    const key=fenKey(state);
    if ((repetitionMap[key]||0)>=3) return {type:'threefold',winner:null,inCheck,legalMoves:moves.length};
    if (insufficientMaterial(state)) return {type:'insufficient-material',winner:null,inCheck,legalMoves:moves.length};
    return {type:inCheck?'check':'playing',winner:null,inCheck,legalMoves:moves.length};
  }

  function sanForMove(state, move, next, repetitionMap={}) {
    const piece=move.piece, type=typeOf(piece), isCapture=!!(move.captured||move.isEnPassant);
    if (move.isCastle) return move.to[1]===6 ? 'O-O' : 'O-O-O';
    let text='';
    if(type!=='p') {
      text=type.toUpperCase();
      const others=legalMoves(state).filter(m=>m.from[0]!==move.from[0]||m.from[1]!==move.from[1]).filter(m=>m.to[0]===move.to[0]&&m.to[1]===move.to[1]&&typeOf(m.piece)===type);
      if (others.length) {
        const sameFile=others.some(m=>m.from[1]===move.from[1]);
        const sameRank=others.some(m=>m.from[0]===move.from[0]);
        if(!sameFile) text+=FILES[move.from[1]]; else if(!sameRank) text+=(8-move.from[0]); else text+=squareName(move.from[0],move.from[1]);
      }
    } else if(isCapture) text+=FILES[move.from[1]];
    if(isCapture) text+='x';
    text+=squareName(move.to[0],move.to[1]);
    if(move.promotion) text+='='+move.promotion.toUpperCase();
    const st=status(next,repetitionMap);
    if(st.type==='checkmate') text+='#'; else if(st.inCheck) text+='+';
    return text;
  }

  const api={
    FILES, PIECE_NAMES, createInitialState, cloneState, colorOf, typeOf, opponent, squareName, parseSquare,
    isSquareAttacked, isInCheck, findKing, legalMoves, findLegalMove, applyMove, fenKey, status, sanForMove, insufficientMaterial
  };
  global.ChessEngine=api;
// The engine is pure logic with no DOM access, so it must also load inside a
// Web Worker (where `window` does not exist) for the search to run off the
// main thread.
})(typeof window !== 'undefined' ? window : self);
