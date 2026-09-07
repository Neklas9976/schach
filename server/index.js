/**
 * Der Spielserver: WebSocket-Verbindungen, Nachrichten, Zeitgeber.
 *
 * Hier steht nur die Verdrahtung. Was eine Partie darf, entscheidet game.js,
 * wer gegen wen spielt, entscheidet lobby.js - beide ohne Netzwerk und deshalb
 * ohne zwei Browser pruefbar. Diese Datei uebersetzt zwischen JSON-Nachrichten
 * und diesen beiden.
 *
 * Aufruf:
 *     node server/index.js
 * Umgebung:
 *     PORT            Port (Vorgabe 8787)
 *     DATA_FILE       Wo die Konten liegen (Vorgabe server/data/players.json)
 *     ALLOWED_ORIGINS Kommaliste erlaubter Herkuenfte; leer heisst alle
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { Lobby } from './lobby.js';
import { FileStore } from './store.js';
import { TIME_CONTROLS } from './game.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const DATA_FILE = process.env.DATA_FILE || path.join(HERE, 'data', 'players.json');
const ALLOWED = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

/** Wie lange eine unterbrochene Partie auf den Spieler wartet. */
const RECONNECT_GRACE_MS = 60_000;
/** Wie oft Uhren geprueft werden. Feiner als die kleinste sinnvolle Anzeige. */
const TICK_MS = 250;
/** Grenze fuer eine einzelne Nachricht - ein Zug ist ein paar Byte gross. */
const MAX_MESSAGE_BYTES = 4_096;

const store = new FileStore(DATA_FILE);
const lobby = new Lobby({ store });

/** playerId -> WebSocket */
const sockets = new Map();
/** playerId -> Zeitgeber, der die Partie nach zu langer Abwesenheit beendet */
const abandonTimers = new Map();

/* ===================================================================== *
 * Nachrichten
 * ===================================================================== */

function send(socket, message) {
  if (!socket || socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(message));
}

function sendTo(playerId, message) {
  send(sockets.get(playerId), message);
}

function fail(socket, reason) {
  send(socket, { t: 'error', message: reason });
}

/** Beiden Spielern einer Partie dasselbe schicken. */
function broadcast(game, message) {
  sendTo(game.white.id, message);
  sendTo(game.black.id, message);
}

function lobbyStatus() {
  return {
    t: 'lobby',
    waiting: lobby.queueSize(),
    playing: [...lobby.games.values()].filter(g => g.status === 'active').length,
    online: sockets.size
  };
}

function broadcastLobby() {
  const message = lobbyStatus();
  for (const socket of sockets.values()) send(socket, message);
}

/**
 * Beendet eine Partie fuer beide Seiten und bucht die Wertung.
 *
 * An einer Stelle, weil eine Partie auf fuenf Wegen endet und die Buchung
 * ueberall dieselbe ist - und weil sie sich genau einmal ereignen darf.
 */
function concludeGame(game) {
  const ratings = lobby.settle(game);
  broadcast(game, {
    t: 'gameOver',
    gameId: game.id,
    result: game.result,
    ratings,
    clock: game.clockView(Date.now())
  });
  broadcastLobby();
}

/* ===================================================================== *
 * Eingehende Nachrichten
 * ===================================================================== */

