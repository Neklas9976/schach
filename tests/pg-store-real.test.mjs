import assert from 'node:assert/strict';
import test from 'node:test';

import { PostgresStore } from '../server/pg-store.js';
import { Lobby } from '../server/lobby.js';

/**
 * Dieselbe Datenbankschicht, aber gegen ein *echtes* Postgres.
 *
 * pg-store.test.mjs prueft das Zusammenspiel gegen eine Attrappe - die sagt
 * aber zu jedem SQL brav ja. Ob die Anweisungen ueberhaupt gueltig sind, ob
 * ON CONFLICT wirklich aktualisiert statt zu scheitern, und in welcher Form
 * bigint zurueckkommt, sagt nur ein echter Server.
 *
 * PGlite ist genau das: Postgres als WebAssembly, im selben Prozess. Kein
 * Docker, keine Installation, dieselbe Abfragesprache. Fehlt das Paket, wird
 * uebersprungen statt zu scheitern - es ist reines Pruefwerkzeug und wird
 * nicht mit ausgeliefert.
 */

let PGlite = null;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
} catch {
  /* npm install --save-dev @electric-sql/pglite */
}

const skip = PGlite ? false : 'PGlite fehlt (npm install --save-dev @electric-sql/pglite)';

/**
 * Ein frisches, leeres Postgres pro Test.
 *
 * `end` tut absichtlich nichts: der Store ruft es beim Schliessen auf, und im
 * Betrieb schliesst das nur die Verbindung - die Datenbank steht ausserhalb
 * und laeuft weiter. Hier liefe sie sonst mit, und ein Test ueber einen
 * Neustart haette nichts mehr, wohin er zurueckkehren koennte.
 */
async function freshDb() {
  const db = new PGlite();
  return {
    query: (text, values) => db.query(text, values),
    end: async () => {},
    shutdown: () => db.close()
  };
}

function player(id, extra = {}) {
  return {
    id, token: `t-${id}`, name: `Spieler ${id}`, rating: 1200,
    games: 0, wins: 0, losses: 0, draws: 0, createdAt: 1_700_000_000_000, ...extra
  };
}

