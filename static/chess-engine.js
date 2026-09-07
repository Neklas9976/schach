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

  /**
   * Every legal move between two squares.
   *
   * Usually zero or one, but a promotion is four moves over the same pair of
   * squares - which is exactly what `findLegalMove` cannot express. Callers
   * that start from a pair of squares (a click, a drag, a premove) should ask
   * this and let the count tell them whether a piece still has to be chosen.
   */
  function movesBetween(state, from, to) {
    return legalMoves(state).filter(m =>
      m.from[0] === from[0] && m.from[1] === from[1] &&
      m.to[0] === to[0] && m.to[1] === to[1]);
  }

  /**
   * The one legal move between two squares, or null.
   *
   * Note the promotion argument is part of the identity of the move, not an
   * optional hint: with it left out, a promotion matches nothing, because
   * "push to the eighth rank" is not yet a move until the piece is named.
   * Use `movesBetween` when the caller does not know yet.
   */
  function findLegalMove(state, from, to, promotion=null) {
    return movesBetween(state, from, to).find(m=>(m.promotion||null)===(promotion||null)) || null;
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

  /**
   * Translates "king onto its own rook" into the square the king really goes.
   *
   * Castling is entered that way on most boards, and it is the gesture a lot
   * of players have in their fingers: you grab the king and drop it on the
   * rook. Written as e1-h1 it matches no legal move at all, so the board
   * silently did nothing and the move looked broken - while e1-g1 worked, which
   * is exactly the "first try failed, second try worked" pattern.
   *
   * This is an input convention, not a rule. It only ever *renames* the target
   * square; whether the castling is actually allowed is still decided by the
   * move generator afterwards.
   *
   * Returns the real destination, or null when the gesture is not this one.
   */
  function castlingTarget(state, from, to) {
    const piece = state.board[from[0]]?.[from[1]];
    if (!piece || typeOf(piece) !== 'k') return null;

    const color = colorOf(piece);
    const homeRow = color === 'white' ? 7 : 0;
    if (from[0] !== homeRow || from[1] !== 4 || to[0] !== homeRow) return null;

    const rook = color === 'white' ? 'R' : 'r';
    if (state.board[homeRow][to[1]] !== rook) return null;

    // The corner tells which side: h-file is short castling, a-file long.
    if (to[1] === 7) return [homeRow, 6];
    if (to[1] === 0) return [homeRow, 2];
    return null;
  }

  /**
   * Squares a piece may be *pre*-moved to, before the opponent has replied.
   *
   * A premove cannot be checked for legality: the position it will be played
   * in does not exist yet. What can be checked is whether the move is even
   * plausible for that piece, which is all this offers - `findLegalMove` still
   * decides at execution time, so an impossible premove is discarded rather
   * than played.
   *
   * The rule is asymmetric on purpose. Enemy pieces are ignored entirely:
   * anticipating that they move out of the way is the whole point of a
   * premove, and treating them as blockers would refuse exactly the moves
   * players queue up. Own pieces still block, because with a single queued
   * premove they cannot have moved by the time it runs.
   *
   * Unlike `legalMoves` this does not care whose turn it is - a premove is by
   * definition made out of turn.
   */
  function premoveTargets(state, from) {
    const [r, c] = from;
    const piece = state.board[r]?.[c];
    if (!piece) return [];
    const color = colorOf(piece), type = typeOf(piece);

    const blocked = (rr, cc) => {
      const other = state.board[rr][cc];
      return !!other && colorOf(other) === color;
    };

    const targets = [];
    const offer = (rr, cc) => { if (inBounds(rr, cc) && !blocked(rr, cc)) targets.push([rr, cc]); };

    if (type === 'p') {
      const dir = color === 'white' ? -1 : 1;
      const start = color === 'white' ? 6 : 1;
      if (inBounds(r + dir, c) && !blocked(r + dir, c)) {
        targets.push([r + dir, c]);
        if (r === start && inBounds(r + 2 * dir, c) && !blocked(r + 2 * dir, c)) targets.push([r + 2 * dir, c]);
      }
      // Both diagonals are offered even with nothing on them: the capture a
      // premove waits for is the opponent's move that has not happened yet.
      for (const dc of [-1, 1]) offer(r + dir, c + dc);
      return targets;
    }

    if (type === 'n') {
      for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) offer(r + dr, c + dc);
      return targets;
    }

    if (type === 'k') {
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (dr || dc) offer(r + dr, c + dc);
      }
      // Castling is offered from the home square and sorted out on execution;
      // the rights and the squares in between depend on the reply. The rook's
      // own corner is offered too, because dropping the king on the rook is
      // how a lot of players enter it.
      const homeRow = color === 'white' ? 7 : 0;
      if (r === homeRow && c === 4) {
        offer(homeRow, 6); offer(homeRow, 2);
        const rook = color === 'white' ? 'R' : 'r';
        for (const corner of [0, 7]) {
          if (state.board[homeRow][corner] === rook) targets.push([homeRow, corner]);
        }
      }
      return targets;
    }

    const directions = [];
    if (type === 'b' || type === 'q') directions.push([-1,-1],[-1,1],[1,-1],[1,1]);
    if (type === 'r' || type === 'q') directions.push([-1,0],[1,0],[0,-1],[0,1]);
    for (const [dr, dc] of directions) {
      let rr = r + dr, cc = c + dc;
      while (inBounds(rr, cc) && !blocked(rr, cc)) {
        targets.push([rr, cc]);
        rr += dr; cc += dc;
      }
    }
    return targets;
  }

  /**
   * The complete six-field FEN.
   *
   * `fenKey` deliberately stops after four fields: repetition detection must
   * ignore the move counters, or a position reached with a different halfmove
   * clock would not count as the same position. Everything that needs to
   * round-trip a game - Stockfish, PGN, save/restore - needs all six.
   */
  function toFen(state) {
    return `${fenKey(state)} ${state.halfmove} ${state.fullmove}`;
  }

  const FEN_PIECES = new Set(['r','n','b','q','k','p','R','N','B','Q','K','P']);

  /**
   * Parses a FEN into a state, rejecting anything malformed.
   *
   * This is the entry point for text a person typed or pasted, so every field
   * is checked. A silently mis-parsed FEN would produce a board that looks
   * plausible and then generates illegal moves.
   */
  function fromFen(fen) {
    if (typeof fen !== 'string') throw new Error('FEN muss Text sein');
    const parts = fen.trim().split(/\s+/);
    if (parts.length < 4) throw new Error('FEN unvollständig: mindestens vier Felder erwartet');

    const [placement, turnField, castleField, epField] = parts;
    const rows = placement.split('/');
    if (rows.length !== 8) throw new Error('FEN muss genau acht Reihen beschreiben');

    const board = [];
    for (const row of rows) {
      const cells = [];
      for (const ch of row) {
        if (ch >= '1' && ch <= '8') {
          for (let i = 0; i < Number(ch); i++) cells.push(null);
        } else if (FEN_PIECES.has(ch)) {
          cells.push(ch);
        } else {
          throw new Error(`Unbekanntes Zeichen in der Stellung: ${ch}`);
        }
      }
      if (cells.length !== 8) throw new Error(`Reihe "${row}" beschreibt ${cells.length} statt 8 Felder`);
      board.push(cells);
    }

    if (turnField !== 'w' && turnField !== 'b') throw new Error('Zugrecht muss "w" oder "b" sein');
    if (!/^(-|[KQkq]{1,4})$/.test(castleField)) throw new Error('Ungültige Rochaderechte');
    if (!/^(-|[a-h][36])$/.test(epField)) throw new Error('Ungültiges en-passant-Feld');

    const halfmove = parts.length > 4 ? Number(parts[4]) : 0;
    const fullmove = parts.length > 5 ? Number(parts[5]) : 1;
    if (!Number.isInteger(halfmove) || halfmove < 0) throw new Error('Ungültige Halbzugregel');
    if (!Number.isInteger(fullmove) || fullmove < 1) throw new Error('Ungültige Zugnummer');

    const state = {
      board,
      turn: turnField === 'w' ? 'white' : 'black',
      castling: {
        K: castleField.includes('K'), Q: castleField.includes('Q'),
        k: castleField.includes('k'), q: castleField.includes('q')
      },
      ep: epField === '-' ? null : parseSquare(epField),
      halfmove,
      fullmove
    };

    // A position without both kings is not a chess position: legalMoves and
    // every check test would dereference null. Rejecting it here keeps that
    // failure at the entry point rather than deep inside the search.
    if (!findKing(state, 'white') || !findKing(state, 'black')) {
      throw new Error('Die Stellung braucht beide Könige');
    }
    // The side that just moved must not still be in check - that position can
    // never arise in a real game and would let the mover be captured.
    if (isInCheck(state, opponent(state.turn))) {
      throw new Error('Die Seite, die nicht am Zug ist, steht im Schach');
    }
    return state;
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
    isSquareAttacked, isInCheck, findKing, legalMoves, movesBetween, findLegalMove, applyMove, premoveTargets, castlingTarget, fenKey, toFen, fromFen, status, sanForMove, insufficientMaterial
  };
  global.ChessEngine=api;
// The engine is pure logic with no DOM access, so it must also load inside a
// Web Worker (where `window` does not exist) for the search to run off the
// main thread.
})(typeof window !== 'undefined' ? window : self);
