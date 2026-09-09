/**
 * Der Differenztest: alte gegen neue Regel-Engine, Stellung fuer Stellung.
 *
 * Die uebrigen Tests beschreiben, was die Engine koennen soll. Dieser hier
 * beschreibt gar nichts - er behauptet nur, dass sich nichts geaendert hat.
 * Genau das ist bei einem verhaltenserhaltenden Umbau die Frage: nicht "ist
 * Rochade richtig umgesetzt", sondern "urteilt die neue Fassung in jeder
 * Stellung so wie die alte".
 *
 * Der Unterschied ist praktisch. 262 Zeilen Bestandstests decken die Faelle ab,
 * an die jemand gedacht hat. Eine stille Abweichung - eine Zugreihenfolge, ein
 * fehlendes Feld am Zugobjekt, ein Remisgrund, der eine Stellung frueher
 * greift - faende sich darin nicht, wuerde aber im Spiel auffallen.
 *
 * Verglichen wird ueber zufaellige, aber reproduzierbare Partien: ein fester
 * Startwert erzeugt immer dieselbe Folge, damit ein Fehlschlag nachstellbar
 * bleibt. Mit auf den Weg gegeben wird die vollstaendige Zugfolge, sodass aus
 * einem roten Test sofort eine Stellung wird.
 *
 * Diese Datei ist Geruest fuer den Umbau. Sie darf zusammen mit
 * tests/fixtures/chess-engine-legacy.js verschwinden, wenn die Umstellung
 * abgeschlossen und eingefahren ist.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Laedt eine Browserdatei so, wie der Server es tut - siehe server/rules.js.
 *
 * Die zweite Datei bekommt eine eigene Sandbox, sonst ueberschriebe die zweite
 * Engine die erste und der Test verglaeche etwas mit sich selbst. Das waere ein
 * Test, der immer gruen ist, und damit schlimmer als keiner.
 */
function loadEngine(relativePath, extraGlobals = {}) {
  const sandbox = { window: {}, ...extraGlobals };
  sandbox.globalThis = sandbox;
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  vm.runInNewContext(source, sandbox, { filename: path.basename(relativePath) });
  const engine = sandbox.window.ChessEngine;
  if (!engine || typeof engine.legalMoves !== 'function') {
    throw new Error(`${relativePath} hat keine brauchbare Regel-Engine geliefert`);
  }
  return engine;
}

/**
 * Die neue Engine bekommt chess.js in ihre Sandbox gestellt.
 *
 * Im Browser laedt ein eigenes <script> die Bibliothek vorher; hier muss das
 * von Hand nachgebaut werden. Solange die neue Engine chess.js noch nicht
 * benutzt, schadet das nichts - sie ignoriert es einfach.
 */
function loadCurrentEngine() {
  const sandbox = { window: {} };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'static/vendor/chess.js'), 'utf8'), sandbox, { filename: 'chess.js' });
  vm.runInNewContext(fs.readFileSync(path.join(root, 'static/chess-engine.js'), 'utf8'), sandbox, { filename: 'chess-engine.js' });
  const engine = sandbox.window.ChessEngine;
  if (!engine || typeof engine.legalMoves !== 'function') {
    throw new Error('static/chess-engine.js hat keine brauchbare Regel-Engine geliefert');
  }
  return engine;
}

const legacy = loadEngine('tests/fixtures/chess-engine-legacy.js');
const current = loadCurrentEngine();

/**
 * Holt einen Wert aus einer vm-Sandbox in die Welt dieses Tests herueber.
 *
 * Ohne das ist jeder Vergleich falsch-negativ: assert.deepEqual prueft auch den
 * Prototyp, und ein Array aus einer Sandbox hat ein anderes Array.prototype als
 * eines von hier. Zwei inhaltlich gleiche Zuglisten gelten dann als ungleich -
 * der Test waere immer rot und damit ebenso wertlos wie einer, der immer gruen
 * ist. Der Umweg ueber JSON macht aus beiden Seiten schlichte Daten.
 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Ein Zug als Text - mit allen Feldern, auf die app.js sich verlaesst. */
function moveKey(move) {
  const sq = ([r, c]) => `${'abcdefgh'[c]}${8 - r}`;
  return [
    sq(move.from),
    sq(move.to),
    move.piece,
    move.promotion || '-',
    move.captured || '-',
    move.isCastle ? 'castle' : '-',
    move.isEnPassant ? 'ep' : '-',
    move.rookFrom ? sq(move.rookFrom) : '-',
    move.rookTo ? sq(move.rookTo) : '-'
  ].join('|');
}

