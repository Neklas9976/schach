(() => {
  'use strict';

  const boardEl = document.getElementById('chess-board');
  const modal = document.getElementById('appearance-modal');
  const openBtn = document.getElementById('appearance-btn');
  const closeBtn = document.getElementById('appearance-close');
  const tabs = [...document.querySelectorAll('.appearance-tab')];
  const panels = {
    boards: document.getElementById('appearance-boards'),
    pieces: document.getElementById('appearance-pieces')
  };
  const boardGrid = document.getElementById('board-style-grid');
  const pieceGrid = document.getElementById('piece-style-grid');
  const searchInput = document.getElementById('style-search');
  const activeBoardName = document.getElementById('active-board-name');
  const activePieceName = document.getElementById('active-piece-name');

  const BOARD_BASE = 'https://raw.githubusercontent.com/GiorgioMegrelli/chess.com-boards-and-pieces/v2.x/boards';
  const PIECE_BASE = 'https://raw.githubusercontent.com/GiorgioMegrelli/chess.com-boards-and-pieces/v2.x/pieces';

  const BOARDS = [
    '4fs27','6m5lc','8_bit','9rdwe','bases','bju81','blue','brown','bubblegum','burled_wood','checkers','dark_wood','dash','g715q','glass','graffiti','icy_sea','light','lolz','marble','metal','my2xa','neon','newspaper','orange','parchment','purple','red','sand','sky','stone','tan','tournament','translucent','walnut','z4m3d'
  ];

  const PIECES = [
    '3d_chesskid','3d_plastic','3d_staunton','3d_wood','8_bit','8qetl','alpha','bases','book','bubblegum','cases','classic','club','condal','dash','ejgfv','game_room','glass','gothic','graffiti','icy_sea','light','lolz','luca','marble','maya','metal','modern','nature','neo_wood','neon','newspaper','ocean','sky','space','tigers','tournament','vintage','wood'
  ];

  const labels = {
    '4fs27':'4fs27','6m5lc':'6m5lc','8_bit':'8 Bit','9rdwe':'9rdwe','bases':'Bases','bju81':'Bju81','blue':'Blue','brown':'Brown','bubblegum':'Bubblegum','burled_wood':'Burled Wood','checkers':'Checkers','dark_wood':'Dark Wood','dash':'Dash','g715q':'g715q','glass':'Glass','graffiti':'Graffiti','icy_sea':'Icy Sea','light':'Light','lolz':'Lolz','marble':'Marble','metal':'Metal','my2xa':'my2xa','neon':'Neon','newspaper':'Newspaper','orange':'Orange','parchment':'Parchment','purple':'Purple','red':'Red','sand':'Sand','sky':'Sky','stone':'Stone','tan':'Tan','tournament':'Tournament','translucent':'Translucent','walnut':'Walnut','z4m3d':'z4m3d',
    '3d_chesskid':'3D ChessKid','3d_plastic':'3D Plastic','3d_staunton':'3D Staunton','3d_wood':'3D Wood','8_bit':'8 Bit','8qetl':'8QETL','alpha':'Alpha','bases':'Bases','book':'Book','bubblegum':'Bubblegum','cases':'Cases','classic':'Classic','club':'Club','condal':'Condal','dash':'Dash','ejgfv':'ejgfv','game_room':'Game Room','glass':'Glass','gothic':'Gothic','graffiti':'Graffiti','icy_sea':'Icy Sea','light':'Light','lolz':'Lolz','luca':'Luca','marble':'Marble','maya':'Maya','metal':'Metal','modern':'Modern','nature':'Nature','neo_wood':'Neo Wood','neon':'Neon','newspaper':'Newspaper','ocean':'Ocean','sky':'Sky','space':'Space','tigers':'Tigers','tournament':'Tournament','vintage':'Vintage','wood':'Wood'
  };

  const safeBoardNames = new Set(['brown']);
  const fallbackBoard = { light:'#f0d9b5', dark:'#b58863' };

  function get(key, fallback) {
    try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
  }
  function set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* ignore storage failures */ }
  }

  let boardStyle = get('chess-board-style', 'brown');
  let pieceStyle = get('chess-piece-style', '3d_wood');

  function pieceUrl(style, code) {
    return `${PIECE_BASE}/${encodeURIComponent(style)}/${code}.png`;
  }
  function boardUrl(style) {
    return `${BOARD_BASE}/${encodeURIComponent(style)}.png`;
  }

  function normalizeBoardUrl(url) {
    return url.replace(/'/g, "\\'");
  }

  function paintBoardSquares() {
    const url = boardUrl(boardStyle);
    boardEl.dataset.boardStyle = boardStyle;
    boardEl.style.setProperty('--board-image', `url('${normalizeBoardUrl(url)}')`);
    document.documentElement.dataset.boardTheme = boardStyle;
    for (const sq of boardEl.querySelectorAll('.square')) {
      const r = Number(sq.dataset.row), c = Number(sq.dataset.col);
      // Always keep a real color underneath the remote image. If the image
      // fails, the board remains a normal chessboard instead of becoming the
      // dark board-frame color.
      sq.style.backgroundColor = ((r + c) % 2 === 0) ? fallbackBoard.light : fallbackBoard.dark;
      sq.style.backgroundImage = `url('${normalizeBoardUrl(url)}')`;
      sq.style.backgroundSize = '800% 800%';
      sq.style.backgroundPosition = `${(c * 100 / 7).toFixed(4)}% ${(r * 100 / 7).toFixed(4)}%`;
    }
  }

  function applyBoardStyle() {
    activeBoardName.textContent = labels[boardStyle] || boardStyle;
    paintBoardSquares();

    const url = boardUrl(boardStyle);
    const probe = new Image();
    probe.onload = () => document.documentElement.classList.remove('board-image-failed');
    probe.onerror = () => {
      // Do not clear the squares here. A failed remote image must fall back
      // to the per-square background color, not to the dark board frame.
      document.documentElement.classList.add('board-image-failed');
      for (const sq of boardEl.querySelectorAll('.square')) {
        sq.style.backgroundImage = 'none';
        sq.style.backgroundPosition = '';
        sq.style.backgroundSize = '';
      }
    };
    probe.src = url;
  }

  function applyPieceStyle() {
    activePieceName.textContent = labels[pieceStyle] || pieceStyle;
    document.documentElement.dataset.pieceTheme = pieceStyle;
  }

  function renderCards() {
    boardGrid.innerHTML = '';
    for (const style of BOARDS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `style-card ${style === boardStyle ? 'active' : ''}`;
      button.dataset.style = style;
      button.dataset.name = labels[style] || style;
      button.innerHTML = `<span class="style-preview board-preview" aria-hidden="true"></span><span class="style-label">${labels[style] || style}</span>`;
      const preview = button.querySelector('.board-preview');
      preview.style.backgroundImage = `url('${boardUrl(style)}')`;
      preview.style.backgroundSize = 'cover';
      button.addEventListener('click', () => {
        boardStyle = style; set('chess-board-style', boardStyle); applyBoardStyle(); renderCards();
      });
      boardGrid.appendChild(button);
    }

    pieceGrid.innerHTML = '';
    for (const style of PIECES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `style-card ${style === pieceStyle ? 'active' : ''}`;
      button.dataset.style = style;
      button.dataset.name = labels[style] || style;
      const preview = document.createElement('span');
      preview.className = 'style-preview piece-preview';
      const img = document.createElement('img');
      img.src = pieceUrl(style, 'wq');
      img.alt = `${labels[style] || style} Figuren Vorschau`;
      img.loading = 'lazy';
      img.addEventListener('error', () => {
        // Hide broken preview instead of showing a broken-image icon.
        img.hidden = true;
      });
      preview.appendChild(img);
      const label = document.createElement('span'); label.className='style-label'; label.textContent=labels[style] || style;
      button.append(preview, label);
      button.addEventListener('click', () => {
        pieceStyle = style; set('chess-piece-style', pieceStyle); applyPieceStyle(); renderCards();
        if (typeof window.renderChessBoard === 'function') window.renderChessBoard();
      });
      pieceGrid.appendChild(button);
    }
  }

  function filterCards() {
    const term = searchInput.value.trim().toLowerCase();
    for (const card of [...boardGrid.children, ...pieceGrid.children]) {
      const visible = !term || card.dataset.name.toLowerCase().includes(term) || card.dataset.style.toLowerCase().includes(term);
      card.hidden = !visible;
    }
  }

  function switchTab(target) {
    tabs.forEach(tab => tab.classList.toggle('active', tab.dataset.tab === target));
    Object.entries(panels).forEach(([name, panel]) => panel.hidden = name !== target);
    searchInput.value=''; filterCards();
  }

  openBtn.addEventListener('click', () => { modal.hidden = false; switchTab('boards'); });
  closeBtn.addEventListener('click', () => { modal.hidden = true; });
  modal.addEventListener('click', e => { if (e.target === modal) modal.hidden = true; });
  document.addEventListener('keydown', e => { if(e.key === 'Escape') modal.hidden = true; });
  tabs.forEach(tab => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));
  searchInput.addEventListener('input', filterCards);

  // Expose the selected piece style to app.js without coupling the two modules too tightly.
  window.getSelectedPieceStyle = () => pieceStyle;
  window.getPieceAssetUrl = (piece) => {
    const map = {P:'wp',R:'wr',N:'wn',B:'wb',Q:'wq',K:'wk',p:'bp',r:'br',n:'bn',b:'bb',q:'bq',k:'bk'};
    return pieceUrl(pieceStyle, map[piece]);
  };

  window.applyBoardAppearance = applyBoardStyle;
  window.paintBoardSquares = paintBoardSquares;
  window.initAppearance = () => { renderCards(); applyPieceStyle(); applyBoardStyle(); };
  window.__appearanceCatalog = { boards: BOARDS.length, pieces: PIECES.length };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', window.initAppearance); else window.initAppearance();
})();
