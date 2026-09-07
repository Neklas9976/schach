/**
 * Board and piece appearance.
 *
 * An earlier version fetched board and piece images at runtime from a public
 * mirror of a commercial site's assets. That made the look of the app depend
 * on artwork nobody here had the right to use, and on somebody else's server
 * staying up. Both are gone: nothing is loaded from outside this project.
 *
 * Pieces now come from the Cburnett set that Wikimedia Commons publishes under
 * free licences - the same drawings Wikipedia uses for chess diagrams - and
 * ship with the project as twelve small SVGs. See ATTRIBUTIONS.md.
 *
 * Boards are two colours each. A two-colour chequerboard is not anybody's
 * expression to own; it is the game. The palettes below are chosen here.
 */
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

  const BOARDS = [
    { id: 'nussbaum', label: 'Nussbaum', light: '#efd9b4', dark: '#b07d4e' },
    { id: 'wald',     label: 'Wald',     light: '#eceed4', dark: '#6f8f5a' },
    { id: 'schiefer', label: 'Schiefer', light: '#dfe4ea', dark: '#7d8796' },
    { id: 'meer',     label: 'Meer',     light: '#dde8f2', dark: '#6a8fb5' },
    { id: 'sand',     label: 'Sand',     light: '#f4e8d2', dark: '#c3a37a' },
    { id: 'espresso', label: 'Espresso', light: '#d9c3a5', dark: '#6f4e37' },
    { id: 'nacht',    label: 'Nacht',    light: '#8a94a6', dark: '#3a4350' },
    { id: 'rose',     label: 'Rosé',     light: '#f6dfe3', dark: '#c08497' },
    { id: 'moos',     label: 'Moos',     light: '#e5e9d8', dark: '#57734a' },
    { id: 'flieder',  label: 'Flieder',  light: '#e6e0f0', dark: '#8b7fae' },
    { id: 'kontrast', label: 'Kontrast', light: '#ffffff', dark: '#6f6f6f' },
    { id: 'papier',   label: 'Papier',   light: '#faf7f0', dark: '#c8c0b2' }
  ];

  const BOARD_BY_ID = new Map(BOARDS.map(board => [board.id, board]));
  const DEFAULT_BOARD = 'nussbaum';

  // One set for now. Adding another means dropping twelve SVGs into
  // static/pieces/<id>/ and adding a line here - and checking its licence,
  // which is the part that actually takes the time.
  const PIECE_SETS = [
    { id: 'cburnett', label: 'Cburnett', dir: 'cburnett' }
  ];
  const PIECE_SET_BY_ID = new Map(PIECE_SETS.map(set => [set.id, set]));
  const DEFAULT_PIECES = 'cburnett';

  const PIECE_FILES = {
    P: 'white-pawn', R: 'white-rook', N: 'white-knight',
    B: 'white-bishop', Q: 'white-queen', K: 'white-king',
    p: 'black-pawn', r: 'black-rook', n: 'black-knight',
    b: 'black-bishop', q: 'black-queen', k: 'black-king'
  };

  function pieceUrl(setId, piece) {
    const set = PIECE_SET_BY_ID.get(setId) || PIECE_SET_BY_ID.get(DEFAULT_PIECES);
    const file = PIECE_FILES[piece];
    return file ? new URL(`static/pieces/${set.dir}/${file}.svg`, document.baseURI).href : '';
  }

  function get(key, fallback) {
    try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
  }
  function set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* ignore storage failures */ }
  }

  // Stored ids are validated rather than trusted: the old version saved names
  // like "3d_wood" that no longer exist, and an unknown id must not leave the
  // board unpainted.
  let boardStyle = BOARD_BY_ID.has(get('chess-board-style', '')) ? get('chess-board-style', '') : DEFAULT_BOARD;
  let pieceStyle = PIECE_SET_BY_ID.has(get('chess-piece-style', '')) ? get('chess-piece-style', '') : DEFAULT_PIECES;

  function boardFor(id) {
    return BOARD_BY_ID.get(id) || BOARD_BY_ID.get(DEFAULT_BOARD);
  }

  /**
   * Colours the 64 squares.
   *
   * Kept as an explicit per-square paint rather than a CSS nth-child rule
   * because app.js rebuilds squares in place and calls this after every
   * render; a rule keyed on document order would break the moment the board
   * is flipped, which reorders the squares.
   */
  function paintBoardSquares() {
    const board = boardFor(boardStyle);
    boardEl.dataset.boardStyle = board.id;
    document.documentElement.dataset.boardTheme = board.id;
    boardEl.style.setProperty('--light-square', board.light);
    boardEl.style.setProperty('--dark-square', board.dark);
    for (const sq of boardEl.querySelectorAll('.square')) {
      const r = Number(sq.dataset.row), c = Number(sq.dataset.col);
      sq.style.backgroundColor = ((r + c) % 2 === 0) ? board.light : board.dark;
      // Left over from the era of remote board images; clearing it means a
      // stored style from that version cannot leave an image behind.
      sq.style.backgroundImage = 'none';
    }
  }

  function applyBoardStyle() {
    activeBoardName.textContent = boardFor(boardStyle).label;
    paintBoardSquares();
  }

  function applyPieceStyle() {
    const set = PIECE_SET_BY_ID.get(pieceStyle) || PIECE_SET_BY_ID.get(DEFAULT_PIECES);
    activePieceName.textContent = set.label;
    document.documentElement.dataset.pieceTheme = set.id;
  }

  function boardPreviewCss(board) {
    // A four-square swatch, drawn with a gradient so the card needs no markup
    // of its own.
    return `conic-gradient(${board.dark} 0 25%, ${board.light} 0 50%, ${board.dark} 0 75%, ${board.light} 0)`;
  }

  function renderCards() {
    boardGrid.innerHTML = '';
    for (const board of BOARDS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `style-card ${board.id === boardStyle ? 'active' : ''}`;
      button.dataset.style = board.id;
      button.dataset.name = board.label;
      button.innerHTML = `<span class="style-preview board-preview" aria-hidden="true"></span><span class="style-label">${board.label}</span>`;
      button.querySelector('.board-preview').style.background = boardPreviewCss(board);
      button.addEventListener('click', () => {
        boardStyle = board.id; set('chess-board-style', boardStyle); applyBoardStyle(); renderCards();
      });
      boardGrid.appendChild(button);
    }

    pieceGrid.innerHTML = '';
    for (const pieceSet of PIECE_SETS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `style-card ${pieceSet.id === pieceStyle ? 'active' : ''}`;
      button.dataset.style = pieceSet.id;
      button.dataset.name = pieceSet.label;

      const preview = document.createElement('span');
      preview.className = 'style-preview piece-preview';
      // Both colours in the swatch: half a set says little about how it will
      // look on a board.
      for (const piece of ['N', 'n']) {
        const img = document.createElement('img');
        img.src = pieceUrl(pieceSet.id, piece);
        img.alt = '';
        preview.appendChild(img);
      }

      const label = document.createElement('span');
      label.className = 'style-label';
      label.textContent = pieceSet.label;

      button.append(preview, label);
      button.addEventListener('click', () => {
        pieceStyle = pieceSet.id; set('chess-piece-style', pieceStyle); applyPieceStyle(); renderCards();
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
    Object.entries(panels).forEach(([name, panel]) => { panel.hidden = name !== target; });
    searchInput.value = ''; filterCards();
  }

  openBtn.addEventListener('click', () => { modal.hidden = false; switchTab('boards'); });
  closeBtn.addEventListener('click', () => { modal.hidden = true; });
  modal.addEventListener('click', e => { if (e.target === modal) modal.hidden = true; });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') modal.hidden = true; });
  tabs.forEach(tab => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));
  searchInput.addEventListener('input', filterCards);

  // The board asks for piece images through this, so it never needs to know
  // which scheme is selected or where the artwork comes from.
  window.getSelectedPieceStyle = () => pieceStyle;
  window.getPieceAssetUrl = piece => pieceUrl(pieceStyle, piece);

  window.applyBoardAppearance = applyBoardStyle;
  window.paintBoardSquares = paintBoardSquares;
  window.initAppearance = () => { renderCards(); applyPieceStyle(); applyBoardStyle(); };
  window.__appearanceCatalog = { boards: BOARDS.length, pieces: PIECE_SETS.length };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', window.initAppearance);
  else window.initAppearance();
})();