const handlers = {
  hello(socket, data) {
    const player = lobby.authenticate(data.token, data.name);
    // Ein zweiter Tab desselben Kontos verdraengt den ersten. Zwei offene
    // Verbindungen fuer einen Spieler hiessen, dass Zuege je nach Zufall in
    // einem der beiden Fenster landen.
    const previous = sockets.get(player.id);
    if (previous && previous !== socket) {
      send(previous, { t: 'replaced', message: 'Du hast die Seite woanders geöffnet.' });
      previous.close(4001, 'replaced');
    }
    socket.playerId = player.id;
    sockets.set(player.id, socket);

    const timer = abandonTimers.get(player.id);
    if (timer) { clearTimeout(timer); abandonTimers.delete(player.id); }

    const game = lobby.gameOf(player.id);
    send(socket, {
      t: 'welcome',
      player: publicSelf(player),
      token: player.token,
      controls: TIME_CONTROLS,
      // Eine laufende Partie wird beim Verbinden mitgeliefert: wer die Seite
      // neu laedt, soll weiterspielen und nicht verlieren.
      game: game ? game.view(Date.now()) : null
    });
    send(socket, lobbyStatus());
    if (game) {
      const opponent = game.opponentOf(player.id);
      if (opponent) sendTo(opponent.id, { t: 'opponentBack', gameId: game.id });
    }
    broadcastLobby();
  },

  rename(socket, data) {
    const player = store.byId(socket.playerId);
    if (!player) return;
    lobby.authenticate(player.token, data.name);
    send(socket, { t: 'player', player: publicSelf(store.byId(player.id)) });
  },

  seek(socket, data) {
    const result = lobby.seek(socket.playerId, data.control);
    if (!result.ok) return fail(socket, result.reason);
    if (result.game) {
      const now = Date.now();
      broadcast(result.game, { t: 'gameStart', game: result.game.view(now) });
    } else {
      send(socket, { t: 'seeking', control: data.control, waiting: result.waiting });
    }
    broadcastLobby();
  },

  cancelSeek(socket) {
    lobby.cancelSeek(socket.playerId);
    send(socket, { t: 'seekCancelled' });
    broadcastLobby();
  },

  move(socket, data) {
    const game = lobby.gameOf(socket.playerId);
    if (!game || game.id !== data.gameId) return fail(socket, 'Diese Partie läuft nicht.');
    const now = Date.now();
    const result = game.play(socket.playerId, data.uci, now);
    if (!result.ok) {
      // Der Zug wurde abgelehnt. Der Client bekommt die gueltige Stellung
      // zurueck, damit sein Brett nicht auseinanderlaeuft.
      fail(socket, result.reason);
      send(socket, { t: 'sync', game: game.view(now) });
      if (result.over) concludeGame(game);
      return;
    }
    broadcast(game, {
      t: 'move',
      gameId: game.id,
      uci: result.uci,
      san: result.san,
      fen: game.view(now).fen,
      clock: game.clockView(now),
      moveNumber: game.moves.length
    });
    if (game.status === 'finished') concludeGame(game);
  },

  resign(socket, data) {
    const game = lobby.gameOf(socket.playerId);
    if (!game || game.id !== data.gameId) return;
    if (game.resign(socket.playerId, Date.now())) concludeGame(game);
  },

  drawOffer(socket, data) {
    const game = lobby.gameOf(socket.playerId);
    if (!game || game.id !== data.gameId) return;
    const result = game.offerDraw(socket.playerId);
    if (!result.ok) return fail(socket, result.reason);
    broadcast(game, { t: 'drawOffered', gameId: game.id, from: result.from });
  },

  drawAnswer(socket, data) {
    const game = lobby.gameOf(socket.playerId);
    if (!game || game.id !== data.gameId) return;
    const result = game.answerDraw(socket.playerId, !!data.accept, Date.now());
    if (!result.ok) return fail(socket, result.reason);
    if (result.accepted) concludeGame(game);
    else broadcast(game, { t: 'drawDeclined', gameId: game.id });
  },

  sync(socket, data) {
    const game = lobby.gameOf(socket.playerId);
    if (!game || game.id !== data.gameId) return;
    send(socket, { t: 'sync', game: game.view(Date.now()) });
  },

  leaderboard(socket) {
    send(socket, { t: 'leaderboard', players: lobby.leaderboard(20) });
  },

  ping(socket) { send(socket, { t: 'pong' }); }
};

function publicSelf(player) {
  return {
    id: player.id, name: player.name, rating: player.rating,
    games: player.games || 0, wins: player.wins || 0,
    losses: player.losses || 0, draws: player.draws || 0
  };
}

/* ===================================================================== *
 * Server
 * ===================================================================== */

