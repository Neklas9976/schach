import assert from 'node:assert/strict';
import test from 'node:test';

import { Game, findControl, TIME_CONTROLS } from '../server/game.js';
import { Lobby, cleanName, nextRatings, ratingTolerance, kFactor } from '../server/lobby.js';
import { MemoryStore } from '../server/store.js';
import { ChessEngine, resolveUci, toUci } from '../server/rules.js';

/**
 * Der Server muss die Regeln selbst kennen - sonst schreibt der Client sie.
 * Was hier geprueft wird, ist deshalb vor allem: was der Server *ablehnt*.
 */

const BLITZ = findControl('5+0');
const INC = findControl('3+2');

function players() {
  return {
    a: { id: 'a', name: 'Anna', rating: 1200, games: 0 },
    b: { id: 'b', name: 'Bert', rating: 1200, games: 0 }
  };
}

function newGame(now = 1_000_000, control = BLITZ) {
  const { a, b } = players();
  return new Game({ id: 'g1', white: a, black: b, control, now });
}

/* --- Regeln ------------------------------------------------------------ */

test('the server uses the same rules the browser does', () => {
  // Nicht "eine" Engine, sondern genau die aus static/. Eine zweite
  // Regelimplementierung waere eine zweite Wahrheit.
  assert.equal(typeof ChessEngine.legalMoves, 'function');
  assert.equal(typeof ChessEngine.sanForMove, 'function');
  const start = ChessEngine.createInitialState();
  assert.equal(ChessEngine.legalMoves(start).length, 20);
});

test('a promotion without a named piece is refused, not guessed', () => {
  // Vier Zuege liegen ueber denselben zwei Feldern. Einen davon auszuwaehlen
  // hiesse, der Server entscheidet, was aus dem Bauern wird.
  const state = ChessEngine.fromFen('8/P6k/8/8/8/8/8/K7 w - - 0 1');
  assert.equal(resolveUci(state, 'a7a8'), null);
  const queen = resolveUci(state, 'a7a8q');
  assert.ok(queen && String(queen.promotion).toLowerCase() === 'q');
  assert.equal(toUci(queen), 'a7a8q');
});

test('nonsense never reaches the board', () => {
  const state = ChessEngine.createInitialState();
  for (const bad of ['', 'e2', 'e2e4e5e6', 'z9z9', 'e7e5', null, 42, {}]) {
    assert.equal(resolveUci(state, bad), null, `angenommen: ${JSON.stringify(bad)}`);
  }
});

/* --- Partie ------------------------------------------------------------ */

test('only the player on move may move, and only their own pieces', () => {
  const game = newGame();
  assert.equal(game.play('b', 'e7e5', 1_000_000).ok, false, 'Schwarz zog zuerst');
  assert.equal(game.play('fremder', 'e2e4', 1_000_000).ok, false, 'Fremder zog mit');
  assert.equal(game.play('a', 'e2e4', 1_000_000).ok, true);
  assert.equal(game.play('a', 'd2d4', 1_000_001).ok, false, 'Weiss zog zweimal');
});

test('an illegal move is refused with a reason', () => {
  const game = newGame();
  const result = game.play('a', 'e2e5', 1_000_000);
  assert.equal(result.ok, false);
  assert.match(result.reason, /legal/i);
  assert.equal(game.moves.length, 0);
});

test('a game keeps the notation, not just the squares', () => {
  const game = newGame();
  game.play('a', 'e2e4', 1_000_000);
  game.play('b', 'e7e5', 1_000_100);
  game.play('a', 'g1f3', 1_000_200);
  assert.deepEqual(game.moves.map(m => m.san), ['e4', 'e5', 'Nf3']);
});

test('checkmate ends the game by itself', () => {
  const game = newGame();
  let now = 1_000_000;
  for (const uci of ['f2f3', 'e7e5', 'g2g4', 'd8h4']) {
    now += 100;
    assert.equal(game.play(game.state.turn === 'white' ? 'a' : 'b', uci, now).ok, true, uci);
  }
  assert.equal(game.status, 'finished');
  assert.equal(game.result.reason, 'checkmate');
  assert.equal(game.result.winner, 'black');
  // Und danach geht nichts mehr.
  assert.equal(game.play('a', 'e1f2', now + 100).ok, false);
});

