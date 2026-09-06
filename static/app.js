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

  let suppressNextClick=false;
  let activePointerId=null;

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

  // Single source of truth for "is the human allowed to act right now".
  // Placed in one helper rather than duplicated across the drag, click and
  // move paths, so the computer's turn can never be driven by the mouse
  // through whichever path was forgotten.
  function humanMayAct(){
    if(gameEnded || moveTransaction) return false;
    if(!window.ChessAI) return true;
    if(window.ChessAI.isThinking()) return false;
    return !window.ChessAI.isComputerTurn(state.turn);
  }
  let movesLog=[];

  function assetUrl(piece){ return typeof window.getPieceAssetUrl === 'function' ? window.getPieceAssetUrl(piece) : `/static/chess-pieces/${ASSETS[piece]}.png`; }
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
    for(let r=8;r>=1;r--){const s=document.createElement('span');s.textContent=r;rankLabels.appendChild(s);}
    for(const f of ChessEngine.FILES){const s=document.createElement('span');s.textContent=f;fileLabels.appendChild(s);}
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

    const legal=selected?ChessEngine.legalMoves(state).filter(m=>m.from[0]===selected[0]&&m.from[1]===selected[1]):[];
    const legalMap=new Map(legal.map(m=>[`${m.to[0]},${m.to[1]}`,m]));
    const st=ChessEngine.status(state,repetition);
    if(['checkmate','stalemate','fifty-move','threefold','insufficient-material'].includes(st.type)) gameEnded=true;

    const checked=st.inCheck?ChessEngine.findKing(state,state.turn):null;
    const last=movesLog.at(-1);

    for(let r=0;r<8;r++)for(let c=0;c<8;c++){
      const cell=cells[r][c], sq=cell.sq;

      sq.classList.toggle('selected', !!(selected && selected[0]===r && selected[1]===c));
      sq.classList.toggle('last-move', !!(last && ((last.from[0]===r&&last.from[1]===c)||(last.to[0]===r&&last.to[1]===c))));

      const isChecked=!!(checked && checked[0]===r && checked[1]===c);
      // Visual marker only: CSS uses outline, never a background overlay.
      // Keep the square's board texture completely untouched.
      sq.classList.toggle('check', isChecked);
      if(isChecked) sq.dataset.check='true'; else if(sq.dataset.check) delete sq.dataset.check;

      const marker=legalMap.get(`${r},${c}`);
      const wantMarkerType=marker?(marker.captured||marker.isEnPassant?'capture':'legal'):null;
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

      const piece=getPiece(r,c);
      if(piece){
        if(!cell.pieceWrap){
          cell.pieceWrap=document.createElement('div');
          cell.pieceImg=document.createElement('img');
          cell.pieceImg.draggable=false;
          cell.pieceImg.addEventListener('error',()=>{
            if(cell.pieceImg.dataset.fallbackApplied!=='1' && cell.piece){
              cell.pieceImg.dataset.fallbackApplied='1';
              cell.pieceImg.src=`/static/chess-pieces/${ASSETS[cell.piece]}.png`;
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

    updateStatus(st);
    renderMoves();
    undoBtn.disabled=history.length===0;
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
    if(e.button!==0 || gameEnded || moveTransaction || pendingPromotion || dragSession) return;
    if(!humanMayAct()) return;
    const settings=getInteractionSettings();
    if(settings.pieceMovement==='click') return;
    const start=pointerToSquare(e.clientX,e.clientY);
    if(!start) return;
    const piece=getPiece(start.row,start.col);
    if(!piece || ChessEngine.colorOf(piece)!==state.turn) return;

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
    if(!humanMayAct()) return;
    const settings=getInteractionSettings();
    const p=getPiece(r,c);
    if(settings.pieceMovement==='drag') return;
    if(!selected){ if(p && ChessEngine.colorOf(p)===state.turn){selected=[r,c];render();} return; }
    if(p && ChessEngine.colorOf(p)===state.turn){selected=[r,c];render();return;}
    tryMove(selected[0],selected[1],r,c,{dragged:false});
  }

  function tryMove(fr,fc,tr,tc,interaction={dragged:false}){
    if (moveTransaction) return;
    const piece=getPiece(fr,fc);
    if(!piece || ChessEngine.colorOf(piece)!==state.turn) return;

    // Resolve the move through the engine once. The previous implementation
    // generated the complete legal-move list and then filtered it again. That
    // was safe but unnecessarily expensive and made the UI more fragile while
    // a pointer interaction was finishing.
    const move=ChessEngine.findLegalMove(state,[fr,fc],[tr,tc]);
    if(!move){
      selected=[fr,fc];
      if (interaction.dragged) {
        // A rejected drag should never lock the board. Repaint only the
        // selection state; no move transaction is started.
        render();
      }
      return;
    }
    if(move.promotion){
      pendingPromotion={fr,fc,tr,tc,candidates:ChessEngine.legalMoves(state).filter(m=>m.from[0]===fr&&m.from[1]===fc&&m.to[0]===tr&&m.to[1]===tc)};
      openPromotion(piece);
      return;
    }
    commitMove(move, interaction);
  }

  function openPromotion(piece){
    promoOptions.innerHTML='';
    const choices=piece===piece.toUpperCase()?['Q','R','B','N']:['q','r','b','n'];
    for(const p of choices){const b=document.createElement('button');b.type='button';b.className='promotion-option';const img=document.createElement('img');img.src=assetUrl(p);img.alt=ChessEngine.PIECE_NAMES[ChessEngine.typeOf(p)];b.appendChild(img);b.addEventListener('click',()=>{const move=pendingPromotion.candidates.find(m=>m.promotion===p.toLowerCase());closePromotion();commitMove(move);});promoOptions.appendChild(b);}
    promoOverlay.hidden=false;
  }
  function closePromotion(){promoOverlay.hidden=true;pendingPromotion=null;}

  function animateMove(move, piece, interaction, done){
    const settings=getInteractionSettings();
    if(!settings.pieceAnimationEnabled){done();return;}

    const from=boardSquareCenter(move.from[0],move.from[1]);
    const to=boardSquareCenter(move.to[0],move.to[1]);
    if(!from || !to){done();return;}

    const animator=document.createElement('div');
    animator.className=`move-animator ${settings.pieceAnimation}`;
    const img=document.createElement('img');
    img.src=assetUrl(piece); img.alt='';
    img.addEventListener('error',()=>{
      const fallback=`/static/chess-pieces/${ASSETS[piece]}.png`;
      if(img.src!==new URL(fallback,location.href).href) img.src=fallback;
    },{once:true});
    animator.appendChild(img);

    const factor=piece.toLowerCase()==='p'?0.864:0.88;
    const size=Math.min(from.width,to.width)*factor;
    animator.style.width=`${size}px`;
    animator.style.height=`${size}px`;
    animator.style.left='0px';
    animator.style.top='0px';

    const startPoint=(interaction?.dragged && interaction.dropPoint)
      ? interaction.dropPoint
      : {x:from.x,y:from.y};
    const startTransform=`translate3d(${startPoint.x-size/2}px,${startPoint.y-size/2}px,0)`;
    const endTransform=`translate3d(${to.x-size/2}px,${to.y-size/2}px,0)`;
    animator.style.transform=startTransform;
    document.body.appendChild(animator);

    const base=settings.animation || {duration:280,easing:'cubic-bezier(0.4,0,0.2,1)'};
    const distance=Math.hypot(to.x-startPoint.x,to.y-startPoint.y);
    let duration=base.duration;
    if(settings.pieceAnimation==='dynamic') duration=Math.round(Math.max(120,Math.min(420, distance*1.8)));
    if(distance<2) duration=Math.min(duration,90);

    let keyframes;
    if(settings.pieceAnimation==='arcade') {
      keyframes=[
        {transform:startTransform},
        {transform:`translate3d(${startPoint.x-size/2 + (to.x-startPoint.x)*.58}px,${startPoint.y-size/2 + (to.y-startPoint.y)*.58}px,0) scale(1.035)`},
        {transform:endTransform}
      ];
    } else if(settings.pieceAnimation==='dynamic') {
      keyframes=[
        {transform:startTransform},
        {transform:`translate3d(${startPoint.x-size/2 + (to.x-startPoint.x)*.72}px,${startPoint.y-size/2 + (to.y-startPoint.y)*.72}px,0) scale(1.025)`},
        {transform:endTransform}
      ];
    } else {
      keyframes=[{transform:startTransform},{transform:endTransform}];
    }

    let finished=false;
    const finish=()=>{
      if(finished)return;
      finished=true;
      try{animation?.cancel();}catch{}
      animator.remove();
      done();
    };

    let animation=null;
    try {
      animation=animator.animate(keyframes,{
        duration,
        easing:base.easing,
        fill:'forwards'
      });
      animation.onfinish=finish;
      animation.oncancel=finish;
    } catch {
      animator.style.transform=endTransform;
      finish();
    }
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
    gameEnded=['checkmate','stalemate','fifty-move','threefold','insufficient-material'].includes(nextStatus.type);

    if(window.ChessClock){
      const mover=ChessEngine.colorOf(piece);
      if(gameEnded) window.ChessClock.stop();
      else window.ChessClock.onMoveMade(mover,state.turn);
    }

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
      window.setTimeout(maybeRequestComputerMove,0);
      return;
    }

    const target=document.querySelector(`.square[data-row="${move.to[0]}"][data-col="${move.to[1]}"]`);
    target?.classList.add('animation-target-hidden');

    let completed=false;
    const finish=()=>{
      if(completed)return;
      completed=true;
      target?.classList.remove('animation-target-hidden');
      moveTransaction=null;
      // Do NOT rebuild the board here. The final state was already rendered;
      // rebuilding here was one of the sources of pointer/render races.
    };

    animateMove(move,piece,interaction,finish);

    // Hard safety net: a visual animation can never lock gameplay forever,
    // even if a browser refuses to fire an animation completion callback.
    const duration=Math.max(120,(settings.animation?.duration||280)+180);
    window.setTimeout(finish,duration);
    window.setTimeout(maybeRequestComputerMove,duration+20);
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
    if(active && statusExtra) statusExtra.textContent='Der Computer denkt nach …';
  }

  function reportAiError(error){
    if(statusExtra) statusExtra.textContent=`Engine-Fehler: ${error?.message||error}`;
  }

  function updateStatus(st){
    statusCard.classList.remove('check-state','game-over');
    // A fallen flag ends the game regardless of what the position looks like,
    // so it is checked before any engine-derived result.
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
      statusCard.classList.add('check-state');turnText.textContent=`${state.turn==='white'?'Weiß':'Schwarz'} ist am Zug`;statusExtra.textContent='Schach! Der König steht im Angriff.';
    } else {
      turnText.textContent=`${state.turn==='white'?'Weiß':'Schwarz'} ist am Zug`;statusExtra.textContent=selected?'Gültige Zielfelder sind markiert.':'Wähle eine Figur aus.';
    }
  }

  function renderMoves(){
    moveCount.textContent=movesLog.length;
    if(!movesLog.length){movesList.innerHTML='<div class="empty-moves">Noch keine Züge gespielt.</div>';return;}
    let html='';
    for(let i=0;i<movesLog.length;i+=2){html+=`<div class="move-row"><span class="move-number">${Math.floor(i/2)+1}.</span><span class="move-cell">${movesLog[i]?.notation||''}</span><span class="move-cell">${movesLog[i+1]?.notation||''}</span></div>`;}
    movesList.innerHTML=html;movesList.scrollTop=movesList.scrollHeight;
  }

  function newGame(){
    if(moveTransaction)return;
    aiGeneration++;
    setThinking(false);
    state=ChessEngine.createInitialState();history=[];movesLog=[];selected=null;
    gameEnded=false;timeoutResult=null;
    closePromotion();resetRepetition();
    if(window.ChessClock){
      window.ChessClock.reset(window.ChessClock.control.id);
      window.ChessClock.resetDisplayCache?.();
      window.ChessClock.repaint?.();
    }
    render();
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
    gameEnded=false;timeoutResult=null;
    if(window.ChessClock && prev.clock){
      window.ChessClock.restoreState(prev.clock);
      window.ChessClock.resetDisplayCache?.();
      window.ChessClock.repaint?.();
    }
    render();
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
            aiHint.textContent=status.available
              ? `Native Engine aktiv: ${status.path}. Volle Spielstärke, rechnet bis ${(s.levelConfig.maxTimeMs/1000).toFixed(1)} s pro Zug.`
              : `${status.reason||'Engine nicht verfügbar.'} Lege die Stockfish-Datei in den Projektordner 'engine/' und starte den Server neu.`;
          }
        });
        return 'Prüfe native Engine …';
      }
      if(s.backend==='stockfish'){
        return 'Stockfish wird aus /static/stockfish.js geladen (WASM-Build). Fehlt die Datei, erscheint hier ein Engine-Fehler.';
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
      window.ChessAI.dispose();
      applyAndRestart({backend:backendSelect.value});
    });
    // Strength can change mid-game without invalidating anything.
    if(levelSelect) levelSelect.addEventListener('change',()=>{
      window.ChessAI.update({level:Number(levelSelect.value)});
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

  window.renderChessBoard = render;
  buildLabels();resetRepetition();render();
})();
