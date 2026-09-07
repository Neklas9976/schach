import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Der Server als Ganzes: ein echter Prozess, zwei echte WebSocket-Verbindungen,
 * eine echte Partie.
 *
 * game.js und lobby.js sind einzeln geprueft. Was hier dazukommt, ist die
 * Verdrahtung - und genau die faellt bei Einzelpruefungen durch: eine
 * Nachricht, die beim falschen Spieler landet, ein Ergebnis, das nur einer der
 * beiden erfaehrt, ein Wiederverbinden, das die Partie verliert.
 */

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const SERVER = path.join(ROOT, 'server', 'index.js');

/** Erst starten, wenn ws installiert ist - sonst wuerde der Lauf hier haengen. */
const wsInstalled = fs.existsSync(path.join(ROOT, 'server', 'node_modules', 'ws'));

function freePort() {
  // Ein fester Port wuerde zwei gleichzeitige Laeufe kollidieren lassen.
  return 9000 + Math.floor(Math.random() * 900);
}

async function startServer() {
  const port = freePort();
  const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'schach-')), 'players.json');
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), DATA_FILE: dataFile },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const errors = [];
  child.stderr.on('data', chunk => errors.push(String(chunk)));

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startete nicht: ${errors.join('')}`)), 10_000);
    child.stdout.on('data', chunk => {
      if (String(chunk).includes(`Port ${port}`)) { clearTimeout(timer); resolve(); }
    });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`Server endete mit ${code}: ${errors.join('')}`)); });
  });
  return { port, child, errors, stop: () => child.kill() };
}

/** Ein Testclient: verbindet, sammelt Nachrichten, wartet auf bestimmte. */
class Client {
  constructor(port) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}`);
    this.messages = [];
    this.waiters = [];
    this.socket.addEventListener('message', event => {
      const data = JSON.parse(event.data);
      this.messages.push(data);
      for (const waiter of [...this.waiters]) {
        if (waiter.match(data)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(data);
        }
      }
    });
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve);
      this.socket.addEventListener('error', reject);
    });
  }

  send(message) { this.socket.send(JSON.stringify(message)); }

  /** Wartet auf eine Nachricht - auch auf eine, die schon da war. */
  expect(type, extra = () => true, timeoutMs = 5_000) {
    const match = data => data.t === type && extra(data);
    const already = this.messages.find(match);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
          reject(new Error(`Keine Nachricht "${type}" nach ${timeoutMs} ms. `
            + `Bekommen: ${this.messages.map(m => m.t).join(', ')}`));
        }
      }, timeoutMs).unref();
    });
  }

  close() { try { this.socket.close(); } catch { /* egal */ } }
}

async function pairedGame(port, names = ['Anna', 'Bert']) {
  const one = new Client(port);
  const two = new Client(port);
  await Promise.all([one.ready, two.ready]);
  one.send({ t: 'hello', name: names[0] });
  two.send({ t: 'hello', name: names[1] });
  const [helloOne, helloTwo] = await Promise.all([one.expect('welcome'), two.expect('welcome')]);
  one.send({ t: 'seek', control: '5+0' });
  await one.expect('seeking');
  two.send({ t: 'seek', control: '5+0' });
  const [startOne, startTwo] = await Promise.all([one.expect('gameStart'), two.expect('gameStart')]);
  return { one, two, helloOne, helloTwo, game: startOne.game, gameTwo: startTwo.game };
}

/** Wer von beiden ist Weiss? */
function byColour(session) {
  const oneIsWhite = session.game.white.id === session.helloOne.player.id;
  return {
    white: oneIsWhite ? session.one : session.two,
    black: oneIsWhite ? session.two : session.one,
    whiteToken: oneIsWhite ? session.helloOne.token : session.helloTwo.token,
    whiteName: oneIsWhite ? session.helloOne.player.name : session.helloTwo.player.name
  };
}

test('two players find each other and play a game', { skip: !wsInstalled && 'npm install --prefix server' }, async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const session = await pairedGame(server.port);
  t.after(() => { session.one.close(); session.two.close(); });

  // Beide sehen dieselbe Partie, mit vertauschten Farben in der Anzeige.
  assert.equal(session.game.id, session.gameTwo.id);
  assert.deepEqual(
    [session.game.white.id, session.game.black.id].sort(),
    [session.helloOne.player.id, session.helloTwo.player.id].sort()
  );
  assert.equal(session.game.control.id, '5+0');
  assert.equal(session.game.turn, 'white');

  const { white, black } = byColour(session);

  white.send({ t: 'move', gameId: session.game.id, uci: 'e2e4' });
  const [seenByWhite, seenByBlack] = await Promise.all([white.expect('move'), black.expect('move')]);
  // Beide erfahren denselben Zug - der Gegner darf nichts anderes sehen.
  assert.equal(seenByWhite.san, 'e4');
  assert.equal(seenByBlack.san, 'e4');
  assert.equal(seenByBlack.fen, seenByWhite.fen);
  assert.match(seenByWhite.fen, /^rnbqkbnr/);
});

test('a move from the wrong player is refused and the board resynced', { skip: !wsInstalled && 'npm install --prefix server' }, async t => {
  const server = await startServer();
  t.after(() => server.stop());
  const session = await pairedGame(server.port);
  t.after(() => { session.one.close(); session.two.close(); });
  const { white, black } = byColour(session);

  // Schwarz zieht zuerst.
  black.send({ t: 'move', gameId: session.game.id, uci: 'e7e5' });
  const error = await black.expect('error');
  assert.match(error.message, /am Zug/i);
  // Und bekommt die gueltige Stellung zurueck, damit sein Brett nicht
  // auseinanderlaeuft.
  const sync = await black.expect('sync');
  assert.equal(sync.game.turn, 'white');
  assert.equal(sync.game.moves.length, 0);

  // Ein illegaler Zug der richtigen Seite wird genauso behandelt.
  white.send({ t: 'move', gameId: session.game.id, uci: 'e2e5' });
  assert.match((await white.expect('error')).message, /legal/i);
});

