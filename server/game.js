/**
 * Eine Online-Partie, wie der Server sie fuehrt.
 *
 * Kein Netzwerk, keine Sockets, kein Zeitgeber: diese Datei bekommt Zuege und
 * einen Zeitstempel und sagt, was daraus folgt. Alles, was schiefgehen kann -
 * ein illegaler Zug, ein Zug der falschen Seite, eine abgelaufene Uhr, ein
 * Remisangebot zur Unzeit - entscheidet sich hier und laesst sich deshalb ohne
 * zwei Browser und eine Netzverbindung pruefen.
 */

import { ChessEngine, resolveUci, toUci } from './rules.js';

/** Dieselben Bedenkzeiten wie im Browser (static/clock.js). */
export const TIME_CONTROLS = [
  { id: '1+0', label: '1 + 0', category: 'Bullet', base: 60_000, increment: 0 },
  { id: '2+1', label: '2 + 1', category: 'Bullet', base: 120_000, increment: 1_000 },
  { id: '3+0', label: '3 + 0', category: 'Blitz', base: 180_000, increment: 0 },
  { id: '3+2', label: '3 + 2', category: 'Blitz', base: 180_000, increment: 2_000 },
  { id: '5+0', label: '5 + 0', category: 'Blitz', base: 300_000, increment: 0 },
  { id: '5+3', label: '5 + 3', category: 'Blitz', base: 300_000, increment: 3_000 },
  { id: '10+0', label: '10 + 0', category: 'Rapid', base: 600_000, increment: 0 },
  { id: '10+5', label: '10 + 5', category: 'Rapid', base: 600_000, increment: 5_000 },
  { id: '15+10', label: '15 + 10', category: 'Rapid', base: 900_000, increment: 10_000 },
  { id: '30+0', label: '30 + 0', category: 'Classical', base: 1_800_000, increment: 0 }
];

export function findControl(id) {
  return TIME_CONTROLS.find(c => c.id === id) || null;
}

const ENDINGS = ['checkmate', 'stalemate', 'fifty-move', 'threefold', 'insufficient-material'];

export class Game {
  /**
   * @param {object} options
   * @param {string} options.id
   * @param {object} options.white  {id, name, rating}
   * @param {object} options.black
   * @param {object} options.control  aus TIME_CONTROLS
   * @param {number} options.now  Zeitstempel in ms
   */
  constructor({ id, white, black, control, now }) {
    this.id = id;
    this.white = white;
    this.black = black;
    this.control = control;
    this.state = ChessEngine.createInitialState();
    this.startingFen = ChessEngine.toFen(this.state);
    this.moves = [];
    this.repetition = { [ChessEngine.fenKey(this.state)]: 1 };
    this.remaining = { white: control.base, black: control.base };
    // Ab wann die Uhr des Ziehenden laeuft. Die erste Zeitmessung beginnt mit
    // dem ersten Zug, nicht mit dem Partiestart - sonst verliert, wer beim
    // Verbinden langsamer war.
    this.turnStartedAt = now;
    this.startedAt = now;
    this.status = 'active';
    this.result = null;
    this.drawOfferFrom = null;
    this.lastActivityAt = now;
  }

  colorOf(playerId) {
    if (this.white.id === playerId) return 'white';
    if (this.black.id === playerId) return 'black';
    return null;
  }

  opponentOf(playerId) {
    const color = this.colorOf(playerId);
    if (!color) return null;
    return color === 'white' ? this.black : this.white;
  }

  /** Wie viel Zeit die Seite am Zug jetzt noch haette. */
  remainingAt(color, now) {
    if (this.status !== 'active') return this.remaining[color];
    if (color !== this.state.turn) return this.remaining[color];
    // Vor dem ersten Zug laeuft keine Uhr - sonst verliert, wer beim Verbinden
    // langsamer war, Zeit fuer nichts.
    if (this.moves.length === 0) return this.remaining[color];
    return this.remaining[color] - (now - this.turnStartedAt);
  }

  clockView(now) {
    return {
      white: Math.max(0, Math.round(this.remainingAt('white', now))),
      black: Math.max(0, Math.round(this.remainingAt('black', now))),
      turn: this.state.turn,
      running: this.status === 'active' && this.moves.length > 0
    };
  }

  /**
   * Spielt einen Zug, wenn er zulaessig ist.
   *
   * Gibt `{ok:false, reason}` zurueck statt zu werfen: ein Client, der Unsinn
   * schickt, ist der Normalfall und kein Ausnahmezustand.
   */
  play(playerId, uci, now) {
    if (this.status !== 'active') return { ok: false, reason: 'Die Partie ist beendet.' };
    const color = this.colorOf(playerId);
    if (!color) return { ok: false, reason: 'Du spielst diese Partie nicht.' };
    if (color !== this.state.turn) return { ok: false, reason: 'Du bist nicht am Zug.' };

    // Die Uhr zuerst. Wer seinen Zug abschickt, nachdem die Zeit abgelaufen
    // ist, hat verloren - auch wenn der Zug ein Matt gewesen waere.
    const flag = this.checkFlag(now);
    if (flag) return { ok: false, reason: 'Die Zeit ist abgelaufen.', over: flag };

    const move = resolveUci(this.state, uci);
    if (!move) return { ok: false, reason: `Kein legaler Zug: ${uci}` };

    const before = this.state;
    const next = ChessEngine.applyMove(before, move);
    const key = ChessEngine.fenKey(next);
    this.repetition[key] = (this.repetition[key] || 0) + 1;
    const san = ChessEngine.sanForMove(before, move, next, this.repetition);
    this.state = next;

    // Der Fischer-Zuschlag gilt nur fuer tatsaechlich gespielte Zuege, und die
    // Zeit lief erst ab dem ersten Zug.
    if (this.moves.length > 0) {
      this.remaining[color] -= (now - this.turnStartedAt);
    }
    this.remaining[color] += this.control.increment;
    this.turnStartedAt = now;
    this.lastActivityAt = now;

    this.moves.push({ uci: toUci(move), san, at: now });
    // Ein Remisangebot gilt fuer den einen Zug, auf den es sich bezieht.
    this.drawOfferFrom = null;

    const status = ChessEngine.status(this.state, this.repetition);
    if (ENDINGS.includes(status.type)) {
      this.finish(status.type === 'checkmate'
        ? { winner: status.winner, reason: 'checkmate' }
        : { winner: null, reason: status.type }, now);
    }
    return { ok: true, uci: toUci(move), san, status };
  }