/**
 * Zugmengen werden sortiert verglichen.
 *
 * Die Reihenfolge ist kein zugesichertes Verhalten: app.js sucht sich seine
 * Zuege heraus, statt sich auf Position eins zu verlassen. Auf Gleichheit der
 * Reihenfolge zu bestehen hiesse, den Umbau an eine Zufaelligkeit zu ketten.
 */
function moveSet(moves) {
  // Array.from statt moves.map: map erzeugt das Ergebnis mit dem Array der
  // Sandbox, aus der die Liste stammt - siehe plain().
  return Array.from(moves, moveKey).sort();
}

/** Ein kleiner, reproduzierbarer Zufallsgenerator (mulberry32). */
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Vergleicht beide Engines in einer Stellung - ueber die ganze oeffentliche
 * Regel-Oberflaeche, nicht nur ueber die Zugliste.
 */
function compareState(state, trail) {
  const where = `nach ${trail.length} Halbzuegen [${trail.join(' ')}]`;

  assert.equal(current.toFen(state), legacy.toFen(state), `FEN weicht ab ${where}`);
  assert.equal(current.fenKey(state), legacy.fenKey(state), `FEN-Schluessel weicht ab ${where}`);

  const a = legacy.legalMoves(state);
  const b = current.legalMoves(state);
  assert.deepEqual(moveSet(b), moveSet(a), `Zugmenge weicht ab ${where}`);

  assert.deepEqual(plain(current.status(state)), plain(legacy.status(state)), `Zugstatus weicht ab ${where}`);

  for (const color of ['white', 'black']) {
    assert.equal(current.isInCheck(state, color), legacy.isInCheck(state, color),
      `Schachlage (${color}) weicht ab ${where}`);
    // Zuege der Seite, die nicht am Zug ist - app.js fragt das fuer die
    // Bedrohungsanzeige, und chess.js kennt den Fall nicht von sich aus.
    //
    // Verglichen wird ohne en-passant-Feld, und zwar auf beiden Seiten. Dieses
    // Feld gehoert der Seite am Zug; mit vertauschtem Zugrecht beschreibt es
    // einen Doppelschritt, den es nie gab. Die alte Fassung erzeugte daraus in
    // seltenen Stellungen ein Schlagen im Vorbeigehen ohne Doppelschritt - ein
    // Fehler, den die neue nicht uebernimmt. Der eigene Test weiter unten haelt
    // diese eine gewollte Abweichung fest, damit sie nicht hier untergeht.
    const noEp = { ...plain(state), ep: null };
    assert.deepEqual(moveSet(current.legalMoves(noEp, color)), moveSet(legacy.legalMoves(noEp, color)),
      `Zugmenge fuer ${color} weicht ab ${where}`);
  }

  assert.equal(current.insufficientMaterial(state), legacy.insufficientMaterial(state),
    `Materialurteil weicht ab ${where}`);

  // SAN haengt an der Gesamtstellung: Gleichheit der Zielfelder reicht nicht,
  // die Unterscheidung zweier Springer und das Matt-Zeichen kommen von aussen.
  for (const move of a) {
    const next = legacy.applyMove(state, move);
    assert.equal(current.sanForMove(state, move, next), legacy.sanForMove(state, move, next),
      `SAN fuer ${moveKey(move)} weicht ab ${where}`);
  }

  // Der Folgezustand muss Feld fuer Feld gleich sein, nicht nur "gleich gut":
  // app.js legt diese Objekte in die Zughistorie und navigiert darin.
  for (const move of a) {
    assert.deepEqual(plain(current.applyMove(state, move)), plain(legacy.applyMove(state, move)),
      `Folgestellung nach ${moveKey(move)} weicht ab ${where}`);
  }

  // Vorzuege sind Eingabekonvention, keine Regel - trotzdem darf sich beim
  // Umbau daran nichts verschieben.
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (!state.board[r][c]) continue;
      assert.deepEqual(plain(current.premoveTargets(state, [r, c])), plain(legacy.premoveTargets(state, [r, c])),
        `Vorzugsfelder von ${'abcdefgh'[c]}${8 - r} weichen ab ${where}`);
    }
  }

  // Ein FEN muss sich zurueck in genau dieselbe Stellung lesen lassen.
  assert.deepEqual(plain(current.fromFen(current.toFen(state))), plain(legacy.fromFen(legacy.toFen(state))),
    `FEN-Rundreise weicht ab ${where}`);
}