test('resigning ends the game for both and moves the ratings', { skip: !wsInstalled && 'npm install --prefix server' }, async t => {
  const server = await startServer();
  t.after(() => server.stop());
  const session = await pairedGame(server.port);
  t.after(() => { session.one.close(); session.two.close(); });
  const { white, black } = byColour(session);

  black.send({ t: 'resign', gameId: session.game.id });
  const [overWhite, overBlack] = await Promise.all([white.expect('gameOver'), black.expect('gameOver')]);
  assert.equal(overWhite.result.winner, 'white');
  assert.equal(overWhite.result.reason, 'resign');
  assert.equal(overBlack.result.winner, 'white');
  // Der Gewinner steigt, der Verlierer faellt - und zwar bei beiden gemeldet.
  assert.ok(overWhite.ratings.white.after > overWhite.ratings.white.before);
  assert.ok(overWhite.ratings.black.after < overWhite.ratings.black.before);
});

test('a draw is offered, declined, offered again and accepted', { skip: !wsInstalled && 'npm install --prefix server' }, async t => {
  const server = await startServer();
  t.after(() => server.stop());
  const session = await pairedGame(server.port);
  t.after(() => { session.one.close(); session.two.close(); });
  const { white, black } = byColour(session);
  const gameId = session.game.id;

  white.send({ t: 'drawOffer', gameId });
  assert.equal((await black.expect('drawOffered')).from, 'white');
  black.send({ t: 'drawAnswer', gameId, accept: false });
  await white.expect('drawDeclined');

  black.send({ t: 'drawOffer', gameId });
  await white.expect('drawOffered', d => d.from === 'black');
  white.send({ t: 'drawAnswer', gameId, accept: true });
  const over = await white.expect('gameOver');
  assert.equal(over.result.winner, null);
  assert.equal(over.result.reason, 'agreement');
});

test('reloading the page keeps the game', { skip: !wsInstalled && 'npm install --prefix server' }, async t => {
  const server = await startServer();
  t.after(() => server.stop());
  const session = await pairedGame(server.port);
  t.after(() => { session.one.close(); session.two.close(); });
  const { white, black, whiteToken, whiteName } = byColour(session);

  white.send({ t: 'move', gameId: session.game.id, uci: 'd2d4' });
  await black.expect('move');

  // Wie ein Neuladen: alte Verbindung weg, neue mit demselben Merkmal.
  white.close();
  const back = new Client(server.port);
  t.after(() => back.close());
  await back.ready;
  back.send({ t: 'hello', token: whiteToken, name: whiteName });
  const welcome = await back.expect('welcome');

  assert.ok(welcome.game, 'die Partie war nach dem Neuladen weg');
  assert.equal(welcome.game.id, session.game.id);
  assert.equal(welcome.game.moves.length, 1);
  assert.equal(welcome.game.moves[0].san, 'd4');
  // Und der Gegner erfaehrt, dass wieder jemand da ist.
  await black.expect('opponentBack');
});

test('a second tab takes over instead of playing alongside', { skip: !wsInstalled && 'npm install --prefix server' }, async t => {
  // Zwei offene Verbindungen fuer einen Spieler hiessen, dass Zuege je nach
  // Zufall in einem der beiden Fenster landen.
  const server = await startServer();
  t.after(() => server.stop());
  const first = new Client(server.port);
  t.after(() => first.close());
  await first.ready;
  first.send({ t: 'hello', name: 'Anna' });
  const welcome = await first.expect('welcome');

  const second = new Client(server.port);
  t.after(() => second.close());
  await second.ready;
  second.send({ t: 'hello', token: welcome.token, name: 'Anna' });
  await second.expect('welcome');
  await first.expect('replaced');
});

test('nothing works before saying hello', { skip: !wsInstalled && 'npm install --prefix server' }, async t => {
  const server = await startServer();
  t.after(() => server.stop());
  const client = new Client(server.port);
  t.after(() => client.close());
  await client.ready;
  client.send({ t: 'seek', control: '5+0' });
  assert.match((await client.expect('error')).message, /anmelden/i);
});

test('rubbish does not bring the server down', { skip: !wsInstalled && 'npm install --prefix server' }, async t => {
  const server = await startServer();
  t.after(() => server.stop());
  const client = new Client(server.port);
  t.after(() => client.close());
  await client.ready;

  client.socket.send('kein JSON');
  assert.match((await client.expect('error')).message, /unlesbar/i);
  client.send({ hallo: 'welt' });
  await client.expect('error', e => /Typ/.test(e.message));

  // Und danach laeuft alles ganz normal weiter.
  client.send({ t: 'hello', name: 'Anna' });
  assert.ok((await client.expect('welcome')).player.name === 'Anna');

  // Eine unbekannte Nachricht wird als solche gemeldet - vor der Anmeldung
  // haette die Anmeldepflicht zuerst gegriffen, und die Pruefung waere
  // versehentlich eine ganz andere gewesen.
  client.send({ t: 'gibtesnicht' });
  await client.expect('error', e => /Unbekannt/.test(e.message));
});

test('the health endpoint answers', { skip: !wsInstalled && 'npm install --prefix server' }, async t => {
  const server = await startServer();
  t.after(() => server.stop());
  const response = await fetch(`http://127.0.0.1:${server.port}/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
});