/* --- Uhr --------------------------------------------------------------- */

test('the clock only starts with the first move', () => {
  // Sonst verliert, wer beim Verbinden langsamer war.
  const game = newGame(0);
  assert.equal(game.checkFlag(10 * 60_000), null);
  assert.equal(game.clockView(10 * 60_000).white, BLITZ.base);
});

test('time is taken from the player who used it', () => {
  const game = newGame(0);
  game.play('a', 'e2e4', 0);          // erster Zug: noch kein Abzug
  game.play('b', 'e7e5', 10_000);     // Schwarz hat 10 s gebraucht
  assert.equal(game.remaining.white, BLITZ.base);
  assert.equal(game.remaining.black, BLITZ.base - 10_000);
});

test('the increment is credited for moves actually played', () => {
  const game = newGame(0, INC);
  game.play('a', 'e2e4', 0);
  assert.equal(game.remaining.white, INC.base + INC.increment);
  game.play('b', 'e7e5', 5_000);
  assert.equal(game.remaining.black, INC.base - 5_000 + INC.increment);
});

test('running out of time loses the game', () => {
  const game = newGame(0);
  game.play('a', 'e2e4', 0);
  const over = game.checkFlag(BLITZ.base + 1_000);
  assert.ok(over, 'die Uhr lief nicht ab');
  assert.equal(over.reason, 'timeout');
  assert.equal(over.winner, 'white');
  assert.equal(game.status, 'finished');
});

test('a move sent after the flag falls does not save the game', () => {
  // Auch wenn es ein Matt gewesen waere: die Zeit war vorher um.
  const game = newGame(0);
  game.play('a', 'e2e4', 0);
  const late = game.play('b', 'e7e5', BLITZ.base + 5_000);
  assert.equal(late.ok, false);
  assert.equal(late.over.reason, 'timeout');
  assert.equal(game.moves.length, 1);
});

test('a bare king does not win on time', () => {
  // Schwarz hat eine Dame und laesst die Zeit ablaufen. Weiss steht mit dem
  // blanken Koenig da und koennte gar nicht mattsetzen - also Remis, nicht
  // Gewinn. Das ist die Regel, und ohne sie waere ein blanker Koenig ein Sieg.
  const { a, b } = players();
  const game = new Game({ id: 'g', white: a, black: b, control: BLITZ, now: 0 });
  game.state = ChessEngine.fromFen('7k/8/8/8/8/8/6q1/K7 b - - 0 1');
  game.moves.push({ uci: 'a2a1', san: 'Ka1', at: 0 });
  game.turnStartedAt = 0;
  const over = game.checkFlag(BLITZ.base + 1_000);
  assert.equal(over.winner, null, 'der blanke Koenig hat gewonnen');
  assert.equal(over.reason, 'timeout-insufficient');
});

test('a player who can still mate does win on time', () => {
  // Die Gegenprobe zur vorigen: sonst wuerde jede Zeitueberschreitung remis.
  const { a, b } = players();
  const game = new Game({ id: 'g', white: a, black: b, control: BLITZ, now: 0 });
  game.state = ChessEngine.fromFen('7k/8/8/8/8/8/6q1/K7 w - - 0 1');
  game.moves.push({ uci: 'g3g2', san: 'Qg2', at: 0 });
  game.turnStartedAt = 0;
  const over = game.checkFlag(BLITZ.base + 1_000);
  assert.equal(over.winner, 'black');
  assert.equal(over.reason, 'timeout');
});

test('the clock stops when the game does', () => {
  const game = newGame(0);
  game.play('a', 'e2e4', 0);
  game.resign('a', 5_000);
  const first = game.clockView(5_000);
  const later = game.clockView(600_000);
  assert.deepEqual({ w: first.white, b: first.black }, { w: later.white, b: later.black });
});

/* --- Aufgeben und Remis ------------------------------------------------- */

test('resigning hands the game to the other side', () => {
  const game = newGame(0);
  const result = game.resign('b', 1_000);
  assert.equal(result.winner, 'white');
  assert.equal(result.reason, 'resign');
});