/**
 * Vergleicht den vollstaendigen Zugbaum bis zu einer Tiefe - jeden Knoten.
 *
 * Das ist der Teil, der Zufallspartien ergaenzt, und er wurde noetig, weil die
 * Zufallspartien allein zu wenig fanden: ein absichtlich eingebauter Fehler in
 * der langen Rochade - die Pruefung des Feldes d1 entfernt - blieb ueber vierzig
 * Partien hinweg unbemerkt. Solche Stellungen entstehen aus der Grundstellung
 * heraus fast nie, im Spiel aber sehr wohl.
 *
 * Erschoepfend statt zufaellig: aus einer Handvoll dicht besetzter Stellungen
 * wird jeder Zug gespielt, nicht einer. Verglichen wird hier nur das Billige -
 * FEN, Zugmenge, Status -, sonst waere die Laufzeit nicht zu halten. Das Teure
 * uebernimmt compareState an gezielten Stellungen.
 */
function compareTree(state, depth, trail = []) {
  const where = `Zugbaum [${trail.join(' ')}]`;
  assert.equal(current.toFen(state), legacy.toFen(state), `FEN weicht ab im ${where}`);

  const moves = legacy.legalMoves(state);
  assert.deepEqual(moveSet(current.legalMoves(state)), moveSet(moves), `Zugmenge weicht ab im ${where}`);
  assert.deepEqual(plain(current.status(state)), plain(legacy.status(state)), `Status weicht ab im ${where}`);

  if (depth <= 0) return moves.length;

  let nodes = 0;
  for (const move of moves) {
    nodes += compareTree(legacy.applyMove(state, move), depth - 1, [...trail, moveKey(move)]);
  }
  return nodes;
}

