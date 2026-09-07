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
| `DATA_FILE` | `server/data/players.json` | Wo die Konten liegen |
| `ALLOWED_ORIGINS` | leer (alle) | Erlaubte Herkünfte, kommagetrennt |

`ALLOWED_ORIGINS` gehört im Betrieb gesetzt. Ohne die Angabe kann jede fremde
Seite Verbindungen zu deinem Server öffnen.

## Konten

Es gibt **keine Passwörter**. Der Server gibt beim ersten Besuch ein Merkmal
aus, das im Browser liegen bleibt; wer es verliert (anderer Browser, Verlauf
gelöscht), fängt mit einem neuen Konto an. Für eine Schachseite ist das der
richtige Tausch: wo keine Anmeldedaten liegen, können auch keine gestohlen
werden, und es gibt nichts zurückzusetzen.

Die Konten stehen in einer JSON-Datei. Auf Render und Fly ist das Dateisystem
flüchtig – die Datei überlebt eine neue Version **nicht**, wenn kein
dauerhafter Datenträger eingebunden ist (Render: *Disk*, Fly: *Volume*, jeweils
auf `server/data` gemountet). Ohne das beginnen nach jeder Aktualisierung alle
wieder bei 1200. Für den Anfang mag das reichen; wer die Wertungen behalten
will, hängt einen Datenträger an.

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

47 Tests für die Logik und den vollständigen Ablauf (`tests/server.test.mjs`),
neun weitere starten einen echten Serverprozess und spielen mit zwei echten
Verbindungen eine Partie (`tests/server-e2e.test.mjs`).
