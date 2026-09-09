/**
 * Was diese Datei bewacht: die drei Stellen, an denen die Regel-Engine chess.js
 * beim Wort nimmt, ohne dass die Bibliothek das zugesichert haette.
 *
 * 1. applyMove ist handgeschrieben geblieben, weil der Weg ueber chess.js in
 *    der Suche das Hundertneunfache kostet. Es schreibt damit Rochaderechte,
 *    en-passant-Feld und Zaehler selbst fort - und koennte dabei von chess.js
 *    abweichen. Hier wird fuer jeden Zug aus tausenden Stellungen verglichen,
 *    ob dieselbe Stellung herauskommt.
 *
 * 2. legalMoves benutzt _moves(), eine private Schnittstelle. Sie ist der
 *    einzige bezahlbare Weg zu Zugdetails - der oeffentliche erzeugt fuer jeden
 *    einzelnen Zug die gesamte Zugliste neu. Hier wird festgehalten, dass beide
 *    dasselbe liefern; aendert chess.js seine Innereien, faellt das auf.
 *
 * 3. Die Zugflaggen sind als Zahlen nachgeschrieben, weil chess.js sie nicht
 *    exportiert. Verschoeben sie sich, wuerde aus einer Rochade stillschweigend
 *    eine Umwandlung.
 *
 * Die Kosten der Absicherung fallen damit beim Testen an und nicht bei jedem
 * Zug eines Spielers. Das ist der ganze Sinn der Aufteilung.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sandbox = { window: {} };
sandbox.globalThis = sandbox;
for (const file of ['static/vendor/chess.js', 'static/chess-engine.js']) {
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: path.basename(file) });
}
const E = sandbox.window.ChessEngine;
const { Chess } = sandbox.window.ChessJs;

const sq = ([r, c]) => `${'abcdefgh'[c]}${8 - r}`;

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
 * Vergleicht unsere Ausfuehrung eines Zuges mit der von chess.js.
 *
 * Verglichen wird die vollstaendige FEN - Stellung, Zugrecht, Rochaderechte,
 * en-passant-Feld und beide Zaehler. Genau die Felder also, die applyMove von
 * Hand fortschreibt.
 */
function assertApplyMoveAgrees(state, where) {
  for (const move of E.legalMoves(state)) {
    const game = new Chess(E.toFen(state));
    game.move({ from: sq(move.from), to: sq(move.to), promotion: move.promotion || undefined });

    const ours = E.toFen(E.applyMove(state, move));
    assert.equal(withoutEp(ours), withoutEp(game.fen()),
      `applyMove weicht von chess.js ab: ${sq(move.from)}${sq(move.to)}${move.promotion || ''} in ${where}`);
  }
}

/**
 * Blendet das en-passant-Feld aus dem Vergleich aus.
 *
 * Nicht um einen Fehler zu verstecken, sondern weil dort eine bekannte,
 * absichtlich unangetastete Abweichung sitzt - der Test darunter haelt sie
 * genau fest. Ohne diese Ausblendung wuerde jeder Doppelschritt hier
 * fehlschlagen und die eigentliche Frage - schreibt applyMove Rochaderechte,
 * Zaehler und Brett richtig fort - ginge im Rauschen unter.
 */
function withoutEp(fen) {
  const parts = fen.split(' ');
  parts[3] = '-';
  return parts.join(' ');
}

