(() => {
  'use strict';
  const boardEl=document.getElementById('chess-board');
  const rankLabels=document.getElementById('rank-labels');
  const fileLabels=document.getElementById('file-labels');
  const turnText=document.getElementById('turn-text');
  const statusExtra=document.getElementById('status-extra');
  const statusCard=document.getElementById('status-card');
  const movesList=document.getElementById('moves-list');
  const moveCount=document.getElementById('move-count');
  const undoBtn=document.getElementById('undo-btn');
  const newBtn=document.getElementById('new-game-btn');
  const promoOverlay=document.getElementById('promotion-overlay');
  const promoOptions=document.getElementById('promotion-options');
  const overlayEl=document.getElementById('board-overlay');
  const openingEl=document.getElementById('opening-name');
  const topCaptured=document.getElementById('top-captured');
  const bottomCaptured=document.getElementById('bottom-captured');
  const topName=document.getElementById('top-name');
  const bottomName=document.getElementById('bottom-name');
  const topAvatar=document.getElementById('top-avatar');
  const bottomAvatar=document.getElementById('bottom-avatar');
  const evalBar=document.getElementById('eval-bar');
  const evalFill=document.getElementById('eval-fill');
  const evalScore=document.getElementById('eval-score');

  let suppressNextClick=false;
  let activePointerId=null;
  // Square a right-button drag started on, while an annotation is being drawn.
  let drawFrom=null;

  /* --------------------------------------------------------------------- *
   * Review / navigation state
   * --------------------------------------------------------------------- *
   * `viewPly` is the number of plies shown on the board. It equals
   * movesLog.length while the game is live, and anything smaller means the
   * player is looking back through the game. Keeping it an index rather than a
   * separate "reviewing" flag means there is exactly one place that decides
   * which position is on screen, so the board and the move list cannot
   * disagree.
   */
  let viewPly=0;
  let flipped=false;
  // Right-click annotations, cleared with every move like on any board.
  let arrows=[];
  let marks=[];
  // Latest evaluation of the live position, or null when nothing is known.
  let currentEval=null;
  let evalGeneration=0;
  // Per-ply analysis once a review has run: {eval, classification} by index.
  let reviewPlies=null;
  // Evaluation of every position of the game, one entry longer than the move
  // list because it includes the starting position.
  let reviewEvals=null;
  let hintMove=null;
  // A move entered while the opponent is still to move: {from,to}. At most
  // one. A queue of them would need every later entry re-validated against a
  // position that does not exist yet, and the deeper it got the more often it
  // would simply be thrown away.
  let premove=null;

  /** See ai.js assetPath: a leading slash breaks every project-page deploy. */
  function staticUrl(name){ return new URL(`static/${name}`,document.baseURI).href; }

  const ASSETS={
    P:'white-pawn',R:'white-rook',N:'white-knight',B:'white-bishop',Q:'white-queen',K:'white-king',
    p:'black-pawn',r:'black-rook',n:'black-knight',b:'black-bishop',q:'black-queen',k:'black-king'
  };

  let state=ChessEngine.createInitialState();
  let history=[];
  let repetition={};
  let selected=null;
  let pendingPromotion=null;
  let gameEnded=false;
  // Set when a clock runs out. The engine has no concept of time, so this is
  // tracked separately and always takes precedence in the status display.
  let timeoutResult=null;
  // Set when a side gives up. Like a fallen flag this is a result the position
  // itself knows nothing about, so it is tracked beside the board.
  let resignedBy=null;
  // A standing message about the engine, e.g. that the native one failed and
  // the built-in one took over. It has to survive re-renders: the computer's
  // reply repaints the board immediately afterwards, and a message that is
  // wiped a few hundred milliseconds later is a message nobody reads.
  let engineNotice='';
  // The position the current game started from. Only ever different from the
  // initial position when a FEN or a PGN with SetUp was loaded, and needed so
  // an export says where the game began. Set here as well as in newGame(),
  // because the first game of a session never goes through newGame().
  let startingFen=ChessEngine.toFen(state);

  // Single source of truth for "is the human allowed to act right now".
  // Placed in one helper rather than duplicated across the drag, click and
  // move paths, so the computer's turn can never be driven by the mouse
  // through whichever path was forgotten.
  function humanMayAct(){
    if(gameEnded || moveTransaction) return false;
    // Looking back through the game must never move a piece: the board on
    // screen is not the position the game is actually in.
    if(!isLive()) return false;
    if(!window.ChessAI) return true;
    if(window.ChessAI.isThinking()) return false;
    return !window.ChessAI.isComputerTurn(state.turn);
  }
  let movesLog=[];

  function isLive(){ return viewPly>=movesLog.length; }

  function premovesEnabled(){
    try { return JSON.parse(localStorage.getItem('chess-premoves')||'true')!==false; }
    catch { return true; }
  }

  /** Whether a move may be queued for after the opponent's reply. */
  function canPremove(){
    if(!premovesEnabled()) return false;
    if(gameEnded||moveTransaction||pendingPromotion) return false;
    if(!isLive()) return false;
    if(!window.ChessAI||!window.ChessAI.isComputerGame()) return false;
    // Only against an opponent that moves on its own. At one board with two
    // people, "premoving" would mean entering a move for the other player.
    return window.ChessAI.isComputerTurn(state.turn);
  }

  /**
   * The colour the player may enter a move for, or null for none.
   *
   * Both input paths ask this instead of comparing against `state.turn`
   * directly: during a premove the piece being moved belongs to the side that
   * is *not* to move, and every place that forgot the distinction would either
   * refuse the premove or accept a move for the opponent.
   */
  function inputColor(){
    if(humanMayAct()) return state.turn;
    if(canPremove()) return window.ChessAI.getSettings().humanColor;
    return null;
  }

  /**
   * The position currently on the board.
   *
   * history[i] is the snapshot taken *before* move i, so the position after
   * `n` plies is history[n].state - and the live state once n reaches the end.
   */
  function shownState(){
    if(isLive()) return state;
    return history[viewPly].state;
  }

  function assetUrl(piece){ return typeof window.getPieceAssetUrl === 'function' ? window.getPieceAssetUrl(piece) : staticUrl(`pieces/cburnett/${ASSETS[piece]}.svg`); }
  function getPiece(r,c){return state.board[r][c];}
  function snapshot(){
    return {
      state:ChessEngine.cloneState(state),
      repetition:{...repetition},
      movesLog:movesLog.map(m=>({...m})),
      // Undo must restore the clocks too, otherwise taking a move back would
      // silently hand the opponent the time already spent on it.
      clock:window.ChessClock?window.ChessClock.getState():null
    };
  }
  function resetRepetition(){repetition={};repetition[ChessEngine.fenKey(state)]=1;}

  function buildLabels(){
    rankLabels.innerHTML=''; fileLabels.innerHTML='<span></span>';
    const ranks=flipped?[1,2,3,4,5,6,7,8]:[8,7,6,5,4,3,2,1];
    const files=flipped?[...ChessEngine.FILES].reverse():[...ChessEngine.FILES];
    for(const r of ranks){const s=document.createElement('span');s.textContent=r;rankLabels.appendChild(s);}
    for(const f of files){const s=document.createElement('span');s.textContent=f;fileLabels.appendChild(s);}
  }

  // The 64 square elements are created exactly once and then updated in place.
  // At high refresh rates (e.g. 240 Hz) the per-frame budget is only ~4ms, so
  // tearing down and recreating 64 DOM nodes (and reloading up to 32 piece
  // images) on every click or move - as a full rebuild would - is easily
  // visible as a stutter. Diffing against what is already on screen keeps
  // each render() touching only the handful of squares that actually changed.
  let cells=null;

  function buildBoardOnce(){
    boardEl.innerHTML='';
    cells=[];
    const fragment=document.createDocumentFragment();
    for(let r=0;r<8;r++){
      const row=[];
      for(let c=0;c<8;c++){
        const sq=document.createElement('button');
        sq.type='button';
        sq.className=`square ${(r+c)%2===0?'light':'dark'}`;
        sq.dataset.row=r; sq.dataset.col=c;
        fragment.appendChild(sq);
        row.push({sq,markerEl:null,markerType:null,pieceWrap:null,pieceImg:null,pieceSrc:null,piece:null});
      }
      cells.push(row);
    }
    boardEl.appendChild(fragment);
  }

  function render(){
    if(!cells) buildBoardOnce();

    const vs=shownState();
    const live=isLive();

    // Which squares get a dot. While it is the opponent's turn these are the
    // premove targets rather than legal moves - the rules cannot answer the
    // question yet, so the two come from different sources.
    const acting=inputColor();
    const markerTypes=new Map();
    if(live&&selected&&acting){
      if(acting===vs.turn){
        for(const m of ChessEngine.legalMoves(vs)){
          if(m.from[0]!==selected[0]||m.from[1]!==selected[1]) continue;
          markerTypes.set(`${m.to[0]},${m.to[1]}`,(m.captured||m.isEnPassant)?'capture':'legal');
        }
      } else {
        for(const [tr,tc] of ChessEngine.premoveTargets(vs,selected)){
          markerTypes.set(`${tr},${tc}`,vs.board[tr][tc]?'capture':'legal');
        }
      }
    }
    // Repetition counts belong to the game as played. A historical position
    // must not be reported as a threefold draw just because the count reached
    // three later on.
    const st=ChessEngine.status(vs,live?repetition:{});
    if(live&&['checkmate','stalemate','fifty-move','threefold','insufficient-material'].includes(st.type)) gameEnded=true;
    if(resignedBy) gameEnded=true;

    const checked=st.inCheck?ChessEngine.findKing(vs,vs.turn):null;
    const last=live?movesLog.at(-1):(viewPly>0?movesLog[viewPly-1]:null);

    for(let r=0;r<8;r++)for(let c=0;c<8;c++){
      const cell=cells[r][c], sq=cell.sq;

      sq.classList.toggle('selected', !!(selected && selected[0]===r && selected[1]===c));
      sq.classList.toggle('last-move', !!(last && ((last.from[0]===r&&last.from[1]===c)||(last.to[0]===r&&last.to[1]===c))));
      sq.classList.toggle('premove', !!(premove && ((premove.from[0]===r&&premove.from[1]===c)||(premove.to[0]===r&&premove.to[1]===c))));

      const isChecked=!!(checked && checked[0]===r && checked[1]===c);
      // Visual marker only: CSS uses outline, never a background overlay.
      // Keep the square's board texture completely untouched.
      sq.classList.toggle('check', isChecked);
      if(isChecked) sq.dataset.check='true'; else if(sq.dataset.check) delete sq.dataset.check;

      const wantMarkerType=markerTypes.get(`${r},${c}`)||null;
      if(cell.markerType!==wantMarkerType){
        if(cell.markerEl){cell.markerEl.remove();cell.markerEl=null;}
        if(wantMarkerType){
          const el=document.createElement('span');
          el.className=wantMarkerType==='capture'?'capture-marker':'legal-marker';
          sq.appendChild(el);
          cell.markerEl=el;
        }
        cell.markerType=wantMarkerType;
      }

      const piece=vs.board[r][c];
      if(piece){
        if(!cell.pieceWrap){
          cell.pieceWrap=document.createElement('div');
          cell.pieceImg=document.createElement('img');
          cell.pieceImg.draggable=false;
          cell.pieceImg.addEventListener('error',()=>{
            if(cell.pieceImg.dataset.fallbackApplied!=='1' && cell.piece){
              cell.pieceImg.dataset.fallbackApplied='1';
              cell.pieceImg.src=staticUrl(`pieces/cburnett/${ASSETS[cell.piece]}.svg`);
            }
          });
          cell.pieceWrap.appendChild(cell.pieceImg);
          cell.pieceWrap.draggable=false;
          sq.appendChild(cell.pieceWrap);
        }
        const pieceClass=`piece ${ChessEngine.typeOf(piece)==='p'?'pawn':''}`;
        if(cell.pieceWrap.className!==pieceClass) cell.pieceWrap.className=pieceClass;
        if(cell.pieceWrap.dataset.piece!==piece) cell.pieceWrap.dataset.piece=piece;
        cell.piece=piece;
        // Re-resolve the URL every time (not just when the logical piece
        // changes): the active piece style can change independently via the
        // appearance picker, and the image must follow it without a full
        // board rebuild.
        const wantSrc=assetUrl(piece);
        if(cell.pieceSrc!==wantSrc){
          cell.pieceImg.dataset.fallbackApplied='';
          cell.pieceImg.src=wantSrc;
          cell.pieceImg.alt=`${ChessEngine.colorOf(piece)==='white'?'Weiß':'Schwarz'} ${ChessEngine.PIECE_NAMES[ChessEngine.typeOf(piece)]}`;
          cell.pieceSrc=wantSrc;
        }
      } else if(cell.pieceWrap){
        cell.pieceWrap.remove();
        cell.pieceWrap=null; cell.pieceImg=null; cell.pieceSrc=null; cell.piece=null;
      }
    }

    document.documentElement.classList.toggle('premove-possible',canPremove());
    updateStatus(st,vs);
    renderMoves();
    renderCaptured(vs);
    renderNavigation();
    renderOpening();
    renderEvalGraph();
    paintEval();
    drawOverlay();
    undoBtn.disabled=history.length===0||!live;
    if (typeof window.paintBoardSquares === 'function') window.paintBoardSquares();
  }

  let dragSession=null;
  let moveTransaction=null;

  function getInteractionSettings(){
    if(typeof window.getChessSettings === 'function') return window.getChessSettings();
    return {pieceAnimationEnabled:true,pieceAnimation:'medium',pieceMovement:'drag-or-click',animation:{duration:280,easing:'cubic-bezier(0.4,0,0.2,1)'}};
  }

  function boardSquareCenter(r,c){
    const el=boardEl.querySelector(`.square[data-row="${r}"][data-col="${c}"]`);
    if(!el)return null;
    const rect=el.getBoundingClientRect();
    return {x:rect.left+rect.width/2,y:rect.top+rect.height/2,width:rect.width,height:rect.height};
  }

  function makeDragGhost(piece,x,y){
    const ghost=document.createElement('div');
    ghost.className='drag-ghost';
    const img=document.createElement('img');
    img.src=assetUrl(piece);
    img.alt='';
    ghost.appendChild(img);
    const sq=boardSquareCenter(dragSession.r,dragSession.c);
    const factor=piece.toLowerCase()==='p'?0.864:0.88;
    const size=Math.min((sq?.width||80)*factor,(sq?.height||80)*factor);
    ghost.style.setProperty('--piece-size',`${size}px`);
    ghost._halfSize=size/2;
    ghost.style.left='0px'; ghost.style.top='0px';
    ghost.style.transform=`translate3d(${x-size/2}px,${y-size/2}px,0)`;
    document.body.appendChild(ghost);
    return ghost;
  }

  function moveGhost(ghost,x,y){
    if(!ghost) return;
    ghost._targetX=x; ghost._targetY=y;
    if(ghost._rafPending) return;
    ghost._rafPending=true;
    requestAnimationFrame(()=>{
      ghost._rafPending=false;
      const halfW=ghost._halfSize || 36;
      ghost.style.transform=`translate3d(${ghost._targetX-halfW}px,${ghost._targetY-halfW}px,0)`;
    });
  }

  function removeDragGhost(){
    if(dragSession?.ghost){dragSession.ghost.remove();dragSession.ghost=null;}
  }

  // One stable board-level pointer controller. Render() may replace every
  // square, but these handlers stay attached to #chess-board.
  // Resolve the drop square from the real square rectangles rather than
  // assuming #chess-board is a mathematically perfect 8x8 rectangle.
  // This remains correct with borders, zoom, fractional CSS pixels,
  // responsive sizing and custom board themes.
  function pointerToSquare(clientX, clientY){
    const squares=boardEl.querySelectorAll('.square');
    for(const sq of squares){
      const rect=sq.getBoundingClientRect();
      if(clientX >= rect.left && clientX < rect.right && clientY >= rect.top && clientY < rect.bottom){
        return {row:Number(sq.dataset.row), col:Number(sq.dataset.col)};
      }
    }
    return null;
  }

  function beginDrag(e){
    // The right button draws annotations. It shares this handler rather than
    // adding a second pointerdown listener: one pointer pipeline on the board
    // is what keeps drag, click and drawing from racing each other.
    if(e.button===2){
      e.preventDefault();
      // The right button is also the way out of a queued premove, which is
      // what every other board does with it.
      if(premove){ premove=null; render(); }
      drawFrom=pointerToSquare(e.clientX,e.clientY);
      return;
    }
    if(e.button!==0 || gameEnded || moveTransaction || pendingPromotion || dragSession) return;
    const acting=inputColor();
    if(!acting) return;
    const settings=getInteractionSettings();
    if(settings.pieceMovement==='click') return;
    const start=pointerToSquare(e.clientX,e.clientY);
    if(!start) return;
    // Touching the board replaces whatever was queued.
    if(premove) premove=null;
    const piece=getPiece(start.row,start.col);
    if(!piece || ChessEngine.colorOf(piece)!==acting) return;

    e.preventDefault();
    const session={
      r:start.row,c:start.col,piece,pointerId:e.pointerId,
      startX:e.clientX,startY:e.clientY,moved:false,ghost:null,
      dropHandled:false,settings,sourceSquare:e.target.closest?.('.square')
    };
    dragSession=session;
    activePointerId=e.pointerId;
    selected=[start.row,start.col];
    try{boardEl.setPointerCapture(e.pointerId);}catch{}
  }

  function updateDrag(e){
    const s=dragSession;
    if(!s || s.pointerId!==e.pointerId || s.dropHandled) return;
    e.preventDefault();
    if(!s.moved && Math.hypot(e.clientX-s.startX,e.clientY-s.startY)>5){
      s.moved=true;
      document.body.classList.add('piece-dragging');
      s.ghost=makeDragGhost(s.piece,e.clientX,e.clientY);
      s.sourceSquare?.classList.add('drag-source-hidden');
    }
    if(s.moved) moveGhost(s.ghost,e.clientX,e.clientY);
  }

  function finishDrag(e){
    if(e.button===2){
      e.preventDefault();
      const start=drawFrom;
      drawFrom=null;
      const end=start?pointerToSquare(e.clientX,e.clientY):null;
      if(!end) return;
      if(end.row===start.row&&end.col===start.col) toggleMark(start.row,start.col);
      else toggleArrow(start.row,start.col,end.row,end.col);
      return;
    }
    const s=dragSession;
    if(!s || s.pointerId!==e.pointerId || s.dropHandled) return;
    e.preventDefault();
    s.dropHandled=true;
    const moved=s.moved;
    const fromR=s.r, fromC=s.c;
    const target=pointerToSquare(e.clientX,e.clientY);
    const dropPoint={x:e.clientX,y:e.clientY};

    s.sourceSquare?.classList.remove('drag-source-hidden');
    if(s.ghost){s.ghost.remove();s.ghost=null;}
    document.body.classList.remove('piece-dragging');
    dragSession=null; activePointerId=null;
    try{if(boardEl.hasPointerCapture(e.pointerId))boardEl.releasePointerCapture(e.pointerId);}catch{}

    if(!moved){
      if(s.settings.pieceMovement==='drag') selected=null;
      render();
      return;
    }

    suppressNextClick=true;
    window.setTimeout(()=>{suppressNextClick=false;},50);
    requestAnimationFrame(()=>{
      try{
        if(target) tryMove(fromR,fromC,target.row,target.col,{dragged:true,dropPoint});
        else {selected=null;render();}
      }catch(error){
        console.error('Chess move pipeline error:',error);
        moveTransaction=null; selected=null; render();
      }
    });
  }

  function cancelDrag(e){
    const s=dragSession;
    if(!s || s.pointerId!==e.pointerId)return;
    s.sourceSquare?.classList.remove('drag-source-hidden');
    if(s.ghost)s.ghost.remove();
    document.body.classList.remove('piece-dragging');
    dragSession=null; activePointerId=null; selected=null;
    try{if(boardEl.hasPointerCapture(e.pointerId))boardEl.releasePointerCapture(e.pointerId);}catch{}
    render();
  }

  function onSquareClick(r,c){
    if(suppressNextClick){suppressNextClick=false;return;}
    if(gameEnded)return;
    const acting=inputColor();
    if(!acting) return;
    const settings=getInteractionSettings();
    const p=getPiece(r,c);
    if(settings.pieceMovement==='drag') return;
    // Touching the board replaces whatever was queued. A premove always
    // leaves the selection empty, so the two never coexist.
    if(premove) premove=null;
    if(!selected){ if(p && ChessEngine.colorOf(p)===acting){selected=[r,c];} render(); return; }
    // Clicking one of your own pieces normally just moves the selection - but
    // the king onto its own rook is castling, and treating that as a
    // re-selection is what made the click path refuse to castle at all.
    const gesture=ChessEngine.castlingTarget(shownState(),selected,[r,c]);
    if(!gesture && p && ChessEngine.colorOf(p)===acting){selected=[r,c];render();return;}
    tryMove(selected[0],selected[1],r,c,{dragged:false});
  }

  function tryMove(fr,fc,tr,tc,interaction={dragged:false}){
    /* eslint-disable-next-line no-param-reassign -- the castling gesture below
       renames the target square before anything else looks at it. */
    if (moveTransaction) return;
    const acting=inputColor();
    if(!acting) return;
    const piece=getPiece(fr,fc);
    if(!piece || ChessEngine.colorOf(piece)!==acting) return;

    // Dropping the king on its own rook is how a lot of players castle; it
    // names a square no legal move goes to, so without this the board just
    // sat there and the move looked broken.
    const castled=ChessEngine.castlingTarget(state,[fr,fc],[tr,tc]);
    if(castled){ tr=castled[0]; tc=castled[1]; }

    // Not our turn: the move is queued instead of played.
    if(acting!==state.turn){ queuePremove([fr,fc],[tr,tc]); return; }

    // Resolve the move through the engine once, from the pair of squares the
    // player actually gave us. `findLegalMove` cannot be used here: a
    // promotion is four moves over the same two squares and matches none of
    // them until the piece is named, so asking for one returned nothing and
    // the promotion dialog below was unreachable.
    const candidates=ChessEngine.movesBetween(state,[fr,fc],[tr,tc]);
    if(!candidates.length){
      selected=[fr,fc];
      if (interaction.dragged) {
        // A rejected drag should never lock the board. Repaint only the
        // selection state; no move transaction is started.
        render();
      }
      return;
    }
    if(candidates.length>1&&candidates[0].promotion){
      pendingPromotion={fr,fc,tr,tc,candidates};
      openPromotion(piece);
      return;
    }
    commitMove(candidates[0], interaction);
  }

  function openPromotion(piece){
    promoOptions.innerHTML='';
    const choices=piece===piece.toUpperCase()?['Q','R','B','N']:['q','r','b','n'];
    for(const p of choices){const b=document.createElement('button');b.type='button';b.className='promotion-option';const img=document.createElement('img');img.src=assetUrl(p);img.alt=ChessEngine.PIECE_NAMES[ChessEngine.typeOf(p)];b.appendChild(img);b.addEventListener('click',()=>{const move=pendingPromotion.candidates.find(m=>m.promotion===p.toLowerCase());closePromotion();commitMove(move);});promoOptions.appendChild(b);}
    promoOverlay.hidden=false;
  }
  function closePromotion(){promoOverlay.hidden=true;pendingPromotion=null;}

  /** One floating copy of a piece, positioned over the board. */
  function makeAnimator(piece, size, kind){
    const animator=document.createElement('div');
    animator.className=`move-animator ${kind}`;
    const img=document.createElement('img');
    img.src=assetUrl(piece); img.alt='';
    img.addEventListener('error',()=>{
      const fallback=staticUrl(`pieces/cburnett/${ASSETS[piece]}.svg`);
      if(img.src!==new URL(fallback,location.href).href) img.src=fallback;
    },{once:true});
    animator.appendChild(img);
    animator.style.width=`${size}px`;
    animator.style.height=`${size}px`;
    animator.style.left='0px';
    animator.style.top='0px';
    document.body.appendChild(animator);
    return animator;
  }

  function pieceScale(piece){ return piece.toLowerCase()==='p'?0.864:0.88; }

  /**
   * Plays the move.
   *
   * A move can involve more than one piece. Castling moves two, and the board
   * used to animate only the king - the rook simply appeared at its
   * destination the moment the final position was painted, which is what made
   * castling look broken. A capture removes a third piece, which likewise used
   * to vanish between two frames.
   *
   * So this animates a list: everything that travels, plus everything that
   * leaves the board. `done` runs once, after the last of them.
   */
  function animateMove(move, piece, interaction, done){
    const settings=getInteractionSettings();
    if(!settings.pieceAnimationEnabled){done();return;}

    const base=settings.animation || {duration:280,easing:'cubic-bezier(0.4,0,0.2,1)'};

    // The rook follows a beat after the king. Simultaneous reads as a glitch
    // because the two cross paths; the small stagger makes it legible as one
    // deliberate manoeuvre.
    const travellers=[{piece,from:move.from,to:move.to,delay:0,dragged:true}];
    if(move.isCastle && move.rookFrom && move.rookTo){
      const rook=ChessEngine.colorOf(piece)==='white'?'R':'r';
      travellers.push({piece:rook,from:move.rookFrom,to:move.rookTo,delay:60,dragged:false});
    }

    const animators=[];
    const animations=[];
    let longest=0;

    for(const leg of travellers){
      const from=boardSquareCenter(leg.from[0],leg.from[1]);
      const to=boardSquareCenter(leg.to[0],leg.to[1]);
      if(!from||!to) continue;

      const size=Math.min(from.width,to.width)*pieceScale(leg.piece);
      // A drag already carried the piece to where the pointer let go; starting
      // from the square centre instead would snap it backwards first.
      const startPoint=(leg.dragged && interaction?.dragged && interaction.dropPoint)
        ? interaction.dropPoint : {x:from.x,y:from.y};

      const startTransform=`translate3d(${startPoint.x-size/2}px,${startPoint.y-size/2}px,0)`;
      const endTransform=`translate3d(${to.x-size/2}px,${to.y-size/2}px,0)`;
      const distance=Math.hypot(to.x-startPoint.x,to.y-startPoint.y);

      let duration=base.duration;
      if(settings.pieceAnimation==='dynamic') duration=Math.round(Math.max(120,Math.min(420,distance*1.8)));
      if(distance<2) duration=Math.min(duration,90);

      const midpoint=fraction=>`translate3d(${startPoint.x-size/2+(to.x-startPoint.x)*fraction}px,${startPoint.y-size/2+(to.y-startPoint.y)*fraction}px,0)`;
      let keyframes;
      if(settings.pieceAnimation==='arcade'){
        keyframes=[{transform:startTransform},{transform:`${midpoint(.58)} scale(1.035)`},{transform:endTransform}];
      } else if(settings.pieceAnimation==='dynamic'){
        keyframes=[{transform:startTransform},{transform:`${midpoint(.72)} scale(1.025)`},{transform:endTransform}];
      } else {
        keyframes=[{transform:startTransform},{transform:endTransform}];
      }

      const animator=makeAnimator(leg.piece,size,settings.pieceAnimation);
      animator.style.transform=startTransform;
      animators.push(animator);
      longest=Math.max(longest,duration+leg.delay);

      try{
        animations.push(animator.animate(keyframes,{
          duration, delay:leg.delay, easing:base.easing, fill:'both'
        }));
      }catch{
        animator.style.transform=endTransform;
      }
    }

    // The piece being taken. It is already gone from the board by now, so this
    // is a copy that shrinks away on the square it stood on - without it a
    // capture is the one move where something simply blinks out of existence.
    const captured=move.captured;
    if(captured){
      const square=move.isEnPassant?[move.from[0],move.to[1]]:[move.to[0],move.to[1]];
      const spot=boardSquareCenter(square[0],square[1]);
      if(spot){
        const size=spot.width*pieceScale(captured);
        const ghost=makeAnimator(captured,size,'captured');
        const at=`translate3d(${spot.x-size/2}px,${spot.y-size/2}px,0)`;
        ghost.style.transform=at;
        animators.push(ghost);
        try{
          animations.push(ghost.animate(
            [{transform:`${at} scale(1)`,opacity:1},{transform:`${at} scale(.55)`,opacity:0}],
            {duration:Math.max(140,base.duration*0.8),easing:'cubic-bezier(.4,0,.6,1)',fill:'both'}));
        }catch{ ghost.remove(); }
      }
    }

    if(!animators.length){ done(); return; }

    let finished=false;
    const finish=()=>{
      if(finished)return;
      finished=true;
      for(const a of animations){ try{a.cancel();}catch{} }
      for(const el of animators) el.remove();
      done();
    };

    // Resolved together: the move is over when the last piece has landed.
    Promise.all(animations.map(a=>a.finished.catch(()=>{}))).then(finish);

    // The same safety net the move transaction already gets, for the same
    // reason: `finished` is not guaranteed to settle. A backgrounded tab all
    // but stops the animation clock, so it can resolve minutes late or never -
    // and every missed one leaves a floating piece in the DOM. The real
    // position is already on the board, so removing them early costs nothing.
    window.setTimeout(finish,longest+220);
  }

  function commitMove(move, interaction={dragged:false}){
    if (moveTransaction) return;
    const piece=getPiece(move.from[0],move.from[1]);
    if(!piece || ChessEngine.colorOf(piece)!==state.turn) return;

    // Take the snapshot before mutating state so undo remains atomic.
    const previous=snapshot();
    const before=state;
    const next=ChessEngine.applyMove(state,move);
    const nextRepetition={...repetition};
    const key=ChessEngine.fenKey(next);
    nextRepetition[key]=(nextRepetition[key]||0)+1;
    const notation=ChessEngine.sanForMove(before,move,next,nextRepetition);
    const nextStatus=ChessEngine.status(next,nextRepetition);

    history.push(previous);
    repetition=nextRepetition;
    movesLog.push({from:move.from,to:move.to,notation});
    state=next;
    selected=null;
    // A move always returns the board to the live position; annotations and a
    // shown hint belong to the position they were drawn in. The premove is
    // deliberately NOT cleared here: the opponent's move landing is precisely
    // the moment a queued premove has been waiting for, and this runs just
    // before afterMoveSettled plays it.
    viewPly=movesLog.length;arrows=[];marks=[];hintMove=null;
    gameEnded=['checkmate','stalemate','fifty-move','threefold','insufficient-material'].includes(nextStatus.type);

    if(window.ChessClock){
      const mover=ChessEngine.colorOf(piece);
      if(gameEnded) window.ChessClock.stop();
      else window.ChessClock.onMoveMade(mover,state.turn);
    }

    announceMove(move,nextStatus);
    if(gameEnded) window.setTimeout(()=>showGameOver(nextStatus),650);
    refreshEvaluation();

    const settings=getInteractionSettings();
    const shouldAnimate=!!settings.pieceAnimationEnabled;
    moveTransaction={from:move.from,to:move.to,piece,startedAt:performance.now()};

    // Render the final logical position exactly once. The moving piece is
    // hidden only after this render, while a separate compositor-layer copy
    // performs the visual movement. No render is allowed during the animation.
    render();

    if(!shouldAnimate){
      moveTransaction=null;
      // The animated path schedules this after the animation finishes; with
      // animations off there is nothing to wait for.
      window.setTimeout(afterMoveSettled,0);
      return;
    }

    // Every square a piece is flying to, not just the mover's. The final
    // position is already painted, so an unhidden destination shows the piece
    // sitting there while its copy is still in the air - which is exactly what
    // made castling look wrong: the rook had arrived before the king moved.
    const landing=[move.to];
    if(move.isCastle && move.rookTo) landing.push(move.rookTo);
    const hidden=landing
      .map(([r,c])=>document.querySelector(`.square[data-row="${r}"][data-col="${c}"]`))
      .filter(Boolean);
    for(const square of hidden) square.classList.add('animation-target-hidden');

    let completed=false;
    const finish=()=>{
      if(completed)return;
      completed=true;
      for(const square of hidden) square.classList.remove('animation-target-hidden');
      moveTransaction=null;
      // Do NOT rebuild the board here. The final state was already rendered;
      // rebuilding here was one of the sources of pointer/render races.
    };

    animateMove(move,piece,interaction,finish);

    // Hard safety net: a visual animation can never lock gameplay forever,
    // even if a browser refuses to fire an animation completion callback. The
    // castling rook starts a beat late, so the net has to outlast that too.
    const stagger=move.isCastle?60:0;
    const duration=Math.max(120,(settings.animation?.duration||280)+stagger+180);
    window.setTimeout(finish,duration);
    window.setTimeout(afterMoveSettled,duration+20);
  }

  /**
   * Asks the engine for a reply when it is the computer's turn.
   *
   * `aiGeneration` invalidates in-flight searches: if the player starts a new
   * game or takes a move back while the engine is thinking, the answer that
   * arrives afterwards belongs to a position that no longer exists and must be
   * discarded rather than played onto the current board.
   */
  let aiGeneration=0;
  async function maybeRequestComputerMove(){
    if(!window.ChessAI || !window.ChessAI.isComputerTurn(state.turn)) return;
    if(gameEnded || moveTransaction || pendingPromotion || window.ChessAI.isThinking()) return;

    const generation=aiGeneration;
    setThinking(true);
    try{
      const move=await window.ChessAI.requestMove(ChessEngine.cloneState(state));
      if(generation!==aiGeneration) return;
      if(gameEnded) return;
      if(!move){
        // Either the engine had nothing to play, or its answer was not a legal
        // move in this position and was rejected. Both must surface: leaving
        // the "thinking" text in place would look like a freeze.
        reportAiError(new Error('Die Engine hat keinen gültigen Zug geliefert.'));
        return;
      }
      commitMove(move,{dragged:false});
    }catch(error){
      if(generation===aiGeneration) reportAiError(error);
    }finally{
      if(generation===aiGeneration) setThinking(false);
    }
  }

  function setThinking(active){
    document.documentElement.classList.toggle('ai-thinking',!!active);
    // render() last ran while the move transaction was still open, when a
    // premove is by definition impossible. This is the point where it becomes
    // possible, so the board must stop showing a "wait" cursor here.
    document.documentElement.classList.toggle('premove-possible',canPremove());
    if(active && statusExtra) statusExtra.textContent='Der Computer denkt nach …';
  }

  function reportAiError(error){
    if(statusExtra) statusExtra.textContent=`Engine-Fehler: ${error?.message||error}`;
  }

  function updateStatus(st,vs){
    statusCard.classList.remove('check-state','game-over');
    // While the player is looking back through the game, the status line
    // describes the position on screen, not the result of the game.
    if(!isLive()){
      const total=movesLog.length;
      turnText.textContent=viewPly===0?'Startstellung':`Nach ${movesLog[viewPly-1].notation}`;
      statusExtra.textContent=`Zug ${viewPly} von ${total} – zurück zur Partie mit ▶ oder der Ende-Taste.`;
      return;
    }
    // Resignation and a fallen flag both end the game regardless of what the
    // position looks like, so they come before any engine-derived result.
    if(resignedBy){
      statusCard.classList.add('game-over');
      turnText.textContent=`${resignedBy==='white'?'Schwarz':'Weiß'} gewinnt`;
      statusExtra.textContent=`${resignedBy==='white'?'Weiß':'Schwarz'} hat aufgegeben.`;
      return;
    }
    if(timeoutResult){
      statusCard.classList.add('game-over');
      const loser=timeoutResult.flagged==='white'?'Weiß':'Schwarz';
      if(timeoutResult.type==='timeout-draw'){
        turnText.textContent='Remis – Zeit abgelaufen';
        statusExtra.textContent=`${loser} hat die Zeit überschritten, dem Gegner fehlt aber das Mattmaterial.`;
      } else {
        turnText.textContent=`Zeit abgelaufen – ${timeoutResult.winner==='white'?'Weiß':'Schwarz'} gewinnt`;
        statusExtra.textContent=`${loser} hat die Bedenkzeit überschritten.`;
      }
      return;
    }
    if(st.type==='checkmate'){
      statusCard.classList.add('game-over');turnText.textContent=`Schachmatt – ${st.winner==='white'?'Weiß':'Schwarz'} gewinnt`;statusExtra.textContent='Die Partie ist beendet.';
    } else if(st.type==='stalemate'){
      statusCard.classList.add('game-over');turnText.textContent='Patt – Remis';statusExtra.textContent='Kein legaler Zug mehr möglich.';
    } else if(st.type==='fifty-move'){
      statusCard.classList.add('game-over');turnText.textContent='50-Züge-Regel – Remis';statusExtra.textContent='Die Partie ist beendet.';
    } else if(st.type==='threefold'){
      statusCard.classList.add('game-over');turnText.textContent='Dreifache Stellungswiederholung – Remis';statusExtra.textContent='Die Partie ist beendet.';
    } else if(st.type==='insufficient-material'){
      statusCard.classList.add('game-over');turnText.textContent='Remis – unzureichendes Material';statusExtra.textContent='Die Partie ist beendet.';
    } else if(st.type==='check'){
      statusCard.classList.add('check-state');turnText.textContent=`${vs.turn==='white'?'Weiß':'Schwarz'} ist am Zug`;statusExtra.textContent='Schach! Der König steht im Angriff.';
    } else {
      turnText.textContent=`${vs.turn==='white'?'Weiß':'Schwarz'} ist am Zug`;
      statusExtra.textContent=engineNotice||(premove
        ?`Premove ${ChessEngine.squareName(premove.from[0],premove.from[1])}–${ChessEngine.squareName(premove.to[0],premove.to[1])} vorgemerkt. Rechtsklick bricht ab.`
        :(selected?'Gültige Zielfelder sind markiert.':'Wähle eine Figur aus.'));
    }
  }

  /* ===================================================================== *
   * Move list and navigation
   * ===================================================================== */

  function moveCellHtml(index){
    const entry=movesLog[index];
    if(!entry) return '<span class="move-cell"></span>';
    const judged=reviewPlies&&reviewPlies[index];
    const tone=judged?` tone-${judged.tone}`:'';
    const symbol=judged?`<span class="move-mark">${judged.symbol}</span>`:'';
    // viewPly counts positions, so the move at index i is "current" when the
    // board shows the position that came after it.
    const current=viewPly===index+1?' current':'';
    return `<button type="button" class="move-cell move-link${tone}${current}" data-ply="${index+1}" title="${judged?judged.label:''}">${entry.notation}${symbol}</button>`;
  }

  function renderMoves(){
    moveCount.textContent=movesLog.length;
    if(!movesLog.length){
      movesList.innerHTML='<div class="empty-moves">Noch keine Züge gespielt.</div>';
      return;
    }
    let html='';
    for(let i=0;i<movesLog.length;i+=2){
      html+=`<div class="move-row"><span class="move-number">${Math.floor(i/2)+1}.</span>${moveCellHtml(i)}${moveCellHtml(i+1)}</div>`;
    }
    movesList.innerHTML=html;
    const active=movesList.querySelector('.move-link.current');
    if(active) active.scrollIntoView({block:'nearest'});
    else movesList.scrollTop=movesList.scrollHeight;
  }

  function renderNavigation(){
    const atStart=viewPly<=0, atEnd=isLive();
    for(const [id,disabled] of [['nav-first',atStart],['nav-prev',atStart],['nav-next',atEnd],['nav-last',atEnd]]){
      const el=document.getElementById(id);
      if(el) el.disabled=disabled;
    }
  }

  /**
   * Jumps to a position in the game.
   *
   * Any in-flight engine search is invalidated: stepping back and then
   * returning to the end would otherwise let a reply that was computed for the
   * old position land on the board.
   */
  function goToPly(target){
    if(moveTransaction||pendingPromotion) return;
    const clamped=Math.max(0,Math.min(target,movesLog.length));
    if(clamped===viewPly) return;
    viewPly=clamped;
    selected=null;
    hintMove=null;premove=null;
    arrows=[]; marks=[];
    render();
    // Returning to the live position may hand the turn back to the computer.
    if(isLive()) window.setTimeout(maybeRequestComputerMove,0);
  }

  /* ===================================================================== *
   * Premoves
   * ===================================================================== */

  /**
   * Queues a move for after the opponent's reply.
   *
   * The move cannot be checked for legality here - the position it will be
   * played in does not exist yet. `premoveTargets` only rejects what is
   * implausible for that piece; `findLegalMove` is still the authority when
   * the premove actually runs.
   */
  function queuePremove(from,to){
    const gesture=ChessEngine.castlingTarget(state,from,to);
    if(gesture) to=gesture;
    const targets=ChessEngine.premoveTargets(state,from);
    const reachable=targets.some(t=>t[0]===to[0]&&t[1]===to[1]);
    selected=null;
    if(!reachable){ premove=null; render(); return; }
    premove={from:[...from],to:[...to]};
    render();
    window.ChessSound?.play('notify');
  }

  /**
   * Plays the queued premove, if one is waiting and it turned out legal.
   *
   * Returns true when a move was committed, so the caller knows the next
   * round has already been scheduled by commitMove itself.
   */
  function runPremove(){
    if(!premove) return false;
    const queued=premove;
    premove=null;

    if(gameEnded||moveTransaction||pendingPromotion||!isLive()) return false;
    if(window.ChessAI&&window.ChessAI.isComputerTurn(state.turn)) return false;

    const candidates=ChessEngine.movesBetween(state,queued.from,queued.to);
    // A queen, without asking. The dialog would appear a fraction of a second
    // after the opponent moved, on a board the player is not even looking at
    // yet - which is the opposite of what a premove is for.
    const move=candidates.find(m=>(m.promotion||'q').toLowerCase()==='q')||candidates[0]||null;
    if(!move){
      // Entirely normal: the opponent's move may have taken the piece, blocked
      // the square or left the king in check. Silently dropping it would look
      // like the board ignored the click.
      render();
      statusExtra.textContent='Der Premove war nach dem Gegenzug nicht möglich und wurde verworfen.';
      window.ChessSound?.play('illegal');
      return false;
    }

    commitMove(move,{dragged:false});
    return true;
  }

  /**
   * What happens once a move has fully landed: the queued premove gets its
   * turn first, and only if there is none does the engine get asked.
   */
  function afterMoveSettled(){
    if(runPremove()) return;
    maybeRequestComputerMove();
  }

  /* ===================================================================== *
   * Board orientation
   * ===================================================================== */

  /**
   * Flips the board by reordering the grid items rather than rotating them.
   *
   * A CSS rotation would also turn every piece image upside down and need a
   * counter-rotation on each one. Setting `order` leaves the DOM, the pointer
   * geometry and the diff-renderer completely untouched: squares keep their
   * real coordinates and getBoundingClientRect still reports where they
   * actually are.
   */
  function applyOrientation(){
    if(!cells) return;
    for(let r=0;r<8;r++)for(let c=0;c<8;c++){
      const index=r*8+c;
      cells[r][c].sq.style.order=String(flipped?63-index:index);
    }
    buildLabels();
    boardEl.classList.toggle('flipped',flipped);
  }

  function setFlipped(value){
    flipped=!!value;
    applyOrientation();
    render();
  }

  /* ===================================================================== *
   * Captured pieces and material
   * ===================================================================== */

  const FULL_SET={p:8,n:2,b:2,r:2,q:1};
  const PIECE_VALUE={p:1,n:3,b:3,r:5,q:9};
  const GLYPHS={p:'♟',n:'♞',b:'♝',r:'♜',q:'♛'};

  /** What each side is missing, derived from the board rather than tracked. */
  function capturedFrom(board){
    const counts={white:{p:0,n:0,b:0,r:0,q:0},black:{p:0,n:0,b:0,r:0,q:0}};
    for(const row of board) for(const piece of row){
      if(!piece) continue;
      const type=ChessEngine.typeOf(piece);
      if(type==='k') continue;
      counts[ChessEngine.colorOf(piece)][type]++;
    }
    const missing={white:{},black:{}};
    let balance=0;
    for(const color of ['white','black']){
      for(const [type,total] of Object.entries(FULL_SET)){
        // Promotions can leave a side with *more* queens than it started with,
        // which would otherwise show up as a negative number of captures.
        const gone=Math.max(0,total-counts[color][type]);
        missing[color][type]=gone;
        balance+=(color==='white'?-1:1)*gone*PIECE_VALUE[type];
      }
    }
    return {missing,balance};
  }

  function capturedHtml(missing,advantage){
    let html='';
    for(const type of ['q','r','b','n','p']){
      for(let i=0;i<missing[type];i++) html+=`<span class="captured-piece">${GLYPHS[type]}</span>`;
    }
    if(advantage>0) html+=`<span class="material-plus">+${advantage}</span>`;
    return html;
  }

  function renderCaptured(vs){
    const {missing,balance}=capturedFrom(vs.board);
    // The strip at the bottom belongs to whoever is playing from that side.
    const bottomColor=flipped?'black':'white';
    const topColor=flipped?'white':'black';
    // A player's strip shows the pieces they have taken, i.e. the opponent's
    // missing ones.
    bottomCaptured.innerHTML=capturedHtml(missing[topColor],bottomColor==='white'?balance:-balance);
    topCaptured.innerHTML=capturedHtml(missing[bottomColor],topColor==='white'?balance:-balance);
    bottomName.textContent=bottomColor==='white'?'Weiß':'Schwarz';
    topName.textContent=topColor==='white'?'Weiß':'Schwarz';
    bottomAvatar.textContent=bottomColor==='white'?'♔':'♚';
    topAvatar.textContent=topColor==='white'?'♔':'♚';
  }

  /* ===================================================================== *
   * Opening name
   * ===================================================================== */

  function renderOpening(){
    if(!openingEl||!window.ChessOpenings) return;
    const hit=window.ChessOpenings.lookup(movesLog.slice(0,viewPly).map(m=>m.notation));
    openingEl.hidden=!hit;
    if(hit) openingEl.textContent=`${hit.eco} · ${hit.name}`;
  }

  /* ===================================================================== *
   * Arrows and square marks (right mouse button, as on any board)
   * ===================================================================== */

  const SVG_NS='http://www.w3.org/2000/svg';

  /** Board coordinates to overlay coordinates, honouring the orientation. */
  function overlayPoint(r,c){
    const vr=flipped?7-r:r, vc=flipped?7-c:c;
    return {x:vc*10+5,y:vr*10+5};
  }

  function drawOverlay(){
    if(!overlayEl) return;
    overlayEl.innerHTML='';
    for(const [r,c] of marks){
      const {x,y}=overlayPoint(r,c);
      const circle=document.createElementNS(SVG_NS,'circle');
      circle.setAttribute('cx',x); circle.setAttribute('cy',y); circle.setAttribute('r',4.4);
      circle.setAttribute('class','board-mark');
      overlayEl.appendChild(circle);
    }
    const all=hintMove?arrows.concat([[...hintMove.from,...hintMove.to,'hint']]):arrows;
    for(const [fr,fc,tr,tc,kind] of all){
      const a=overlayPoint(fr,fc), b=overlayPoint(tr,tc);
      const dx=b.x-a.x, dy=b.y-a.y;
      const length=Math.hypot(dx,dy);
      if(!length) continue;
      const ux=dx/length, uy=dy/length;
      // The shaft stops short of the target square's centre so the head sits
      // inside the square instead of overshooting it.
      const head=3.2, gap=1.6;
      const sx=a.x+ux*gap, sy=a.y+uy*gap;
      const ex=b.x-ux*head, ey=b.y-uy*head;

      const line=document.createElementNS(SVG_NS,'line');
      line.setAttribute('x1',sx); line.setAttribute('y1',sy);
      line.setAttribute('x2',ex); line.setAttribute('y2',ey);
      line.setAttribute('class',`board-arrow ${kind==='hint'?'hint':''}`);
      overlayEl.appendChild(line);

      const px=-uy, py=ux;
      const tip=`${b.x-ux*0.4},${b.y-uy*0.4}`;
      const left=`${ex+px*2.2},${ey+py*2.2}`;
      const right=`${ex-px*2.2},${ey-py*2.2}`;
      const headEl=document.createElementNS(SVG_NS,'polygon');
      headEl.setAttribute('points',`${tip} ${left} ${right}`);
      headEl.setAttribute('class',`board-arrow-head ${kind==='hint'?'hint':''}`);
      overlayEl.appendChild(headEl);
    }
  }

  function toggleMark(r,c){
    const at=marks.findIndex(m=>m[0]===r&&m[1]===c);
    if(at>=0) marks.splice(at,1); else marks.push([r,c]);
    drawOverlay();
  }

  function toggleArrow(fr,fc,tr,tc){
    const at=arrows.findIndex(a=>a[0]===fr&&a[1]===fc&&a[2]===tr&&a[3]===tc);
    if(at>=0) arrows.splice(at,1); else arrows.push([fr,fc,tr,tc,'user']);
    drawOverlay();
  }

  /* ===================================================================== *
   * Sound
   * ===================================================================== */

  function announceMove(move,resultingStatus){
    if(!window.ChessSound) return;
    const terminal=['checkmate','stalemate','fifty-move','threefold','insufficient-material'];
    if(terminal.includes(resultingStatus.type)){
      let outcome='draw';
      if(resultingStatus.type==='checkmate'){
        const winner=resultingStatus.winner;
        // "Win" means the human won. In a two-player game at one board there
        // is no losing side to address, so it is always the winning fanfare.
        const humanColor=window.ChessAI&&window.ChessAI.isComputerGame()
          ? window.ChessAI.getSettings().humanColor : winner;
        outcome=winner===humanColor?'win':'loss';
      }
      window.ChessSound.playForMove({gameOver:outcome});
      return;
    }
    window.ChessSound.playForMove({
      captured:!!(move.captured||move.isEnPassant),
      castle:!!move.isCastle,
      promotion:!!move.promotion,
      check:!!resultingStatus.inCheck
    });
  }

  /* ===================================================================== *
   * Evaluation bar
   * ===================================================================== */

  function evalEnabled(){
    try { return JSON.parse(localStorage.getItem('chess-eval-bar')||'false')===true; }
    catch { return false; }
  }

  /**
   * Engines report their score from the side to move; the bar and the review
   * both speak in White's terms. Normalising here keeps that conversion in one
   * place instead of at every call site.
   */
  function whiteRelative(raw,turn){
    if(!raw) return null;
    const sign=turn==='white'?1:-1;
    if(raw.mate!=null) return {mate:raw.mate*sign};
    if(raw.score_cp!=null) return {cp:raw.score_cp*sign};
    return null;
  }

  /**
   * Scores a position for the bar, the hint and the review.
   *
   * Delegated to ChessAI rather than talking to an engine here, because which
   * engine answers depends on where the app is running: the local server's
   * native Stockfish when there is one, the WebAssembly build in the visitor's
   * browser on the published site. Nothing above this line needs to know.
   */
  async function requestEvaluation(fen,movetime=300){
    if(!window.ChessAI) throw new Error('Keine Engine verfügbar');
    return window.ChessAI.analyse(fen,movetime);
  }

  function paintEval(){
    if(!evalBar) return;
    const on=evalEnabled();
    evalBar.hidden=!on;
    if(!on||!window.ChessReview) return;
    const shown=reviewPlies&&!isLive()&&reviewPlies[viewPly-1]
      ? reviewPlies[viewPly-1].evalAfter
      : currentEval;
    const fraction=window.ChessReview.barFraction(shown);
    // The white share grows from the bottom, which is the orientation the
    // player is looking at; flipping the board flips the bar with it.
    evalFill.style.height=`${(flipped?1-fraction:fraction)*100}%`;
    evalScore.textContent=shown?window.ChessReview.formatScore(shown):'';
    evalScore.classList.toggle('for-black',fraction<0.5);
  }

  async function refreshEvaluation(){
    if(!evalEnabled()){ paintEval(); return; }
    const generation=++evalGeneration;
    try{
      const target=state;
      const raw=await requestEvaluation(ChessEngine.toFen(target),300);
      // A newer position was reached while this was in flight.
      if(generation!==evalGeneration) return;
      currentEval=whiteRelative(raw,target.turn);
    }catch{
      if(generation===evalGeneration) currentEval=null;
    }
    paintEval();
  }

  function newGame(){
    if(moveTransaction)return;
    aiGeneration++;
    setThinking(false);
    state=ChessEngine.createInitialState();history=[];movesLog=[];selected=null;
    gameEnded=false;timeoutResult=null;resignedBy=null;engineNotice='';
    viewPly=0;arrows=[];marks=[];hintMove=null;premove=null;reviewPlies=null;reviewEvals=null;currentEval=null;
    // A new game must not inherit a piece still flying across the old one.
    document.querySelectorAll('.move-animator,.drag-ghost').forEach(el=>el.remove());
    document.querySelectorAll('.animation-target-hidden').forEach(el=>el.classList.remove('animation-target-hidden'));
    startingFen=ChessEngine.toFen(state);
    archivedGameId=null;
    evalGeneration++;
    closeGameOver();hideReview();
    closePromotion();resetRepetition();
    if(window.ChessClock){
      window.ChessClock.reset(window.ChessClock.control.id);
      window.ChessClock.resetDisplayCache?.();
      window.ChessClock.repaint?.();
    }
    render();
    window.ChessSound?.play('gameStart');
    refreshEvaluation();
    window.setTimeout(maybeRequestComputerMove,0);
  }
  function undo(){
    if(moveTransaction)return;
    if(!history.length)return;
    // Cancel any search in flight so its result cannot land on the restored
    // position after the take-back.
    aiGeneration++;
    setThinking(false);
    // Against the computer a single take-back would just hand the move
    // straight back to the engine, so undo steps back a full move pair to
    // return the player to their own turn.
    const steps=(window.ChessAI && window.ChessAI.isComputerGame() && history.length>1) ? 2 : 1;
    let prev=null;
    for(let i=0;i<steps && history.length;i++) prev=history.pop();
    state=prev.state;repetition=prev.repetition;movesLog=prev.movesLog;selected=null;
    gameEnded=false;timeoutResult=null;resignedBy=null;
    // The game just got shorter, so the view has to follow it back to the end.
    viewPly=movesLog.length;arrows=[];marks=[];hintMove=null;premove=null;
    // Judgements belong to the moves that were played; taking one back makes
    // the remaining labels stale.
    reviewPlies=null;reviewEvals=null;hideReview();closeGameOver();
    if(window.ChessClock && prev.clock){
      window.ChessClock.restoreState(prev.clock);
      window.ChessClock.resetDisplayCache?.();
      window.ChessClock.repaint?.();
    }
    render();
    refreshEvaluation();
  }

  newBtn.addEventListener('click',newGame);undoBtn.addEventListener('click',undo);

  if(window.ChessClock){
    window.ChessClock.onFlag(flagged=>{
      timeoutResult=window.ChessClock.resolveFlag(state.board,flagged);
      gameEnded=true;
      selected=null;
      render();
    });

    const describeControl=()=>{
      const tc=window.ChessClock.control;
      if(!window.ChessClock.isEnabled()) return 'Ohne Zeit: Die Uhren bleiben ausgeblendet.';
      const minutes=(tc.base/60000);
      const incText=tc.increment?` mit ${tc.increment/1000} Sekunden Zuwachs pro Zug`:' ohne Zuwachs';
      return `${minutes} Minuten pro Spieler${incText}. Die Uhr startet mit dem ersten Zug.`;
    };

    window.addEventListener('chess-time-control-changed',e=>{
      const id=e.detail?.id;
      // Changing the control mid-game would silently rewrite the position's
      // history, so it only takes effect once a fresh game is started.
      if(movesLog.length===0){
        window.ChessClock.reset(id);
        window.ChessClock.resetDisplayCache?.();
        window.ChessClock.repaint?.();
        window.ChessClock.setHint?.(describeControl());
      } else {
        window.ChessClock.setHint?.('Wird mit der nächsten Partie übernommen.');
      }
    });

    window.ChessClock.setHint?.(describeControl());
  }

  if(window.ChessAI){
    const modeSelect=document.getElementById('game-mode-select');
    const colorSelect=document.getElementById('ai-color-select');
    const levelSelect=document.getElementById('ai-level-select');
    const backendSelect=document.getElementById('ai-backend-select');
    const aiOptions=document.getElementById('ai-options');
    const aiHint=document.getElementById('ai-hint');

    if(levelSelect && !levelSelect.options.length){
      for(const level of window.ChessAI.LEVELS){
        const option=document.createElement('option');
        option.value=level.id;option.textContent=level.label;
        levelSelect.appendChild(option);
      }
    }

    const describeAi=()=>{
      const s=window.ChessAI.getSettings();
      if(s.mode!==window.ChessAI.MODES.COMPUTER) return 'Beide Seiten werden von Hand gespielt.';
      if(s.backend==='server'){
        // Availability is checked against the server rather than assumed, so a
        // missing binary is visible before the first move instead of surfacing
        // as a failed search mid-game.
        window.ChessAI.serverEngineStatus().then(status=>{
          if(aiHint && window.ChessAI.getSettings().backend==='server'){
            const strength=s.levelConfig.elo==null
              ? 'ohne Stärkebegrenzung'
              : `begrenzt auf ca. ${s.levelConfig.elo} Elo`;
            aiHint.textContent=status.available
              ? `${status.name||status.file||'Native Engine'} aktiv – ${strength}, bis ${(s.levelConfig.maxTimeMs/1000).toFixed(1)} s pro Zug.`
              : `${status.reason||'Engine nicht verfügbar.'} Lege die Stockfish-Datei in den Projektordner 'engine/' und starte den Server neu.`;
          }
        });
        return 'Prüfe native Engine …';
      }
      if(s.backend==='stockfish'){
        const strength=s.levelConfig.elo==null?'ohne Stärkebegrenzung':`begrenzt auf ca. ${s.levelConfig.elo} Elo`;
        return `Stockfish läuft als WebAssembly in deinem Browser – ${strength}, bis ${(s.levelConfig.maxTimeMs/1000).toFixed(1)} s pro Zug. Nichts wird an einen Server geschickt.`;
      }
      return `Die eingebaute Engine rechnet bis Tiefe ${s.levelConfig.maxDepth} und maximal ${(s.levelConfig.maxTimeMs/1000).toFixed(1)} s pro Zug. Sie läuft in einem Web Worker, das Brett bleibt also bedienbar.`;
    };

    const syncAiControls=()=>{
      const s=window.ChessAI.getSettings();
      if(modeSelect) modeSelect.value=s.mode;
      if(colorSelect) colorSelect.value=s.humanColor;
      if(levelSelect) levelSelect.value=String(s.level);
      if(backendSelect) backendSelect.value=s.backend;
      if(aiOptions) aiOptions.hidden=s.mode!==window.ChessAI.MODES.COMPUTER;
      if(aiHint) aiHint.textContent=describeAi();
    };

    // Mode, colour and engine changes restart the game: applying them to a
    // position already in progress would leave the board mid-game with the
    // sides swapped underneath the player.
    const applyAndRestart=patch=>{
      window.ChessAI.update(patch);
      syncAiControls();
      newGame();
    };

    if(modeSelect) modeSelect.addEventListener('change',()=>applyAndRestart({mode:modeSelect.value}));
    if(colorSelect) colorSelect.addEventListener('change',()=>applyAndRestart({humanColor:colorSelect.value}));
    if(backendSelect) backendSelect.addEventListener('change',()=>{
      // chooseBackend also pins the choice, so auto-selection stops second
      // guessing the player on the next start.
      window.ChessAI.chooseBackend(backendSelect.value);
      syncAiControls();
      newGame();
    });
    // Strength can change mid-game without invalidating anything.
    if(levelSelect) levelSelect.addEventListener('change',()=>{
      window.ChessAI.update({level:Number(levelSelect.value)});
      syncAiControls();
    });

    // The WASM build is an optional download. Offering it when the file is
    // absent only produces an engine error at the worst possible moment, so
    // the option is removed unless it can actually be loaded.
    if(backendSelect){
      const wasmOption=backendSelect.querySelector('option[value="stockfish"]');
      if(wasmOption){
        fetch(staticUrl('stockfish.js'),{method:'HEAD'})
          .then(r=>{ if(!r.ok && window.ChessAI.getSettings().backend!=='stockfish') wasmOption.remove(); })
          .catch(()=>{ if(window.ChessAI.getSettings().backend!=='stockfish') wasmOption.remove(); });
      }
    }

    // A native engine is the better opponent whenever one is installed, but it
    // can only be selected once the server has confirmed it exists.
    window.ChessAI.autoSelectBackend().then(syncAiControls).catch(()=>{});

    window.addEventListener('chess-ai-backend-fallback',event=>{
      const reason=event.detail?.error?.message||'unbekannter Fehler';
      engineNotice=`Native Engine ausgefallen (${reason}) – die eingebaute Engine übernimmt.`;
      if(statusExtra) statusExtra.textContent=engineNotice;
      syncAiControls();
    });

    syncAiControls();
  }

  const movementSelect=document.getElementById('piece-movement-select');
  const movementPreviewTitle=document.getElementById('movement-preview-title');
  const movementPreviewText=document.getElementById('movement-preview-text');
  if(movementSelect){
    const updateMovementPreview=()=>{
      const map={
        'drag-or-click':['Drag oder click','Ziehe Figuren bei gedrückter linker Maustaste oder wähle Start- und Zielfeld per Klick.'],
        'drag':['Nur Drag','Bewege Figuren ausschließlich durch Ziehen mit gedrückter linker Maustaste.'],
        'click':['Nur Klick','Wähle zuerst die Figur und anschließend das Zielfeld per Klick.']
      };
      const v=map[movementSelect.value]||map['drag-or-click'];
      if(movementPreviewTitle) movementPreviewTitle.textContent=v[0];
      if(movementPreviewText) movementPreviewText.textContent=v[1];
    };
    movementSelect.addEventListener('change',updateMovementPreview);
    updateMovementPreview();
  }
  promoOverlay.addEventListener('click',e=>{if(e.target===promoOverlay)closePromotion();});

  // Install interaction once. These listeners survive every render().
  boardEl.addEventListener('pointerdown', beginDrag, {passive:false});
  boardEl.addEventListener('pointermove', updateDrag, {passive:false});
  boardEl.addEventListener('pointerup', finishDrag, {passive:false});
  boardEl.addEventListener('pointercancel', cancelDrag, {passive:false});
  boardEl.addEventListener('lostpointercapture', cancelDrag, {passive:false});
  boardEl.addEventListener('click', e => {
    const square=e.target.closest?.('.square');
    if(square && boardEl.contains(square)) onSquareClick(Number(square.dataset.row),Number(square.dataset.col));
  });

  /* ===================================================================== *
   * Game-over dialog and running record
   * ===================================================================== */

  const gameOverOverlay=document.getElementById('gameover-overlay');

  // The archive entry for the game in progress, once it has been saved. Kept
  // so a game that finishes twice - take the mate back, play on, finish again -
  // updates its record instead of leaving two versions behind.
  let archivedGameId=null;

  const REASON_TEXT={
    checkmate:'Schachmatt', stalemate:'Patt', 'fifty-move':'50-Züge-Regel',
    threefold:'Stellungswiederholung', 'insufficient-material':'Materialmangel',
    resign:'Aufgabe', timeout:'Zeit', 'timeout-draw':'Zeit / Remis'
  };

  /** Writes the finished game to the archive, replacing its own earlier entry. */
  function archiveFinishedGame(outcome,reason){
    if(!window.ChessArchive||!window.ChessNotation||!movesLog.length) return null;
    const computerGame=!!(window.ChessAI&&window.ChessAI.isComputerGame());
    const settings=window.ChessAI?window.ChessAI.getSettings():null;
    const opening=window.ChessOpenings
      ? window.ChessOpenings.lookup(movesLog.map(m=>m.notation)) : null;

    const saved=window.ChessArchive.save({
      id:archivedGameId||undefined,
      result:outcome.result==='draw'?'1/2-1/2':(outcome.result==='white'?'1-0':'0-1'),
      // Only a game against the computer has a result that is *yours*.
      outcome:computerGame?outcome.personal:null,
      reason,
      mode:computerGame?'human-vs-computer':'human-vs-human',
      humanColor:computerGame?settings.humanColor:null,
      level:computerGame?settings.level:null,
      levelLabel:computerGame?settings.levelConfig.label:null,
      engine:computerGame?settings.backend:null,
      moves:movesLog.length,
      opening:opening?`${opening.eco} · ${opening.name}`:null,
      resignedBy:resignedBy||null,
      timeoutResult:timeoutResult||null,
      startFen:startingFen,
      pgn:currentPgn()
    });
    archivedGameId=saved?saved.id:null;
    return saved;
  }

  function describeOutcome(st){
    if(resignedBy){
      const winner=resignedBy==='white'?'black':'white';
      return {result:winner,title:`${winner==='white'?'Weiß':'Schwarz'} gewinnt`,
              reason:`${resignedBy==='white'?'Weiß':'Schwarz'} hat aufgegeben.`};
    }
    if(timeoutResult){
      if(timeoutResult.type==='timeout-draw') return {result:'draw',title:'Remis',reason:'Zeit abgelaufen, dem Gegner fehlt das Mattmaterial.'};
      const winner=timeoutResult.winner;
      return {result:winner,title:`${winner==='white'?'Weiß':'Schwarz'} gewinnt`,reason:'Die Bedenkzeit des Gegners ist abgelaufen.'};
    }
    switch(st.type){
      case 'checkmate': return {result:st.winner,title:`${st.winner==='white'?'Weiß':'Schwarz'} gewinnt`,reason:'Schachmatt.'};
      case 'stalemate': return {result:'draw',title:'Remis',reason:'Patt – der Spieler am Zug hat keinen legalen Zug.'};
      case 'fifty-move': return {result:'draw',title:'Remis',reason:'50 Züge ohne Schlag oder Bauernzug.'};
      case 'threefold': return {result:'draw',title:'Remis',reason:'Dieselbe Stellung ist dreimal aufgetreten.'};
      case 'insufficient-material': return {result:'draw',title:'Remis',reason:'Kein Spieler kann noch mattsetzen.'};
      default: return null;
    }
  }

  /** A short, stable code for how the game ended - stored, never shown raw. */
  function reasonCodeFor(st){
    if(resignedBy) return 'resign';
    if(timeoutResult) return timeoutResult.type==='timeout-draw'?'timeout-draw':'timeout';
    return st&&st.type?st.type:'unfinished';
  }

  function showGameOver(st){
    if(!gameOverOverlay) return;
    const outcome=describeOutcome(st);
    if(!outcome) return;

    const computerGame=!!(window.ChessAI&&window.ChessAI.isComputerGame());
    const humanColor=computerGame?window.ChessAI.getSettings().humanColor:null;
    const personal=outcome.result==='draw'?'draw':(outcome.result===humanColor?'win':'loss');

    document.getElementById('gameover-title').textContent=outcome.title;
    document.getElementById('gameover-reason').textContent=outcome.reason;
    document.getElementById('gameover-icon').textContent=
      outcome.result==='draw'?'½':outcome.result==='white'?'♔':'♚';

    archiveFinishedGame({...outcome,personal},reasonCodeFor(st));

    const stats=window.ChessArchive?window.ChessArchive.stats(window.ChessArchive.list()):null;
    const scoreEl=document.getElementById('gameover-score');
    scoreEl.textContent=(stats&&stats.rated)
      ? `Bilanz gegen den Computer: ${stats.wins} Siege · ${stats.draws} Remis · ${stats.losses} Niederlagen`
      : '';
    gameOverOverlay.hidden=false;
  }

  function closeGameOver(){ if(gameOverOverlay) gameOverOverlay.hidden=true; }

  gameOverOverlay?.addEventListener('click',e=>{ if(e.target===gameOverOverlay) closeGameOver(); });
  document.getElementById('gameover-close')?.addEventListener('click',closeGameOver);
  document.getElementById('gameover-rematch')?.addEventListener('click',()=>{closeGameOver();newGame();});
  document.getElementById('gameover-review')?.addEventListener('click',()=>{closeGameOver();runReview();});

  /* ===================================================================== *
   * Archive: my games
   * ===================================================================== */

  const archiveOverlay=document.getElementById('archive-overlay');
  const archiveStats=document.getElementById('archive-stats');
  const archiveDetail=document.getElementById('archive-detail');
  const archiveListEl=document.getElementById('archive-list');
  const archiveCount=document.getElementById('archive-count');
  const archiveClear=document.getElementById('archive-clear');

  function escapeHtml(text){
    return String(text).replace(/[&<>"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
  }

  function formatPlayedAt(iso){
    const date=new Date(iso);
    if(Number.isNaN(date.getTime())) return '—';
    const pad=n=>String(n).padStart(2,'0');
    return `${pad(date.getDate())}.${pad(date.getMonth()+1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function statTile(label,value,hint=''){
    return `<div class="stat-tile"><span class="stat-value">${value}</span><span class="stat-label">${label}</span>${hint?`<span class="stat-hint">${hint}</span>`:''}</div>`;
  }

  function renderArchiveStats(games){
    const s=window.ChessArchive.stats(games);
    archiveStats.innerHTML=
      statTile('Partien',s.total)+
      statTile('Siege',s.wins)+
      statTile('Remis',s.draws)+
      statTile('Niederlagen',s.losses)+
      statTile('Punktequote',s.winRate==null?'–':`${s.winRate.toFixed(0)}%`,'Remis zählt halb')+
      statTile('Genauigkeit',s.averageAccuracy==null?'–':s.averageAccuracy.toFixed(1),'Ø der analysierten');

    const parts=[];
    if(s.rated&&s.rated!==s.total) parts.push(`${s.total-s.rated} Partie(n) zu zweit am Brett fließen nicht in die Bilanz ein.`);
    if(s.longestWinStreak>1) parts.push(`Längste Siegesserie: ${s.longestWinStreak}.`);
    if(s.currentStreak>1) parts.push(`Aktuell ${s.currentStreak} Siege in Folge.`);

    const levels=Object.entries(s.byLevel).sort((a,b)=>Number(a[0])-Number(b[0]));
    if(levels.length){
      parts.push('Nach Stufe: '+levels
        .map(([level,b])=>`Stufe ${level} ${b.wins}/${b.draws}/${b.losses}`)
        .join(' · ')+' (S/R/N)');
    }
    if(s.openings.length){
      parts.push('Häufigste Eröffnungen: '+s.openings.map(o=>`${escapeHtml(o.name)} (${o.count})`).join(', '));
    }
    archiveDetail.innerHTML=parts.map(text=>`<p>${text}</p>`).join('');
  }

  function resultBadge(game){
    const tone=game.outcome==='win'?'win':game.outcome==='loss'?'loss':game.outcome==='draw'?'draw':'neutral';
    const text=game.result==='1-0'?'1–0':game.result==='0-1'?'0–1':game.result==='1/2-1/2'?'½–½':game.result||'*';
    return `<span class="result-badge tone-${tone}">${text}</span>`;
  }

  function describeOpponent(game){
    if(game.mode!=='human-vs-computer') return 'Mensch gegen Mensch';
    const side=game.humanColor==='white'?'als Weiß':'als Schwarz';
    return `${escapeHtml(game.levelLabel||`Stufe ${game.level}`)} · ${side}`;
  }

  function renderArchiveList(games){
    if(!games.length){
      archiveListEl.innerHTML='<div class="archive-empty">Noch keine beendeten Partien. Sobald eine Partie zu Ende gespielt, aufgegeben oder auf Zeit verloren ist, steht sie hier.</div>';
      archiveCount.textContent='';
      return;
    }
    archiveCount.textContent=`${games.length} von höchstens ${window.ChessArchive.MAX_GAMES}`;
    archiveListEl.innerHTML=games.map(game=>`
      <div class="archive-row" data-id="${game.id}">
        ${resultBadge(game)}
        <div class="archive-main">
          <div class="archive-title">${describeOpponent(game)}</div>
          <div class="archive-sub">${formatPlayedAt(game.playedAt)} · ${game.moves} Halbzüge · ${escapeHtml(REASON_TEXT[game.reason]||game.reason||'—')}${game.opening?` · ${escapeHtml(game.opening)}`:''}${game.accuracy!=null?` · Genauigkeit ${Number(game.accuracy).toFixed(1)}`:''}</div>
        </div>
        <button class="nav-button archive-load" type="button" data-id="${game.id}" title="Partie laden">Laden</button>
        <button class="nav-button archive-delete" type="button" data-id="${game.id}" title="Partie löschen">✕</button>
      </div>`).join('');
  }

  function renderArchive(){
    if(!archiveOverlay||!window.ChessArchive) return;
    const games=window.ChessArchive.list();
    renderArchiveStats(games);
    renderArchiveList(games);
    archiveClear.textContent='Alle löschen';
    archiveClear.classList.remove('confirming');
  }

  function openArchive(){
    if(!archiveOverlay) return;
    renderArchive();
    archiveOverlay.hidden=false;
  }

  function closeArchive(){ if(archiveOverlay) archiveOverlay.hidden=true; }

  /** Puts an archived game back on the board, result and all. */
  function loadArchivedGame(id){
    const game=window.ChessArchive.find(id);
    if(!game) return;
    try{
      const parsed=window.ChessNotation.fromPgn(game.pgn);
      loadGame(
        parsed.startFen||ChessEngine.toFen(ChessEngine.createInitialState()),
        parsed.plies,
        {resignedBy:game.resignedBy,timeoutResult:game.timeoutResult}
      );
      // Reloading a game means further edits belong to that record, not a new
      // one - otherwise reviewing an old game would duplicate it.
      archivedGameId=game.id;
      closeArchive();
      statusExtra.textContent=`Partie vom ${formatPlayedAt(game.playedAt)} geladen.`;
    }catch(error){
      statusExtra.textContent=`Partie nicht ladbar: ${error.message}`;
      closeArchive();
    }
  }

  archiveOverlay?.addEventListener('click',e=>{ if(e.target===archiveOverlay) closeArchive(); });
  document.getElementById('archive-close')?.addEventListener('click',closeArchive);
  document.getElementById('archive-btn')?.addEventListener('click',openArchive);

  archiveListEl?.addEventListener('click',e=>{
    const remove=e.target.closest?.('.archive-delete');
    if(remove){ window.ChessArchive.remove(remove.dataset.id); renderArchive(); return; }
    const row=e.target.closest?.('.archive-row');
    if(row) loadArchivedGame(row.dataset.id);
  });

  // Two-step rather than window.confirm: a native dialog blocks the page and
  // looks nothing like the rest of the app, and this is not worth a modal.
  archiveClear?.addEventListener('click',()=>{
    if(!archiveClear.classList.contains('confirming')){
      archiveClear.classList.add('confirming');
      archiveClear.textContent='Wirklich alle löschen?';
      window.setTimeout(()=>{
        archiveClear.classList.remove('confirming');
        archiveClear.textContent='Alle löschen';
      },4000);
      return;
    }
    window.ChessArchive.clear();
    archivedGameId=null;
    renderArchive();
  });

  /* ===================================================================== *
   * PGN and FEN
   * ===================================================================== */

  const pgnOverlay=document.getElementById('pgn-overlay');
  const pgnText=document.getElementById('pgn-text');
  const fenText=document.getElementById('fen-text');
  const pgnHint=document.getElementById('pgn-hint');

  function currentPgn(){
    const st=ChessEngine.status(state,repetition);
    return window.ChessNotation.toPgn({
      moves:movesLog.map(m=>({san:m.notation})),
      startFen:startingFen,
      headers:playerHeaders(),
      result:resignedBy
        ? (resignedBy==='white'?'0-1':'1-0')
        : window.ChessNotation.resultFor(st,timeoutResult?timeoutResult.flagged:null)
    });
  }

  /** Names both sides the way the game was actually set up. */
  function playerHeaders(){
    const headers={Date:window.ChessNotation.formatDate()};
    if(window.ChessAI&&window.ChessAI.isComputerGame()){
      const settings=window.ChessAI.getSettings();
      const engineName=`Computer (${settings.levelConfig.label})`;
      headers.White=settings.humanColor==='white'?'Spieler':engineName;
      headers.Black=settings.humanColor==='white'?engineName:'Spieler';
    } else {
      headers.White='Weiß'; headers.Black='Schwarz';
    }
    if(window.ChessClock?.isEnabled?.()){
      const tc=window.ChessClock.control;
      headers.TimeControl=`${Math.round(tc.base/1000)}+${Math.round((tc.increment||0)/1000)}`;
    }
    return headers;
  }

  function openPgn(){
    if(!pgnOverlay) return;
    pgnText.value=currentPgn();
    fenText.value=ChessEngine.toFen(shownState());
    pgnHint.textContent='Das Feld zeigt die laufende Partie. Überschreibe es, um eine andere zu laden.';
    pgnOverlay.hidden=false;
  }

  function closePgn(){ if(pgnOverlay) pgnOverlay.hidden=true; }

  async function copyText(value,label){
    try{
      await navigator.clipboard.writeText(value);
      pgnHint.textContent=`${label} in die Zwischenablage kopiert.`;
    }catch{
      pgnHint.textContent=`Kopieren wurde vom Browser abgelehnt – markiere den Text und kopiere ihn von Hand.`;
    }
  }

  /**
   * Replaces the game with one built from a starting position and a list of
   * resolved moves. Used by both the FEN and the PGN loader, so a loaded game
   * and a loaded position end up in exactly the same shape.
   */
  function loadGame(startFen,plies,finished=null){
    aiGeneration++;
    evalGeneration++;
    setThinking(false);
    closePromotion();closeGameOver();hideReview();

    startingFen=startFen;
    archivedGameId=null;
    state=ChessEngine.fromFen(startFen);
    history=[];movesLog=[];selected=null;
    gameEnded=false;timeoutResult=null;resignedBy=null;engineNotice='';
    arrows=[];marks=[];hintMove=null;premove=null;reviewPlies=null;reviewEvals=null;currentEval=null;
    resetRepetition();

    for(const ply of plies){
      const previous=snapshot();
      const next=ChessEngine.applyMove(state,ply.move);
      const key=ChessEngine.fenKey(next);
      const nextRepetition={...repetition};
      nextRepetition[key]=(nextRepetition[key]||0)+1;
      history.push(previous);
      repetition=nextRepetition;
      movesLog.push({from:ply.move.from,to:ply.move.to,notation:ply.san});
      state=next;
    }

    viewPly=movesLog.length;
    // Resignation and a fallen flag are results the move list cannot express,
    // so a loaded game carries them alongside. Without this the engine would
    // cheerfully play on from a position somebody had already given up.
    if(finished&&finished.resignedBy) resignedBy=finished.resignedBy;
    if(finished&&finished.timeoutResult) timeoutResult=finished.timeoutResult;
    const st=ChessEngine.status(state,repetition);
    gameEnded=!!resignedBy||!!timeoutResult||
      ['checkmate','stalemate','fifty-move','threefold','insufficient-material'].includes(st.type);

    if(window.ChessClock){
      window.ChessClock.reset(window.ChessClock.control.id);
      window.ChessClock.resetDisplayCache?.();
      window.ChessClock.repaint?.();
    }
    render();
    refreshEvaluation();
    // A loaded position may well be the computer's to move; without this the
    // board would simply sit there waiting for a player who is not on turn.
    if(!gameEnded) window.setTimeout(maybeRequestComputerMove,0);
  }

  function loadFen(){
    try{
      const fen=fenText.value.trim();
      ChessEngine.fromFen(fen);
      loadGame(fen,[]);
      pgnHint.textContent='Stellung geladen.';
      closePgn();
    }catch(error){
      pgnHint.textContent=`Stellung nicht ladbar: ${error.message}`;
    }
  }

  function loadPgn(){
    try{
      const parsed=window.ChessNotation.fromPgn(pgnText.value);
      loadGame(parsed.startFen||ChessEngine.toFen(ChessEngine.createInitialState()),parsed.plies);
      pgnHint.textContent=`Partie geladen: ${parsed.plies.length} Halbzüge.`;
      closePgn();
    }catch(error){
      pgnHint.textContent=`PGN nicht ladbar: ${error.message}`;
    }
  }

  function downloadPgn(){
    const blob=new Blob([currentPgn()],{type:'application/x-chess-pgn'});
    const url=URL.createObjectURL(blob);
    const link=document.createElement('a');
    link.href=url;
    link.download=`partie-${window.ChessNotation.formatDate().replace(/\./g,'-')}.pgn`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Revoking immediately can cancel the download in some browsers.
    window.setTimeout(()=>URL.revokeObjectURL(url),2000);
  }

  pgnOverlay?.addEventListener('click',e=>{ if(e.target===pgnOverlay) closePgn(); });
  document.getElementById('pgn-close')?.addEventListener('click',closePgn);
  document.getElementById('pgn-btn')?.addEventListener('click',openPgn);
  document.getElementById('pgn-copy')?.addEventListener('click',()=>copyText(pgnText.value,'PGN'));
  document.getElementById('fen-copy')?.addEventListener('click',()=>copyText(fenText.value,'FEN'));
  document.getElementById('pgn-load')?.addEventListener('click',loadPgn);
  document.getElementById('fen-load')?.addEventListener('click',loadFen);
  document.getElementById('pgn-download')?.addEventListener('click',downloadPgn);

  /* ===================================================================== *
   * Hint
   * ===================================================================== */

  async function showHint(){
    if(!isLive()||gameEnded){ return; }
    const target=shownState();
    try{
      statusExtra.textContent='Suche den besten Zug …';
      const raw=await requestEvaluation(ChessEngine.toFen(target),600);
      if(!raw.bestmove){ statusExtra.textContent='Die Engine sieht hier keinen Zug.'; return; }
      const from=window.ChessAI.parseUciSquare(raw.bestmove.slice(0,2));
      const to=window.ChessAI.parseUciSquare(raw.bestmove.slice(2,4));
      hintMove={from:[...from],to:[...to]};
      drawOverlay();
      statusExtra.textContent=`Vorschlag: ${ChessEngine.squareName(from[0],from[1])}–${ChessEngine.squareName(to[0],to[1])}`;
    }catch(error){
      statusExtra.textContent=`Hinweis nicht möglich: ${error.message}`;
    }
  }

  /* ===================================================================== *
   * Game review
   * ===================================================================== */

  const reviewCard=document.getElementById('review-card');
  const reviewStatus=document.getElementById('review-status');
  const accuracyRow=document.getElementById('accuracy-row');
  const reviewSummary=document.getElementById('review-summary');
  let reviewRunning=false;

  function hideReview(){
    if(reviewCard) reviewCard.hidden=true;
    const graph=document.getElementById('eval-graph');
    if(graph){ graph.hidden=true; graph.innerHTML=''; }
  }

  /** Whether a move handed over material, used to spot real sacrifices. */
  function isSacrifice(before,move){
    if(!move.captured&&!move.isEnPassant) {
      // A piece moved to a square the opponent attacks and nothing was won.
      const after=ChessEngine.applyMove(before,move);
      return ChessEngine.isSquareAttacked(after,move.to[0],move.to[1],ChessEngine.opponent(ChessEngine.colorOf(move.piece)))
        && ChessEngine.typeOf(move.piece)!=='p'
        && ChessEngine.typeOf(move.piece)!=='k';
    }
    // A capture is a sacrifice when it gives up more than it takes.
    const gained=PIECE_VALUE[ChessEngine.typeOf(move.captured)]||0;
    const risked=PIECE_VALUE[ChessEngine.typeOf(move.piece)]||0;
    const after=ChessEngine.applyMove(before,move);
    const hanging=ChessEngine.isSquareAttacked(after,move.to[0],move.to[1],ChessEngine.opponent(ChessEngine.colorOf(move.piece)));
    return hanging&&risked>gained;
  }

  /**
   * Evaluates every position of the game and labels each move.
   *
   * One request per position rather than one batch: the whole point is the
   * progress indicator, and a review of a long game takes long enough that a
   * silent wait would look like a hang.
   */
  async function runReview(){
    if(reviewRunning||!movesLog.length) return;
    if(!window.ChessReview||!window.ChessNotation) return;
    reviewRunning=true;
    reviewCard.hidden=false;
    accuracyRow.innerHTML='';
    reviewSummary.innerHTML='';

    const positions=[];
    for(let i=0;i<movesLog.length;i++) positions.push(history[i].state);
    positions.push(state);

    const evaluations=new Array(positions.length).fill(null);
    const bestMoves=new Array(positions.length).fill(null);

    try{
      for(let i=0;i<positions.length;i++){
        reviewStatus.textContent=`${i} / ${positions.length}`;
        const raw=await requestEvaluation(ChessEngine.toFen(positions[i]),250);
        evaluations[i]=whiteRelative(raw,positions[i].turn);
        bestMoves[i]=raw.bestmove||null;
      }
    }catch(error){
      reviewStatus.textContent='';
      reviewSummary.textContent=`Analyse nicht möglich: ${error.message}.`;
      reviewRunning=false;
      return;
    }

    const sanList=movesLog.map(m=>m.notation);
    const judged=[];
    for(let i=0;i<movesLog.length;i++){
      const before=positions[i];
      const move=ChessEngine.findLegalMove(before,movesLog[i].from,movesLog[i].to);
      judged.push(window.ChessReview.classifyMove({
        before:evaluations[i],
        after:evaluations[i+1],
        mover:before.turn,
        isBook:window.ChessOpenings?window.ChessOpenings.isBookMove(sanList,i):false,
        bestMove:bestMoves[i],
        playedMove:move?window.ChessAI.toUci(move):null,
        sacrifice:move?isSacrifice(before,move):false
      }));
      judged[i].evalAfter=evaluations[i+1];
    }

    reviewPlies=judged;
    reviewEvals=evaluations;
    reviewStatus.textContent='fertig';
    const accuracies=renderReview(judged);
    renderEvalGraph();
    render();
    recordAccuracy(accuracies);
    reviewRunning=false;
  }

  function renderReview(judged){
    const white=judged.filter((_,i)=>i%2===0);
    const black=judged.filter((_,i)=>i%2===1);
    const whiteAccuracy=window.ChessReview.accuracyOf(white);
    const blackAccuracy=window.ChessReview.accuracyOf(black);

    accuracyRow.innerHTML=`
      <div class="accuracy-cell"><span class="accuracy-label">Weiß</span><span class="accuracy-value">${whiteAccuracy==null?'–':whiteAccuracy.toFixed(1)}</span></div>
      <div class="accuracy-caption">Genauigkeit</div>
      <div class="accuracy-cell"><span class="accuracy-label">Schwarz</span><span class="accuracy-value">${blackAccuracy==null?'–':blackAccuracy.toFixed(1)}</span></div>`;

    const whiteCounts=window.ChessReview.summarise(white);
    const blackCounts=window.ChessReview.summarise(black);
    const order=['brilliant','best','excellent','good','book','inaccuracy','mistake','blunder'];
    let html='';
    for(const key of order){
      if(!whiteCounts[key]&&!blackCounts[key]) continue;
      const meta=window.ChessReview.LABELS[key];
      html+=`<div class="review-row tone-${meta.tone}"><span>${whiteCounts[key]}</span><span class="review-label">${meta.symbol} ${meta.label}</span><span>${blackCounts[key]}</span></div>`;
    }
    reviewSummary.innerHTML=html||'<div class="review-row"><span class="review-label">Keine Züge zu bewerten.</span></div>';
    return {white:whiteAccuracy,black:blackAccuracy};
  }

  /**
   * Files the player's own accuracy with the archived game.
   *
   * Only the human's side, and only against the computer: at one board there
   * are two players and no single number that belongs to "you".
   */
  function recordAccuracy(accuracies){
    if(!archivedGameId||!window.ChessArchive||!accuracies) return;
    if(!(window.ChessAI&&window.ChessAI.isComputerGame())) return;
    const humanColor=window.ChessAI.getSettings().humanColor;
    const value=humanColor==='black'?accuracies.black:accuracies.white;
    if(value==null) return;
    window.ChessArchive.update(archivedGameId,{accuracy:Number(value.toFixed(1))});
  }

  /**
   * Draws the evaluation across the whole game.
   *
   * The white area is the share White stood better in, so the shape itself
   * reads as "who was on top, and from when". Clicking jumps to that move,
   * which is the point of drawing it next to a move list at all.
   */
  function renderEvalGraph(){
    const graph=document.getElementById('eval-graph');
    if(!graph) return;
    if(!reviewEvals||reviewEvals.length<2){ graph.hidden=true; return; }
    graph.hidden=false;

    const W=300, H=90;
    const step=W/(reviewEvals.length-1);
    const y=e=>H-window.ChessReview.barFraction(e)*H;

    let points=`0,${H} `;
    reviewEvals.forEach((e,i)=>{ points+=`${(i*step).toFixed(2)},${y(e).toFixed(2)} `; });
    points+=`${W},${H}`;

    const cursor=viewPly>=0&&viewPly<reviewEvals.length
      ? `<line class="eval-graph-cursor" x1="${(viewPly*step).toFixed(2)}" y1="0" x2="${(viewPly*step).toFixed(2)}" y2="${H}"/>`
      : '';
    graph.innerHTML=
      `<polygon class="eval-graph-fill" points="${points}"/>`+
      `<line class="eval-graph-mid" x1="0" y1="${H/2}" x2="${W}" y2="${H/2}"/>`+
      cursor;
  }

  document.getElementById('eval-graph')?.addEventListener('click',e=>{
    if(!reviewEvals) return;
    const rect=e.currentTarget.getBoundingClientRect();
    const fraction=(e.clientX-rect.left)/rect.width;
    goToPly(Math.round(fraction*(reviewEvals.length-1)));
  });

  /** Gives up the game for the side that would have to move next. */
  function resign(){
    if(gameEnded||resignedBy||!movesLog.length) return;
    aiGeneration++;
    setThinking(false);
    // In a game against the computer it is always the human who resigns, even
    // if the engine is the one on move while it is thinking.
    premove=null;
    resignedBy=(window.ChessAI&&window.ChessAI.isComputerGame())
      ? window.ChessAI.getSettings().humanColor
      : state.turn;
    gameEnded=true;
    selected=null;
    viewPly=movesLog.length;
    window.ChessClock?.stop();
    render();
    window.ChessSound?.play('gameEndLoss');
    window.setTimeout(()=>showGameOver(ChessEngine.status(state,repetition)),400);
  }

  document.getElementById('review-btn')?.addEventListener('click',runReview);
  document.getElementById('hint-btn')?.addEventListener('click',showHint);
  document.getElementById('resign-btn')?.addEventListener('click',resign);
  document.getElementById('flip-btn')?.addEventListener('click',()=>setFlipped(!flipped));

  /* ===================================================================== *
   * Sound and evaluation-bar settings
   * ===================================================================== */

  const soundToggle=document.getElementById('sound-toggle');
  const soundVolume=document.getElementById('sound-volume');
  if(soundToggle&&window.ChessSound){
    soundToggle.checked=window.ChessSound.isEnabled();
    soundToggle.addEventListener('change',()=>{
      window.ChessSound.setEnabled(soundToggle.checked);
      if(soundToggle.checked) window.ChessSound.play('move');
    });
  }
  if(soundVolume&&window.ChessSound){
    soundVolume.value=String(Math.round(window.ChessSound.getVolume()*100));
    soundVolume.addEventListener('input',()=>window.ChessSound.setVolume(Number(soundVolume.value)/100));
    soundVolume.addEventListener('change',()=>window.ChessSound.play('move'));
  }

  const premoveToggle=document.getElementById('premove-toggle');
  if(premoveToggle){
    premoveToggle.checked=premovesEnabled();
    premoveToggle.addEventListener('change',()=>{
      try { localStorage.setItem('chess-premoves',JSON.stringify(premoveToggle.checked)); } catch { /* ignore */ }
      if(!premoveToggle.checked) premove=null;
      render();
    });
  }

  const evalToggle=document.getElementById('eval-toggle');
  const evalHint=document.getElementById('eval-hint');
  function describeEval(){
    if(!evalHint) return;
    if(!evalEnabled()){ evalHint.textContent='Der Balken ist ausgeblendet.'; return; }
    window.ChessAI?.serverEngineStatus().then(status=>{
      evalHint.textContent=status.available
        ? `Bewertung durch ${status.name||status.file||'die native Engine'} – eigener Prozess, der Gegner wird dadurch nicht langsamer.`
        : 'Bewertung durch Stockfish als WebAssembly in deinem Browser – eigene Instanz, der Gegner wird dadurch nicht langsamer.';
    });
  }
  if(evalToggle){
    evalToggle.checked=evalEnabled();
    evalToggle.addEventListener('change',()=>{
      try { localStorage.setItem('chess-eval-bar',JSON.stringify(evalToggle.checked)); } catch { /* ignore */ }
      describeEval();
      refreshEvaluation();
    });
  }
  describeEval();

  /* ===================================================================== *
   * Move-list clicks, navigation buttons, keyboard, right-click drawing
   * ===================================================================== */

  movesList.addEventListener('click',e=>{
    const link=e.target.closest?.('.move-link');
    if(link) goToPly(Number(link.dataset.ply));
  });

  document.getElementById('nav-first')?.addEventListener('click',()=>goToPly(0));
  document.getElementById('nav-prev')?.addEventListener('click',()=>goToPly(viewPly-1));
  document.getElementById('nav-next')?.addEventListener('click',()=>goToPly(viewPly+1));
  document.getElementById('nav-last')?.addEventListener('click',()=>goToPly(movesLog.length));

  document.addEventListener('keydown',e=>{
    // Never steal keys from a text field - the PGN box is a textarea.
    const tag=e.target?.tagName;
    if(tag==='INPUT'||tag==='TEXTAREA'||e.target?.isContentEditable) return;
    if(e.ctrlKey||e.metaKey||e.altKey) return;

    switch(e.key){
      case 'ArrowLeft': goToPly(viewPly-1); break;
      case 'ArrowRight': goToPly(viewPly+1); break;
      case 'Home': goToPly(0); break;
      case 'End': goToPly(movesLog.length); break;
      case 'f': case 'F': setFlipped(!flipped); break;
      case 'h': case 'H': showHint(); break;
      case 's': case 'S': openPgn(); break;
      case 'p': case 'P': openArchive(); break;
      case 'Escape': closePgn(); closeArchive(); closeGameOver(); closePromotion(); break;
      default: return;
    }
    e.preventDefault();
  });

  // The board's own context menu has to go, or it opens on top of every
  // arrow the player tries to draw. The drawing itself lives in the shared
  // pointer handlers above.
  boardEl.addEventListener('contextmenu',e=>e.preventDefault());

  /* ===================================================================== *
   * Start
   * ===================================================================== */

  window.renderChessBoard = render;
  buildLabels();resetRepetition();buildBoardOnce();applyOrientation();render();
  paintEval();
})();