  /** Prueft, ob die Uhr der Seite am Zug abgelaufen ist, und beendet dann. */
  checkFlag(now) {
    if (this.status !== 'active') return null;
    // Vor dem ersten Zug laeuft keine Uhr.
    if (this.moves.length === 0) return null;
    const color = this.state.turn;
    if (this.remainingAt(color, now) > 0) return null;

    this.remaining[color] = 0;
    const winner = color === 'white' ? 'black' : 'white';
    // Wer nicht mattsetzen koennte, gewinnt auch nicht auf Zeit - das ist die
    // Regel, und ohne sie waere ein blanker Koenig ein Gewinn.
    const opponentBoard = { ...this.state, turn: winner };
    const canWin = !insufficientToMate(opponentBoard, winner);
    return this.finish(canWin
      ? { winner, reason: 'timeout' }
      : { winner: null, reason: 'timeout-insufficient' }, now);
  }

  resign(playerId, now) {
    if (this.status !== 'active') return null;
    const color = this.colorOf(playerId);
    if (!color) return null;
    return this.finish({ winner: color === 'white' ? 'black' : 'white', reason: 'resign' }, now);
  }

  /** Der Gegner hat die Verbindung endgueltig verloren. */
  abandon(playerId, now) {
    if (this.status !== 'active') return null;
    const color = this.colorOf(playerId);
    if (!color) return null;
    return this.finish({ winner: color === 'white' ? 'black' : 'white', reason: 'abandoned' }, now);
  }

  offerDraw(playerId) {
    if (this.status !== 'active') return { ok: false, reason: 'Die Partie ist beendet.' };
    const color = this.colorOf(playerId);
    if (!color) return { ok: false, reason: 'Du spielst diese Partie nicht.' };
    if (this.drawOfferFrom === color) return { ok: false, reason: 'Angebot steht bereits.' };
    this.drawOfferFrom = color;
    return { ok: true, from: color };
  }

  answerDraw(playerId, accept, now) {
    const color = this.colorOf(playerId);
    if (!color) return { ok: false, reason: 'Du spielst diese Partie nicht.' };
    if (!this.drawOfferFrom) return { ok: false, reason: 'Es steht kein Angebot.' };
    // Sein eigenes Angebot anzunehmen waere ein Remis auf Zuruf.
    if (this.drawOfferFrom === color) return { ok: false, reason: 'Das ist dein eigenes Angebot.' };
    this.drawOfferFrom = null;
    if (!accept) return { ok: true, accepted: false };
    return { ok: true, accepted: true, over: this.finish({ winner: null, reason: 'agreement' }, now) };
  }

  finish(result, now) {
    if (this.status !== 'active') return this.result;
    // Die Restzeit der Seite am Zug einfrieren, sonst laeuft sie in der
    // Anzeige weiter, obwohl die Partie vorbei ist.
    if (this.moves.length > 0) {
      const color = this.state.turn;
      this.remaining[color] = Math.max(0, this.remainingAt(color, now));
    }
    this.status = 'finished';
    this.finishedAt = now;
    this.result = { ...result, at: now };
    return this.result;
  }

  /** Was ein Client ueber die Partie wissen muss. */
  view(now) {
    return {
      id: this.id,
      white: publicPlayer(this.white),
      black: publicPlayer(this.black),
      control: this.control,
      startingFen: this.startingFen,
      moves: this.moves.map(m => ({ uci: m.uci, san: m.san })),
      fen: ChessEngine.toFen(this.state),
      turn: this.state.turn,
      clock: this.clockView(now),
      status: this.status,
      result: this.result,
      drawOfferFrom: this.drawOfferFrom
    };
  }
}

function publicPlayer(player) {
  return { id: player.id, name: player.name, rating: player.rating };
}

/**
 * Kann diese Seite ueberhaupt noch mattsetzen?
 *
 * Nur fuer die Zeitueberschreitung gebraucht. ChessEngine.insufficientMaterial
 * fragt nach beiden Seiten zusammen; hier geht es um eine einzelne.
 */
function insufficientToMate(state, color) {
  let pieces = [];
  for (const row of state.board) {
    for (const piece of row) {
      if (!piece) continue;
      if (ChessEngine.colorOf(piece) !== color) continue;
      const type = ChessEngine.typeOf(piece);
      if (type !== 'k') pieces.push(type);
    }
  }
  if (pieces.length === 0) return true;
  if (pieces.length === 1 && (pieces[0] === 'n' || pieces[0] === 'b')) return true;
  // Zwei Springer koennen ein Matt nicht erzwingen, aber es ist mit Hilfe des
  // Gegners moeglich - nach den FIDE-Regeln zaehlt genau das, also gewinnt man
  // damit auf Zeit.
  return false;
}
