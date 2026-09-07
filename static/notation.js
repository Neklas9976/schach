/**
 * PGN reading and writing.
 *
 * FEN lives in chess-engine.js because it is a serialisation of the rules'
 * own state. PGN sits one level up: it is a *game* format, it needs the move
 * generator to make sense of algebraic notation, and it carries metadata the
 * engine knows nothing about.
 *
 * Design note on parsing: there is no hand-written SAN parser here. Reading
 * "Nbd7" correctly means resolving exactly the same ambiguity that writing it
 * does, and a second implementation of that rule is how a loader starts
 * disagreeing with the board. Instead every legal move is rendered to SAN with
 * the engine's own `sanForMove` and matched against the token. At forty-odd
 * moves per position that is far too cheap to be worth optimising.
 */
(function (global) {
  'use strict';

  const E = global.ChessEngine;

  const SEVEN_TAG_ROSTER = ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result'];

  /** Strips the decorations that must not take part in move matching. */
  function bareSan(san) {
    return String(san).replace(/[+#]/g, '').replace(/[!?]+$/, '').replace(/^\.+/, '');
  }

  /** Every legal move in `state`, paired with its SAN. */
  function sanIndex(state) {
    const out = [];
    for (const move of E.legalMoves(state)) {
      const next = E.applyMove(state, move);
      out.push({ move, san: E.sanForMove(state, move, next), next });
    }
    return out;
  }

  /**
   * Resolves one SAN token against a position.
   *
   * Castling is matched separately because PGN in the wild uses the digit zero
   * ("0-0") at least as often as the letter O, and some writers omit the
   * suffix on "O-O-O" ambiguity that does not exist.
   */
  function resolveSan(state, token) {
    const wanted = bareSan(token).replace(/0/g, 'O');
    const candidates = sanIndex(state);

    let hit = candidates.find(c => bareSan(c.san) === wanted);
    if (hit) return hit;

    // A promotion written without the "=" ("e8Q") is common enough to accept.
    hit = candidates.find(c => bareSan(c.san).replace('=', '') === wanted.replace('=', ''));
    if (hit) return hit;

    return null;
  }

  function formatDate(date = new Date()) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`;
  }

  /**
   * Wraps movetext at 80 columns, which is what the PGN standard asks for and
   * what every reader expects. Tokens are never split.
   */
  function wrap(tokens, width = 80) {
    const lines = [];
    let line = '';
    for (const token of tokens) {
      if (!line) line = token;
      else if (line.length + 1 + token.length <= width) line += ` ${token}`;
      else { lines.push(line); line = token; }
    }
    if (line) lines.push(line);
    return lines;
  }

  /**
   * Builds PGN text.
   *
   * `moves` only needs a `san` per ply - the caller already has those from the
   * move list, and re-deriving them would mean replaying the whole game.
   */
  function toPgn({ moves = [], headers = {}, startFen = null, result = '*' } = {}) {
    const tags = {
      Event: 'Partie', Site: 'Schachprogramm', Date: formatDate(),
      Round: '-', White: 'Weiß', Black: 'Schwarz',
      ...headers,
      Result: headers.Result || result
    };

    const lines = SEVEN_TAG_ROSTER.map(key => `[${key} "${String(tags[key]).replace(/"/g, "'")}"]`);
    for (const [key, value] of Object.entries(tags)) {
      if (SEVEN_TAG_ROSTER.includes(key) || value == null || value === '') continue;
      lines.push(`[${key} "${String(value).replace(/"/g, "'")}"]`);
    }

    // A game that does not start from the initial position is unreadable
    // without these two tags, and readers require them together.
    if (startFen && startFen !== E.toFen(E.createInitialState())) {
      lines.push('[SetUp "1"]');
      lines.push(`[FEN "${startFen}"]`);
    }

    const startState = startFen ? E.fromFen(startFen) : E.createInitialState();
    let moveNumber = startState.fullmove;
    let whiteToMove = startState.turn === 'white';

    const tokens = [];
    // A game continuing from a black-to-move position opens with "12..." so
    // the first token is not mistaken for White's move.
    if (!whiteToMove && moves.length) tokens.push(`${moveNumber}...`);
    for (const entry of moves) {
      if (whiteToMove) tokens.push(`${moveNumber}.`);
      tokens.push(entry.san || entry.notation);
      if (!whiteToMove) moveNumber++;
      whiteToMove = !whiteToMove;
    }
    tokens.push(tags.Result);

    return `${lines.join('\n')}\n\n${wrap(tokens).join('\n')}\n`;
  }

  const TAG_RE = /\[\s*(\w+)\s*"([^"]*)"\s*\]/g;

  /**
   * Removes everything that is not a move token.
   *
   * Variations nest, so they cannot be stripped with a single regex - a naive
   * `\([^)]*\)` stops at the first inner ")" and leaves the rest of the
   * variation in the token stream, where it parses as real moves.
   */
  function stripAnnotations(text) {
    let out = '';
    let depth = 0;
    let inBrace = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inBrace) { if (ch === '}') inBrace = false; continue; }
      if (ch === '{') { inBrace = true; continue; }
      if (ch === '(') { depth++; continue; }
      if (ch === ')') { depth = Math.max(0, depth - 1); continue; }
      if (depth === 0) out += ch;
    }
    return out
      .replace(/;[^\n]*/g, '')       // rest-of-line comments
      .replace(/\$\d+/g, '')         // numeric annotation glyphs
      .replace(/<[^>]*>/g, '');      // reserved by the standard, never moves
  }

  const RESULTS = new Set(['1-0', '0-1', '1/2-1/2', '*']);

  /**
   * Reads PGN text into something the board can load.
   *
   * Returns the headers, the starting position and one entry per ply carrying
   * the resolved move and the position after it, so the caller never has to
   * replay anything itself.
   */
  function fromPgn(text) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Kein PGN-Text übergeben');

    const headers = {};
    let match;
    TAG_RE.lastIndex = 0;
    while ((match = TAG_RE.exec(text)) !== null) headers[match[1]] = match[2];

    // Only the movetext may contain move tokens; a header value like a player
    // named "Bc4" would otherwise be parsed as a move.
    const movetext = stripAnnotations(text.replace(TAG_RE, ' '));

    let startFen = null;
    if (headers.FEN) {
      try { E.fromFen(headers.FEN); } catch (error) {
        throw new Error(`Die Startstellung im PGN ist ungültig: ${error.message}`);
      }
      startFen = headers.FEN;
    }

    let state = startFen ? E.fromFen(startFen) : E.createInitialState();
    const plies = [];
    let result = headers.Result || '*';

    const tokens = movetext.split(/\s+/).filter(Boolean);
    for (const raw of tokens) {
      if (RESULTS.has(raw)) { result = raw; continue; }
      // "12." / "12..." / a bare "..." continuation marker.
      if (/^\d+\.*$/.test(raw) || /^\.+$/.test(raw)) continue;

      const hit = resolveSan(state, raw);
      if (!hit) {
        // Named the way the PGN itself numbers moves ("12..." for Black), so
        // the reader can find the offending token by eye.
        const where = `${state.fullmove}${state.turn === 'white' ? '.' : '...'}`;
        throw new Error(`Zug ${where} ${raw} ist in dieser Stellung nicht möglich`);
      }
      plies.push({ san: hit.san, move: hit.move, state: hit.next });
      state = hit.next;
    }

    return { headers, startFen, plies, result };
  }

  /** Maps an engine status to the PGN result token. */
  function resultFor(status, timeoutLoser = null) {
    if (timeoutLoser) return timeoutLoser === 'white' ? '0-1' : '1-0';
    if (!status) return '*';
    if (status.type === 'checkmate') return status.winner === 'white' ? '1-0' : '0-1';
    if (['stalemate', 'fifty-move', 'threefold', 'insufficient-material'].includes(status.type)) return '1/2-1/2';
    return '*';
  }

  const api = { toPgn, fromPgn, resolveSan, resultFor, bareSan, stripAnnotations, formatDate };

  if (typeof window !== 'undefined') window.ChessNotation = api;
  else (typeof self !== 'undefined' ? self : globalThis).ChessNotation = api;
})(typeof window !== 'undefined' ? window : self);