test('the schema this code ships really is valid SQL', { skip }, async t => {
  const db = await freshDb();
  t.after(() => db.shutdown());
  const store = new PostgresStore(db);
  await store.load();

  const columns = await db.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_name = 'players' ORDER BY ordinal_position`
  );
  assert.deepEqual(columns.rows.map(c => c.column_name),
    ['id', 'token', 'name', 'rating', 'games', 'wins', 'losses', 'draws', 'created_at']);
});

test('running it twice does not fall over', { skip }, async t => {
  // Der Server legt das Schema bei jedem Start an - beim zweiten Mal darf das
  // nicht scheitern, sonst startet er nach dem ersten Neustart nicht mehr.
  const db = await freshDb();
  t.after(() => db.shutdown());
  await new PostgresStore(db).load();
  await assert.doesNotReject(() => new PostgresStore(db).load());
});

test('a real write comes back as a real read', { skip }, async t => {
  const db = await freshDb();
  t.after(() => db.shutdown());
  const first = new PostgresStore(db, { writeDelay: 5 });
  await first.load();
  first.create(player('a', { rating: 1480, games: 12, wins: 7, draws: 2, losses: 3 }));
  await first.flush();

  const second = new PostgresStore(db, { writeDelay: 5 });
  assert.equal(await second.load(), 1);
  const back = second.byId('a');
  assert.equal(back.rating, 1480);
  assert.equal(back.games, 12);
  assert.equal(back.wins, 7);
  assert.equal(back.name, 'Spieler a');
  assert.equal(back.token, 't-a');
});

test('bigint really does come back as a number', { skip }, async t => {
  // Postgres liefert bigint als Zeichenkette. Ohne die Umwandlung waere
  // createdAt ein Text - und eine Wertung als "1500" wuerde beim naechsten
  // Elo-Schritt zu "150032" statt zu 1532.
  const db = await freshDb();
  t.after(() => db.shutdown());
  const first = new PostgresStore(db);
  await first.load();
  first.create(player('a'));
  await first.flush();

  // In welcher Form bigint zurueckkommt, entscheidet der Treiber: node-postgres
  // liefert eine Zeichenkette, PGlite eine Zahl. Genau deshalb verlaesst sich
  // der Store nicht darauf, sondern wandelt um.
  const raw = await db.query('SELECT created_at, rating FROM players WHERE id = $1', ['a']);
  assert.ok(['string', 'number'].includes(typeof raw.rows[0].created_at));

  const second = new PostgresStore(db);
  await second.load();
  assert.equal(typeof second.byId('a').createdAt, 'number');
  assert.equal(second.byId('a').createdAt, 1_700_000_000_000);
  assert.equal(typeof second.byId('a').rating, 'number');
});

test('a second write to the same account updates instead of failing', { skip }, async t => {
  // ON CONFLICT: ohne das waere jede zweite Partie desselben Spielers ein
  // Schluesselkonflikt, und die Wertung bliebe fuer immer bei 1200 stehen.
  const db = await freshDb();
  t.after(() => db.shutdown());
  const store = new PostgresStore(db, { writeDelay: 5 });
  await store.load();
  store.create(player('a'));
  await store.flush();
  store.update('a', { rating: 1333, games: 1, wins: 1 });
  await store.flush();

  const rows = await db.query('SELECT rating, games FROM players');
  assert.equal(rows.rows.length, 1, 'es wurde eine zweite Zeile angelegt');
  assert.equal(Number(rows.rows[0].rating), 1333);
  assert.equal(Number(rows.rows[0].games), 1);
});

test('two accounts cannot share a token', { skip }, async t => {
  // Das Merkmal *ist* die Anmeldung. Zwei Konten mit demselben waeren zwei
  // Leute, die sich als dieselbe Person anmelden.
  const db = await freshDb();
  t.after(() => db.shutdown());
  const store = new PostgresStore(db);
  await store.load();
  store.create(player('a'));
  await store.flush();
  await assert.rejects(
    () => db.query(
      `INSERT INTO players (id, token, name, rating, games, wins, losses, draws, created_at)
       VALUES ('b', 't-a', 'Dieb', 1200, 0, 0, 0, 0, 1)`),
    /unique|duplicate/i
  );
});

test('a whole game survives a server restart', { skip }, async t => {
  // Der Grund fuer die ganze Uebung, einmal von vorne bis hinten: bei Render
  // ist die Platte fluechtig, und beim ersten Ausrollen fingen alle wieder
  // bei 1200 an.
  const db = await freshDb();
  t.after(() => db.shutdown());

  const before = new PostgresStore(db, { writeDelay: 5 });
  await before.load();
  const lobby = new Lobby({ store: before, now: () => 1_000 });
  const anna = lobby.authenticate(null, 'Anna');
  const bert = lobby.authenticate(null, 'Bert');
  lobby.seek(anna.id, '5+0');
  const game = lobby.seek(bert.id, '5+0').game;
  game.resign(game.black.id, 2_000);
  lobby.settle(game);
  await before.close();

  // Neuer Prozess, neue Instanz, dieselbe Datenbank.
  const after = new PostgresStore(db, { writeDelay: 5 });
  await after.load();
  const nextLobby = new Lobby({ store: after, now: () => 3_000 });
  const returning = nextLobby.authenticate(anna.token, 'Anna');

  assert.equal(returning.id, anna.id, 'das Konto wurde nicht wiedererkannt');
  assert.equal(returning.games, 1);
  assert.notEqual(returning.rating, 1200, 'die Wertung ist zurueckgefallen');
  assert.equal(nextLobby.leaderboard().length, 2);
});

test('the leaderboard survives too', { skip }, async t => {
  const db = await freshDb();
  t.after(() => db.shutdown());
  const store = new PostgresStore(db, { writeDelay: 5 });
  await store.load();
  store.create(player('a', { rating: 1500, games: 3 }));
  store.create(player('b', { rating: 1700, games: 5 }));
  store.create(player('c', { rating: 1900, games: 0 }));
  await store.flush();

  const reloaded = new PostgresStore(db);
  await reloaded.load();
  const board = new Lobby({ store: reloaded }).leaderboard();
  // Nach Wertung sortiert, und wer noch nie gespielt hat, steht nicht drin.
  assert.deepEqual(board.map(p => p.name), ['Spieler b', 'Spieler a']);
});