test('beide Engines urteilen im ganzen Zugbaum gleich, auch bei der Rochade', () => {
  // Stellungen, in denen Rochade, Fesselung und Umwandlung dicht beieinander
  // liegen. Die ersten fuenf zielen genau auf die Felder, ueber die der Koenig
  // zieht: wird eines davon nicht mehr auf Angriff geprueft, entsteht hier
  // sofort ein Zug zu viel.
  const positions = [
    ['d1 angegriffen, c1 frei', 'r2qk2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1'],
    ['f1 angegriffen', 'r3k1r1/8/8/8/8/8/8/R3K2R w KQkq - 0 1'],
    ['b1 angegriffen, sonst frei', '1r2k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1'],
    ['d8 angegriffen', 'r3k2r/8/8/8/8/8/8/R2QK2R b KQkq - 0 1'],
    ['Koenig im Schach, Rochade verboten', 'r3k2r/8/8/8/4q3/8/8/R3K2R w KQkq - 0 1'],
    ['dichtes Mittelspiel', 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 5'],
    ['Bauern vor der Umwandlung', '8/PPP4k/8/8/8/8/4ppp1/7K w - - 0 1']
  ];

  let nodes = 0;
  for (const [name, fen] of positions) {
    nodes += compareTree(legacy.fromFen(fen), 2, [name]);
  }
  assert.ok(nodes > 20000, `zu wenige Knoten geprueft: ${nodes}`);
});

test('beide Engines urteilen in der Startstellung gleich', () => {
  compareState(legacy.createInitialState(), []);
  assert.deepEqual(plain(current.createInitialState()), plain(legacy.createInitialState()));
});

test('beide Engines urteilen ueber zufaellige Partien hinweg gleich', () => {
  const GAMES = 40;
  const MAX_PLIES = 140;
  let positions = 0;

  for (let game = 0; game < GAMES; game++) {
    const random = rng(0x5EED + game);
    let state = legacy.createInitialState();
    const trail = [];

    for (let ply = 0; ply < MAX_PLIES; ply++) {
      compareState(state, trail);
      positions++;

      const moves = legacy.legalMoves(state);
      if (!moves.length) break;
      const status = legacy.status(state);
      if (status.type !== 'playing' && status.type !== 'check') break;

      const move = moves[Math.floor(random() * moves.length)];
      trail.push(legacy.sanForMove(state, move, legacy.applyMove(state, move)));
      state = legacy.applyMove(state, move);
    }
  }

  // Ohne diese Schranke koennte der Test durch eine kaputte Zugerzeugung
  // stillschweigend zu einem Test ueber nichts werden.
  assert.ok(positions > 1000, `zu wenige Stellungen geprueft: ${positions}`);
});

test('beide Engines lesen dieselben Sonderstellungen gleich', () => {
  // Faelle, die eine Zufallspartie kaum erreicht: Umwandlung, en passant,
  // Rochaderechte, Patt, Materialmangel, Zugwiederholung.
  const positions = [
    ['Umwandlung steht an', '8/P6k/8/8/8/8/7K/8 w - - 0 1'],
    ['Umwandlung mit Schlag', '1n6/P6k/8/8/8/8/7K/8 w - - 0 1'],
    ['en passant moeglich', 'rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3'],
    ['alle vier Rochaderechte', 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1'],
    ['Rochade durch Schach verhindert', 'r3k2r/8/8/8/8/8/8/R2QK2R b KQkq - 0 1'],
    ['Patt', '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'],
    ['Matt', 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3'],
    ['nur Koenige', '7k/8/8/8/8/8/8/7K w - - 0 1'],
    ['Koenig und Laeufer', '7k/8/8/8/8/8/8/6BK w - - 0 1'],
    ['gefesselte Figur', '7k/8/8/8/8/8/4R3/4K1r1 w - - 0 1'],
    ['Fuenfzig-Zuege-Regel fast erreicht', '7k/8/8/8/8/8/8/R6K w - - 99 60'],
    ['Doppelschach', 'rnb1kbnr/pppp1ppp/8/8/7q/5P2/PPPPP1PP/RNBQKBNR w KQkq - 0 1']
  ];

  for (const [name, fen] of positions) {
    const state = legacy.fromFen(fen);
    assert.deepEqual(plain(current.fromFen(fen)), plain(state), `fromFen weicht ab: ${name}`);
    compareState(state, [name]);
  }
});

test('die eine gewollte Abweichung: en passant gehoert der Seite am Zug', () => {
  // Weiss am Zug, e6 als en-passant-Feld - schwarz hat gerade e7-e5 gezogen.
  const state = legacy.fromFen('rnbqkbnr/pppp1ppp/8/3Pp3/8/8/PPP1PPPP/RNBQKBNR w KQkq e6 0 3');

  // Fuer Weiss, die Seite am Zug, ist das Schlagen im Vorbeigehen legal - und
  // beide Fassungen sehen es.
  const white = moveSet(current.legalMoves(state));
  assert.ok(white.some(m => m.includes('|ep|')), 'Weiss muss en passant schlagen koennen');
  assert.deepEqual(white, moveSet(legacy.legalMoves(state)));

  // Fuer Schwarz ergibt dasselbe Feld keinen Sinn: Schwarz hat den
  // Doppelschritt gemacht, nicht darauf geantwortet. Die neue Fassung raeumt
  // das Feld weg und liefert eine gueltige Zugmenge, statt wie chess.js die
  // Stellung als ungueltig zurueckzuweisen oder wie die alte Fassung einen
  // erfundenen Zug anzubieten.
  const black = current.legalMoves(state, 'black');
  assert.ok(black.length > 0, 'die Gegenseite muss trotzdem Zuege haben');
  assert.equal(black.filter(m => m.isEnPassant).length, 0,
    'fuer die Seite, die nicht am Zug ist, darf es kein en passant geben');
});

test('beide Engines lehnen dieselben kaputten FEN ab', () => {
  const broken = [
    '',
    'foo',
    '8/8/8/8/8/8/8/8 w - - 0 1',                                   // keine Koenige
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1',    // Zugrecht
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w XYZ - 0 1',     // Rochaderechte
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq z9 0 1',   // en-passant-Feld
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP w KQkq - 0 1',             // sieben Reihen
    'rnbqkbnr/ppppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'    // neun Felder
  ];

  for (const fen of broken) {
    const legacyThrew = (() => { try { legacy.fromFen(fen); return false; } catch { return true; } })();
    const currentThrew = (() => { try { current.fromFen(fen); return false; } catch { return true; } })();
    assert.equal(currentThrew, legacyThrew, `Urteil ueber "${fen}" weicht ab`);
    assert.ok(legacyThrew, `"${fen}" haette abgelehnt werden muessen`);
  }
});
