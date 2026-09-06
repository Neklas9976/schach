# Schachprogramm v3.0

Diese Version enthält eine überarbeitete, board-basierte Drag-and-Drop-Steuerung. Das Zielfeld wird anhand der tatsächlichen `.square`-Geometrie ermittelt und der Zug wird beim `pointerup` ohne zusätzliche Render-Frame-Verzögerung an die Schachengine übergeben.

Die Schachlogik bleibt getrennt von der UI.

# Schachprogramm v2.7

## Wichtige Fehlerbehebung
- Das Brett wird vor dem Ersetzen vollständig als DocumentFragment aufgebaut. Ein Fehler während eines Render-Vorgangs kann das vorhandene Brett dadurch nicht mehr einfach leeren.
- Jedes Feld besitzt zusätzlich eine echte Fallback-Farbe. Wenn ein extern geladenes Board-Bild nicht erreichbar ist, bleibt das Brett sichtbar.
- Der Fehlerpfad für ein fehlgeschlagenes Board-Bild löscht nicht mehr die gesamte Felddarstellung.
- Die bestehende Schachlogik, Figuren, Drag & Drop, Animationen und Darstellungsauswahl bleiben erhalten.

Start:
`python -m pip install -r requirements.txt`
`python app.py`


## v2.5 – Drag-Drop-Regression
- Drop-Ziel wird direkt aus der Brettgeometrie berechnet, nicht über `elementFromPoint()`.
- Dadurch bleiben Check-/Highlight-Ebenen und Pointer-Capture ohne Einfluss auf das Zielfeld.
- Regressionstests für schwarze Züge, die Weiß Schach geben.


## v2.7 – Stabiler Pointer-Controller
- Drag & Drop läuft über einen einzigen, stabilen Pointer-Controller am Schachbrett.
- Figuren und Felder registrieren keine eigenen transienten Pointer-Handler mehr.
- Das Zielfeld wird ausschließlich aus der Brettgeometrie berechnet.
- Während eines Drags wird kein Brett-Render ausgelöst.
- Pointer Capture wird auf dem stabilen Brett-Container verwaltet.
- Der logische Zug wird erst nach Abschluss des PointerUp-Events in einem Animation Frame ausgeführt.
- Der vorhandene Animations- und Schachlogik-Code bleibt getrennt.

## Spielmodi und Computergegner (v3.0)

Unter **Einstellungen → Spielmodus** lässt sich zwischen *Mensch gegen Mensch*
und *Mensch gegen Computer* umschalten. Im Computermodus können Farbe,
Spielstärke (8 Stufen) und die verwendete Engine gewählt werden.

### Eingebaute Engine (Standard)

`static/ai-worker.js` enthält eine eigene Suche: Iterative Deepening mit
Alpha-Beta-Schnitt, Quiescence-Suche für Schlagzüge, MVV-LVA-Zugsortierung und
Piece-Square-Tables inklusive eigener Endspieltabelle für den König.

Die Suche läuft in einem Web Worker und ist zeitbegrenzt. Sie kann das Brett
also weder blockieren noch dauerhaft hängen bleiben. Für die Zugregeln nutzt
sie ausschließlich `chess-engine.js` – eine zweite Regelimplementierung wäre
die klassische Quelle für illegale Computerzüge.

### Stockfish nativ (empfohlen, volle Stärke)

Ein Browser kann keine `.exe` ausführen – der lokale Flask-Server dagegen
schon. `engine_bridge.py` startet die native Engine als Hintergrundprozess und
spricht UCI mit ihr; über `/api/engine/bestmove` kommt nur noch der fertige Zug
zurück. Das ist deutlich stärker als jeder WASM-Build.

Einrichtung: Stockfish herunterladen, die ausführbare Datei nach `engine/`
kopieren, Server neu starten, in den Einstellungen **Stockfish nativ** wählen.
Details stehen in `engine/README.md`. Alternativ setzt die Umgebungsvariable
`CHESS_ENGINE_PATH` den Pfad direkt.

Eigenschaften der Brücke:

* **Ein langlebiger Prozess** – Stockfish lädt beim Start sein NNUE-Netz, ein
  Neustart pro Zug wäre deutlich spürbar.
* **Eigener Lesethread**, damit die Ausgabe der Engine nie den Pipe-Puffer
  füllt und blockiert.
* **Serialisierte Anfragen**, weil UCI eine zustandsbehaftete Einzelsitzung ist.
* **Sauberes Scheitern** statt Hängen: ungültige Stellungen, abgestürzte
  Engines und unsinnige Antworten werden erkannt und gemeldet.
* Jeder Zug der Engine wird gegen `chess-engine.js` geprüft. Ein illegaler Zug
  landet nie auf dem Brett.

### Stockfish im Browser (WASM, optional)

Alternativ lässt sich ein WASM-Build als `static/stockfish.js` ablegen und in
den Einstellungen auswählen. Der UCI-Adapter dafür steckt in `static/ai.js`.

Stockfish ist bewusst **nicht** mitgeliefert: Die Engine ist über 100 MB groß
und steht unter der GPL, woraus bei einer Weitergabe eigene Pflichten
entstehen. Lokal genutzt ist das unproblematisch.

## Tests

```bash
npm test           # JavaScript: Engine, Uhr, KI, UI-Regression
npm run test:python  # Python: Engine-Brücke
```
