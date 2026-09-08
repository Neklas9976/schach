/**
 * Spielerkonten in einer Postgres-Datenbank.
 *
 * Warum ueberhaupt: bei Render und aehnlichen Anbietern ist das Dateisystem
 * fluechtig. Jede neue Version des Servers startet mit leerer Platte, und
 * damit waeren alle Wertungen weg - beim ersten Ausrollen ist genau das
 * passiert. Eine Datenbank liegt ausserhalb und ueberlebt das.
 *
 * Warum trotzdem alles im Arbeitsspeicher: die Lobby fragt Konten *synchron*
 * ab, mitten in der Bearbeitung einer Nachricht. Das auf await umzustellen
 * hiesse, lobby.js, game.js und index.js anzufassen - fuer Daten, die selbst
 * bei zehntausend Spielern nur wenige Megabyte sind. Stattdessen wird beim
 * Start einmal alles geladen und jede Aenderung nach hinten durchgeschrieben.
 * Dieselbe Bauart wie FileStore, nur mit einem anderen Ziel.
 *
 * Die Folge, die man kennen muss: es darf genau *eine* Serverinstanz laufen.
 * Zwei wuerden sich gegenseitig ueberschreiben. Fuer eine Schachseite dieser
 * Groesse ist das kein Problem - der Gratis- wie der Starter-Tarif von Render
 * betreiben ohnehin nur eine.
 */

import { MemoryStore } from './store.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  id         text PRIMARY KEY,
  token      text UNIQUE NOT NULL,
  name       text NOT NULL,
  rating     integer NOT NULL DEFAULT 1200,
  games      integer NOT NULL DEFAULT 0,
  wins       integer NOT NULL DEFAULT 0,
  losses     integer NOT NULL DEFAULT 0,
  draws      integer NOT NULL DEFAULT 0,
  created_at bigint  NOT NULL
);
CREATE INDEX IF NOT EXISTS players_rating_idx ON players (rating DESC);
`;

const UPSERT = `
INSERT INTO players (id, token, name, rating, games, wins, losses, draws, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (id) DO UPDATE SET
  token = EXCLUDED.token, name = EXCLUDED.name, rating = EXCLUDED.rating,
  games = EXCLUDED.games, wins = EXCLUDED.wins, losses = EXCLUDED.losses,
  draws = EXCLUDED.draws
`;

export class PostgresStore extends MemoryStore {
  /**
   * @param {object} client  etwas mit query(text, values) - im Betrieb ein
   *                         pg.Pool, in den Tests eine Attrappe.
   * @param {object} [options]
   * @param {number} [options.writeDelay]  Sammelzeit vor dem Schreiben
   */
  constructor(client, { writeDelay = 1_000 } = {}) {
    super();
    this.client = client;
    this.writeDelay = writeDelay;
    this.dirty = new Set();
    this.timer = null;
    /** Laeuft gerade ein Schreibvorgang? Zwei parallel waeren ein Rennen. */
    this.writing = null;
  }

  /** Schema anlegen und alles laden. Muss vor dem ersten Zugriff fertig sein. */
  async load() {
    await this.client.query(SCHEMA);
    const result = await this.client.query(
      'SELECT id, token, name, rating, games, wins, losses, draws, created_at FROM players'
    );
    for (const row of result.rows) {
      super.insert({
        id: row.id,
        token: row.token,
        name: row.name,
        rating: Number(row.rating),
        games: Number(row.games),
        wins: Number(row.wins),
        losses: Number(row.losses),
        draws: Number(row.draws),
        createdAt: Number(row.created_at)
      });
    }
    return this.all().length;
  }

  /**
   * Uebernimmt Konten aus einer frueheren Dateiablage.
   *
   * Einmalig beim Umstieg: wer schon gespielt hat, soll seine Wertung
   * behalten. Vorhandene Konten werden nicht angeruehrt - die Datenbank ist
   * ab jetzt massgeblich.
   */
  async importAll(players) {
    let added = 0;
    for (const player of players) {
      if (!player || !player.id || !player.token) continue;
      if (this.byId(player.id) || this.byToken(player.token)) continue;
      super.insert(player);
      this.dirty.add(player.id);
      added += 1;
    }
    if (added) await this.flush();
    return added;
  }

  create(player) {
    const created = super.create(player);
    this.dirty.add(created.id);
    this.touch();
    return created;
  }

  update(id, patch) {
    const player = super.update(id, patch);
    if (player) { this.dirty.add(id); this.touch(); }
    return player;
  }

  touch() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.writeDelay);
    // Ein wartender Schreibvorgang darf den Prozess nicht am Beenden hindern;
    // beim Herunterfahren wird ohnehin einmal von Hand geschrieben.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  async flush() {
    // Ein zweiter Aufruf waehrend eines laufenden Schreibvorgangs haengt sich
    // hinten an, statt parallel dieselben Zeilen zu schreiben.
    if (this.writing) return this.writing.then(() => this.flush());
    if (!this.dirty.size) return;

    const ids = [...this.dirty];
    this.dirty.clear();
    this.writing = (async () => {
      for (const id of ids) {
        const p = this.byId(id);
        if (!p) continue;
        try {
          await this.client.query(UPSERT, [
            p.id, p.token, p.name, p.rating,
            p.games || 0, p.wins || 0, p.losses || 0, p.draws || 0,
            p.createdAt || Date.now()
          ]);
        } catch (error) {
          // Nicht verlieren: beim naechsten Mal noch einmal versuchen. Ein
          // stillschweigend verschluckter Schreibfehler waere eine Wertung,
          // die im Browser steht und in der Datenbank nicht.
          this.dirty.add(id);
          console.error(`Konto ${id} nicht gespeichert: ${error.message}`);
        }
      }
    })();

    try {
      await this.writing;
    } finally {
      this.writing = null;
    }
  }

  async close() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.flush();
    if (typeof this.client.end === 'function') await this.client.end();
  }
}

/**
 * Baut die Verbindung auf, wie der jeweilige Anbieter sie braucht.
 *
 * Neon, Supabase und die meisten anderen benutzen Zertifikate einer
 * oeffentlichen Stelle - die werden geprueft. Renders interne Datenbank
 * benutzt ein selbst ausgestelltes; dafuer gibt es DATABASE_SSL_INSECURE.
 * Das steht bewusst nicht als Vorgabe drin: die Pruefung stillschweigend
 * abzuschalten ist genau die Art Abkuerzung, die man spaeter bereut.
 */
export async function connectPostgres(url, { insecure = false } = {}) {
  const { default: pg } = await import('pg');
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    ssl: local ? false : (insecure ? { rejectUnauthorized: false } : true),
    max: 4,
    idleTimeoutMillis: 30_000
  });
  // Einmal anfassen, damit ein falscher Zugang beim Start auffaellt und nicht
  // erst, wenn sich der erste Spieler anmeldet.
  await pool.query('SELECT 1');
  return pool;
}
