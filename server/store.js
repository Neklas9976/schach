/**
 * Die Spielerkonten.
 *
 * Eine JSON-Datei, keine Datenbank. Fuer eine Schachseite mit ein paar hundert
 * Konten ist das genau richtig: nichts zu betreiben, nichts zu sichern ausser
 * einer Datei, und man kann hineinschauen. Wenn daraus einmal Zehntausende
 * werden, ist der Austausch eine Datei - alles andere spricht nur mit diesem
 * Umriss hier.
 *
 * Geschrieben wird verzoegert und ueber eine Zwischendatei: ein Absturz mitten
 * im Schreiben soll nicht die halbe Datei hinterlassen und damit alle Konten
 * kosten.
 */

import fs from 'node:fs';
import path from 'node:path';

export class MemoryStore {
  constructor(players = []) {
    this.players = new Map();
    this.tokens = new Map();
    for (const player of players) this.insert(player);
  }

  insert(player) {
    this.players.set(player.id, player);
    if (player.token) this.tokens.set(player.token, player.id);
    return player;
  }

  create(player) { return this.insert(player); }

  byId(id) { return this.players.get(id) || null; }

  byToken(token) {
    const id = this.tokens.get(token);
    return id ? this.players.get(id) || null : null;
  }

  update(id, patch) {
    const player = this.players.get(id);
    if (!player) return null;
    Object.assign(player, patch);
    this.touch();
    return player;
  }

  all() { return [...this.players.values()]; }

  touch() { /* nichts zu tun */ }
}

export class FileStore extends MemoryStore {
  constructor(file, { writeDelay = 2_000 } = {}) {
    super();
    this.file = file;
    this.writeDelay = writeDelay;
    this.timer = null;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      for (const player of JSON.parse(raw)) this.insert(player);
    } catch (error) {
      // Beim ersten Start gibt es die Datei noch nicht - das ist kein Fehler.
      if (error.code !== 'ENOENT') {
        console.error(`Konten nicht lesbar (${this.file}): ${error.message}`);
      }
    }
  }

  create(player) {
    const created = super.create(player);
    this.touch();
    return created;
  }

  touch() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.writeDelay);
    // Ein wartender Schreibvorgang darf den Serverprozess nicht am Beenden
    // hindern; beim Herunterfahren wird ohnehin einmal von Hand geschrieben.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  flush() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(this.all(), null, 1), 'utf8');
      // Umbenennen ist atomar: entweder die alte Datei oder die neue, nie eine
      // halbe.
      fs.renameSync(temporary, this.file);
    } catch (error) {
      console.error(`Konten nicht schreibbar (${this.file}): ${error.message}`);
    }
  }

  close() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.flush();
  }
}
