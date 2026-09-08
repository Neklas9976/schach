import assert from 'node:assert/strict';
import test from 'node:test';

import { PostgresStore } from '../server/pg-store.js';
import { Lobby } from '../server/lobby.js';

/**
 * Die Datenbankschicht gegen eine Attrappe.
 *
 * Eine echte Postgres-Instanz waere hier der falsche Aufwand: was schiefgehen
 * kann, ist nicht SQL, sondern das Zusammenspiel - eine Aenderung, die nie
 * geschrieben wird, ein Schreibfehler, der stillschweigend verschluckt wird,
 * ein Neustart, der die letzten Wertungen verliert.
 */

/** Merkt sich alle Abfragen und spielt eine Tabelle nach. */
function fakeClient({ failUntil = 0 } = {}) {
  const rows = new Map();
  let calls = 0;
  return {
    queries: [],
    rows,
    get calls() { return calls; },
    async query(text, values) {
      this.queries.push({ text, values });
      if (/CREATE TABLE/i.test(text)) return { rows: [] };
      if (/^\s*SELECT 1/i.test(text)) return { rows: [{ one: 1 }] };
      if (/^\s*SELECT/i.test(text)) return { rows: [...rows.values()] };
      if (/INSERT INTO players/i.test(text)) {
        calls += 1;
        if (calls <= failUntil) throw new Error('Verbindung weg');
        const [id, token, name, rating, games, wins, losses, draws, createdAt] = values;
        rows.set(id, {
          id, token, name, rating, games, wins, losses, draws, created_at: createdAt
        });
        return { rows: [] };
      }
      return { rows: [] };
    }
  };
}

function player(id, extra = {}) {
  return {
    id, token: `t-${id}`, name: `Spieler ${id}`, rating: 1200,
    games: 0, wins: 0, losses: 0, draws: 0, createdAt: 1_700_000_000_000, ...extra
  };
}

test('the schema is created before anything is read', async () => {
  const client = fakeClient();
  const store = new PostgresStore(client);
  await store.load();
  assert.match(client.queries[0].text, /CREATE TABLE IF NOT EXISTS players/);
});

test('a new account is written through', async () => {
  const client = fakeClient();
  const store = new PostgresStore(client, { writeDelay: 5 });
  await store.load();
  store.create(player('a'));
  await store.flush();
  assert.equal(client.rows.size, 1);
  assert.equal(client.rows.get('a').name, 'Spieler a');
});

test('a changed rating reaches the database', async () => {
  const client = fakeClient();
  const store = new PostgresStore(client, { writeDelay: 5 });
  await store.load();
  store.create(player('a'));
  store.update('a', { rating: 1350, games: 1, wins: 1 });
  await store.flush();
  assert.equal(client.rows.get('a').rating, 1350);
  assert.equal(client.rows.get('a').wins, 1);
});

test('everything comes back after a restart', async () => {
  // Der eigentliche Zweck der Uebung: bei Render ist die Platte fluechtig.
  const client = fakeClient();
  const first = new PostgresStore(client, { writeDelay: 5 });
  await first.load();
  first.create(player('a', { rating: 1500, games: 7 }));
  first.create(player('b'));
  await first.flush();

  const second = new PostgresStore(client, { writeDelay: 5 });
  const count = await second.load();
  assert.equal(count, 2);
  assert.equal(second.byId('a').rating, 1500);
  assert.equal(second.byId('a').games, 7);
  // Und die Anmeldung ueber das Merkmal funktioniert weiter.
  assert.equal(second.byToken('t-b').id, 'b');
});

test('numbers come back as numbers, not as text', async () => {
  // Postgres liefert bigint als Zeichenkette; eine Wertung als "1500" wuerde
  // beim naechsten Elo-Schritt zu "150032" statt zu 1532.
  const client = fakeClient();
  const first = new PostgresStore(client);
  await first.load();
  first.create(player('a', { rating: 1500 }));
  await first.flush();
  client.rows.get('a').rating = '1500';
  client.rows.get('a').created_at = '1700000000000';

  const second = new PostgresStore(client);
  await second.load();
  assert.equal(typeof second.byId('a').rating, 'number');
  assert.equal(second.byId('a').rating, 1500);
  assert.equal(typeof second.byId('a').createdAt, 'number');
});