const server = http.createServer((request, response) => {
  // Ein einfacher Gesundheitscheck: die Hoster fragen ihn ab, und man sieht
  // von aussen, ob der Server ueberhaupt laeuft.
  if (request.url === '/health' || request.url === '/') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({
      ok: true,
      online: sockets.size,
      waiting: lobby.queueSize(),
      games: [...lobby.games.values()].filter(g => g.status === 'active').length
    }));
    return;
  }
  response.writeHead(404).end();
});

const wss = new WebSocketServer({
  server,
  maxPayload: MAX_MESSAGE_BYTES,
  verifyClient({ origin }, done) {
    if (!ALLOWED.length) return done(true);
    done(ALLOWED.includes(origin));
  }
});

wss.on('connection', socket => {
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });

  socket.on('message', raw => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return fail(socket, 'Unlesbare Nachricht.');
    }
    if (!data || typeof data.t !== 'string') return fail(socket, 'Nachricht ohne Typ.');
    // Alles ausser der Anmeldung setzt voraus, dass der Absender bekannt ist.
    if (data.t !== 'hello' && !socket.playerId) return fail(socket, 'Erst anmelden.');
    const handler = handlers[data.t];
    if (!handler) return fail(socket, `Unbekannt: ${data.t}`);
    try {
      handler(socket, data);
    } catch (error) {
      // Ein Fehler in einer Nachricht darf nicht den ganzen Server mitnehmen.
      console.error(`Fehler bei ${data.t}:`, error);
      fail(socket, 'Da ist beim Server etwas schiefgegangen.');
    }
  });

  socket.on('close', () => {
    const playerId = socket.playerId;
    if (!playerId) return;
    if (sockets.get(playerId) === socket) sockets.delete(playerId);
    lobby.cancelSeek(playerId);

    const game = lobby.gameOf(playerId);
    if (game && game.status === 'active') {
      const opponent = game.opponentOf(playerId);
      if (opponent) sendTo(opponent.id, { t: 'opponentGone', gameId: game.id, graceMs: RECONNECT_GRACE_MS });
      // Nicht sofort verloren: ein Netzwechsel oder ein Neuladen dauert
      // Sekunden. Erst wenn niemand zurueckkommt, ist die Partie verlassen.
      const timer = setTimeout(() => {
        abandonTimers.delete(playerId);
        if (sockets.has(playerId)) return;
        const still = lobby.gameOf(playerId);
        if (still && still.status === 'active' && still.abandon(playerId, Date.now())) {
          concludeGame(still);
        }
      }, RECONNECT_GRACE_MS);
      if (typeof timer.unref === 'function') timer.unref();
      abandonTimers.set(playerId, timer);
    }
    broadcastLobby();
  });
});

/** Uhren pruefen. Eine abgelaufene Uhr beendet die Partie auch ohne Zug. */
const tick = setInterval(() => {
  for (const game of lobby.sweep(Date.now())) concludeGame(game);
}, TICK_MS);
if (typeof tick.unref === 'function') tick.unref();

/** Tote Verbindungen erkennen, die sich nicht ordentlich verabschiedet haben. */
const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) { socket.terminate(); continue; }
    socket.isAlive = false;
    socket.ping();
  }
}, 30_000);
if (typeof heartbeat.unref === 'function') heartbeat.unref();

function shutdown() {
  console.log('Server wird beendet, Konten werden gesichert …');
  clearInterval(tick);
  clearInterval(heartbeat);
  store.close();
  wss.close();
  server.close(() => process.exit(0));
  // Falls eine Verbindung nicht loslaesst.
  setTimeout(() => process.exit(0), 3_000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  console.log(`Schachserver auf Port ${PORT}`);
  console.log(`Konten: ${DATA_FILE} (${store.all().length} vorhanden)`);
  console.log(ALLOWED.length ? `Erlaubte Herkunft: ${ALLOWED.join(', ')}` : 'Alle Herkuenfte erlaubt');
});