test('a draw needs two people', () => {
  const game = newGame(0);
  assert.equal(game.offerDraw('a').ok, true);
  // Sein eigenes Angebot anzunehmen waere ein Remis auf Zuruf.
  assert.equal(game.answerDraw('a', true, 1_000).ok, false);
  assert.equal(game.status, 'active');
  const answer = game.answerDraw('b', true, 1_000);
  assert.equal(answer.accepted, true);
  assert.equal(game.result.reason, 'agreement');
  assert.equal(game.result.winner, null);
});

test('a declined offer is gone, and so is one overtaken by a move', () => {
  const game = newGame(0);
  game.offerDraw('a');
  game.answerDraw('b', false, 100);
  assert.equal(game.drawOfferFrom, null);
  game.offerDraw('a');
  game.play('a', 'e2e4', 200);
  assert.equal(game.drawOfferFrom, null, 'das Angebot ueberlebte den Zug');
});

/* --- Wertung ------------------------------------------------------------ */

test('winning against a stronger player is worth more', () => {
  const weak = { rating: 1000, games: 50 };
  const strong = { rating: 1600, games: 50 };
  const upset = nextRatings(weak, strong, 'white').white - weak.rating;
  const expected = nextRatings(strong, weak, 'white').white - strong.rating;
  assert.ok(upset > expected, `${upset} muss groesser sein als ${expected}`);
});

test('a draw moves the weaker player up and the stronger down', () => {
  const white = { rating: 1000, games: 50 };
  const black = { rating: 1600, games: 50 };
  const after = nextRatings(white, black, null);
  assert.ok(after.white > 1000);
  assert.ok(after.black < 1600);
});

test('ratings are a zero-sum game between equals', () => {
  const white = { rating: 1500, games: 50 };
  const black = { rating: 1500, games: 50 };
  const after = nextRatings(white, black, 'white');
  assert.equal(after.white - 1500, 1500 - after.black);
});

test('the first games move the rating faster than the hundredth', () => {
  assert.ok(kFactor(0, 1200) > kFactor(50, 1200));
  assert.ok(kFactor(50, 2500) < kFactor(50, 1200));
});

test('the search widens the longer nobody is found', () => {
  // Sonst wartet man abends allein, weil der einzige andere Spieler
  // 300 Punkte entfernt ist.
  assert.ok(ratingTolerance(0) < ratingTolerance(20_000));
  assert.equal(ratingTolerance(60_000), Infinity);
});

/* --- Lobby -------------------------------------------------------------- */

function newLobby(now = () => 1_000) {
  return new Lobby({ store: new MemoryStore(), now });
}

test('a returning player keeps their account', () => {
  const lobby = newLobby();
  const first = lobby.authenticate(null, 'Anna');
  const again = lobby.authenticate(first.token, 'Anna');
  assert.equal(again.id, first.id);
  // Ohne Merkmal ist es jemand anders.
  assert.notEqual(lobby.authenticate(null, 'Anna').id, first.id);
});

test('names are cleaned on the server, where they cannot be bypassed', () => {
  assert.equal(cleanName('  Anna  '), 'Anna');
  assert.equal(cleanName('a'.repeat(50)).length, 20);
  assert.equal(cleanName('Zeile\nUmbruch'), 'ZeileUmbruch');
  // Unsichtbare Zeichen: damit liessen sich zwei Konten anlegen, die auf dem
  // Schirm gleich aussehen.
  assert.equal(cleanName(`Bo${String.fromCharCode(0x200b)}b`), 'Bob');
  assert.match(cleanName('   '), /^Gast-/);
});

test('two seekers are paired into one game', () => {
  const lobby = newLobby();
  const anna = lobby.authenticate(null, 'Anna');
  const bert = lobby.authenticate(null, 'Bert');
  assert.equal(lobby.seek(anna.id, '5+0').waiting, 1);
  const paired = lobby.seek(bert.id, '5+0');
  assert.ok(paired.game, 'niemand wurde gepaart');
  assert.equal(lobby.queueSize(), 0);
  const colours = [paired.game.white.id, paired.game.black.id].sort();
  assert.deepEqual(colours, [anna.id, bert.id].sort());
});

test('nobody is paired with themselves', () => {
  const lobby = newLobby();
  const anna = lobby.authenticate(null, 'Anna');
  lobby.seek(anna.id, '5+0');
  const again = lobby.seek(anna.id, '5+0');
  assert.equal(again.game, undefined);
  assert.equal(lobby.queueSize(), 1, 'zweimal in derselben Schlange');
});

