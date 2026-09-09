/**
 * Die Schachregeln - seit der Umstellung mit chess.js als Schiedsrichter.
 *
 * Diese Datei hat ihre Form behalten und ihren Kern getauscht. Nach aussen ist
 * sie dieselbe wie vorher: dieselben Funktionen, dieselben Zustandsobjekte,
 * dieselben Zugobjekte. app.js, ai-worker.js und der Server merken davon
 * nichts. Innen entscheidet nicht mehr eine eigene Zugerzeugung, welche Zuege
 * es gibt, sondern chess.js.
 *
 * Warum ueberhaupt: die Regeln sind die Stelle, an der ein Fehler am teuersten
 * ist. Ein falsch beurteilter Zug entscheidet eine Partie, und niemand merkt es
 * im Moment des Fehlers. chess.js ist an genau dieser Aufgabe seit Jahren
 * geprueft; eine selbstgeschriebene Zugerzeugung ist es nicht.
 *
 * ------------------------------------------------------------------------
 * Die Arbeitsteilung, und warum sie so und nicht anders ist
 * ------------------------------------------------------------------------
 *
 * chess.js entscheidet, WELCHE Zuege es gibt. Diese Datei fuehrt sie AUS.
 *
 * Das ist keine Bequemlichkeit, sondern gemessen. applyMove ist reines
 * Feldkopieren und kostet fuer 20.000 Aufrufe 6 ms. Dieselbe Arbeit ueber
 * chess.js - Stellung laden, Zug machen, FEN zurueckschreiben - kostet 656 ms,
 * das Hundertneunfache. In der Suche von ai-worker.js laeuft applyMove einmal
 * pro betrachtetem Zug; ueber chess.js geleitet waere der eingebaute Gegner
 * zwei Groessenordnungen langsamer und damit kaputt.
 *
 * Die Zugerzeugung dagegen ist ueber chess.js sogar guenstiger als vorher
 * (405 ms gegen 477 ms fuer 20.000 Aufrufe), solange man die ausfuehrlichen
 * Zugobjekte meidet - siehe legalMoves.
 *
 * Der Preis dieser Teilung ist, dass applyMove die Rochaderechte und das
 * en-passant-Feld selbst fortschreibt und dabei von chess.js abweichen
 * koennte. Deshalb liegt in tests/ ein Test, der fuer jeden Zug aus tausenden
 * Stellungen vergleicht, ob unser Ergebnis dem von chess.js entspricht. Die
 * Kosten dieser Absicherung fallen damit beim Testen an und nicht bei jedem
 * Zug eines Spielers.
 *
 * Nicht von chess.js kommen zwei Dinge, weil sie keine Regeln sind:
 * premoveTargets und castlingTarget beschreiben, wie eine Eingabe gemeint ist,
 * nicht was erlaubt ist. Ebenso bleibt das Lesen und Schreiben von FEN hier -
 * das ist Textverarbeitung mit eigenen, absichtlich strengen Fehlermeldungen.
 */
