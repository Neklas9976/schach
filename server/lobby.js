/**
 * Spielersuche, Spielerkonten und Wertungen.
 *
 * Wie game.js ohne Netzwerk: die Lobby bekommt gesagt, wer sich meldet und
 * wann, und sagt zurueck, wer gegen wen spielt. Was daraus an Nachrichten
 * wird, entscheidet index.js.
 */

import { randomUUID, randomBytes } from 'node:crypto';
import { Game, findControl } from './game.js';

export const START_RATING = 1200;

/**
 * Wie weit die Wertungen auseinanderliegen duerfen, je nach Wartezeit.
 *
 * Am Anfang eng, damit die Paarung passt; nach einer halben Minute egal,
 * damit auf einer kleinen Seite ueberhaupt jemand ein Spiel bekommt. Ohne das
 * Nachgeben wartet man abends allein in der Lobby, weil der einzige andere
 * Spieler 300 Punkte entfernt ist.
 */
export function ratingTolerance(waitedMs) {
  if (waitedMs < 5_000) return 150;
  if (waitedMs < 15_000) return 300;
  if (waitedMs < 30_000) return 600;
  return Infinity;
}

/**
 * Elo-Anpassung nach einer Partie.
 *
 * Der K-Faktor faellt mit der Erfahrung: die ersten Partien sollen die Wertung
 * schnell dorthin bringen, wo sie hingehoert, danach soll sie ruhig liegen.
 */
export function kFactor(gamesPlayed, rating) {
  if (gamesPlayed < 20) return 40;
  if (rating >= 2400) return 16;
  return 24;
}

export function nextRatings(white, black, winner) {
  const score = winner === 'white' ? 1 : winner === 'black' ? 0 : 0.5;
  const expectedWhite = 1 / (1 + Math.pow(10, (black.rating - white.rating) / 400));
  const kw = kFactor(white.games || 0, white.rating);
  const kb = kFactor(black.games || 0, black.rating);
  return {
    white: clampRating(white.rating + kw * (score - expectedWhite)),
    black: clampRating(black.rating + kb * ((1 - score) - (1 - expectedWhite)))
  };
}

function clampRating(value) {
  return Math.max(100, Math.min(3000, Math.round(value)));
}

/** Namen sind oeffentlich, also werden sie hier beschnitten, nicht im Browser. */
export function cleanName(raw) {
  const text = String(raw == null ? '' : raw)
    // Steuerzeichen und Zeilenumbrueche wuerden die Anzeige zerreissen.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    // Unsichtbare Zeichen: Nullbreiten-Leerzeichen und Richtungssteuerung.
    // Damit liessen sich sonst zwei Konten anlegen, die auf dem Schirm gleich
    // aussehen - der uebliche Weg, sich fuer jemand anderen auszugeben.
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
  return text || `Gast-${randomBytes(2).toString('hex')}`;
}

export class Lobby {
  /**
   * @param {object} options
   * @param {object} options.store  Spielerkonten, siehe store.js
   * @param {() => number} [options.now]
   * @param {(playerId: string) => boolean} [options.isPresent]
   */
  constructor({ store, now = Date.now, isPresent = () => true } = {}) {
    this.store = store;
    this.now = now;
    // Ob ein Spieler ueberhaupt noch erreichbar ist. Die Lobby weiss nichts
    // von Verbindungen - index.js reicht die Auskunft herein.
    this.isPresent = isPresent;
    /** controlId -> [{playerId, since}] */
    this.queues = new Map();
    /** gameId -> Game */
    this.games = new Map();
    /** playerId -> gameId, damit ein Wiederverbinden die Partie findet */
    this.playing = new Map();
  }

  /* --- Konten --------------------------------------------------------- */

  /**
   * Meldet einen Spieler an.
   *
   * Bewusst ohne Passwort: die Seite braucht keine Anmeldedaten, und wo keine
   * liegen, kann auch keine gestohlen werden. Der Server gibt beim ersten
   * Besuch ein Merkmal aus, das im Browser liegen bleibt. Wer es verliert,
   * faengt mit einem neuen Konto an - fuer eine Schachseite ist das der
   * richtige Tausch.
   */
  authenticate(token, name) {
    let player = token ? this.store.byToken(token) : null;
    if (!player) {
      player = this.store.create({
        id: randomUUID(),
        token: randomBytes(24).toString('base64url'),
        name: cleanName(name),
        rating: START_RATING,
        games: 0, wins: 0, losses: 0, draws: 0,
        createdAt: this.now()
      });
    } else if (name != null) {
      const wanted = cleanName(name);
      if (wanted !== player.name) this.store.update(player.id, { name: wanted });
    }
    return this.store.byId(player.id);
  }

  /* --- Spielersuche --------------------------------------------------- */

  seek(playerId, controlId) {
    const control = findControl(controlId);
    if (!control) return { ok: false, reason: 'Diese Bedenkzeit gibt es nicht.' };
    if (this.playing.has(playerId)) return { ok: false, reason: 'Du spielst bereits.' };

    // Ein Spieler steht in genau einer Warteschlange. Sonst liesse sich in
    // allen zugleich warten und man wuerde in zwei Partien zugleich gepaart.
    this.cancelSeek(playerId);

    const queue = this.queues.get(control.id) || [];
    const me = this.store.byId(playerId);
    if (!me) return { ok: false, reason: 'Unbekannter Spieler.' };

    const now = this.now();
    const partner = this.findPartner(queue, me, now);
    if (partner) {
      queue.splice(queue.indexOf(partner), 1);
      this.queues.set(control.id, queue);
      const game = this.startGame(this.store.byId(partner.playerId), me, control, now);
      return { ok: true, game };
    }

    queue.push({ playerId, since: now });
    this.queues.set(control.id, queue);
    return { ok: true, waiting: queue.length };
  }

