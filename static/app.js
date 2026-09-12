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

  // Taktik-Training. Steht hier oben bei den uebrigen Griffen, weil render()
  // die Karte mitzeichnet - eine erst weiter unten deklarierte Konstante waere
  // beim ersten Zeichnen noch nicht vorhanden.
  const puzzleCard=document.getElementById('puzzle-card');
  const puzzleTitle=document.getElementById('puzzle-title');
  const puzzleBadge=document.getElementById('puzzle-badge');
  const puzzleFeedback=document.getElementById('puzzle-feedback');
  const puzzleSteps=document.getElementById('puzzle-steps');
  const puzzleMeta=document.getElementById('puzzle-meta');
  const puzzleOverlay=document.getElementById('puzzle-overlay');
  const puzzleStatsEl=document.getElementById('puzzle-stats');
  const puzzleThemesEl=document.getElementById('puzzle-themes');
  const puzzleModalHint=document.getElementById('puzzle-modal-hint');
  const puzzleNextBtn=document.getElementById('puzzle-next');
  const puzzleRetryBtn=document.getElementById('puzzle-retry');
  const puzzleHintBtn=document.getElementById('puzzle-hint');
  const puzzleSolutionBtn=document.getElementById('puzzle-solution');

  // Online spielen. Wie die Puzzle-Griffe hier oben, aus demselben Grund.
  const onlineCard=document.getElementById('online-card');
  const onlineTitle=document.getElementById('online-title');
  const onlineDot=document.getElementById('online-dot');
  const onlineFeedback=document.getElementById('online-feedback');
  const onlineDrawBox=document.getElementById('online-draw');
  const onlineDrawText=document.getElementById('online-draw-text');
  const onlineOfferDrawBtn=document.getElementById('online-offer-draw');
  const onlineResignBtn=document.getElementById('online-resign');
  const onlineLeaveBtn=document.getElementById('online-leave');
  const onlineOverlay=document.getElementById('online-overlay');
  const onlineConnection=document.getElementById('online-connection');
  const onlineNameInput=document.getElementById('online-name');
  const onlineStats=document.getElementById('online-stats');
  const onlineControls=document.getElementById('online-controls');
  const onlineSeekBtn=document.getElementById('online-seek');
  const onlineLobbyHint=document.getElementById('online-lobby-hint');
  const onlineBoard=document.getElementById('online-board');
  const onlineUrlInput=document.getElementById('online-url');

  /** Die laufende Online-Partie, oder null. */
  let onlineMode=null;

  /**
   * Was gerade gespielt wird: 'game', 'puzzle' oder 'online'.
   *
   * Frueher waren das zwei unabhaengige Klassen am body, und die konnten
   * beide zugleich gelten - wer aus einer Online-Partie heraus das Training
   * oeffnete, hatte danach beide Karten untereinander und die Knoepfe beider
   * Modi. Ein Zustand mit drei Werten kann das nicht.
   */
  function currentMode(){
    if(onlineMode) return 'online';
    if(puzzleMode) return 'puzzle';
    return 'game';
  }

  function applyMode(){
    const mode=currentMode();
    if(document.body.dataset.mode!==mode) document.body.dataset.mode=mode;
    for(const tab of document.querySelectorAll('.mode-tab')){
      const active=tab.dataset.mode===mode;
      tab.classList.toggle('active',active);
      tab.setAttribute('aria-current',active?'true':'false');
    }
  }

  /**
   * Der Wechsel ueber die Leiste ueber dem Brett.
   *
   * Zurueck zur Partie heisst: das Training beenden oder die Online-Partie
   * verlassen - und das Zweite ist ein Aufgeben, weil der Gegner sonst vor
   * einem leeren Brett sitzt. Deshalb wird gefragt.
   */
  function switchMode(target){
    if(target===currentMode()&&target!=='game') return;
    if(target==='game'){
      if(onlineMode){
        if(!onlineMode.finished&&!window.confirm('Die laufende Online-Partie gilt dann als aufgegeben. Wirklich verlassen?')) return;
        leaveOnline();
        return;
      }
      if(puzzleMode){ exitPuzzle(); return; }
      newGame();
      return;
    }
    if(target==='puzzle'){ openPuzzleDialog(); return; }
    if(target==='online'){ openOnlineDialog(); }
  }

  document.querySelector('.mode-bar')?.addEventListener('click',event=>{
    const tab=event.target.closest('.mode-tab');
    if(tab) switchMode(tab.dataset.mode);
  });

  /** Der laufende Trainingszustand, oder null ausserhalb des Trainings. */
  let puzzleMode=null;
  /** Vom Anwender im Trainingsfenster gewaehltes Thema. */
  let puzzleTheme=null;


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
  // Der zuletzt aufs Brett gelegte Zug. Die Zugliste haelt nur from/to und
  // die Notation; das Training braucht den Zug selbst, samt Umwandlung.
  let lastCommittedMove=null;

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
    if(onlineMode){
      // Nur die eigene Farbe, nur am Zug, nur solange die Partie laeuft. Ein
      // Premove waere hier moeglich, aber er muesste ueber den Server laufen -
      // solange es das nicht gibt, waere er ein Zug ins Leere.
      if(onlineMode.finished||moveTransaction||pendingPromotion||!isLive()) return null;
      return state.turn===onlineMode.colour?onlineMode.colour:null;
    }
    if(puzzleMode){
      // Kein Premove, keine Gegenfarbe, nichts waehrend das Programm zieht:
      // eine Aufgabe hat genau einen Spieler und genau eine Reihenfolge.
      if(puzzleMode.status!=='playing'||puzzleMode.busy) return null;
      if(moveTransaction||pendingPromotion||!isLive()) return null;
      return state.turn===puzzleMode.side?puzzleMode.side:null;
    }
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
  /**
   * Gesetzt, solange commitMove laeuft - und keinen Lidschlag laenger.
   *
   * Frueher hielt diese Sperre die ganze Zuganimation lang und war damit das,
   * was das Brett nach jedem Zug fuer eine Zehntel- bis Drittelsekunde taub
   * machte. Die Animation braucht sie nicht: sie hat mit `activeAnimation`
   * ihre eigene Buchfuehrung. Was sie wirklich absichert, ist der synchrone
   * Lauf von commitMove selbst - und der ist nach einem Lidschlag vorbei.
   */
  let moveTransaction=null;

  /**
   * Die Animation, die gerade noch in der Luft ist - oder null.
   *
   * Sie besteht aus zwei Dingen, die wieder eingesammelt werden muessen: den
   * fliegenden Kopien der Figuren und den Zielfeldern, die solange ausgeblendet
   * bleiben, damit die Figur nicht zweimal zu sehen ist. Beides gehoert der
   * Darstellung, nicht der Partie.
   */
  let activeAnimation=null;

  /**
   * Holt eine noch fliegende Animation sofort ein.
   *
   * Wird vor jedem Vorgang aufgerufen, der eine andere Stellung aufs Brett
   * bringt. Der Zug davor ist damit sichtbar beendet, bevor der naechste
   * gezeichnet wird - es gibt also nie zwei Animationen gleichzeitig und nie
   * ein Zielfeld, das noch von der vorigen ausgeblendet ist. Das ersetzt das
   * Warten: statt den naechsten Zug zu verbieten, wird der vorige fertig.
   */
  function settleActiveAnimation(){
    const running=activeAnimation;
    if(!running) return;
    running.settle();
  }

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

  /**
   * The one way a drag ends - a drop, an abort, a lost capture, a watchdog.
   *
   * Every ending used to clean up for itself, and each list of steps was
   * slightly different. That is what let a missed pointerup leave the board
   * dragging forever: the ghost stayed under the cursor, the source square
   * stayed empty, `piece-dragging` stayed on the body, and because beginDrag
   * refuses to start while a session exists, every later click was ignored.
   * With one teardown there is no ending that can forget a step.
   *
   * The sweep over the document at the end is deliberate belt and braces: a
   * ghost whose session was already dropped has no owner left to remove it.
   */
  function endDragSession(session){
    const s=session||dragSession;
    if(s){
      if(s.watchdog){window.clearTimeout(s.watchdog);s.watchdog=null;}
      s.sourceSquare?.classList.remove('drag-source-hidden');
      if(s.ghost){s.ghost.remove();s.ghost=null;}
      if(dragSession===s){dragSession=null;activePointerId=null;}
      try{if(boardEl.hasPointerCapture(s.pointerId))boardEl.releasePointerCapture(s.pointerId);}catch{}
    }
    if(!dragSession){
      document.body.classList.remove('piece-dragging');
      for(const orphan of document.querySelectorAll('.drag-ghost')) orphan.remove();
      for(const square of document.querySelectorAll('.drag-source-hidden')) square.classList.remove('drag-source-hidden');
    }
    return s;
  }

  /**
   * Last line of defence for a drag nobody ended.
   *
   * Nothing in the pointer protocol guarantees that a pointerup arrives. The
   * button can be released over a native context menu, over another window,
   * outside the browser entirely, or after the page was put in the background
   * - and when the capture could not be taken, no `lostpointercapture` follows
   * either. A drag that has outlived every plausible gesture is not a drag any
   * more, and leaving it open is what made the board need a reload.
   *
   * Generous on purpose: this must never cut a real drag short, only clear one
   * that is already lost. It is re-armed on every pointermove.
   */
  const DRAG_WATCHDOG_MS=15000;
  function armDragWatchdog(session){
    if(session.watchdog) window.clearTimeout(session.watchdog);
    session.watchdog=window.setTimeout(()=>{
      if(dragSession!==session||session.dropHandled) return;
      endDragSession(session);
      selected=null;
      render();
    },DRAG_WATCHDOG_MS);
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
    // The capture routes every later pointer event to the board even once the
    // pointer has left it. When it cannot be taken the drag still runs - the
    // window-level listeners deliver the release either way - but the failure
    // must not vanish silently as it used to: without a capture there is no
    // `lostpointercapture` to end a session nobody else ends, so the watchdog
    // is the only thing left, and it has to be armed in both cases.
    try{
      boardEl.setPointerCapture(e.pointerId);
      session.captured=boardEl.hasPointerCapture(e.pointerId);
    }catch{
      session.captured=false;
    }
    armDragWatchdog(session);
  }

  function updateDrag(e){
    const s=dragSession;
    if(!s || s.pointerId!==e.pointerId || s.dropHandled) return;
    e.preventDefault();
    // A drag that is still moving is still alive.
    armDragWatchdog(s);
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

    endDragSession(s);

    if(!moved){
      if(s.settings.pieceMovement==='drag') selected=null;
      render();
      return;
    }

    suppressNextClick=true;
    window.setTimeout(()=>{suppressNextClick=false;},50);

    /* The move runs in the event that produced it.
     *
     * This used to be deferred into the next animation frame, which is the
     * next 16 ms only while the frame clock runs at full speed. A throttled
     * tab - an occluded window, a background monitor, power saving, a busy
     * main thread - stretches that to a second or more, and until some later
     * input happens to wake the clock the piece simply refuses to land.
     * Measured at a throttled 1 Hz: 1059 ms between releasing the button and
     * the move appearing, with the piece snapped back in the meantime.
     *
     * Nothing here needs a frame. `target` was already resolved above from the
     * pointerup coordinates, and the animation that does need frame timing is
     * started inside commitMove and keeps its own.
     */
    try{
      if(target) tryMove(fromR,fromC,target.row,target.col,{dragged:true,dropPoint});
      else {selected=null;render();}
    }catch(error){
      console.error('Chess move pipeline error:',error);
      moveTransaction=null; selected=null;
      // The repaint is the recovery, so it must not be able to throw the board
      // into the same hole a second time.
      try{ render(); }catch(renderError){ console.error('Chess render error:',renderError); }
    }
  }

  function cancelDrag(e){
    const s=dragSession;
    // An event without a pointer id is one of the coarse aborts - the window
    // losing focus, say - and those end whatever session is open.
    if(!s || (e && e.pointerId!=null && s.pointerId!==e.pointerId)) return;
    // A capture released by a completed drop is the normal tail of a
    // successful move, not an abort. Without this guard the `lostpointercapture`
    // that follows every release would cancel the drag that just succeeded.
    if(s.dropHandled) return;
    endDragSession(s);
    selected=null;
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
    if(!settings.pieceAnimationEnabled){done();return ()=>{};}

    const base=settings.animation || {duration:280,easing:'cubic-bezier(0.4,0,0.2,1)'};

    // Koenig und Turm laufen zusammen los. Ein Versatz war hier einmal
    // Absicht, las sich aber wie ein Ruckler statt wie ein Zug - eine Rochade
    // ist eine Bewegung, keine zwei nacheinander.
    const travellers=[{piece,from:move.from,to:move.to,dragged:true}];
    if(move.isCastle && move.rookFrom && move.rookTo){
      const rook=ChessEngine.colorOf(piece)==='white'?'R':'r';
      travellers.push({piece:rook,from:move.rookFrom,to:move.rookTo,dragged:false});
    }

    /* Erst alles messen, dann alles bauen.
     *
     * getBoundingClientRect zwingt den Browser, den Seitenaufbau sofort neu zu
     * rechnen - und zwar alles, was seither veraendert wurde. Wer misst,
     * einfuegt, wieder misst und wieder einfuegt, loest das bei jedem Durchgang
     * aus. Bei einem einzelnen Zug faellt das nicht auf, weil es nur einmal
     * passiert. Bei der Rochade wurde der Turm vermessen, nachdem der Koenig
     * schon im Dokument hing - genau dort fehlten die ersten Bilder, und genau
     * deshalb sah nur die Rochade nach halber Bildrate aus. */
    const legs=[];
    for(const leg of travellers){
      const from=boardSquareCenter(leg.from[0],leg.from[1]);
      const to=boardSquareCenter(leg.to[0],leg.to[1]);
      if(from&&to) legs.push({...leg,from,to});
    }

    // Das Feld der geschlagenen Figur gehoert in dieselbe Lesephase - sonst
    // loest der Schatten denselben Zwischen-Umbruch aus wie zuvor der Turm,
    // nur eben bei jedem Schlagzug.
    const capturedPiece=move.captured;
    const capturedSpot=capturedPiece
      ? boardSquareCenter(...(move.isEnPassant?[move.from[0],move.to[1]]:[move.to[0],move.to[1]]))
      : null;

    const animators=[];
    const animations=[];
    let longest=0;

    for(const leg of legs){
      const {from,to}=leg;
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
      longest=Math.max(longest,duration);

      try{
        animations.push(animator.animate(keyframes,{
          duration, easing:base.easing, fill:'both'
        }));
      }catch{
        animator.style.transform=endTransform;
      }
    }

    // The piece being taken. It is already gone from the board by now, so this
    // is a copy that shrinks away on the square it stood on - without it a
    // capture is the one move where something simply blinks out of existence.
    if(capturedPiece&&capturedSpot){
      const size=capturedSpot.width*pieceScale(capturedPiece);
      const ghost=makeAnimator(capturedPiece,size,'captured');
      const at=`translate3d(${capturedSpot.x-size/2}px,${capturedSpot.y-size/2}px,0)`;
      ghost.style.transform=at;
      animators.push(ghost);
      try{
        animations.push(ghost.animate(
          [{transform:`${at} scale(1)`,opacity:1},{transform:`${at} scale(.55)`,opacity:0}],
          {duration:Math.max(140,base.duration*0.8),easing:'cubic-bezier(.4,0,.6,1)',fill:'both'}));
      }catch{ ghost.remove(); }
    }

    if(!animators.length){ done(); return ()=>{}; }

    let finished=false;
    /** Beendet die Animation sofort. Mehrfach aufrufbar, tut dann nichts. */
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

    // Gereicht wird der Abbruch nach aussen: der naechste Zug muss die noch
    // fliegende Kopie sofort einholen koennen, statt auf sie zu warten.
    return finish;
  }

  /**
   * Fuehrt einen Zug aus.
   *
   * Der eigentliche Schutz des Spielzustands steht gleich in den ersten
   * Zeilen, und er braucht keine Wartezeit: ein Zug wird nur ausgefuehrt,
   * wenn die Figur der Seite gehoert, die am Zug ist. Nach einem Zug ist das
   * Zugrecht gewechselt - ein zweiter Zug derselben Seite, ein doppelt
   * zugestelltes pointerup, ein Zug aus einer Stellung von vorhin: alle
   * scheitern dort, unabhaengig davon, ob gerade eine Animation laeuft.
   *
   * Zusammen damit, dass diese Funktion von der ersten bis zur letzten Zeile
   * synchron laeuft und sich zwei Aufrufe deshalb nicht verschraenken
   * koennen, ist der Zustand ohne jede Sperre sicher. Die Sperre unten deckt
   * nur diesen synchronen Lauf ab.
   */
  function commitMove(move, interaction={dragged:false}){
    if (moveTransaction) return;
    const piece=getPiece(move.from[0],move.from[1]);
    if(!piece || ChessEngine.colorOf(piece)!==state.turn) return;

    // Der vorige Zug wird sichtbar fertig, bevor dieser gezeichnet wird.
    settleActiveAnimation();

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
    lastCommittedMove=move;
    state=next;
    selected=null;
    // A move always returns the board to the live position; annotations and a
    // shown hint belong to the position they were drawn in. The premove is
    // deliberately NOT cleared here: the opponent's move landing is precisely
    // the moment a queued premove has been waiting for, and this runs just
    // before afterMoveSettled plays it.
    viewPly=movesLog.length;arrows=[];marks=[];hintMove=null;
    gameEnded=['checkmate','stalemate','fifty-move','threefold','insufficient-material'].includes(nextStatus.type);

    if(window.ChessClock && !puzzleMode && !onlineMode){
      const mover=ChessEngine.colorOf(piece);
      if(gameEnded) window.ChessClock.stop();
      else window.ChessClock.onMoveMade(mover,state.turn);
    }

    announceMove(move,nextStatus);
    if(gameEnded) window.setTimeout(()=>showGameOver(nextStatus),650);
    refreshEvaluation();

    const settings=getInteractionSettings();
    const shouldAnimate=!!settings.pieceAnimationEnabled;

    /* Die Sperre gilt nur fuer diesen synchronen Lauf.
     *
     * Sie verhindert, dass irgendetwas, was render() ausloest, mitten im Zug
     * ein zweites commitMove startet. Das `finally` gibt sie in jedem Fall
     * wieder frei - auch wenn render() wirft. Frueher lag die Freigabe am
     * Ende der Animation, und eine Ausnahme davor liess sie fuer immer
     * stehen; das war nur ueber einen Wecker nach zwei Sekunden zu heilen.
     * Jetzt ist es keine Frage der Zeit mehr, sondern des Kontrollflusses.
     */
    moveTransaction={from:move.from,to:move.to,piece,startedAt:performance.now()};
    try{
      // Render the final logical position exactly once. The moving piece is
      // hidden only after this render, while a separate compositor-layer copy
      // performs the visual movement.
      render();
      if(shouldAnimate) startMoveAnimation(move,piece,interaction,settings);
    } finally {
      moveTransaction=null;
    }

    /* Wann der naechste Schritt der Partie faellig ist - Premove, dann Engine.
     *
     * Das bleibt an die Animationsdauer gebunden, und zwar mit Absicht: es
     * geht hier nicht mehr um eine Sperre, sondern um Takt. Ein Gegenzug, der
     * losschlaegt, waehrend die eigene Figur noch fliegt, sieht gehetzt aus.
     * Der Spieler selbst wartet darauf nicht mehr - er darf ab sofort ziehen.
     */
    const settleDelay=shouldAnimate?Math.max(120,(settings.animation?.duration||280)+180)+20:0;
    window.setTimeout(afterMoveSettled,settleDelay);
  }

  /**
   * Laesst die Figuren eines Zuges fliegen und fuehrt Buch darueber.
   *
   * Getrennt von commitMove, weil hier nichts mehr ueber die Partie
   * entschieden wird: der Zustand steht bereits, das Brett zeigt bereits die
   * Endstellung. Was hier passiert, ist reine Darstellung - und genau deshalb
   * darf der Spieler waehrenddessen weiterziehen.
   */
  function startMoveAnimation(move,piece,interaction,settings){
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

    let settled=false;
    const handle={
      timer:null,
      stopAnimators:null,
      settle(){
        if(settled) return;
        settled=true;
        if(handle.timer){window.clearTimeout(handle.timer);handle.timer=null;}
        for(const square of hidden) square.classList.remove('animation-target-hidden');
        // Holt die fliegenden Kopien ein. Ruft seinerseits settle() zurueck,
        // was durch `settled` oben ins Leere laeuft.
        handle.stopAnimators?.();
        if(activeAnimation===handle) activeAnimation=null;
      }
    };
    activeAnimation=handle;

    handle.stopAnimators=animateMove(move,piece,interaction,()=>handle.settle());

    // Hard safety net: a visual animation can never leave a square hidden for
    // ever, even if a browser refuses to fire an animation completion
    // callback. The castling rook starts a beat late, so the net has to
    // outlast that too.
    handle.timer=window.setTimeout(()=>handle.settle(),Math.max(120,(settings.animation?.duration||280)+180));
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
    // Die Gegenzuege einer Aufgabe stehen fest; eine Engine, die hier
    // dazwischenspielt, wuerde die Loesung zerstoeren.
    if(puzzleMode||onlineMode) return;
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
    applyMode();
    paintPuzzleCard();
    paintOnlineCard();
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
    // Aus welcher Stellung die Partie kommt, entscheidet ueber die Nummern:
    // eine geladene Stellung mit Schwarz am Zug beginnt weder bei 1. noch mit
    // einem weissen Zug, und ohne das rutscht die ganze Liste um einen Halbzug.
    const fields=String(startingFen).split(' ');
    const blackFirst=fields[1]==='b';
    const firstNumber=Number(fields[5])||1;
    let html='';
    let i=0;
    if(blackFirst){
      html+=`<div class="move-row"><span class="move-number">${firstNumber}.</span>`+
        `<span class="move-cell move-skipped">…</span>${moveCellHtml(0)}</div>`;
      i=1;
    }
    for(;i<movesLog.length;i+=2){
      const number=firstNumber+(blackFirst?Math.floor((i+1)/2):Math.floor(i/2));
      html+=`<div class="move-row"><span class="move-number">${number}.</span>${moveCellHtml(i)}${moveCellHtml(i+1)}</div>`;
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
    // Eine noch fliegende Figur gehoert zu der Stellung, die gerade verlassen
    // wird. Sie wird eingeholt, statt das Blaettern zu verbieten.
    settleActiveAnimation();
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
    if(onlineMode){ onlineAfterMove(); return; }
    if(puzzleMode){
      // Ein vom Programm gespielter Zug kann eine Fortsetzung angehaengt
      // haben - die Loesungsvorfuehrung laeuft so Schritt fuer Schritt ab.
      const queued=puzzleMode.afterReply;
      puzzleMode.afterReply=null;
      if(queued){ puzzleMode.busy=false; paintPuzzleCard(); queued(); return; }
      // `busy` bleibt hier stehen: puzzleAfterMove liest daran ab, ob der Zug
      // vom Programm kam. Wer es vorher loescht, laesst den Zug, der in die
      // Stellung fuehrt, als Loesungsversuch durchgehen - und die Aufgabe
      // gilt als verpatzt, bevor der Spieler sie ueberhaupt gesehen hat.
      puzzleAfterMove();
      return;
    }
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
    // Online tragen die Leisten die Namen der beiden Spieler. renderCaptured
    // laeuft bei jedem Neuzeichnen und hat sie bisher wieder durch "Weiß" und
    // "Schwarz" ersetzt - nach dem ersten Zug sass man wieder namenlos da.
    if(onlineMode&&window.ChessOnline?.game()){
      setOnlinePlayers(window.ChessOnline.game());
    } else {
      bottomName.textContent=bottomColor==='white'?'Weiß':'Schwarz';
      topName.textContent=topColor==='white'?'Weiß':'Schwarz';
    }
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
    // Waehrend einer Aufgabe waere der Balken die Loesung: er zeigt an, dass
    // hier etwas zu holen ist, und nach dem richtigen Zug schlaegt er aus.
    // Gegen einen Menschen ist er schlicht Betrug - eine Stockfish-Bewertung
    // neben dem Brett ist genau das, wofuer man anderswo gesperrt wird.
    if(puzzleMode||onlineMode) return false;
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
    settleActiveAnimation();
    if(onlineMode){
      onlineMode=null;
      if(onlineCard) onlineCard.hidden=true;
      window.ChessClock?.useExternalClock?.(null);
    }
    if(puzzleMode){
      puzzleMode=null;
      if(puzzleCard) puzzleCard.hidden=true;
    }
    applyMode();
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
    settleActiveAnimation();
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

  /* The same endings, heard a second time at the window.
   *
   * The board only hears them while it holds the pointer capture, and a
   * capture can be refused or taken away - by a native context menu, by the
   * browser starting a drag of its own, by a window switch. Whenever that
   * happened the release never reached finishDrag and the session stayed open
   * for good; the board was dead until the page was reloaded.
   *
   * Registered on the bubble phase so the board's own handler still runs
   * first for events that reach it. By the time these see such an event the
   * session is already closed and they do nothing, so a drop is never handled
   * twice. The button test keeps the right-hand drawing gesture out of here -
   * finishDrag would otherwise swallow the context menu on the whole page.
   */
  window.addEventListener('pointerup', e=>{
    if(e.button!==0) return;
    if(!dragSession || dragSession.pointerId!==e.pointerId || dragSession.dropHandled) return;
    finishDrag(e);
  });
  window.addEventListener('pointercancel', e=>{
    if(!dragSession || dragSession.pointerId!==e.pointerId) return;
    cancelDrag(e);
  });
  // Alt-Tab, a native menu, the tab going away: the pointer is gone and no
  // release is coming. Aborting is right here - committing a move the player
  // may never have finished aiming would be worse than dropping it.
  window.addEventListener('blur', ()=>{ if(dragSession) cancelDrag(null); });
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
    if(puzzleMode||onlineMode) return null;
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
    // Ein Matt ist im Training die Loesung, nicht das Ende einer Partie - und
    // eine Aufgabe gehoert auch nicht ins Partiearchiv. Online meldet der
    // Server das Ergebnis, samt Grund und Wertung; das Brett darf nicht
    // vorgreifen, denn es kennt weder Uhr noch Aufgabe des Gegners.
    if(puzzleMode||onlineMode) return;
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
    settleActiveAnimation();
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
    if(puzzleMode){ puzzleHint(); return; }
    // Aus demselben Grund wie der Bewertungsbalken: den besten Zug ansagen zu
    // lassen, waehrend gegenueber ein Mensch sitzt, ist kein Hinweis.
    if(onlineMode){ onlineNotice('Im Online-Spiel gibt es keinen Hinweis.'); return; }
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
      case 't': case 'T': openPuzzleDialog(); break;
      case 'o': case 'O': openOnlineDialog(); break;
      case 'Escape': closePgn(); closeArchive(); closeGameOver(); closePromotion(); closePuzzleDialog(); closeOnlineDialog(); break;
      default: return;
    }
    e.preventDefault();
  });

  // The board's own context menu has to go, or it opens on top of every
  // arrow the player tries to draw. The drawing itself lives in the shared
  // pointer handlers above.
  boardEl.addEventListener('contextmenu',e=>e.preventDefault());

  /* ===================================================================== *
   * Puzzles
   * ===================================================================== *
   *
   * Das Training laeuft auf demselben Brett wie eine Partie - dieselben
   * Figuren, dieselbe Animation, derselbe Klang. Ein eigenes Brett daneben
   * waere die zweite Wahrheit, die frueher oder spaeter von der ersten
   * abweicht.
   *
   * Sichtbar wird das an den Stellen, die *anders* laufen muessen: waehrend
   * einer Aufgabe zieht kein Computergegner, der Bewertungsbalken bleibt aus
   * (er wuerde die Loesung verraten), die Uhr laeuft nicht und beendete
   * Partien landen nicht im Archiv.
   */

  function puzzleReady(){ return !!window.ChessPuzzles; }

  function moveToUci(move){
    return window.ChessAI ? window.ChessAI.toUci(move)
      : ChessEngine.squareName(move.from[0],move.from[1])+ChessEngine.squareName(move.to[0],move.to[1]);
  }

  function uciToSquares(uci){
    return {
      from:window.ChessAI.parseUciSquare(uci.slice(0,2)),
      to:window.ChessAI.parseUciSquare(uci.slice(2,4)),
      promotion:uci.length>4?uci[4]:null
    };
  }

  /** Sucht zu einem UCI-Zug den passenden Zug der Regel-Engine. */
  function resolveUci(fromState,uci){
    const {from,to,promotion}=uciToSquares(uci);
    const candidates=ChessEngine.movesBetween(fromState,from,to);
    if(!candidates.length) return null;
    if(promotion){
      return candidates.find(m=>m.promotion&&String(m.promotion).toLowerCase()===promotion)||candidates[0];
    }
    return candidates[0];
  }

  /* --- Ablauf ------------------------------------------------------------ */

  /**
   * Legt die laufende Partie beiseite, damit das Training sie nicht frisst.
   *
   * Das Training laedt eine Stellung aufs Brett, und `loadGame` raeumt dabei
   * alles weg. Wer mitten in einer Partie auf "Puzzle" drueckt, haette sie
   * sonst kommentarlos verloren.
   */
  function captureGame(){
    return {
      state:ChessEngine.cloneState(state),
      history:history.slice(),
      movesLog:movesLog.map(m=>({...m})),
      repetition:{...repetition},
      startingFen,viewPly,gameEnded,resignedBy,timeoutResult,archivedGameId,
      flipped,
      clock:window.ChessClock?window.ChessClock.getState():null
    };
  }

  function restoreGame(saved){
    state=saved.state;history=saved.history;movesLog=saved.movesLog;
    repetition=saved.repetition;startingFen=saved.startingFen;
    viewPly=saved.viewPly;gameEnded=saved.gameEnded;
    resignedBy=saved.resignedBy;timeoutResult=saved.timeoutResult;
    archivedGameId=saved.archivedGameId;
    selected=null;arrows=[];marks=[];hintMove=null;premove=null;
    reviewPlies=null;reviewEvals=null;currentEval=null;
    if(window.ChessClock&&saved.clock){
      window.ChessClock.restoreState(saved.clock);
      window.ChessClock.resetDisplayCache?.();
      window.ChessClock.repaint?.();
    }
    setFlipped(saved.flipped);
    refreshEvaluation();
    // Die Partie war vielleicht am Computer, als das Training begann.
    if(!gameEnded) window.setTimeout(maybeRequestComputerMove,0);
  }

  function startPuzzle(puzzle){
    if(!puzzle||moveTransaction) return;
    // Nur beim Eintritt sichern, nicht bei jeder weiteren Aufgabe - sonst
    // waere die Partie nach der zweiten Aufgabe eine Puzzlestellung.
    const carried=puzzleMode?puzzleMode.savedGame
      :((movesLog.length&&!gameEnded)?captureGame():null);
    const position=ChessEngine.fromFen(puzzle.fen);
    puzzleMode={
      savedGame:carried,
      session:window.ChessPuzzles.createSession(puzzle),
      side:position.turn,
      status:'playing',
      // `busy` deckt beides ab: den Zug, der in die Stellung fuehrt, und die
      // Antworten des Gegners. Solange er gesetzt ist, gehoert das Brett dem
      // Programm und nicht der Maus.
      busy:false,
      ratingBefore:window.ChessPuzzles.readProgress().rating,
      ratingAfter:null
    };
    setFlipped(position.turn==='black');
    window.ChessClock?.stop?.();

    // Der Gegnerzug, der in die Stellung gefuehrt hat, wird vorgespielt. Eine
    // Aufgabe, die aus einer Partie kommt, soll sich auch so anfuehlen - und
    // der letzte Zug des Gegners ist die halbe Information.
    if(puzzle.setupFen&&puzzle.lastMove){
      loadGame(puzzle.setupFen,[]);
      const intro=resolveUci(state,puzzle.lastMove);
      if(intro){
        puzzleMode.busy=true;
        paintPuzzleCard();
        window.setTimeout(()=>{ if(puzzleMode) commitMove(intro); },260);
        return;
      }
    }
    loadGame(puzzle.fen,[]);
    paintPuzzleCard();
  }

  /**
   * Beendet das Training, ohne das Brett anzufassen.
   *
   * Getrennt von exitPuzzle, weil es zwei Anlaesse gibt: der Spieler hoert auf
   * (dann soll seine Partie zurueckkommen), oder eine Online-Partie beginnt
   * (dann uebernimmt die das Brett, und die gesicherte Partie wandert weiter).
   * Gibt zurueck, was aufgehoben war - undefined, wenn gar kein Training lief.
   */
  function closePuzzleMode(){
    if(!puzzleMode) return undefined;
    const saved=puzzleMode.savedGame;
    puzzleMode=null;
    if(puzzleCard) puzzleCard.hidden=true;
    applyMode();
    return saved;
  }

  function exitPuzzle(){
    const saved=closePuzzleMode();
    if(saved===undefined) return;
    if(saved) restoreGame(saved);
    else newGame();
  }

  function nextPuzzle(){
    if(!puzzleReady()) return;
    const previous=puzzleMode?puzzleMode.session.puzzle.id:null;
    const puzzle=window.ChessPuzzles.pick({theme:puzzleTheme,exclude:previous});
    if(!puzzle){ setPuzzleFeedback('Keine passende Aufgabe gefunden.'); return; }
    startPuzzle(puzzle);
  }

  function retryPuzzle(){
    if(!puzzleMode) return;
    startPuzzle(puzzleMode.session.puzzle);
  }

  /** Nimmt genau einen Halbzug zurueck - der falsche Versuch verschwindet. */
  function puzzleTakeBack(){
    if(!history.length) return;
    const previous=history.pop();
    state=previous.state;repetition=previous.repetition;movesLog=previous.movesLog;
    selected=null;gameEnded=false;timeoutResult=null;resignedBy=null;
    viewPly=movesLog.length;arrows=[];marks=[];hintMove=null;premove=null;
    render();
  }

  /**
   * Wird aufgerufen, sobald ein Zug endgueltig auf dem Brett liegt.
   *
   * Drei Faelle: der Zug des Programms (Vorspiel oder Gegnerantwort), der
   * richtige Zug des Spielers, der falsche.
   */
  function puzzleAfterMove(){
    if(!puzzleMode) return;
    if(puzzleMode.busy){ puzzleMode.busy=false; paintPuzzleCard(); return; }
    if(puzzleMode.status!=='playing') { paintPuzzleCard(); return; }

    const played=lastCommittedMove;
    if(!played) return;
    const mates=ChessEngine.status(state,repetition).type==='checkmate';
    const outcome=puzzleMode.session.submit(moveToUci(played),{mates});

    if(outcome.result==='wrong'){
      window.ChessSound?.play('illegal');
      puzzleCard?.classList.add('is-wrong');
      window.setTimeout(()=>puzzleCard?.classList.remove('is-wrong'),600);
      puzzleMode.lastWrong=true;
      puzzleTakeBack();
      setPuzzleFeedback('Das war es nicht – versuch es noch einmal.');
      return;
    }

    puzzleMode.lastWrong=false;
    if(outcome.result==='correct'){
      playPuzzleReply(outcome.reply);
      return;
    }

    if(outcome.result==='solved'){
      if(outcome.reply){ playPuzzleReply(outcome.reply,()=>finishPuzzle(true)); return; }
      finishPuzzle(true);
    }
  }

  function playPuzzleReply(uci,then){
    if(!uci||!puzzleMode){ if(then) then(); return; }
    puzzleMode.busy=true;
    paintPuzzleCard();
    window.setTimeout(()=>{
      if(!puzzleMode) return;
      const move=resolveUci(state,uci);
      if(!move){ puzzleMode.busy=false; if(then) then(); return; }
      if(then) puzzleMode.afterReply=then;
      commitMove(move);
    },340);
  }

  function finishPuzzle(solved){
    if(!puzzleMode) return;
    const session=puzzleMode.session;
    puzzleMode.status=solved?'solved':'failed';
    const progress=window.ChessPuzzles.record(session.puzzle,session.outcome(solved));
    puzzleMode.ratingAfter=progress.rating;
    window.ChessSound?.play(solved&&!session.usedHint?'gameEndWin':'notify');
    if(solved){
      puzzleCard?.classList.add('is-solved');
      window.setTimeout(()=>puzzleCard?.classList.remove('is-solved'),900);
    }
    paintPuzzleCard();
  }

  /** Fuehrt die restliche Loesung vor; die Aufgabe gilt danach als verfehlt. */
  function showPuzzleSolution(){
    if(!puzzleMode||puzzleMode.status!=='playing'||puzzleMode.busy) return;
    const remaining=puzzleMode.session.giveUp();
    puzzleMode.status='failed';
    const progress=window.ChessPuzzles.record(puzzleMode.session.puzzle,
      puzzleMode.session.outcome(false));
    puzzleMode.ratingAfter=progress.rating;
    puzzleMode.busy=true;
    paintPuzzleCard();

    let index=0;
    const step=()=>{
      if(!puzzleMode||index>=remaining.length){
        if(puzzleMode) puzzleMode.busy=false;
        paintPuzzleCard();
        return;
      }
      const move=resolveUci(state,remaining[index++]);
      if(!move){ if(puzzleMode) puzzleMode.busy=false; paintPuzzleCard(); return; }
      puzzleMode.busy=true;
      puzzleMode.afterReply=()=>window.setTimeout(step,420);
      commitMove(move);
    };
    window.setTimeout(step,200);
  }

  function puzzleHint(){
    if(!puzzleMode||puzzleMode.status!=='playing'||puzzleMode.busy) return;
    const uci=puzzleMode.session.hint();
    if(!uci) return;
    const {from}=uciToSquares(uci);
    // Nur das Ausgangsfeld. Der ganze Zug waere die Loesung, nicht ein Hinweis.
    selected=[from[0],from[1]];
    render();
    setPuzzleFeedback(`Die gesuchte Figur steht auf ${ChessEngine.squareName(from[0],from[1])}.`);
  }

  /* --- Anzeige ----------------------------------------------------------- */

  function setPuzzleFeedback(text){
    if(puzzleFeedback) puzzleFeedback.textContent=text;
  }

  function puzzleThemeText(puzzle){
    return puzzle.themes.map(t=>window.ChessPuzzles.themeLabel(t)).join(' · ');
  }

  function paintPuzzleCard(){
    if(!puzzleCard) return;
    puzzleCard.hidden=!puzzleMode;
    if(!puzzleMode) return;

    const session=puzzleMode.session;
    const puzzle=session.puzzle;
    const playing=puzzleMode.status==='playing';
    const toMove=puzzleMode.side==='white'?'Weiß':'Schwarz';

    puzzleTitle.textContent=playing
      ?(puzzle.mateIn?`${toMove} setzt matt`:`${toMove} zieht und gewinnt`)
      :(puzzleMode.status==='solved'?'Gelöst':'Lösung');
    puzzleBadge.textContent=puzzle.rating;

    // Ein Punkt je gesuchtem Zug: gefunden, aktuell, offen.
    if(puzzleSteps){
      const total=session.totalMoves;
      const done=playing?Math.floor(session.index/2):total;
      let html='';
      for(let i=0;i<total;i++){
        const cls=i<done?'done':(i===done&&playing?'current':'');
        html+=`<span class="puzzle-step ${cls}"></span>`;
      }
      puzzleSteps.innerHTML=total>1?html:'';
    }

    if(playing){
      if(puzzleMode.busy) setPuzzleFeedback('Der Gegner antwortet …');
      else if(session.index===0){
        setPuzzleFeedback(puzzle.mateIn
          ?`Matt in ${puzzle.mateIn} – finde den ersten Zug.`
          :'Finde den besten Zug.');
      } else if(!puzzleMode.lastWrong){
        const left=session.totalMoves-Math.floor(session.index/2);
        setPuzzleFeedback(left===1?'Richtig – und jetzt der letzte Zug.'
          :`Richtig. Noch ${left} Züge.`);
      }
    } else if(puzzleMode.status==='solved'){
      const delta=puzzleMode.ratingAfter-puzzleMode.ratingBefore;
      const sign=delta>0?'+':'';
      setPuzzleFeedback(session.usedHint
        ?`Richtig – mit Hilfe, deshalb ohne Wertung (${puzzleMode.ratingAfter}).`
        :`Gelöst! Wertung ${sign}${delta} → ${puzzleMode.ratingAfter}.`);
    } else if(!puzzleMode.busy){
      setPuzzleFeedback(`Wertung jetzt ${puzzleMode.ratingAfter}. Schau dir die Züge in der Liste an.`);
    }

    if(puzzleMeta){
      const stats=window.ChessPuzzles.stats();
      puzzleMeta.innerHTML=`<span>${escapeHtml(puzzleThemeText(puzzle))}</span>`+
        `<span>Deine Wertung <strong>${stats.rating}</strong> · Serie <strong>${stats.streak}</strong></span>`;
    }

    puzzleHintBtn.disabled=!playing||puzzleMode.busy;
    puzzleSolutionBtn.disabled=!playing||puzzleMode.busy;
    puzzleRetryBtn.disabled=puzzleMode.busy;
    puzzleNextBtn.disabled=puzzleMode.busy;
  }

  /* --- Trainingsfenster -------------------------------------------------- */

  function paintPuzzleStats(){
    if(!puzzleStatsEl) return;
    const stats=window.ChessPuzzles.stats();
    const cells=[
      ['Wertung',stats.rating],
      ['Gelöst',`${stats.solved} / ${stats.total}`],
      ['Serie',stats.streak],
      ['Beste Serie',stats.bestStreak],
      ['Treffer',stats.accuracy==null?'–':`${stats.accuracy} %`]
    ];
    puzzleStatsEl.innerHTML=cells.map(([label,value])=>
      `<div class="stat-cell"><div class="stat-value">${escapeHtml(String(value))}</div>`+
      `<div class="stat-label">${escapeHtml(label)}</div></div>`).join('');
  }

  function paintPuzzleThemes(){
    if(!puzzleThemesEl) return;
    const themes=window.ChessPuzzles.availableThemes();
    const buttons=[['','Alles gemischt']].concat(themes.map(t=>[t,window.ChessPuzzles.themeLabel(t)]));
    puzzleThemesEl.innerHTML=buttons.map(([value,label])=>{
      const active=(puzzleTheme||'')===value?' active':'';
      return `<button type="button" class="puzzle-theme${active}" data-theme="${escapeHtml(value)}">${escapeHtml(label)}</button>`;
    }).join('');
  }

  async function openPuzzleDialog(){
    if(!puzzleOverlay||!puzzleReady()) return;
    puzzleOverlay.hidden=false;
    puzzleModalHint.textContent='Aufgaben werden geladen …';
    try{
      await window.ChessPuzzles.load();
      const count=window.ChessPuzzles.all().length;
      // Waehrend einer laufenden Online-Partie kann kein Training beginnen:
      // beide brauchen dasselbe Brett, und die Partie laeuft auf der Uhr.
      const blockiert=!!onlineMode&&!onlineMode.finished;
      document.getElementById('puzzle-start').disabled=blockiert;
      puzzleModalHint.textContent=blockiert
        ? 'Deine Online-Partie läuft noch – beende sie zuerst.'
        : `${count} Aufgaben, alle selbst erzeugt und von Stockfish geprüft.`;
      paintPuzzleStats();
      paintPuzzleThemes();
    }catch(error){
      puzzleModalHint.textContent=`Die Aufgaben konnten nicht geladen werden: ${error.message}`;
    }
  }

  function closePuzzleDialog(){ if(puzzleOverlay) puzzleOverlay.hidden=true; }

  document.getElementById('puzzle-btn')?.addEventListener('click',openPuzzleDialog);
  document.getElementById('puzzle-modal-close')?.addEventListener('click',closePuzzleDialog);
  puzzleOverlay?.addEventListener('click',e=>{ if(e.target===puzzleOverlay) closePuzzleDialog(); });
  puzzleThemesEl?.addEventListener('click',e=>{
    const button=e.target.closest('.puzzle-theme');
    if(!button) return;
    puzzleTheme=button.dataset.theme||null;
    paintPuzzleThemes();
  });
  document.getElementById('puzzle-start')?.addEventListener('click',()=>{
    closePuzzleDialog();
    nextPuzzle();
  });
  document.getElementById('puzzle-reset')?.addEventListener('click',()=>{
    window.ChessPuzzles.resetProgress();
    paintPuzzleStats();
    puzzleModalHint.textContent='Fortschritt zurückgesetzt.';
  });
  puzzleNextBtn?.addEventListener('click',nextPuzzle);
  puzzleRetryBtn?.addEventListener('click',retryPuzzle);
  puzzleHintBtn?.addEventListener('click',puzzleHint);
  puzzleSolutionBtn?.addEventListener('click',showPuzzleSolution);
  document.getElementById('puzzle-exit')?.addEventListener('click',exitPuzzle);

  /* ===================================================================== *
   * Online spielen
   * ===================================================================== *
   *
   * Wie beim Training laeuft alles auf demselben Brett. Der Unterschied: der
   * Server hat recht. Er prueft jeden Zug und misst die Zeit; der Browser
   * zeigt an und schickt hin.
   *
   * Der eigene Zug wird trotzdem sofort gespielt, ohne auf den Server zu
   * warten. Beide rechnen mit derselben Regel-Engine, also stimmen sie
   * ueberein - und ein Brett, das erst nach der Netzlaufzeit reagiert, fuehlt
   * sich kaputt an. Widerspricht der Server doch, schickt er die gueltige
   * Stellung, und die gilt.
   */

  /** Wie lange eine kurze Meldung den Dauerzustand verdeckt. */
  const ONLINE_NOTICE_MS = 4_000;

  const RESULT_REASONS = {
    checkmate: 'Schachmatt',
    resign: 'Aufgegeben',
    timeout: 'Zeit abgelaufen',
    'timeout-insufficient': 'Zeit abgelaufen – Remis mangels Material',
    abandoned: 'Verbindung verloren',
    agreement: 'Remis vereinbart',
    stalemate: 'Patt',
    'fifty-move': '50-Züge-Regel',
    threefold: 'Dreifache Stellungswiederholung',
    'insufficient-material': 'Unzureichendes Material'
  };

  function onlineReady(){ return !!window.ChessOnline; }
  function onlineActive(){ return !!onlineMode; }

  /* --- Betreten und Verlassen -------------------------------------------- */

  function enterOnlineGame(game, resumed){
    const colour=window.ChessOnline.myColour();
    if(!colour) return;
    // Ein laufendes Training wird zuerst beendet - und zwar ohne das Brett
    // anzufassen. Frueher lief hier exitPuzzle(), und das rief newGame(),
    // welches den gerade gesetzten Online-Modus gleich wieder loeschte.
    const fromPuzzle=closePuzzleMode();
    const carried=onlineMode?onlineMode.savedGame
      :(fromPuzzle!==undefined?fromPuzzle
        :((movesLog.length&&!gameEnded)?captureGame():null));

    onlineMode={
      savedGame:carried,
      gameId:game.id,
      colour,
      // Ein selbst gespielter Zug kommt vom Server zurueck. Er ist dann schon
      // auf dem Brett und darf nicht ein zweites Mal gespielt werden.
      pending:null,
      clockAt:Date.now(),
      drawOfferFrom:game.drawOfferFrom||null,
      opponentGone:false,
      finished:game.status==='finished'
    };
    applyMode();
    setFlipped(colour==='black');
    window.ChessClock?.useExternalClock?.(onlineClockSource);
    applyServerGame(game);
    window.ChessSound?.play(resumed?'notify':'gameStart');
    paintOnlineCard();
  }

  function leaveOnline(){
    if(!onlineMode) return;
    const saved=onlineMode.savedGame;
    const running=!onlineMode.finished;
    onlineMode=null;
    if(onlineCard) onlineCard.hidden=true;
    applyMode();
    window.ChessClock?.useExternalClock?.(null);
    // Eine laufende Partie einfach zu verlassen waere ein Aufgeben ohne es zu
    // sagen; der Server wertet sie nach kurzer Wartezeit ohnehin so.
    if(running) window.ChessOnline?.resign?.();
    if(saved) restoreGame(saved);
    else newGame();
  }

  /**
   * Setzt die Stellung des Servers aufs Brett.
   *
   * Wird beim Betreten gebraucht, beim Wiederverbinden und immer dann, wenn
   * der Server widerspricht. Die Zuege werden nachgespielt statt die FEN
   * gesetzt: so stehen Zugliste, Eroeffnungsname und die Rueckschau richtig da.
   */
  function applyServerGame(game){
    const plies=[];
    let cursor=ChessEngine.fromFen(game.startingFen);
    for(const entry of game.moves){
      const move=resolveUci(cursor,entry.uci);
      if(!move) break;
      plies.push({move,san:entry.san});
      cursor=ChessEngine.applyMove(cursor,move);
    }
    loadGame(game.startingFen,plies);
    onlineMode.finished=game.status==='finished';
    onlineMode.drawOfferFrom=game.drawOfferFrom||null;
    setOnlinePlayers(game);
    paintOnlineCard();
  }

  /** Namen und Wertungen in die Leisten ueber und unter dem Brett. */
  function setOnlinePlayers(game){
    if(!onlineMode) return;
    const mine=onlineMode.colour;
    const me=mine==='white'?game.white:game.black;
    const other=mine==='white'?game.black:game.white;
    bottomName.textContent=`${me.name} (${me.rating})`;
    topName.textContent=`${other.name} (${other.rating})`;
  }

  /* --- Uhr --------------------------------------------------------------- */

  /**
   * Was die Uhr anzeigen soll.
   *
   * Der Server schickt die Restzeiten mit jedem Zug. Zwischen zwei Zuegen
   * laeuft die Anzeige hier weiter - sonst stuende sie still und spraenge dann.
   * Massgeblich bleibt trotzdem der Server: seine naechste Zahl ueberschreibt.
   */
  function onlineClockSource(color){
    if(!onlineMode) return null;
    const game=window.ChessOnline.game();
    if(!game||!game.clock) return null;
    const clock=game.clock;
    const base=clock[color];
    if(base==null) return null;
    const running=clock.running&&!onlineMode.finished;
    const ticking=running&&clock.turn===color;
    const since=ticking?Date.now()-(onlineMode.clockAt||Date.now()):0;
    return {ms:Math.max(0,base-since),active:clock.turn===color,running};
  }

  function markClock(){
    if(onlineMode) onlineMode.clockAt=Date.now();
  }

  /* --- Zuege ------------------------------------------------------------- */

  /** Nach einem eigenen Zug: hinschicken. */
  function onlineAfterMove(){
    if(!onlineMode||onlineMode.finished) return;
    const played=lastCommittedMove;
    if(!played) return;
    // Wer gerade gezogen hat, ist die Seite, die jetzt *nicht* mehr am Zug
    // ist. Ein gesetzter Merker waere hier falsch: afterMoveSettled laeuft
    // erst nach der Animation, und bis dahin ist jeder Merker laengst wieder
    // zurueckgenommen - der Zug des Gegners ginge an den Server zurueck.
    const mover=state.turn==='white'?'black':'white';
    if(mover!==onlineMode.colour) return;
    onlineMode.pending=moveToUci(played);
    window.ChessOnline.move(onlineMode.pending);
  }

  /** Ein Zug vom Server. */
  function onServerMove(data){
    if(!onlineMode||data.gameId!==onlineMode.gameId) return;
    markClock();
    if(onlineMode.pending===data.uci){
      // Der eigene Zug, bestaetigt. Er steht schon auf dem Brett.
      onlineMode.pending=null;
      paintOnlineCard();
      return;
    }
    if(moveTransaction){
      // Mitten in einer Animation. Gleich noch einmal versuchen, statt den
      // Zug zu verlieren.
      window.setTimeout(()=>onServerMove(data),120);
      return;
    }
    const move=resolveUci(state,data.uci);
    if(!move){
      // Auseinandergelaufen - der Server weiss es besser.
      window.ChessOnline.requestSync();
      return;
    }
    commitMove(move);
    paintOnlineCard();
  }

  function resolveUci(fromState,uci){
    const from=window.ChessAI.parseUciSquare(uci.slice(0,2));
    const to=window.ChessAI.parseUciSquare(uci.slice(2,4));
    const candidates=ChessEngine.movesBetween(fromState,from,to);
    if(!candidates.length) return null;
    const promotion=uci.length>4?uci[4]:null;
    if(promotion) return candidates.find(m=>m.promotion&&String(m.promotion).toLowerCase()===promotion)||null;
    return candidates.find(m=>!m.promotion)||null;
  }

  /* --- Anzeige ----------------------------------------------------------- */

  function setOnlineFeedback(text){
    if(onlineFeedback) onlineFeedback.textContent=text;
  }

  /**
   * Eine Meldung, die einen Moment stehen bleibt.
   *
   * paintOnlineCard laeuft nach jedem Zug und nach jeder Serverantwort und
   * ueberschreibt den Text mit dem Dauerzustand ("Du bist am Zug"). Ein
   * "Remis abgelehnt" waere sonst weg, bevor man es gelesen hat.
   */
  function onlineNotice(text){
    if(!onlineMode) return;
    onlineMode.notice=text;
    onlineMode.noticeAt=Date.now();
    setOnlineFeedback(text);
    window.setTimeout(()=>{ if(onlineMode&&onlineMode.notice===text) paintOnlineCard(); },ONLINE_NOTICE_MS+100);
  }

  function paintOnlineCard(){
    if(!onlineCard) return;
    onlineCard.hidden=!onlineMode;
    if(!onlineMode) return;
    const game=window.ChessOnline.game();
    const other=window.ChessOnline.opponent();
    const connected=window.ChessOnline.status()==='ready';

    onlineDot.className=`online-dot ${connected?'is-on':'is-off'}`;
    onlineDot.title=connected?'Verbunden':'Keine Verbindung';

    if(onlineMode.finished&&game&&game.result){
      const r=game.result;
      const mine=onlineMode.colour;
      onlineTitle.textContent=r.winner==null?'Remis'
        :(r.winner===mine?'Gewonnen':'Verloren');
      setOnlineFeedback(RESULT_REASONS[r.reason]||'Partie beendet.');
    } else if(!connected){
      onlineTitle.textContent='Verbindung weg';
      setOnlineFeedback('Es wird neu verbunden – deine Uhr läuft weiter.');
    } else if(onlineMode.opponentGone){
      onlineTitle.textContent='Gegner weg';
      setOnlineFeedback(`${other?other.name:'Der Gegner'} ist offline. Kommt niemand zurück, gewinnst du.`);
    } else if(onlineMode.notice&&Date.now()-onlineMode.noticeAt<ONLINE_NOTICE_MS){
      onlineTitle.textContent=other?`Gegen ${other.name}`:'Partie läuft';
      setOnlineFeedback(onlineMode.notice);
    } else {
      onlineMode.notice=null;
      onlineTitle.textContent=other?`Gegen ${other.name}`:'Partie läuft';
      setOnlineFeedback(state.turn===onlineMode.colour?'Du bist am Zug.':'Der Gegner überlegt …');
    }

    const offered=onlineMode.drawOfferFrom;
    const fromOther=offered&&offered!==onlineMode.colour;
    onlineDrawBox.hidden=!fromOther||onlineMode.finished;
    if(fromOther) onlineDrawText.textContent=`${other?other.name:'Der Gegner'} bietet Remis an.`;

    const over=onlineMode.finished;
    onlineOfferDrawBtn.disabled=over||offered===onlineMode.colour;
    onlineResignBtn.disabled=over;
    onlineLeaveBtn.textContent=over?'Zurück':'Online verlassen';
  }

  /* --- Das Fenster ------------------------------------------------------- */

  function paintOnlineDialog(){
    if(!onlineOverlay||onlineOverlay.hidden) return;
    const status=window.ChessOnline.status();
    const player=window.ChessOnline.player();
    const lobby=window.ChessOnline.lobby();
    const seeking=window.ChessOnline.seeking();

    const words={offline:'Nicht verbunden',connecting:'Verbinde …',ready:'Verbunden',
      reconnecting:'Verbindung unterbrochen – neuer Versuch …',unconfigured:'Kein Server eingetragen'};
    onlineConnection.textContent=words[status]||status;

    if(player){
      const cells=[['Wertung',player.rating],['Partien',player.games],
        ['Siege',player.wins],['Remis',player.draws],['Niederlagen',player.losses]];
      onlineStats.innerHTML=cells.map(([label,value])=>
        `<div class="stat-cell"><div class="stat-value">${escapeHtml(String(value))}</div>`+
        `<div class="stat-label">${escapeHtml(label)}</div></div>`).join('');
      if(onlineNameInput&&document.activeElement!==onlineNameInput) onlineNameInput.value=player.name;
    } else {
      onlineStats.innerHTML='';
    }

    const controls=window.ChessOnline.controls();
    if(controls.length&&onlineControls.dataset.filled!=='1'){
      onlineControls.dataset.filled='1';
      onlineControls.innerHTML=controls.map(c=>
        `<button type="button" class="online-control" data-control="${escapeHtml(c.id)}">`+
        `<strong>${escapeHtml(c.label)}</strong><small>${escapeHtml(c.category)}</small></button>`).join('');
      selectOnlineControl(readOnlineControl());
    }

    // Ohne Verbindung waere der Knopf ein Versprechen, das nichts einloest.
    onlineSeekBtn.disabled=status!=='ready';
    onlineSeekBtn.textContent=seeking?'Suche abbrechen':'Spiel suchen';
    onlineSeekBtn.classList.toggle('secondary',!!seeking);
    onlineSeekBtn.classList.toggle('primary',!seeking);
    onlineLobbyHint.textContent=status==='ready'
      ? `${lobby.online} online · ${lobby.waiting} suchen · ${lobby.playing} Partien`
      : (status==='unconfigured'
        ? 'Für diese Seite ist noch kein Spielserver eingetragen. Wie das geht, steht in server/README.md – oder trage die Adresse unten ein.'
        : 'Warte auf die Verbindung …');
    if(onlineUrlInput&&document.activeElement!==onlineUrlInput){
      onlineUrlInput.value=window.ChessOnline.serverUrl()||'';
    }
  }

  function readOnlineControl(){
    try { return localStorage.getItem('chess-online-control')||'5+0'; }
    catch { return '5+0'; }
  }

  function selectOnlineControl(id){
    try { localStorage.setItem('chess-online-control',id); } catch { /* egal */ }
    for(const button of onlineControls.querySelectorAll('.online-control')){
      button.classList.toggle('active',button.dataset.control===id);
    }
  }

  function openOnlineDialog(){
    if(!onlineReady()||!onlineOverlay) return;
    onlineOverlay.hidden=false;
    if(!window.ChessOnline.isConnected()) window.ChessOnline.connect();
    else window.ChessOnline.requestLeaderboard();
    paintOnlineDialog();
  }

  function closeOnlineDialog(){ if(onlineOverlay) onlineOverlay.hidden=true; }

  function paintLeaderboard(players){
    if(!onlineBoard) return;
    if(!players||!players.length){
      onlineBoard.innerHTML='<div class="empty-moves">Noch hat niemand gespielt.</div>';
      return;
    }
    onlineBoard.innerHTML=players.map((p,index)=>
      `<div class="online-board-row"><span class="online-rank">${index+1}</span>`+
      `<span class="online-board-name">${escapeHtml(p.name)}</span>`+
      `<span class="online-board-rating">${escapeHtml(String(p.rating))}</span>`+
      `<span class="online-board-record">${p.wins}/${p.draws}/${p.losses}</span></div>`).join('');
  }

  /* --- Verdrahtung ------------------------------------------------------- */

  if(onlineReady()){
    const O=window.ChessOnline;

    O.on('status',()=>{ paintOnlineDialog(); paintOnlineCard(); });
    O.on('lobby',()=>paintOnlineDialog());
    O.on('welcome',()=>{ paintOnlineDialog(); O.requestLeaderboard(); });
    O.on('player',()=>paintOnlineDialog());
    O.on('leaderboard',paintLeaderboard);
    O.on('seeking',()=>{ paintOnlineDialog(); });
    O.on('seekCancelled',()=>paintOnlineDialog());

    O.on('gameStart',({game,resumed})=>{
      closeOnlineDialog();
      markClock();
      enterOnlineGame(game,resumed);
    });

    O.on('move',onServerMove);

    O.on('sync',game=>{
      if(!onlineMode||game.id!==onlineMode.gameId) return;
      markClock();
      onlineMode.pending=null;
      applyServerGame(game);
    });

    O.on('gameOver',data=>{
      if(!onlineMode||data.gameId!==onlineMode.gameId) return;
      onlineMode.finished=true;
      onlineMode.drawOfferFrom=null;
      markClock();
      const mine=onlineMode.colour;
      const winner=data.result?data.result.winner:null;
      const outcome=winner==null?'draw':(winner===mine?'win':'loss');
      window.ChessSound?.play(outcome==='win'?'gameEndWin':outcome==='loss'?'gameEndLoss':'gameEndDraw');
      showOnlineResult(data,outcome);
      paintOnlineCard();
    });

    O.on('drawOffered',data=>{
      if(!onlineMode||data.gameId!==onlineMode.gameId) return;
      onlineMode.drawOfferFrom=data.from;
      if(data.from!==onlineMode.colour) window.ChessSound?.play('notify');
      paintOnlineCard();
    });

    O.on('drawDeclined',()=>{
      if(!onlineMode) return;
      onlineMode.drawOfferFrom=null;
      paintOnlineCard();
      onlineNotice('Remis abgelehnt.');
    });

    O.on('opponentGone',data=>{
      if(!onlineMode||data.gameId!==onlineMode.gameId) return;
      onlineMode.opponentGone=true;
      paintOnlineCard();
    });

    O.on('opponentBack',()=>{
      if(!onlineMode) return;
      onlineMode.opponentGone=false;
      paintOnlineCard();
    });

    O.on('serverError',data=>{
      if(onlineMode) onlineNotice(data.message);
      else if(onlineOverlay&&!onlineOverlay.hidden) onlineLobbyHint.textContent=data.message;
    });

    O.on('replaced',data=>{
      setOnlineFeedback(data.message);
      if(onlineOverlay) onlineLobbyHint.textContent=data.message;
    });
  }

  function showOnlineResult(data,outcome){
    if(!gameOverOverlay) return;
    const titles={win:'Du gewinnst',loss:'Du verlierst',draw:'Remis'};
    const icons={win:'🏆',loss:'😔',draw:'🤝'};
    document.getElementById('gameover-title').textContent=titles[outcome];
    document.getElementById('gameover-reason').textContent=
      RESULT_REASONS[data.result?data.result.reason:'']||'Die Partie ist beendet.';
    document.getElementById('gameover-icon').textContent=icons[outcome];
    const ratings=data.ratings?data.ratings[onlineMode.colour]:null;
    document.getElementById('gameover-score').textContent=ratings
      ? `Wertung ${ratings.before} → ${ratings.after}`
      : '';
    gameOverOverlay.hidden=false;
  }

  document.getElementById('online-btn')?.addEventListener('click',openOnlineDialog);
  document.getElementById('online-modal-close')?.addEventListener('click',closeOnlineDialog);
  onlineOverlay?.addEventListener('click',e=>{ if(e.target===onlineOverlay) closeOnlineDialog(); });

  onlineControls?.addEventListener('click',e=>{
    const button=e.target.closest('.online-control');
    if(button) selectOnlineControl(button.dataset.control);
  });

  onlineSeekBtn?.addEventListener('click',()=>{
    if(window.ChessOnline.seeking()) window.ChessOnline.cancelSeek();
    else window.ChessOnline.seek(readOnlineControl());
    paintOnlineDialog();
  });

  document.getElementById('online-name-save')?.addEventListener('click',()=>{
    window.ChessOnline.setPlayerName(onlineNameInput.value);
  });
  onlineNameInput?.addEventListener('keydown',e=>{
    if(e.key==='Enter') window.ChessOnline.setPlayerName(onlineNameInput.value);
  });

  document.getElementById('online-url-save')?.addEventListener('click',()=>{
    window.ChessOnline.setServerUrl(onlineUrlInput.value);
    window.ChessOnline.disconnect();
    window.ChessOnline.connect();
    paintOnlineDialog();
  });

  onlineResignBtn?.addEventListener('click',()=>{
    if(!onlineMode||onlineMode.finished) return;
    if(window.confirm('Partie wirklich aufgeben?')) window.ChessOnline.resign();
  });
  onlineOfferDrawBtn?.addEventListener('click',()=>window.ChessOnline.offerDraw());
  document.getElementById('online-draw-yes')?.addEventListener('click',()=>window.ChessOnline.answerDraw(true));
  document.getElementById('online-draw-no')?.addEventListener('click',()=>window.ChessOnline.answerDraw(false));
  onlineLeaveBtn?.addEventListener('click',leaveOnline);

  /* ===================================================================== *
   * Start
   * ===================================================================== */

  window.renderChessBoard = render;
  buildLabels();resetRepetition();buildBoardOnce();applyOrientation();render();
  paintEval();
  // Wer schon online gespielt hat, wird beim Laden wieder verbunden: eine
  // laufende Partie soll ein Neuladen ueberstehen.
  window.ChessOnline?.autoConnect?.();
})();
