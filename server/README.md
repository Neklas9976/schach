# Spielserver

Die Schachseite selbst ist eine reine Dateiablage – sie kann keinen Prozess
betreiben. Für Online-Partien braucht es deshalb diesen kleinen Server. Er
macht drei Dinge:

* er **paart** zwei Suchende zu einer Partie,
* er **prüft jeden Zug** und **misst die Zeit**,
* er **führt die Konten** (Name, Wertung, Bilanz).

Alles andere – Brett, Figuren, Klang – bleibt im Browser.

## Warum der Server die Regeln selbst kennt

Ein Client, dem geglaubt wird, lässt sich in der Entwicklerkonsole in zehn
Sekunden zum Schummeln überreden: illegale Züge, eine Uhr, die nicht abläuft,
ein Ergebnis nach Wunsch. Der Server rechnet deshalb mit – aber mit **derselben**
Regel-Engine wie der Browser (`static/chess-engine.js`, in einer eigenen
Umgebung ausgeführt). Eine zweite Regelimplementierung wäre eine zweite
Wahrheit: Server und Browser würden irgendwann verschieden urteilen, und dann
streitet ein Spieler mit dem Server darüber, ob sein Zug legal war.

## Lokal ausprobieren

```bash
npm install --prefix server
node server/index.js
```

Der Server hört dann auf Port 8787. Die Seite auf `localhost` findet ihn ohne
weitere Einstellung – `static/online.js` versucht beim Entwickeln von selbst
`ws://localhost:8787`.

Zwei Spieler auf einem Rechner brauchen zwei **verschiedene Herkünfte**
(`127.0.0.1` und `localhost` zählen als zwei), denn zwei Tabs derselben
Herkunft teilen sich den Browserspeicher und damit das Konto – der zweite Tab
verdrängt den ersten. Das ist Absicht.

## Veröffentlichen

Der Server braucht einen Anbieter, bei dem ein Prozess dauerhaft läuft.
GitHub Pages kann das nicht.

### Render (kostenlos zum Anfangen)