test('bekannte Abweichung: das en-passant-Feld wird auch ohne Abnehmer notiert', () => {
  // Zwei Lesarten derselben Regel. Diese Engine schreibt das Feld nach jedem
  // Doppelschritt; chess.js folgt der strengeren, heute ueblichen Lesart und
  // notiert es nur, wenn tatsaechlich jemand dort schlagen koennte.
  //
  // Auf die Zuege hat das keinen Einfluss - das belegt der zweite Teil unten.
  // Einfluss hat es allein auf fenKey und damit auf die Stellungswiederholung:
  // zwei Stellungen, die sich nur um ein unbrauchbares en-passant-Feld
  // unterscheiden, gelten hier als verschieden und nach strenger Lesart als
  // gleich. Diese Engine erkennt eine dreifache Wiederholung dadurch eher zu
  // selten als zu oft.
  //
  // Das ist Altverhalten und aelter als die Umstellung auf chess.js. Es hier
  // mitzuaendern haette eine Verhaltensaenderung in einen Umbau geschmuggelt,
  // der ausdruecklich keine haben sollte.
  const start = E.createInitialState();
  const doublePush = E.legalMoves(start).find(m => m.from[0] === 6 && m.from[1] === 0 && m.to[0] === 4);

  const ours = E.toFen(E.applyMove(start, doublePush));
  const theirs = (() => { const g = new Chess(E.toFen(start)); g.move({ from: 'a2', to: 'a4' }); return g.fen(); })();

  assert.match(ours, / a3 /, 'diese Engine notiert das Feld');
  assert.match(theirs, / - /, 'chess.js laesst es weg, weil niemand dort schlagen kann');
  assert.equal(withoutEp(ours), withoutEp(theirs), 'sonst ist die Stellung identisch');

  // Steht ein Abnehmer bereit, sind beide wieder deckungsgleich - und zwar
  // vollstaendig, ohne Ausblendung.
  const fen = 'rnbqkbnr/1ppppppp/8/8/p7/8/PPPPPPPP/RNBQKBNR w KQkq - 0 2';
  const state = E.fromFen(fen);
  const move = E.legalMoves(state).find(m => m.from[0] === 6 && m.from[1] === 1 && m.to[0] === 4);
  const g = new Chess(fen); g.move({ from: 'b2', to: 'b4' });
  assert.equal(E.toFen(E.applyMove(state, move)), g.fen());
  assert.ok(g.moves().includes('axb3'), 'und das Schlagen im Vorbeigehen steht wirklich offen');

  // Und die FEN dieser Engine wird von chess.js richtig verstanden - sonst
  // ginge das Schlagrecht bei jedem Uebergang verloren.
  assert.ok(new Chess(E.toFen(E.applyMove(state, move))).moves().includes('axb3'),
    'chess.js muss unsere FEN samt en-passant-Recht lesen koennen');
});

test('applyMove fuehrt Zuege genauso aus wie chess.js - ueber zufaellige Partien', () => {
  let positions = 0;
  for (let game = 0; game < 12; game++) {
    const random = rng(0xC0FFEE + game);
    let state = E.createInitialState();
    for (let ply = 0; ply < 120; ply++) {
      assertApplyMoveAgrees(state, `Partie ${game}, Halbzug ${ply}`);
      positions++;
      const moves = E.legalMoves(state);
      if (!moves.length) break;
      const status = E.status(state);
      if (status.type !== 'playing' && status.type !== 'check') break;
      state = E.applyMove(state, moves[Math.floor(random() * moves.length)]);
    }
  }
  assert.ok(positions > 500, `zu wenige Stellungen geprueft: ${positions}`);
});

