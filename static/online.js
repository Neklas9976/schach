/**
 * Die Verbindung zum Spielserver.
 *
 * Hier steht das Sprechen mit dem Server und sonst nichts: keine Figuren, kein
 * Brett, keine Knoepfe. Was aus einer Nachricht auf dem Schirm wird,
 * entscheidet app.js. Dadurch laesst sich der ganze Ablauf - verbinden,
 * abreissen, wiederverbinden, Nachrichten in falscher Reihenfolge - pruefen,
 * ohne einen Browser zu starten.
 *
 * Der Server steht woanders als die Seite: die Seite liegt auf GitHub Pages,
 * der Server bei einem Hoster mit laufendem Prozess. Deshalb muss seine
 * Adresse konfigurierbar sein.
 */
(function () {
  'use strict';

  const global = typeof window !== 'undefined' ? window : globalThis;

  const URL_KEY = 'chess-server-url';
  const TOKEN_KEY = 'chess-online-token';
  const NAME_KEY = 'chess-online-name';

  /** Wartezeiten vor dem naechsten Versuch, in ms. Danach bleibt es dabei. */
  const BACKOFF = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

  let socket = null;
  let attempt = 0;
  let reconnectTimer = null;
  /** Vom Anwender ausgeloestes Trennen - dann wird nicht wieder verbunden. */
  let deliberate = false;
  let player = null;
  let game = null;
  let lobby = { online: 0, waiting: 0, playing: 0 };
  let controls = [];
  let seeking = null;
  const listeners = new Map();

  /* --- Einstellungen ---------------------------------------------------- */

  function readLocal(key, fallback = null) {
    try {
      const raw = global.localStorage && global.localStorage.getItem(key);
      return raw == null ? fallback : raw;
    } catch { return fallback; }
  }

  function writeLocal(key, value) {
    try {
      if (value == null) global.localStorage?.removeItem(key);
      else global.localStorage?.setItem(key, value);
    } catch { /* privater Modus: dann merkt sich der Browser eben nichts */ }
  }

  /**
   * Wohin verbunden wird.
   *
   * Reihenfolge: was der Anwender eingetragen hat, sonst was mitgeliefert
   * wurde, sonst - beim Entwickeln auf dem eigenen Rechner - der Server auf
   * Port 8787 daneben. Letzteres spart beim lokalen Ausprobieren jede
   * Einstellung.
   */
  function serverUrl() {
    const stored = readLocal(URL_KEY);
    if (stored) return stored;
    if (global.CHESS_SERVER_URL) return global.CHESS_SERVER_URL;
    const host = global.location && global.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') {
      return `ws://${host}:8787`;
    }
    return '';
  }

  function setServerUrl(url) {
    const text = String(url || '').trim().replace(/\/+$/, '');
    writeLocal(URL_KEY, text || null);
    return serverUrl();
  }

  function playerName() { return readLocal(NAME_KEY, ''); }
  function setPlayerName(name) {
    writeLocal(NAME_KEY, name || null);
    if (isConnected()) send({ t: 'rename', name });
  }

  /* --- Ereignisse ------------------------------------------------------- */

  function on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
    return () => listeners.get(event)?.delete(handler);
  }

  function emit(event, payload) {
    for (const handler of listeners.get(event) || []) {
      try {
        handler(payload);
      } catch (error) {
        // Ein Fehler in einer Anzeige darf die Verbindung nicht mitreissen.
        console.error(`Fehler im Empfänger für "${event}":`, error);
      }
    }
  }

  /* --- Verbindung ------------------------------------------------------- */

  function status() {
    // Ohne eingetragenen Server ist "nicht verbunden" irrefuehrend: da wartet
    // nichts, da fehlt etwas. Die Oberflaeche haengt an dieser Unterscheidung
    // den Suchknopf und den Hinweistext auf.
    if (!socket) return serverUrl() ? 'offline' : 'unconfigured';
    if (socket.readyState === 0) return 'connecting';
    if (socket.readyState === 1) return player ? 'ready' : 'connecting';
    return 'offline';
  }

  function isConnected() {
    return !!socket && socket.readyState === 1;
  }

  function connect() {
    const url = serverUrl();
    if (!url) {
      emit('status', { status: 'unconfigured' });
      return false;
    }
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) return true;
    deliberate = false;
    clearTimeout(reconnectTimer);
    emit('status', { status: 'connecting', attempt });

    try {
      socket = new WebSocket(url);
    } catch (error) {
      emit('status', { status: 'error', message: `Adresse unbrauchbar: ${error.message}` });
      return false;
    }

    socket.addEventListener('open', () => {
      attempt = 0;
      // Sofort anmelden: alles andere weist der Server bis dahin ab.
      send({ t: 'hello', token: readLocal(TOKEN_KEY) || undefined, name: playerName() || undefined });
    });

    socket.addEventListener('message', event => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      receive(data);
    });

    socket.addEventListener('close', event => {
      const wasReady = !!player;
      socket = null;
      player = null;
      emit('status', { status: 'offline', code: event.code, wasReady });
      // 4001 heisst: woanders geoeffnet. Wieder zu verbinden hiesse, sich mit
      // dem anderen Fenster gegenseitig hinauszuwerfen.
      if (deliberate || event.code === 4001) return;
      scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // Auf 'error' folgt immer 'close'; dort wird neu verbunden.
      emit('status', { status: 'error' });
    });
    return true;
  }

  function scheduleReconnect() {
    const wait = BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
    attempt += 1;
    emit('status', { status: 'reconnecting', inMs: wait, attempt });
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, wait);
  }

  function disconnect() {
    deliberate = true;
    clearTimeout(reconnectTimer);
    seeking = null;
    game = null;
    if (socket) socket.close(1000, 'bye');
    socket = null;
    player = null;
    emit('status', { status: 'offline' });
  }

  function send(message) {
    if (!isConnected()) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  /* --- Eingehende Nachrichten ------------------------------------------- */

  function receive(data) {
    switch (data.t) {
      case 'welcome':
        player = data.player;
        controls = data.controls || [];
        // Das Merkmal ist die Anmeldung. Geht es verloren, faengt der Spieler
        // mit einem neuen Konto an - deshalb wird es sofort gesichert.
        if (data.token) writeLocal(TOKEN_KEY, data.token);
        if (player && player.name) writeLocal(NAME_KEY, player.name);
        seeking = null;
        game = data.game || null;
        emit('status', { status: 'ready' });
        emit('welcome', data);
        // Eine laufende Partie kommt beim Verbinden mit: wer neu laedt, soll
        // weiterspielen und nicht verlieren.
        if (game) emit('gameStart', { game, resumed: true });
        break;

      case 'player':
        player = data.player;
        emit('player', player);
        break;

      case 'lobby':
        lobby = { online: data.online, waiting: data.waiting, playing: data.playing };
        emit('lobby', lobby);
        break;

      case 'seeking':
        seeking = data.control;
        emit('seeking', data);
        break;

      case 'seekCancelled':
        seeking = null;
        emit('seekCancelled', data);
        break;

      case 'gameStart':
        seeking = null;
        game = data.game;
        emit('gameStart', { game, resumed: false });
        break;

      case 'move':
        if (game && game.id === data.gameId) {
          game.moves.push({ uci: data.uci, san: data.san });
          game.fen = data.fen;
          game.clock = data.clock;
          game.turn = data.clock.turn;
        }
        emit('move', data);
        break;

      case 'sync':
        game = data.game;
        emit('sync', data.game);
        break;

      case 'gameOver':
        if (game && game.id === data.gameId) {
          game.status = 'finished';
          game.result = data.result;
          if (data.clock) game.clock = data.clock;
        }
        if (data.ratings && player) {
          // Die eigene Wertung nachziehen, ohne auf die naechste Anmeldung zu
          // warten.
          const mine = game && game.white.id === player.id ? data.ratings.white : data.ratings.black;
          if (mine) player.rating = mine.after;
        }
        emit('gameOver', data);
        break;

      case 'drawOffered': emit('drawOffered', data); break;
      case 'drawDeclined': emit('drawDeclined', data); break;
      case 'opponentGone': emit('opponentGone', data); break;
      case 'opponentBack': emit('opponentBack', data); break;
      case 'leaderboard': emit('leaderboard', data.players); break;
      case 'replaced':
        deliberate = true;
        emit('replaced', data);
        break;
      case 'error': emit('serverError', data); break;
      case 'pong': break;
      default: break;
    }
  }

  /* --- Befehle ---------------------------------------------------------- */

  function seek(controlId) { return send({ t: 'seek', control: controlId }); }
  function cancelSeek() { seeking = null; return send({ t: 'cancelSeek' }); }
  function move(uci) { return game && send({ t: 'move', gameId: game.id, uci }); }
  function resign() { return game && send({ t: 'resign', gameId: game.id }); }
  function offerDraw() { return game && send({ t: 'drawOffer', gameId: game.id }); }
  function answerDraw(accept) { return game && send({ t: 'drawAnswer', gameId: game.id, accept: !!accept }); }
  function requestSync() { return game && send({ t: 'sync', gameId: game.id }); }
  function requestLeaderboard() { return send({ t: 'leaderboard' }); }

  /** Welche Farbe der angemeldete Spieler in der laufenden Partie hat. */
  function myColour() {
    if (!game || !player) return null;
    if (game.white.id === player.id) return 'white';
    if (game.black.id === player.id) return 'black';
    return null;
  }

  function opponent() {
    const colour = myColour();
    if (!colour) return null;
    return colour === 'white' ? game.black : game.white;
  }

  /** Hat dieser Browser schon einmal online gespielt? */
  function hasAccount() { return !!readLocal(TOKEN_KEY); }

  /**
   * Verbindet beim Laden der Seite - aber nur fuer wiederkehrende Spieler.
   *
   * Wer noch nie online gespielt hat, soll beim blossen Aufrufen der Seite
   * keine Verbindung aufbauen; das waere eine Verbindung, die niemand bestellt
   * hat. Wer aber mitten in einer Partie neu laedt, bekommt sie sonst nicht
   * zurueck und verliert auf Zeit, ohne es zu merken - genau davor schuetzt
   * die Wiederaufnahme auf der Serverseite, und sie greift nur, wenn sich
   * jemand meldet.
   */
  function autoConnect() {
    if (!hasAccount() || !serverUrl()) return false;
    return connect();
  }

  function forgetAccount() {
    writeLocal(TOKEN_KEY, null);
    writeLocal(NAME_KEY, null);
  }

  global.ChessOnline = {
    on,
    connect, disconnect, isConnected, status,
    serverUrl, setServerUrl,
    playerName, setPlayerName, forgetAccount, hasAccount, autoConnect,
    seek, cancelSeek, move, resign, offerDraw, answerDraw, requestSync, requestLeaderboard,
    myColour, opponent,
    player: () => player,
    game: () => game,
    lobby: () => lobby,
    controls: () => controls,
    seeking: () => seeking
  };
})();