1. Auf [render.com](https://render.com) anmelden, **New → Web Service**, das
   Repository auswählen.
2. Einstellen:
   * **Root Directory:** leer lassen
   * **Build Command:** `npm install --prefix server`
   * **Start Command:** `node server/index.js`
   * **Health Check Path:** `/health`
3. Unter *Environment* eintragen:
   * `ALLOWED_ORIGINS` = `https://DEINNAME.github.io`
     (die Adresse deiner Seite, ohne Pfad; mehrere durch Komma getrennt)
4. Nach dem ersten Start steht die Adresse oben, z. B.
   `https://schach-server.onrender.com`.

Dann in `static/online-config.js` eintragen – mit `wss://` statt `https://`:

```js
window.CHESS_SERVER_URL = 'wss://schach-server.onrender.com';
```

**Wichtig zum kostenlosen Tarif:** der Server wird nach 15 Minuten ohne
Anfragen schlafen gelegt und braucht beim nächsten Aufruf ungefähr eine Minute
zum Aufwachen. Für eine Seite, auf der ab und zu jemand spielt, ist das
unschön, aber tragbar; die Oberfläche zeigt so lange „Verbinde …". Wer das
nicht will, nimmt den bezahlten Tarif (ab etwa 7 $/Monat) oder Fly.

### Fly.io (schläft nicht, wenige Euro im Monat)

```bash
fly launch --no-deploy
fly secrets set ALLOWED_ORIGINS=https://DEINNAME.github.io
fly deploy
```

In der erzeugten `fly.toml` `min_machines_running = 1` setzen, sonst schläft
die Maschine ebenfalls ein.

## Einstellungen

| Umgebungsvariable | Vorgabe | Bedeutung |
| --- | --- | --- |
| `PORT` | `8787` | Port |
| `DATABASE_URL` | leer | Postgres für die Konten; ohne das eine Datei |
| `DATA_FILE` | `server/data/players.json` | Wo die Datei liegt |
| `DATABASE_SSL_INSECURE` | leer | `1` schaltet die Zertifikatsprüfung ab |
| `ALLOWED_ORIGINS` | leer (alle) | Erlaubte Herkünfte, kommagetrennt |

`ALLOWED_ORIGINS` gehört im Betrieb gesetzt. Ohne die Angabe kann jede fremde
Seite Verbindungen zu deinem Server öffnen.

## Konten

Es gibt **keine Passwörter**. Der Server gibt beim ersten Besuch ein Merkmal
aus, das im Browser liegen bleibt; wer es verliert (anderer Browser, Verlauf
gelöscht), fängt mit einem neuen Konto an. Für eine Schachseite ist das der
richtige Tausch: wo keine Anmeldedaten liegen, können auch keine gestohlen
werden, und es gibt nichts zurückzusetzen.

### Wo sie liegen

Ohne `DATABASE_URL` in einer JSON-Datei – richtig für den eigenen Rechner.

Bei einem Hoster ist das Dateisystem **flüchtig**: jede neue Version des
Servers startet mit leerer Platte, und alle Wertungen sind weg. Beim ersten
Ausrollen ist genau das passiert. Deshalb gehört im Betrieb eine Datenbank
dahinter:

1. Bei [neon.com](https://neon.com) ein kostenloses Postgres anlegen
   (Supabase oder jedes andere Postgres geht genauso).
2. Die Verbindungszeichenfolge kopieren – sie beginnt mit `postgresql://`.
3. Auf Render unter *Environment* eintragen: `DATABASE_URL` = diese Zeichenfolge.

Mehr ist nicht zu tun: Tabelle und Index legt der Server beim Start selbst an,
und was noch in `players.json` liegt, wandert beim ersten Start mit hinüber.

`DATABASE_SSL_INSECURE=1` schaltet die Prüfung des Zertifikats ab. Das braucht
man **nur** bei Anbietern mit selbst ausgestelltem Zertifikat – Renders interne
Datenbank ist so einer. Neon, Supabase und die meisten anderen benutzen
öffentlich beglaubigte Zertifikate; dort bleibt die Prüfung an, und das soll sie
auch: ohne sie könnte sich jemand zwischen Server und Datenbank setzen.

### Wie es gebaut ist

Beim Start wird alles einmal in den Arbeitsspeicher geladen, jede Änderung
danach in die Datenbank durchgeschrieben. Das ist Absicht: die Lobby fragt
Konten *synchron* ab, mitten in der Bearbeitung einer Nachricht. Auf `await`
umzustellen hieße, die halbe Anwendung anzufassen – für Daten, die selbst bei
zehntausend Spielern nur wenige Megabyte sind.

Die Folge, die man kennen muss: es darf genau **eine** Serverinstanz laufen.
Zwei würden sich gegenseitig überschreiben. Der Gratis- wie der Starter-Tarif
von Render betreiben ohnehin nur eine.

## Was der Server nicht tut

* **Kein Zuschauen, kein Chat.** Chat hiesse Moderation, und die will hier
  niemand betreiben.
* **Keine laufenden Partien über einen Neustart hinweg.** Läuft der Server neu
  an, sind offene Partien weg; die Konten bleiben. Für einen Hobbybetrieb ist
  das vertretbar, für mehr müssten die Partien mitgeschrieben werden.
* **Keine Turniere, keine Freundesliste.**

## Tests

```bash
npm test
```

50 Tests für die Logik und den vollständigen Ablauf (`tests/server.test.mjs`),
zwölf für die Datenbankschicht gegen eine Attrappe (`tests/pg-store.test.mjs`),
acht weitere gegen ein **echtes** Postgres (`tests/pg-store-real.test.mjs`,
über PGlite – Postgres als WebAssembly, ohne Docker), und neun, die einen
echten Serverprozess starten und mit zwei echten Verbindungen eine Partie
spielen (`tests/server-e2e.test.mjs`).

Der Test gegen das echte Postgres hat sich sofort bezahlt gemacht: das Schema
stand als ein Block mit zwei Anweisungen darin. `node-postgres` schluckt das,
Verbindungsvermittler wie der von Neon nicht – der Server wäre dort gar nicht
erst angelaufen.