test('a player waits in exactly one queue', () => {
  // Sonst liesse sich in allen zugleich warten und man wuerde zweimal gepaart.
  const lobby = newLobby();
  const anna = lobby.authenticate(null, 'Anna');
  lobby.seek(anna.id, '5+0');
  lobby.seek(anna.id, '3+0');
  assert.equal(lobby.queueSize(), 1);
});

test('a made-up time control is refused', () => {
  const lobby = newLobby();
  const anna = lobby.authenticate(null, 'Anna');
  const result = lobby.seek(anna.id, '99+99');
  assert.equal(result.ok, false);
});

test('someone already playing cannot queue up again', () => {
  const lobby = newLobby();
  const anna = lobby.authenticate(null, 'Anna');
  const bert = lobby.authenticate(null, 'Bert');
  lobby.seek(anna.id, '5+0');
  lobby.seek(bert.id, '5+0');
  assert.equal(lobby.seek(anna.id, '3+0').ok, false);
});

test('players far apart in rating are not paired straight away', () => {
  let now = 1_000;
  const lobby = new Lobby({ store: new MemoryStore(), now: () => now });
  const weak = lobby.authenticate(null, 'Schwach');
  const strong = lobby.authenticate(null, 'Stark');
  lobby.store.update(strong.id, { rating: 2200 });
  lobby.seek(weak.id, '5+0');
  assert.equal(lobby.seek(strong.id, '5+0').game, undefined, 'sofort gepaart');
  // Nach genug Wartezeit nimmt man jeden - allein warten ist schlimmer.
  now += 40_000;
  const third = lobby.authenticate(null, 'Dritter');
  assert.ok(lobby.seek(third.id, '5+0').game);
});

test('a finished game is booked exactly once', () => {
  const lobby = newLobby();
  const anna = lobby.authenticate(null, 'Anna');
  const bert = lobby.authenticate(null, 'Bert');
  lobby.seek(anna.id, '5+0');
  const game = lobby.seek(bert.id, '5+0').game;
  game.resign(game.black.id, 2_000);

  const first = lobby.settle(game);
  assert.ok(first, 'nichts gebucht');
  const winner = lobby.store.byId(game.white.id);
  assert.equal(winner.wins, 1);
  assert.equal(winner.games, 1);
  assert.ok(winner.rating > 1200);

  // Zweimal buchen wuerde die Wertung verdoppeln.
  assert.equal(lobby.settle(game), null);
  assert.equal(lobby.store.byId(game.white.id).games, 1);
});

test('finishing a game frees both players for the next one', () => {
  const lobby = newLobby();
  const anna = lobby.authenticate(null, 'Anna');
  const bert = lobby.authenticate(null, 'Bert');
  lobby.seek(anna.id, '5+0');
  const game = lobby.seek(bert.id, '5+0').game;
  game.resign(anna.id, 2_000);
  lobby.settle(game);
  assert.equal(lobby.gameOf(anna.id), null);
  assert.equal(lobby.seek(anna.id, '3+0').ok, true);
});

test('a running game is found again after a reload', () => {
  const lobby = newLobby();
  const anna = lobby.authenticate(null, 'Anna');
  const bert = lobby.authenticate(null, 'Bert');
  lobby.seek(anna.id, '5+0');
  const game = lobby.seek(bert.id, '5+0').game;
  const back = lobby.authenticate(anna.token, 'Anna');
  assert.equal(lobby.gameOf(back.id).id, game.id);
});

test('the sweep ends games whose clock has run out', () => {
  let now = 0;
  const lobby = new Lobby({ store: new MemoryStore(), now: () => now });
  const anna = lobby.authenticate(null, 'Anna');
  const bert = lobby.authenticate(null, 'Bert');
  lobby.seek(anna.id, '5+0');
  const game = lobby.seek(bert.id, '5+0').game;
  game.play(game.white.id, 'e2e4', 0);
  assert.equal(lobby.sweep(1_000).length, 0);
  const done = lobby.sweep(BLITZ.base + 10_000);
  assert.equal(done.length, 1);
  assert.equal(done[0].result.reason, 'timeout');
});

