/**
 * A small opening book, used for two things: naming the opening in the sidebar
 * and marking early moves as "book" during analysis, so a player is not told
 * that 1.e4 was an inaccuracy.
 *
 * Keyed by the SAN move sequence rather than by position. A position key would
 * also catch transpositions, but it would mean shipping a hash for every entry
 * and computing one per ply; for naming an opening the move order *is* what
 * people recognise, and the longest matching prefix wins, so a game keeps the
 * most specific name it has reached.
 *
 * ECO codes are included where they are unambiguous. The list is deliberately
 * a common-openings subset, not a complete ECO database - that would be
 * megabytes and is a download, not source.
 */
(function (global) {
  'use strict';

  // "moves": "ECO|Name". Sequences are plain SAN separated by spaces.
  const BOOK = {
    'e4': 'B00|Königsbauernspiel',
    'e4 e5': 'C20|Offenes Spiel',
    'e4 e5 Nf3': 'C40|Königsspringerspiel',
    'e4 e5 Nf3 Nc6': 'C44|Königsspringerspiel',
    'e4 e5 Nf3 Nc6 Bb5': 'C60|Spanische Partie',
    'e4 e5 Nf3 Nc6 Bb5 a6': 'C68|Spanisch: Abtauschvariante',
    'e4 e5 Nf3 Nc6 Bb5 a6 Ba4': 'C70|Spanisch: Morphy-Verteidigung',
    'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6': 'C78|Spanisch: Morphy-Verteidigung',
    'e4 e5 Nf3 Nc6 Bb5 a6 Bxc6': 'C68|Spanisch: Abtauschvariante',
    'e4 e5 Nf3 Nc6 Bb5 Nf6': 'C65|Spanisch: Berliner Verteidigung',
    'e4 e5 Nf3 Nc6 Bc4': 'C50|Italienische Partie',
    'e4 e5 Nf3 Nc6 Bc4 Bc5': 'C50|Giuoco Piano',
    'e4 e5 Nf3 Nc6 Bc4 Nf6': 'C55|Zweispringerspiel im Nachzuge',
    'e4 e5 Nf3 Nc6 d4': 'C44|Schottische Partie',
    'e4 e5 Nf3 Nc6 d4 exd4': 'C45|Schottisch',
    'e4 e5 Nf3 Nc6 Nc3': 'C46|Dreispringerspiel',
    'e4 e5 Nf3 Nc6 Nc3 Nf6': 'C47|Vierspringerspiel',
    'e4 e5 Nf3 d6': 'C41|Philidor-Verteidigung',
    'e4 e5 Nf3 Nf6': 'C42|Russische Verteidigung',
    'e4 e5 Nc3': 'C25|Wiener Partie',
    'e4 e5 f4': 'C30|Königsgambit',
    'e4 e5 f4 exf4': 'C33|Königsgambit angenommen',
    'e4 e5 f4 d5': 'C31|Falkbeer-Gegengambit',
    'e4 e5 Bc4': 'C23|Läuferspiel',
    'e4 c5': 'B20|Sizilianische Verteidigung',
    'e4 c5 Nf3': 'B27|Sizilianisch',
    'e4 c5 Nf3 d6': 'B50|Sizilianisch',
    'e4 c5 Nf3 d6 d4': 'B54|Sizilianisch: Offen',
    'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6': 'B90|Sizilianisch: Najdorf',
    'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6': 'B70|Sizilianisch: Drachenvariante',
    'e4 c5 Nf3 Nc6': 'B30|Sizilianisch',
    'e4 c5 Nf3 e6': 'B40|Sizilianisch: Paulsen',
    'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 g6': 'B34|Sizilianisch: Beschleunigter Drache',
    'e4 c5 c3': 'B22|Sizilianisch: Alapin',
    'e4 c5 Nc3': 'B23|Sizilianisch: Geschlossen',
    'e4 e6': 'C00|Französische Verteidigung',
    'e4 e6 d4': 'C00|Französisch',
    'e4 e6 d4 d5': 'C01|Französisch',
    'e4 e6 d4 d5 Nc3': 'C10|Französisch: Paulsen',
    'e4 e6 d4 d5 Nd2': 'C03|Französisch: Tarrasch',
    'e4 e6 d4 d5 e5': 'C02|Französisch: Vorstoßvariante',
    'e4 e6 d4 d5 exd5': 'C01|Französisch: Abtauschvariante',
    'e4 c6': 'B10|Caro-Kann',
    'e4 c6 d4 d5': 'B12|Caro-Kann',
    'e4 c6 d4 d5 Nc3': 'B15|Caro-Kann: Hauptvariante',
    'e4 c6 d4 d5 e5': 'B12|Caro-Kann: Vorstoßvariante',
    'e4 d5': 'B01|Skandinavische Verteidigung',
    'e4 Nf6': 'B02|Aljechin-Verteidigung',
    'e4 d6': 'B07|Pirc-Verteidigung',
    'e4 g6': 'B06|Moderne Verteidigung',
    'e4 b6': 'B00|Owen-Verteidigung',
    'e4 Nc6': 'B00|Nimzowitsch-Verteidigung',

    'd4': 'A40|Damenbauernspiel',
    'd4 d5': 'D00|Geschlossenes Spiel',
    'd4 d5 c4': 'D06|Damengambit',
    'd4 d5 c4 dxc4': 'D20|Damengambit angenommen',
    'd4 d5 c4 e6': 'D30|Damengambit abgelehnt',
    'd4 d5 c4 c6': 'D10|Slawische Verteidigung',
    'd4 d5 c4 e6 Nc3 c6': 'D43|Halbslawisch',
    'd4 d5 c4 Nc6': 'D07|Tschigorin-Verteidigung',
    'd4 d5 Nf3': 'D02|Damenbauernspiel',
    'd4 d5 Bf4': 'D00|Londoner System',
    'd4 d5 Nf3 Nf6 Bf4': 'D02|Londoner System',
    'd4 Nf6': 'A45|Indische Verteidigung',
    'd4 Nf6 c4': 'A50|Indisch',
    'd4 Nf6 c4 e6': 'E00|Indisch',
    'd4 Nf6 c4 e6 Nc3 Bb4': 'E20|Nimzowitsch-Indisch',
    'd4 Nf6 c4 e6 Nf3 b6': 'E12|Damenindisch',
    'd4 Nf6 c4 e6 g3': 'E00|Katalanisch',
    'd4 Nf6 c4 g6': 'A48|Königsindisch',
    'd4 Nf6 c4 g6 Nc3 Bg7': 'E60|Königsindische Verteidigung',
    'd4 Nf6 c4 g6 Nc3 d5': 'D80|Grünfeld-Indisch',
    'd4 Nf6 c4 c5': 'A50|Benoni',
    'd4 Nf6 c4 e5': 'A43|Budapester Gambit',
    'd4 Nf6 Bg5': 'A45|Trompowsky-Angriff',
    'd4 Nf6 Nf3 g6': 'A48|Königsindisch',
    'd4 f5': 'A80|Holländische Verteidigung',
    'd4 e6': 'A40|Damenbauernspiel',
    'd4 d6': 'A41|Altindische Verteidigung',
    'd4 g6': 'A40|Moderne Verteidigung',

    'c4': 'A10|Englische Eröffnung',
    'c4 e5': 'A20|Englisch: Umgekehrt Sizilianisch',
    'c4 c5': 'A30|Englisch: Symmetrisch',
    'c4 Nf6': 'A15|Englisch: Indisch',
    'c4 e6': 'A13|Englisch: Agincourt',
    'Nf3': 'A04|Réti-Eröffnung',
    'Nf3 d5': 'A06|Réti-Eröffnung',
    'Nf3 d5 c4': 'A09|Réti-Gambit',
    'Nf3 Nf6': 'A05|Réti-Eröffnung',
    'g3': 'A00|Benkö-Eröffnung',
    'b3': 'A01|Larsen-Eröffnung',
    'f4': 'A02|Bird-Eröffnung',
    'b4': 'A00|Sokolski-Eröffnung',
    'Nc3': 'A00|Dunst-Eröffnung',
    'e3': 'A00|Van-t-Kruijs-Eröffnung',
    'd3': 'A00|Mieses-Eröffnung'
  };

  // Longest sequence in the book; caps how far a lookup ever has to look.
  const MAX_PLIES = Object.keys(BOOK).reduce((max, key) => Math.max(max, key.split(' ').length), 0);

  /**
   * Names the opening for a list of SAN moves, using the longest prefix that
   * is in the book. Returns null when nothing matches.
   */
  function lookup(sanMoves) {
    if (!Array.isArray(sanMoves) || !sanMoves.length) return null;
    const limit = Math.min(sanMoves.length, MAX_PLIES);
    for (let length = limit; length > 0; length--) {
      const entry = BOOK[sanMoves.slice(0, length).join(' ')];
      if (!entry) continue;
      const [eco, name] = entry.split('|');
      return { eco, name, plies: length };
    }
    return null;
  }

  /**
   * Whether the move at `index` (0-based ply) is still book.
   *
   * Analysis uses this so the opening is not scored: calling a main-line
   * theory move a mistake because the engine narrowly prefers something else
   * is noise, not feedback.
   */
  function isBookMove(sanMoves, index) {
    const hit = lookup(sanMoves.slice(0, index + 1));
    return !!hit && hit.plies === index + 1;
  }

  const api = { lookup, isBookMove, MAX_PLIES, size: Object.keys(BOOK).length };

  if (typeof window !== 'undefined') window.ChessOpenings = api;
  else (typeof self !== 'undefined' ? self : globalThis).ChessOpenings = api;
})(typeof window !== 'undefined' ? window : self);