  findPartner(queue, me, now) {
    // Wer nicht mehr da ist, wird zuerst aus der Schlange geworfen. Eine
    // abgerissene Verbindung faellt dem Server erst beim naechsten Herzschlag
    // auf - bis dahin wuerde man gegen einen Geist gepaart, der nie zieht, und
    // haette einen geschenkten Sieg nach Ablauf der Wartefrist.
    for (let i = queue.length - 1; i >= 0; i--) {
      if (!this.isPresent(queue[i].playerId)) queue.splice(i, 1);
    }

    let best = null;
    let bestGap = Infinity;
    for (const entry of queue) {
      if (entry.playerId === me.id) continue;
      const other = this.store.byId(entry.playerId);
      if (!other) continue;
      const gap = Math.abs(other.rating - me.rating);
      // Beide muessen einverstanden sein: der Wartende hat laenger gewartet
      // und ist toleranter, der Neue ist es noch nicht.
      if (gap > ratingTolerance(now - entry.since)) continue;
      if (gap > ratingTolerance(0)) continue;
      if (gap < bestGap) { best = entry; bestGap = gap; }
    }
    if (best) return best;
    // Zweiter Durchgang: wer lange genug wartet, nimmt jeden.
    for (const entry of queue) {
      if (entry.playerId === me.id) continue;
      if (!this.store.byId(entry.playerId)) continue;
      if (now - entry.since >= 30_000) return entry;
    }
    return null;
  }

  cancelSeek(playerId) {
    let removed = false;
    for (const [controlId, queue] of this.queues) {
      const index = queue.findIndex(e => e.playerId === playerId);
      if (index >= 0) { queue.splice(index, 1); removed = true; }
      if (!queue.length) this.queues.delete(controlId);
    }
    return removed;
  }

  queueSize() {
    let total = 0;
    for (const queue of this.queues.values()) total += queue.length;
    return total;
  }

  /* --- Partien -------------------------------------------------------- */

  startGame(a, b, control, now = this.now()) {
    // Die Farben werden gelost. Immer denselben zuerst weiss spielen zu
    // lassen waere ein dauerhafter Vorteil fuer eine Seite.
    const whiteFirst = Math.random() < 0.5;
    const white = whiteFirst ? a : b;
    const black = whiteFirst ? b : a;
    const game = new Game({
      id: randomUUID(),
      white: { id: white.id, name: white.name, rating: white.rating },
      black: { id: black.id, name: black.name, rating: black.rating },
      control,
      now
    });
    this.games.set(game.id, game);
    this.playing.set(white.id, game.id);
    this.playing.set(black.id, game.id);
    return game;
  }

  gameOf(playerId) {
    const id = this.playing.get(playerId);
    return id ? this.games.get(id) || null : null;
  }

  /**
   * Schreibt das Ergebnis in die Konten fort.
   *
   * Getrennt vom Beenden der Partie, weil eine Partie auf mehreren Wegen
   * endet - Matt, Aufgabe, Zeit, Einigung - und die Buchung ueberall dieselbe
   * ist. Zweimal buchen darf sie sich nicht, deshalb der Riegel.
   */
  settle(game) {
    if (!game || game.status !== 'finished' || game.settled) return null;
    game.settled = true;
    const white = this.store.byId(game.white.id);
    const black = this.store.byId(game.black.id);
    this.playing.delete(game.white.id);
    this.playing.delete(game.black.id);
    if (!white || !black) return null;

    const winner = game.result ? game.result.winner : null;
    const rated = nextRatings(white, black, winner);
    // Die alten Werte festhalten, bevor update() sie ueberschreibt: der Store
    // gibt dasselbe Objekt zurueck, das er aendert. Ohne diese Zeile meldet
    // der Server jedem Spieler "1200 -> 1200", egal wie die Partie ausging.
    const before = { white: white.rating, black: black.rating };
    const outcome = (player, color) => ({
      rating: rated[color],
      games: (player.games || 0) + 1,
      wins: (player.wins || 0) + (winner === color ? 1 : 0),
      losses: (player.losses || 0) + (winner && winner !== color ? 1 : 0),
      draws: (player.draws || 0) + (winner ? 0 : 1)
    });
    this.store.update(white.id, outcome(white, 'white'));
    this.store.update(black.id, outcome(black, 'black'));
    return {
      white: { before: before.white, after: rated.white },
      black: { before: before.black, after: rated.black }
    };
  }

  /** Abgelaufene Uhren und vergessene Partien einsammeln. */
  sweep(now = this.now()) {
    const finished = [];
    for (const game of this.games.values()) {
      if (game.status !== 'active') continue;
      const over = game.checkFlag(now);
      if (over) finished.push(game);
    }
    // Beendete Partien noch eine Weile aufheben: ein Spieler, der die Seite
    // neu laedt, soll das Ergebnis noch sehen.
    for (const [id, game] of this.games) {
      if (game.status === 'finished' && now - (game.finishedAt || 0) > 10 * 60_000) {
        this.games.delete(id);
      }
    }
    return finished;
  }

  leaderboard(limit = 20) {
    return this.store.all()
      .filter(p => (p.games || 0) > 0)
      .sort((a, b) => b.rating - a.rating || (a.name < b.name ? -1 : 1))
      .slice(0, limit)
      .map(p => ({ name: p.name, rating: p.rating, games: p.games, wins: p.wins, draws: p.draws, losses: p.losses }));
  }
}