test('the leaderboard only lists people who have played', () => {
  const lobby = newLobby();
  const anna = lobby.authenticate(null, 'Anna');
  lobby.authenticate(null, 'NochNie');
  lobby.store.update(anna.id, { games: 3, rating: 1400 });
  const board = lobby.leaderboard();
  assert.deepEqual(board.map(p => p.name), ['Anna']);
});

test('the view a client gets never carries the other player’s token', () => {
  // Mit einem fremden Merkmal koennte man sich als dieser Spieler anmelden.
  const lobby = newLobby();
  const anna = lobby.authenticate(null, 'Anna');
  const bert = lobby.authenticate(null, 'Bert');
  lobby.seek(anna.id, '5+0');
  const game = lobby.seek(bert.id, '5+0').game;
  const view = JSON.stringify(game.view(1_000));
  assert.equal(view.includes(anna.token), false);
  assert.equal(view.includes(bert.token), false);
});

test('every time control the client may ask for really exists', () => {
  for (const control of TIME_CONTROLS) {
    assert.ok(findControl(control.id), control.id);
    assert.ok(control.base > 0, `${control.id} ohne Bedenkzeit`);
  }
  // "Ohne Zeit" gibt es online nicht: eine Partie ohne Uhr, die der Gegner
  // einfach liegen laesst, blockiert beide fuer immer.
  assert.equal(findControl('unlimited'), null);
});

/* --- Was der Browser aus alldem macht ---------------------------------- */

import fs from 'node:fs';
const onlineCode = fs.readFileSync(new URL('../static/online.js', import.meta.url), 'utf8');
const appOnline = fs.readFileSync(new URL('../static/app.js', import.meta.url), 'utf8');