test('applyMove fuehrt Zuege genauso aus wie chess.js - in den heiklen Faellen', () => {
  // Genau die Stellungen, in denen applyMove eigene Regelkenntnis braucht:
  // Rochaderechte verfallen, das en-passant-Feld entsteht und vergeht, der
  // Halbzugzaehler wird zurueckgesetzt, ein Bauer wird umgewandelt.
  const positions = [
    ['Rochade beidseitig', 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1'],
    ['Rochade fuer Schwarz', 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R b KQkq - 0 1'],
    ['Turm wird geschlagen, Recht verfaellt', 'r3k2r/8/8/8/8/8/7R/R3K2R w KQkq - 0 1'],
    ['Doppelschritt erzeugt en passant', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'],
    ['en passant steht bereit', 'rnbqkbnr/pppp1ppp/8/3Pp3/8/8/PPP1PPPP/RNBQKBNR w KQkq e6 0 3'],
    ['Umwandlung, auch mit Schlag', '1n2k3/P6P/8/8/8/8/8/4K3 w - - 0 1'],
    ['Umwandlung fuer Schwarz', '4k3/8/8/8/8/8/p6p/1N2K3 b - - 0 1'],
    ['hoher Halbzugzaehler', '4k3/8/8/8/8/8/R7/4K3 w - - 87 60'],
    ['Koenig zieht, beide Rechte weg', 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 5 9']
  ];

  for (const [name, fen] of positions) {
    assertApplyMoveAgrees(E.fromFen(fen), name);
  }
});

test('die private Zugerzeugung liefert dasselbe wie die oeffentliche', () => {
  // _moves() ist der schnelle Weg, moves({verbose:true}) der zugesicherte.
  // Solange beide dieselbe Menge ergeben, ist der schnelle Weg unbedenklich.
  const positions = [
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1',
    'rnbqkbnr/pppp1ppp/8/3Pp3/8/8/PPP1PPPP/RNBQKBNR w KQkq e6 0 3',
    '1n2k3/P6P/8/8/8/8/8/4K3 w - - 0 1',
    'r2q1rk1/pp2ppbp/2np1np1/8/2BNP1b1/2N1BP2/PPPQ2PP/R3K2R w KQ - 0 10',
    '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'
  ];

  for (const fen of positions) {
    const game = new Chess(fen);
    const publicSet = game.moves({ verbose: true })
      .map(m => `${m.from}${m.to}${m.promotion || ''}`).sort();
    const privateSet = game._moves({ legal: true })
      .map(m => `${sq([m.from >> 4, m.from & 15])}${sq([m.to >> 4, m.to & 15])}${m.promotion || ''}`).sort();
    assert.deepEqual(privateSet, publicSet, `private und oeffentliche Zugerzeugung weichen ab: ${fen}`);
  }
});

test('die nachgeschriebenen Zugflaggen stimmen noch', () => {
  // Nicht die Zahlen selbst werden geprueft, sondern was sie bedeuten: jede
  // Flagge wird an einem Zug nachgewiesen, den sie beschreiben soll.
  const flagOf = (fen, from, to) => {
    const game = new Chess(fen);
    const move = game._moves({ legal: true })
      .find(m => sq([m.from >> 4, m.from & 15]) === from && sq([m.to >> 4, m.to & 15]) === to);
    assert.ok(move, `Zug ${from}${to} nicht gefunden in ${fen}`);
    return move.flags;
  };

  const CAPTURE = 2, EP_CAPTURE = 8, PROMOTION = 16, KSIDE = 32, QSIDE = 64;

  assert.ok(flagOf('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1', 'g1') & KSIDE, 'kurze Rochade');
  assert.ok(flagOf('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1', 'c1') & QSIDE, 'lange Rochade');
  assert.ok(flagOf('rnbqkbnr/pppp1ppp/8/3Pp3/8/8/PPP1PPPP/RNBQKBNR w KQkq e6 0 3', 'd5', 'e6') & EP_CAPTURE, 'en passant');
  assert.ok(flagOf('1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1', 'a7', 'a8') & PROMOTION, 'Umwandlung');
  assert.ok(flagOf('1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1', 'a7', 'b8') & CAPTURE, 'Schlagzug');

  // Und die Gegenprobe: ein stiller Zug traegt keine dieser Flaggen.
  const quiet = flagOf('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'e2', 'e4');
  assert.equal(quiet & (CAPTURE | EP_CAPTURE | PROMOTION | KSIDE | QSIDE), 0,
    'ein Doppelschritt ist weder Schlag noch Umwandlung noch Rochade');
});

test('die Engine verweigert den Dienst, wenn chess.js fehlt', () => {
  // Ohne Regeln ist jede Antwort falsch, und eine falsche Antwort ueber Schach
  // faellt erst mitten in einer Partie auf. Also lieber sofort abbrechen.
  const bare = { window: {} };
  bare.globalThis = bare;
  assert.throws(
    () => vm.runInNewContext(fs.readFileSync(path.join(root, 'static/chess-engine.js'), 'utf8'), bare),
    /chess\.js/,
    'die Engine muss ohne chess.js laut scheitern'
  );
});