test('a failed write is retried, not swallowed', async () => {
  // Eine Wertung, die im Browser steht und in der Datenbank nicht, ist
  // schlimmer als ein sichtbarer Fehler.
  const client = fakeClient({ failUntil: 1 });
  const store = new PostgresStore(client, { writeDelay: 5 });
  await store.load();
  store.create(player('a'));
  await store.flush();
  assert.equal(client.rows.size, 0, 'trotz Fehler geschrieben?');
  assert.equal(store.dirty.has('a'), true, 'die Aenderung wurde vergessen');
  await store.flush();
  assert.equal(client.rows.size, 1, 'der zweite Versuch fehlte');
});

test('two flushes at once do not race', async () => {
  const client = fakeClient();
  const store = new PostgresStore(client, { writeDelay: 5 });
  await store.load();
  for (let i = 0; i < 5; i++) store.create(player(`p${i}`));
  await Promise.all([store.flush(), store.flush(), store.flush()]);
  assert.equal(client.rows.size, 5);
  // Jede Zeile genau einmal geschrieben.
  assert.equal(client.calls, 5);
});

test('closing writes what is still pending', async () => {
  // Ein Neustart mitten im Sammelfenster wuerde sonst die letzten Wertungen
  // verlieren - und genau dann startet ein Hoster neu.
  const client = fakeClient();
  let ended = false;
  client.end = async () => { ended = true; };
  const store = new PostgresStore(client, { writeDelay: 60_000 });
  await store.load();
  store.create(player('a'));
  assert.equal(client.rows.size, 0);
  await store.close();
  assert.equal(client.rows.size, 1);
  assert.equal(ended, true, 'die Verbindung blieb offen');
});

test('accounts from the old file are carried over once', async () => {
  const client = fakeClient();
  const store = new PostgresStore(client);
  await store.load();
  const added = await store.importAll([player('alt', { rating: 1450 })]);
  assert.equal(added, 1);
  assert.equal(client.rows.get('alt').rating, 1450);
  // Ein zweiter Lauf darf nichts doppeln.
  assert.equal(await store.importAll([player('alt', { rating: 9 })]), 0);
  assert.equal(store.byId('alt').rating, 1450);
});

test('unusable entries in the old file are skipped, not imported broken', async () => {
  const client = fakeClient();
  const store = new PostgresStore(client);
  await store.load();
  const added = await store.importAll([null, {}, { id: 'x' }, player('gut')]);
  assert.equal(added, 1);
  assert.equal(store.byId('gut').name, 'Spieler gut');
});

test('the lobby works against the database store unchanged', async () => {
  // Der Punkt der ganzen Bauart: die Lobby fragt weiter synchron ab und muss
  // von der Datenbank nichts wissen.
  const client = fakeClient();
  const store = new PostgresStore(client, { writeDelay: 5 });
  await store.load();
  const lobby = new Lobby({ store, now: () => 1_000 });
  const anna = lobby.authenticate(null, 'Anna');
  const bert = lobby.authenticate(null, 'Bert');
  lobby.seek(anna.id, '5+0');
  const game = lobby.seek(bert.id, '5+0').game;
  game.resign(game.black.id, 2_000);
  lobby.settle(game);
  await store.flush();

  const winner = client.rows.get(game.white.id);
  assert.ok(winner, 'der Sieger steht nicht in der Datenbank');
  assert.equal(winner.games, 1);
  assert.ok(winner.rating > 1200);
});

test('certificate checking is on unless it is explicitly turned off', async () => {
  // Die Pruefung stillschweigend abzuschalten ist die Art Abkuerzung, die man
  // spaeter bereut. Sie darf nur auf ausdrueckliche Ansage weichen.
  const fs = await import('node:fs');
  const source = fs.readFileSync(new URL('../server/pg-store.js', import.meta.url), 'utf8');
  assert.match(source, /insecure = false/);
  assert.match(source, /insecure \? \{ rejectUnauthorized: false \} : true/);
  const server = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  assert.match(server, /insecure: process\.env\.DATABASE_SSL_INSECURE === '1'/);
});