test('an online game switches off every engine assist', () => {
  // Eine Stockfish-Bewertung neben dem Brett ist genau das, wofuer man
  // anderswo gesperrt wird - gegen einen Menschen darf beides nicht gehen.
  assert.match(appOnline, /function evalEnabled\(\)\{[\s\S]{0,420}if\(puzzleMode\|\|onlineMode\) return false;/);
  assert.match(appOnline, /if\(onlineMode\)\{ onlineNotice\('Im Online-Spiel gibt es keinen Hinweis\.'\); return; \}/);
  assert.match(appOnline, /if\(puzzleMode\|\|onlineMode\) return;\s*\n\s*if\(!window\.ChessAI \|\| !window\.ChessAI\.isComputerTurn/);
});

test('only the player’s own colour can be moved online', () => {
  assert.match(appOnline, /return state\.turn===onlineMode\.colour\?onlineMode\.colour:null;/);
});

test('a move is attributed by the position, not by a flag', () => {
  // afterMoveSettled laeuft erst nach der Animation. Jeder gesetzte Merker
  // waere bis dahin zurueckgenommen, und der Zug des Gegners ginge an den
  // Server zurueck, als waere er der eigene.
  assert.match(appOnline, /const mover=state\.turn==='white'\?'black':'white';\s*if\(mover!==onlineMode\.colour\) return;/);
});

test('the server has the last word when the boards disagree', () => {
  assert.match(appOnline, /window\.ChessOnline\.requestSync\(\);/);
  assert.match(appOnline, /O\.on\('sync',game=>\{/);
});

test('the clock is handed over rather than painted alongside', () => {
  // clock.js uebermalt in seiner Schleife jeden Frame alles - danebenmalen
  // ginge nicht.
  const clockCode = fs.readFileSync(new URL('../static/clock.js', import.meta.url), 'utf8');
  assert.match(clockCode, /window\.ChessClock\.useExternalClock = source =>/);
  assert.match(appOnline, /window\.ChessClock\?\.useExternalClock\?\.\(onlineClockSource\);/);
  // Und beim Verlassen zurueckgegeben, sonst zeigt die naechste Partie die
  // Restzeiten der alten.
  assert.match(appOnline, /window\.ChessClock\?\.useExternalClock\?\.\(null\);/);
});

test('the connection layer knows nothing about the board', () => {
  // Sonst waere sie nicht ohne Browser pruefbar - und die Anzeige haenge an
  // der Netzschicht statt umgekehrt.
  for (const forbidden of ['getElementById', 'querySelector', 'innerHTML', 'ChessEngine']) {
    assert.equal(onlineCode.includes(forbidden), false, `online.js greift auf ${forbidden} zu`);
  }
});

test('a reconnect backs off instead of hammering the server', () => {
  assert.match(onlineCode, /const BACKOFF = \[/);
  assert.match(onlineCode, /BACKOFF\[Math\.min\(attempt, BACKOFF\.length - 1\)\]/);
  // Ein Wechsel in ein anderes Fenster darf sich nicht gegenseitig
  // hinauswerfen.
  assert.match(onlineCode, /if \(deliberate \|\| event\.code === 4001\) return;/);
});

test('names from other players are escaped before they are shown', () => {
  // Sie kommen von Fremden und landen in innerHTML.
  assert.match(appOnline, /escapeHtml\(p\.name\)/);
});

test('a returning player is reconnected on load, a first-time visitor is not', () => {
  // Wer mitten in einer Partie neu laedt, bekommt sie sonst nicht zurueck und
  // verliert auf Zeit, ohne es zu merken. Umgekehrt soll das blosse Aufrufen
  // der Seite keine Verbindung aufbauen, die niemand bestellt hat.
  assert.match(onlineCode, /function autoConnect\(\) \{\s*if \(!hasAccount\(\) \|\| !serverUrl\(\)\) return false;/);
  assert.match(appOnline, /window\.ChessOnline\?\.autoConnect\?\.\(\);/);
});

test('a site without a server says so instead of pretending to connect', () => {
  // "Nicht verbunden" waere irrefuehrend: da wartet nichts, da fehlt etwas.
  // Und der Suchknopf waere ein Versprechen, das nichts einloest.
  assert.match(onlineCode, /if \(!socket\) return serverUrl\(\) \? 'offline' : 'unconfigured';/);
  assert.match(appOnline, /onlineSeekBtn\.disabled=status!=='ready';/);
  assert.match(appOnline, /status==='unconfigured'/);
});

test('nobody is paired with a player whose connection is already gone', () => {
  // Eine abgerissene Verbindung faellt dem Server erst beim naechsten
  // Herzschlag auf. Bis dahin wurde man gegen einen Geist gepaart, der nie
  // zieht - und bekam nach Ablauf der Wartefrist einen geschenkten Sieg.
  // Genau das ist beim ersten Spielen gegen den veroeffentlichten Server
  // passiert.
  const store = new MemoryStore();
  const present = new Set();
  const lobby = new Lobby({ store, now: () => 1_000, isPresent: id => present.has(id) });

  const ghost = lobby.authenticate(null, 'Geist');
  const alive = lobby.authenticate(null, 'Lebendig');
  present.add(ghost.id);
  lobby.seek(ghost.id, '5+0');
  assert.equal(lobby.queueSize(), 1);

  // Der Geist verschwindet, ohne dass der Server es schon weiss.
  present.delete(ghost.id);
  present.add(alive.id);
  const result = lobby.seek(alive.id, '5+0');
  assert.equal(result.game, undefined, 'gegen einen Geist gepaart');
  // Und der Geist ist dabei gleich aus der Schlange geflogen.
  assert.equal(lobby.queueSize(), 1);
});

test('the presence check is wired to the actual sockets', () => {
  const serverCode = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  assert.match(serverCode, /new Lobby\(\{ store, isPresent: id => sockets\.has\(id\) \}\)/);
  // sockets muss vor der Lobby stehen, sonst greift die Auskunft ins Leere.
  assert.ok(serverCode.indexOf('const sockets = new Map();') < serverCode.indexOf('new Lobby({'));
});

test('the status page says where the accounts actually live', () => {
  // Von aussen war nicht zu erkennen, ob wirklich eine Datenbank dahintersteht.
  // Ob die Wertungen den naechsten Neustart ueberleben, will man wissen, bevor
  // sie es nicht tun.
  const serverCode = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  assert.match(serverCode, /store: store instanceof PostgresStore \? 'datenbank' : 'datei'/);
});

test('the opponent’s name stays in the player strip', () => {
  // renderCaptured laeuft bei jedem Neuzeichnen und setzte die Leisten
  // bedingungslos auf "Weiß" und "Schwarz" zurueck. Online sass man damit nach
  // dem ersten Zug wieder namenlos da.
  assert.match(appOnline, /if\(onlineMode&&window\.ChessOnline\?\.game\(\)\)\{\s*setOnlinePlayers\(window\.ChessOnline\.game\(\)\);/);
});