(function (global) {
  'use strict';

  const lib = global.ChessJs;
  if (!lib || typeof lib.Chess !== 'function') {
    // Laut scheitern statt still auf eine halbe Engine zurueckfallen: ohne
    // Regeln ist jede Antwort dieser Datei falsch, und eine falsche Antwort
    // ueber Schach faellt erst mitten in einer Partie auf.
    throw new Error('chess-engine.js braucht chess.js - static/vendor/chess.js muss vorher geladen sein');
  }
  const Chess = lib.Chess;

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

  /**
   * Die Zugflaggen von chess.js.
   *
   * Nachgeschrieben statt importiert, weil chess.js sie nicht exportiert. Ein
   * Test haelt fest, dass sie noch stimmen - verschoben sich die Werte nach
   * einem Upgrade still, wuerde aus einer Rochade eine Umwandlung.
   */
  const BITS = {
    CAPTURE: 2,
    EP_CAPTURE: 8,
    PROMOTION: 16,
    KSIDE_CASTLE: 32,
    QSIDE_CASTLE: 64
  };

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

  /* ------------------------------------------------------------------ *
   * Die Bruecke zu chess.js
   * ------------------------------------------------------------------ */

  /**
   * chess.js zaehlt Felder im 0x88-Schema: obere vier Bit die Reihe, untere
   * vier die Linie, gezaehlt ab a8. Das ist genau die Anordnung, in der auch
   * hier `board[reihe][linie]` liegt - a8 ist [0,0], e1 ist [7,4] und 0x74=116.
   * Deshalb genuegt Schieben und Maskieren; eine Umrechnungstabelle waere nur
   * eine zweite Gelegenheit, sich zu vertun.
   */
  function rowColOf(square0x88) { return [square0x88 >> 4, square0x88 & 15]; }

  /**
   * Eine chess.js-Partie in der Stellung `state`.
   *
   * Der Weg fuehrt ueber FEN, weil chess.js keinen anderen Eingang hat. Das
   * kostet rund 11 Mikrosekunden - in der Zugerzeugung vertretbar, in
   * applyMove nicht, siehe Kopfkommentar.
   */
  function gameFrom(state) {
    return new Chess(toFen(state));
  }

  /**
   * Ein interner chess.js-Zug wird zu einem Zug in der Form dieses Projekts.
   *
   * Ueber die internen Zuege statt ueber moves({verbose:true}), und das ist der
   * Grund, warum die Umstellung ueberhaupt bezahlbar ist: ein ausfuehrliches
   * Zugobjekt von chess.js erzeugt fuer die SAN-Eindeutigkeit die gesamte
   * Zugliste ein zweites Mal und serialisiert zweimal die ganze Stellung - pro
   * Zug. Fuer eine Stellung mit 36 Zuegen sind das 36 Zugerzeugungen; gemessen
   * das 43-fache. Gebraucht wird davon hier nichts: SAN liefert sanForMove,
   * wenn jemand danach fragt.
   */
  function toProjectMove(state, internal) {
    const from = rowColOf(internal.from);
    const to = rowColOf(internal.to);
    const piece = state.board[from[0]][from[1]];
    const move = { from, to, piece };

    if (internal.flags & BITS.EP_CAPTURE) {
      // Geschlagen wird nicht auf dem Zielfeld, sondern neben dem Bauern.
      move.captured = state.board[from[0]][to[1]];
      move.isEnPassant = true;
    } else if (internal.flags & BITS.CAPTURE) {
      move.captured = state.board[to[0]][to[1]];
    }

    if (internal.flags & BITS.PROMOTION) move.promotion = internal.promotion;

    if (internal.flags & (BITS.KSIDE_CASTLE | BITS.QSIDE_CASTLE)) {
      move.isCastle = true;
      const row = from[0];
      if (internal.flags & BITS.KSIDE_CASTLE) { move.rookFrom = [row, 7]; move.rookTo = [row, 5]; }
      else { move.rookFrom = [row, 0]; move.rookTo = [row, 3]; }
    }
    return move;
  }

  function isSquareAttacked(state, targetR, targetC, byColor) {
    return gameFrom(state).isAttacked(squareName(targetR, targetC), byColor === 'white' ? 'w' : 'b');
  }

  function isInCheck(state, color) {
    const king = findKing(state, color);
    if (!king) return false;
    // Nicht ueber isCheck(): das gilt immer der Seite am Zug, gefragt ist hier
    // aber eine beliebige Farbe - app.js fragt auch nach der anderen.
    return gameFrom(state).isAttacked(squareName(king[0], king[1]), color === 'white' ? 'b' : 'w');
  }

  /**
   * Alle legalen Zuege - Fesselungen, Schach und Rochaderechte inbegriffen.
   *
   * Mit `color` laesst sich nach der Seite fragen, die *nicht* am Zug ist. Das
   * ist keine Schachfrage, sondern eine Anzeigefrage - app.js zeichnet damit
   * Bedrohungen. chess.js kennt den Fall nicht, deshalb wird ihm eine Stellung
   * mit vertauschtem Zugrecht vorgelegt.
   *
   * Dabei faellt das en-passant-Feld weg, und das ist eine bewusste Korrektur.
   * Es gehoert der Seite, die gerade am Zug ist - mit vertauschtem Zugrecht
   * beschreibt es einen Doppelschritt, den es nie gab. Die alte Fassung liess
   * es stehen und erzeugte in seltenen Stellungen ein Schlagen im Vorbeigehen
   * ohne vorangegangenen Doppelschritt; chess.js weist eine solche Stellung
   * rundheraus als ungueltig zurueck. Beides zusammen ist der Beleg, dass hier
   * nichts verloren geht, sondern etwas Falsches verschwindet.
   */
  function legalMoves(state, color = state.turn) {
    const working = color === state.turn ? state : { ...cloneState(state), turn: color, ep: null };
    const game = gameFrom(working);
    const internal = game._moves({ legal: true });
    const out = [];
    for (let i = 0; i < internal.length; i++) {
      const move = toProjectMove(working, internal[i]);
      // Ein Koenig wird nicht geschlagen. In einer regulaeren Stellung kommt
      // ein solcher Zug ohnehin nicht vor - wohl aber in der Abfrage oben mit
      // vertauschtem Zugrecht, wenn der Gegner gerade im Schach steht: dann
      // boete chess.js folgerichtig das Schlagen des Koenigs an. Als Antwort
      // auf "was droht mir" ist das keine Auskunft, sondern Unsinn.
      if (move.captured === 'k' || move.captured === 'K') continue;
      out.push(move);
    }
    return out;
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
   *
   * Bleibt bewusst handgeschrieben: das hier ist keine Regel, sondern eine
   * Deutung einer Eingabe. chess.js kennt keine Zuege in Stellungen, die es
   * noch nicht gibt.
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
   *
   * Bleibt handgeschrieben, obwohl chess.js ein eigenes validateFen mitbringt:
   * die Meldungen hier sind deutsch, benennen das schuldige Feld und werden im
   * Einfuegen-Dialog angezeigt. Ein Wechsel wuerde die Sprache der Fehler
   * aendern und obendrein die Menge der akzeptierten Stellungen verschieben -
   * beides ohne Not.
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
    return gameFrom(state).isInsufficientMaterial();
  }

  /**
   * Wie die Partie steht.
   *
   * Die Reihenfolge der Pruefungen ist Absicht und aelter als diese Datei:
   * erst die Faelle ohne Zug, dann die Fuenfzig-Zuege-Regel, dann Wiederholung,
   * dann Materialmangel. Matt schlaegt jedes Remis.
   *
   * Die Wiederholung kommt als `repetitionMap` von aussen und nicht aus
   * chess.js: die Bibliothek zaehlt nur Stellungen, die sie selbst gespielt
   * hat, waehrend die Partie hier als Kette von Zustaenden vorliegt, in der
   * auch vor- und zurueckgeblaettert wird.
   */
  function status(state, repetitionMap={}) {
    const game = gameFrom(state);
    const inCheck = game.isCheck();
    const moves = game._moves({ legal: true });

    if (moves.length===0) {
      if (inCheck) return {type:'checkmate',winner:opponent(state.turn),inCheck:true,legalMoves:0};
      return {type:'stalemate',winner:null,inCheck:false,legalMoves:0};
    }
    if (state.halfmove>=100) return {type:'fifty-move',winner:null,inCheck,legalMoves:moves.length};
    const key=fenKey(state);
    if ((repetitionMap[key]||0)>=3) return {type:'threefold',winner:null,inCheck,legalMoves:moves.length};
    if (game.isInsufficientMaterial()) return {type:'insufficient-material',winner:null,inCheck,legalMoves:moves.length};
    return {type:inCheck?'check':'playing',winner:null,inCheck,legalMoves:moves.length};
  }

  /**
   * Der Zug in Kurznotation.
   *
   * Hier ist das ausfuehrliche Zugobjekt von chess.js genau richtig: es kommt
   * einmal pro tatsaechlich gespieltem Zug vor, nicht millionenfach in einer
   * Suche. Und es loest den Teil, der von Hand am fehleranfaelligsten ist -
   * wann zwei Springer sich unterscheiden muessen und ob ein Zeichen fuer
   * Schach oder Matt ans Ende gehoert.
   *
   * `next` und `repetitionMap` werden nicht mehr gebraucht; sie bleiben in der
   * Signatur, weil sechs Aufrufstellen sie uebergeben und die Umstellung deren
   * Verhalten nicht anfassen soll.
   */
  function sanForMove(state, move, next, repetitionMap={}) {
    const game = gameFrom(state);
    const played = game.move({
      from: squareName(move.from[0], move.from[1]),
      to: squareName(move.to[0], move.to[1]),
      promotion: move.promotion || undefined
    });
    return played.san;
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
