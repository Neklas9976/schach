/**
 * Die Schachregeln fuer den Server - dieselben wie im Browser.
 *
 * static/chess-engine.js ist als Browserdatei geschrieben und haengt sich an
 * `window`. Statt die Regeln fuer den Server ein zweites Mal zu schreiben,
 * wird die Datei hier in einer eigenen Umgebung ausgefuehrt und ihr Export
 * herausgeholt.
 *
 * Das ist der Kern der Sache: eine zweite Regelimplementierung waere eine
 * zweite Wahrheit. Server und Browser wuerden frueher oder spaeter
 * unterschiedlich urteilen, und dann streitet ein Spieler mit dem Server
 * darueber, ob sein Zug legal war. Genau das kann so nicht passieren.
 *
 * Warum der Server ueberhaupt selbst rechnet: weil er es muss. Ein Client, dem
 * geglaubt wird, laesst sich in der Entwicklerkonsole in zehn Sekunden zum
 * Schummeln ueberreden - illegale Zuege, ein Koenig, der nicht im Schach steht,
 * eine Uhr, die nicht ablaeuft.
 */

import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../static/chess-engine.js', import.meta.url), 'utf8');

const sandbox = { window: {} };
sandbox.globalThis = sandbox;
vm.runInNewContext(source, sandbox, { filename: 'chess-engine.js' });

export const ChessEngine = sandbox.window.ChessEngine;

if (!ChessEngine || typeof ChessEngine.legalMoves !== 'function') {
  throw new Error('chess-engine.js hat keine brauchbare Regel-Engine geliefert');
}

const FILES = 'abcdefgh';

export function toUci(move) {
  const from = FILES[move.from[1]] + (8 - move.from[0]);
  const to = FILES[move.to[1]] + (8 - move.to[0]);
  return from + to + (move.promotion ? String(move.promotion).toLowerCase() : '');
}

export function parseSquare(text) {
  const col = FILES.indexOf(text[0]);
  const row = 8 - Number(text[1]);
  if (col < 0 || !Number.isInteger(row) || row < 0 || row > 7) return null;
  return [row, col];
}

/**
 * Sucht zu einem UCI-Zug den legalen Zug - oder gibt null zurueck.
 *
 * Ueber movesBetween, nicht ueber findLegalMove: eine Bauernumwandlung sind
 * vier Zuege ueber dieselben zwei Felder, und ohne genannte Figur passt keiner
 * davon. Genau daran ist im Browser einmal jede Umwandlung stillschweigend
 * gescheitert.
 */
export function resolveUci(state, uci) {
  if (typeof uci !== 'string' || uci.length < 4 || uci.length > 5) return null;
  const from = parseSquare(uci.slice(0, 2));
  const to = parseSquare(uci.slice(2, 4));
  if (!from || !to) return null;
  const candidates = ChessEngine.movesBetween(state, from, to);
  if (!candidates.length) return null;
  const promotion = uci[4];
  if (promotion) {
    return candidates.find(m => m.promotion && String(m.promotion).toLowerCase() === promotion) || null;
  }
  // Ohne genannte Figur darf kein Umwandlungszug durchrutschen: sonst
  // entschiede der Server, was aus dem Bauern wird.
  const plain = candidates.find(m => !m.promotion);
  return plain || null;
}
