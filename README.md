# Schachprogramm v3.8

Schachprogramm mit vollständigen Regeln, Schachuhr, Computergegner, Partie-Analyse,
Taktik-Training, PGN/FEN, Archiv und Sound. Läuft als reine statische Seite –
Stockfish rechnet als WebAssembly im Browser, es gibt keinen Server.

**Lizenz:** GNU GPL v3 (siehe `LICENSE`) · **Fremdinhalte:** `ATTRIBUTIONS.md`

## Taktik-Training (v3.8)

Der Knopf **🧩 Puzzle** (oder die Taste `T`) öffnet das Training. Es läuft auf
demselben Brett wie eine Partie – gleiche Figuren, gleiche Animation, gleicher
Klang; nur spielt kein Computergegner mit, die Uhr steht, der Bewertungsbalken
bleibt aus (er wäre die Lösung) und nichts landet im Partiearchiv.

* Jede Aufgabe beginnt mit dem Zug, der in die Stellung geführt hat. Danach ist
  der Spieler am Zug.
* Ein falscher Zug wird zurückgenommen, nicht bestraft – man darf es noch einmal
  versuchen. Erst *Lösung* wertet die Aufgabe als verfehlt.
* Eine eigene Wertung (Elo, Start 1000) sucht die nächste Aufgabe aus. Wer einen
  Hinweis nimmt, bekommt die Aufgabe nicht angerechnet: sonst wäre die Wertung
  nur Dekoration.
* Themen (Matt in n, Gabel, Opfer, Grundreihenmatt …) lassen sich auswählen.
* Fortschritt, Wertung und Serie liegen in `localStorage`, also auf dem Gerät.

### Woher die Aufgaben kommen

Aus keiner fremden Sammlung. `tools/make_puzzles.py` lässt zwei absichtlich
schwach eingestellte Stockfish-Instanzen gegeneinander spielen und sucht aus
ihren Fehlern die Stellungen heraus, in denen genau ein Zug deutlich gewinnt;
jede Lösung wird danach auf voller Stärke geprüft. Der Satz lässt sich jederzeit
neu erzeugen:

```
python -m pip install chess
python tools/make_puzzles.py --count 320 --out static/puzzles.json
```

Der Filter ist bewusst streng: der beste Zug muss den zweitbesten um mindestens
220 Centipawns schlagen, und ohne ihn darf die Stellung noch nicht gewonnen
sein. Sonst gäbe es Aufgaben mit mehreren richtigen Lösungen – und eine davon
als „falsch" zu melden, wäre schlicht verkehrt. Erzwungene Matts haben einen
eigenen Maßstab, weil dort ohnehin meist schon alles gewonnen ist.


Schachprogramm mit vollständigen Regeln, Schachuhr, Computergegner (eingebaut
und nativ per Stockfish), Partie-Analyse, PGN/FEN und Sound.

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
kopieren, Server neu starten – fertig. Details stehen in `engine/README.md`.
Alternativ setzt die Umgebungsvariable `CHESS_ENGINE_PATH` den Pfad direkt.

**Die native Engine wird automatisch verwendet, sobald sie vorhanden ist.**
Der Standard kann nicht einfach `server` sein, weil die meisten Installationen
gar keine Engine-Datei haben und ein Standard, der beim ersten Zug scheitert,
schlechter ist als einer, der nur schwächer spielt. Die App startet deshalb auf
der eingebauten Engine und stuft sich hoch, sobald der Server eine native
Engine bestätigt hat. Eine von Hand getroffene Auswahl wird dabei nie
überschrieben.

Eigenschaften der Brücke:

* **Ein langlebiger Prozess** – Stockfish lädt beim Start sein NNUE-Netz, ein
  Neustart pro Zug wäre deutlich spürbar.
* **Eigener Lesethread**, damit die Ausgabe der Engine nie den Pipe-Puffer
  füllt und blockiert.
* **Serialisierte Anfragen**, weil UCI eine zustandsbehaftete Einzelsitzung ist.
* **Sauberes Scheitern** statt Hängen: ungültige Stellungen, abgestürzte
  Engines und unsinnige Antworten werden erkannt und gemeldet.
* **Fällt die native Engine im laufenden Spiel aus** – gelöschte Datei,
  abgestürzter Prozess, neu gestarteter Server –, übernimmt die eingebaute
  Engine den Zug, und im Statusbereich steht, warum. Eine tote Engine kostet
  so keine Partie.
* Jeder Zug der Engine wird gegen `chess-engine.js` geprüft. Ein illegaler Zug
  landet nie auf dem Brett.

#### Spielstärke der Stufen

`Skill Level` allein reicht nicht: Stockfish spielt selbst auf Stufe 0 noch
rund 1350 Elo. Die Stufen 1–7 begrenzen die Stärke deshalb zusätzlich über
`UCI_LimitStrength`/`UCI_Elo` (1320 bis 2600 Elo), Stufe 8 spielt ungebremst.
Die Begrenzung wird bei **jeder** Anfrage neu gesetzt – UCI-Optionen gelten
für die Lebensdauer des Prozesses, sonst würde ein Wechsel zurück auf Stufe 8
weiterhin auf 1800 Elo spielen.

### Stockfish im Browser (WASM, optional)

Alternativ lässt sich ein WASM-Build als `static/stockfish.js` ablegen. Der
UCI-Adapter dafür steckt in `static/ai.js`. Der Eintrag erscheint in der
Auswahl nur, wenn die Datei tatsächlich vorhanden ist – eine Option
anzubieten, die zuverlässig in einen Engine-Fehler läuft, ist schlechter als
gar keine Option.

Stockfish ist bewusst **nicht** mitgeliefert: Die Engine ist über 100 MB groß
und steht unter der GPL, woraus bei einer Weitergabe eigene Pflichten
entstehen. Lokal genutzt ist das unproblematisch.

## Veröffentlichen (v3.7)

Die Seite ist eine reine Dateiablage: `index.html` plus `static/`. Es gibt
keinen Server, keine Datenbank, keine Anmeldung und keine Kosten.

### Warum ohne Server

Der Flask-Server hatte genau eine Aufgabe: die native Stockfish-Programmdatei
starten, die ein Browser nicht ausführen kann. Öffentlich wäre er ein Problem
gewesen – `engine_manager` ist ein Modul-Singleton, alle Besucher hätten sich
**einen** Stockfish-Prozess hinter **einem** Lock geteilt. Zwei gleichzeitige
Spieler und einer wartet auf den anderen; ein einziger Aufruf von
`/api/engine/evaluate` mit `movetime=60000` hätte die Seite für alle blockiert.

Stattdessen läuft Stockfish jetzt als WebAssembly **im Browser des Besuchers**.
Gegner, Bewertungsbalken, Hinweis und Partie-Analyse funktionieren damit
vollständig – nur eben auf dem Rechner, der auch den Nutzen davon hat. Die
Rechenlast wächst mit den Besuchern, ohne dass irgendetwas geteilt wird.

Der Flask-Server bleibt für die lokale Entwicklung erhalten. Liegt eine native
Stockfish-Datei in `engine/`, benutzt die App sie automatisch – sie ist
deutlich stärker als der Browser-Build. Fehlt sie, nimmt sie denselben
WebAssembly-Build wie die veröffentlichte Seite.

### Alle Pfade sind relativ

Nichts im ausgelieferten Code beginnt mit `/`. Unter einer Projektseite liegt
die Anwendung auf `https://name.github.io/repo/`, wo `/static/app.js` auf den
Domainstamm zeigen und ins Leere laufen würde. Gegen das Dokument aufgelöst
stimmt beides. `tests/assets.test.mjs` hält das fest.

### GitHub Pages

1. Repository auf GitHub anlegen (öffentlich – die GPL verlangt, dass der
   Quelltext verfügbar ist).
2. Hochladen:

   ```bash
   git remote add origin https://github.com/BENUTZER/REPO.git
   git push -u origin main
   ```

3. Im Repository unter **Settings → Pages**: *Source* auf **Deploy from a
   branch**, Branch `main`, Ordner `/ (root)`.

Nach ein bis zwei Minuten liegt die Seite unter
`https://BENUTZER.github.io/REPO/`.

Die Datei `.nojekyll` schaltet die Jekyll-Verarbeitung ab. Ohne sie lässt
GitHub Pages Dateien und Ordner mit führendem Unterstrich stillschweigend weg –
für eine reine Dateiablage ist die Verarbeitung überflüssig und nur eine
Fehlerquelle.

### Ein eigener Name statt neklas9976.github.io

Drei Wege, vom kostenlosen zum schönsten.

**1. Kostenlos: eine GitHub-Organisation mit gutem Namen.**
Eine Organisation anlegen (github.com/organizations/plan → *Free*), sie z. B.
`schachplatz` nennen, das Repository dorthin verschieben (Repo → Settings →
*Transfer ownership*) und in `schachplatz.github.io` umbenennen. Die Seite liegt
dann unter `https://schachplatz.github.io/` – ohne Benutzernamen und ohne
Unterordner. Kostet nichts, dauert fünf Minuten.

**2. Eine echte Domain (rund 10–15 € im Jahr).**
`.de` ist am günstigsten, `.com` etwas teurer, `.chess` gibt es nicht. Kaufen
lässt sie sich bei jedem Registrar (INWX, Namecheap, Cloudflare Registrar –
letzterer verkauft zum Einkaufspreis ohne Aufschlag). Eine Domain muss der
Inhaber selbst kaufen; das lässt sich nicht delegieren.

Danach zwei Schritte:

*Im Repository:* eine Datei `CNAME` im Wurzelverzeichnis anlegen, die genau
eine Zeile enthält – die Domain, ohne `https://`:

```
schachplatz.de
```

Alternativ dasselbe über Settings → Pages → *Custom domain*; GitHub legt die
Datei dann selbst an. **Wichtig:** die Datei muss im Repository bleiben, sonst
verliert die Seite die Domain beim nächsten Push.

*Beim Registrar (DNS):* für die nackte Domain vier A-Einträge

```
185.199.108.153
185.199.109.153
185.199.110.153
185.199.111.153
```

und für `www` einen CNAME-Eintrag auf `neklas9976.github.io`. Wer stattdessen
nur `schach.meinedomain.de` will, braucht ausschließlich diesen einen
CNAME-Eintrag und keine A-Einträge.

Nach der DNS-Umstellung (Minuten bis wenige Stunden) in Settings → Pages
**Enforce HTTPS** einschalten. Das Zertifikat stellt GitHub kostenlos aus.

**3. Netlify oder Cloudflare Pages** nehmen die Domain im eigenen Dashboard
entgegen und stellen das Zertifikat ebenfalls kostenlos aus – wer ohnehin dort
veröffentlicht, spart sich die A-Einträge.

Am Programm ändert sich in allen drei Fällen **nichts**: alle Pfade sind
dokumentrelativ, die Seite läuft unter `/`, unter `/schach/` und unter jeder
Domain gleich. Der Test *no runtime path starts at the domain root* hält das
fest.

### Netlify, Cloudflare Pages, jeder andere Hoster

Kein Build-Schritt, kein Ausgabeordner: Repository verbinden, Build-Befehl leer
lassen, Veröffentlichungsverzeichnis auf `/` setzen. Oder den Ordner schlicht
per FTP hochladen.

### Lokal ausprobieren, genau wie veröffentlicht

```bash
python -m http.server 8080
```

Dann `http://127.0.0.1:8080/` öffnen. Das ist exakt die Auslieferung, die auch
online läuft – ohne Flask, ohne native Engine.

### Was ein Besucher lädt

| | |
|---|---|
| Seite, Skripte, Stil | ~200 KB |
| Figuren (12 SVG) | 52 KB |
| Stockfish (WASM) | 430 KB |
| **Gesamt** | **unter 700 KB** |

Stockfish wird erst geladen, wenn wirklich gerechnet werden soll.

### Datenschutz

Es gibt nichts zu melden: keine Anmeldung, keine Zählpixel, keine
Fremdressourcen, kein Server, der etwas mitschreiben könnte. Partien,
Einstellungen und die Statistik liegen im `localStorage` des Besuchers und
verlassen sein Gerät nicht. Ob deine Rechtsordnung trotzdem ein Impressum
verlangt, ist eine andere Frage – das hängt am Betreiber, nicht an der
Technik.

## Darstellung und Rechtelage (v3.6)

Das Programm soll veröffentlicht werden können, ohne dass jemand Ansprüche
anmelden kann. Dafür wurde die gesamte Darstellung umgestellt.

### Was das Problem war

Frühere Fassungen luden Brett- und Figurenbilder **zur Laufzeit** aus dem
öffentlichen Repository `GiorgioMegrelli/chess.com-boards-and-pieces` nach;
Standardfiguren waren „3D Wood". Dessen README benennt den Inhalt als Material
von chess.com. Nachladen statt Mitliefern ändert daran nichts – benutzt wird
es so oder so, und die Standardeinstellung tat es bei jedem Seitenaufruf.

Die lokalen Ersatzfiguren unter `static/chess-pieces/` waren dagegen **kein**
chess.com-Material: erkennbar Cburnett-Zeichnungen, nur auf 1024 px
hochskaliert, mit Textur überzogen und rund 6 MB schwer. Frei lizenziert, aber
unscharf und mit einer Herkunftsangabe, die das nicht klar sagte.

### Was jetzt gilt

**Figuren:** der Satz von Cburnett aus Wikimedia Commons – dieselben
Zeichnungen, mit denen Wikipedia seine Schachdiagramme setzt. Zwölf SVG-Dateien
in `static/pieces/cburnett/`, zusammen 52 KB statt 6 MB, und in jeder Größe
scharf. Der Urheber bietet sie unter GFDL, CC BY-SA 3.0 **und** BSD an; man
darf sich eine aussuchen. Einzige Änderung: den `<svg>`-Elementen wurde ein
`viewBox` hinzugefügt, damit Browser sie sauber skalieren – die Zeichnungen
selbst sind unverändert.

**Bretter:** zwölf Farbpaare aus diesem Projekt. Ein zweifarbiges
Schachbrettmuster ist keine schutzfähige Gestaltung, sondern das Spiel.

**Klänge:** werden ohnehin zur Laufzeit erzeugt, es gab nie eine Audiodatei.

### Was zu tun bleibt

Namensnennung ist Bedingung jeder der drei Lizenzen. Sie steht in
`ATTRIBUTIONS.md` **und** im Darstellungsmenü der App selbst. Beides muss bei
einer Veröffentlichung mitgehen.

### Was das gekostet hat

Statt 39 Figurensätzen gibt es einen. Die anderen 38 waren genau das Material,
das nicht verwendet werden durfte. Ein weiterer Satz ist schnell ergänzt:
zwölf SVGs nach `static/pieces/<name>/` legen und eine Zeile in
`appearance.js` eintragen – die Arbeit steckt in der Lizenzprüfung, nicht im
Code.

### Abgesichert

`tests/assets.test.mjs` prüft, dass keine Datei im ausgelieferten Code eine
Adresse nach außen enthält (einzige Ausnahme: der SVG-Namensraum, eine
Kennung und kein Abruf), dass alle zwölf Figuren vorhanden, echte SVGs und
paarweise verschieden sind, und dass die Lizenzangaben dokumentiert sind. Der
alte Zustand kann nicht unbemerkt zurückkommen.

Zum Nachprüfen von Hand:

```bash
grep -rn "githubusercontent\|chess\.com" static/ templates/
```

> Das ist eine sorgfältige Zusammenstellung, keine Rechtsberatung.

## Partiefunktionen (v3.3 bis v3.5)

Dieser Abschnitt beschreibt, was das Programm rund um die reine Partie herum
kann. Vorbild ist chess.com; nicht übernommen wurde alles, was einen Server mit
Benutzerkonten braucht – Online-Gegner, Ranglisten, Turniere, Lektionen.

### Sound

`static/sound.js` erzeugt die Klänge im Browser über die Web Audio API, statt
Audiodateien mitzuliefern. Das hat zwei Gründe: Samples wären weitere
Fremd-Assets mit eigener Lizenzfrage – genau das Problem, das die Brett- und
Figurengrafiken bereits haben – und mehrere hundert Kilobyte Binärdaten in
einem Projekt, das sonst nur aus Quelltext besteht. Ein Holz-Klick lässt sich
aus einem gefilterten Rauschimpuls und einem kurzen Ton gut nachbilden.

Der `AudioContext` entsteht erst bei der ersten echten Nutzergeste. Browser
starten ihn sonst im Zustand *suspended*, und ein solcher Kontext verschluckt
jeden Ton stillschweigend.

### Bewertungsbalken

Der Balken links neben dem Brett zeigt die Stellungsbewertung. Er fragt nach
jedem Zug `/api/engine/evaluate` an – einen eigenen Endpunkt, nicht
`/bestmove`:

* Die Bewertung darf **nie** durch die eingestellte Spielstärke geschwächt
  werden. Ein Balken, der die Stellung so einschätzt wie ein absichtlich
  verschlechterter Gegner, sagt nichts aus.
* Sie läuft auf einem **eigenen Engine-Prozess**. UCI ist eine
  zustandsbehaftete Einzelsitzung: bei gemeinsamer Engine würde jede Bewertung
  sich vor den Zug des Gegners in die Warteschlange stellen und das Brett bei
  jedem Zug sichtbar stocken lassen.

Die Engine meldet ihre Bewertung immer aus Sicht der Seite am Zug; das
Programm rechnet sie an genau einer Stelle (`whiteRelative`) auf Weiß um.
Zwei Umrechnungsstellen sind der Weg, auf dem ein Balken nach einem
schwarzen Zug in die falsche Richtung zeigt.

### Partie durchblättern

Die Zugliste ist anklickbar, dazu ←/→ und Pos1/Ende. Der Zustand dafür ist
eine einzige Zahl: `viewPly` zählt, wie viele Halbzüge auf dem Brett zu sehen
sind, und ist gleich `movesLog.length`, solange die Partie live ist. Ein
separates „Ich schaue gerade zurück"-Flag daneben wäre eine zweite Quelle für
dieselbe Aussage – Brett und Zugliste könnten sich widersprechen.

Während des Zurückblätterns ist kein Zug möglich. Der Riegel sitzt in
`humanMayAct()`, durch das jeder Eingabeweg läuft, statt einzeln in der Klick-
und der Drag-Behandlung.

### Brett drehen

Umgesetzt über `order` auf den Feldern, nicht über eine CSS-Drehung. Eine
Drehung um 180° würde jede Figur auf den Kopf stellen und bräuchte eine
Gegendrehung pro Bild; `order` lässt DOM, Zeiger-Geometrie und den
Diff-Renderer völlig unberührt – die Felder behalten ihre echten Koordinaten.

### PGN und FEN

`static/notation.js` liest und schreibt PGN, FEN steckt in `chess-engine.js`
(es ist eine Serialisierung des Regelzustands).

Beim Einlesen gibt es **keinen** handgeschriebenen SAN-Parser. „Nbd7" richtig
zu lesen bedeutet, genau dieselbe Mehrdeutigkeit aufzulösen wie beim
Schreiben, und eine zweite Implementierung davon ist der Weg, auf dem ein
Loader anfängt, dem Brett zu widersprechen. Stattdessen wird jeder legale Zug
mit der engine-eigenen `sanForMove` nach SAN gerendert und mit dem Token
verglichen. Bei rund vierzig Zügen pro Stellung ist das viel zu billig, um es
zu optimieren.

Kommentare, Varianten und NAGs werden übersprungen. Varianten sind
verschachtelt und lassen sich deshalb nicht mit einem einzelnen regulären
Ausdruck entfernen – `\([^)]*\)` hört bei der ersten inneren Klammer auf und
schiebt den Rest der Variante als echte Züge in den Tokenstrom.

### Partie-Analyse

Bewusst eine **nachvollziehbare Annäherung** an das, was chess.com anzeigt,
keine Nachbildung davon. Deren Klassifikation und Genauigkeitswert sind nicht
offengelegt; alles, was behauptet, sie exakt zu reproduzieren, würde raten.
Umgesetzt ist der veröffentlichte, überprüfbare Weg:

1. Jede Bewertung wird in eine Gewinnwahrscheinlichkeit umgerechnet.
2. Gemessen wird, wie viel davon ein Zug abgegeben hat.
3. Daraus folgen Label und Genauigkeit.

Warum Gewinnwahrscheinlichkeit statt Centipawns: 100 Centipawns
wegzugeben wiegt bei ±0.2 enorm und bei +9 fast nichts. Eine Regel allein auf
Centipawns würde beides gleich benennen.

Alle Schwellen stehen als benannte Konstanten in `static/review.js` und sind
damit diskutierbar. Die Grenzen für Ungenauigkeit/Fehler/grober Fehler sind
die verbreitete 10/20/30-Skala.

Eröffnungszüge werden nicht bewertet. Einen Hauptvarianten-Zug einen Fehler zu
nennen, weil die Engine knapp etwas anderes bevorzugt, ist Rauschen und keine
Rückmeldung.

### Eröffnungsnamen

`static/openings.js` enthält eine kompakte Auswahl gängiger Eröffnungen mit
ECO-Code, nach Zugfolge geschlüsselt. Eine Schlüsselung nach Stellung würde
auch Zugumstellungen erfassen, bräuchte dafür aber einen Hash pro Eintrag und
eine Berechnung pro Halbzug – und für die *Benennung* einer Eröffnung ist
gerade die Zugfolge das, was man wiedererkennt. Es gewinnt der längste
passende Präfix.

Die Liste ist absichtlich eine Auswahl, keine vollständige ECO-Datenbank:
Letztere wäre mehrere Megabyte groß und damit ein Download, kein Quelltext.

### Premoves

Während der Computer rechnet, lässt sich der eigene Zug schon eingeben. Er wird
farblich markiert und in dem Moment ausgeführt, in dem der Gegenzug auf dem
Brett landet. Rechtsklick bricht ab, ein Klick aufs Brett ersetzt ihn.

Nur gegen den Computer. An einem Brett zu zweit hieße „premove", einen Zug für
den anderen Spieler einzugeben.

**Genau einer.** Eine Warteschlange müsste jeden weiteren Eintrag gegen eine
Stellung prüfen, die es noch nicht gibt, und je tiefer sie würde, desto öfter
landete der Inhalt ohnehin im Papierkorb.

**Legalität lässt sich nicht vorab prüfen** – die Stellung, in der der Zug
gespielt wird, existiert noch nicht. `ChessEngine.premoveTargets` filtert
deshalb nur, was für die Figur überhaupt plausibel ist; entschieden wird beim
Ausführen durch `movesBetween`. Passt der Zug dann nicht mehr, wird er
verworfen und das im Statusbereich gesagt.

Die Filterregel ist bewusst asymmetrisch:

* **Gegnerische Figuren zählen nicht als Blocker.** Genau darauf zu setzen,
  dass sie wegziehen, ist der Sinn eines Premoves. Ein Läufer darf also über
  einen gegnerischen Bauern hinweg vorgemerkt werden.
* **Eigene Figuren blockieren weiterhin.** Bei einem einzigen vorgemerkten Zug
  können sie sich bis zur Ausführung nicht bewegt haben.
* **Bauern bekommen beide Diagonalen angeboten**, auch wenn dort nichts steht:
  der Schlagzug, auf den ein Premove wartet, ist der Gegenzug, der noch nicht
  gespielt wurde.
* **Rochade** wird vom Grundfeld aus angeboten und beim Ausführen geklärt – ob
  sie möglich ist, hängt an der Antwort des Gegners.

Ein Test hält fest, dass der Filter nie *enger* sein darf als die Regeln: jeder
in einer Stellung legale Zug muss unter den Premove-Zielen seiner Figur sein.

**Umwandlung wird ohne Rückfrage zur Dame.** Der Dialog würde Sekundenbruchteile
nach dem Gegenzug aufspringen, auf einem Brett, das der Spieler noch gar nicht
ansieht – das Gegenteil dessen, wofür ein Premove da ist.

Der Riegel dafür, wessen Zug gerade eingegeben werden darf, ist `inputColor()`.
Klick- und Drag-Pfad fragen beide dort nach, statt selbst gegen `state.turn` zu
vergleichen: während eines Premoves gehört die bewegte Figur der Seite, die
*nicht* am Zug ist, und jede Stelle, die den Unterschied vergisst, würde den
Premove entweder ablehnen oder einen Zug für den Gegner annehmen. `commitMove`
prüft ganz am Ende weiterhin exakt gegen `state.turn` – auf dem Brett landet ein
Zug erst, wenn die Seite wirklich dran ist.

### Meine Partien (Archiv und Statistik)

Jede beendete Partie landet automatisch im Archiv – ausgespielt, aufgegeben
oder auf Zeit verloren. Erreichbar über **📁 Partien** oder die Taste `P`.

Gespeichert wird **als PGN** plus ein kleiner Kopf. PGN, weil es das Einzige
ist, das jedes andere Schachprogramm lesen kann: ein Archiv, das sonst niemand
öffnen kann, ist ein Tagebuch und kein Bestand.

**Die Statistik wird jedes Mal aus der Liste berechnet, nicht als laufender
Zähler geführt.** Zähler driften – eine gelöschte Partie, eine doppelt
gespeicherte, ein später hinzugekommener Pfad, der das Hochzählen vergisst –
und niemand merkt es. Aus der Liste abgeleitet können die Zahlen den Partien
nicht widersprechen. Der frühere `chess-stats`-Zähler ist damit weg; er zählte
unter anderem doppelt, wenn man nach einem Matt zurücknahm und erneut zu Ende
spielte.

Bilanz und Punktequote decken nur Partien gegen den Computer ab. Zu zweit an
einem Brett gibt es kein „du", dem ein Sieg gehören würde. Solche Partien
stehen trotzdem im Archiv, nur eben ohne Wertung – die Fußnote im Fenster sagt
das auch. Ein Remis zählt halb, wie im Schach üblich.

**Eine Partie kann mehr als einmal enden**: Matt zurücknehmen, weiterspielen,
erneut beenden. Deshalb merkt sich das Programm die Archiv-Kennung der
laufenden Partie und ersetzt deren Eintrag, statt einen zweiten anzulegen.

**Läuft danach eine Analyse**, wird die eigene Genauigkeit in denselben
Eintrag nachgetragen – nur die eigene Seite, und nur gegen den Computer.

Ein Klick auf eine Zeile lädt die Partie zurück aufs Brett. Dabei werden
Aufgabe und Zeitüberschreitung mitgeführt: beides steht nirgends in der
Zugliste, und ohne diese Angabe würde die Engine munter aus einer Stellung
weiterspielen, die jemand längst aufgegeben hatte.

Das Archiv fasst 200 Partien; danach fallen die ältesten heraus. Weit unter
dem, was der Browser hergibt – die Grenze existiert, damit ein über Jahre
mitlaufendes Archiv nicht unbemerkt wächst. Verweigert der Speicher die
Annahme (privates Fenster, volles Kontingent, Speicher abgeschaltet), geht die
Partie verloren, aber nichts stürzt ab.

### Behobener Altfehler: Bauernumwandlung

Seit v3.2 tat ein Bauer, der die Grundreihe erreichte, schlicht nichts – der
Umwandlungsdialog ging nie auf.

`findLegalMove(state, from, to)` nimmt die Umwandlungsfigur als *Teil der
Zugidentität*, nicht als optionalen Hinweis: ohne sie passt keine der vier
Umwandlungen, denn „Bauer auf die achte Reihe" ist noch kein Zug, solange die
Figur nicht benannt ist. Die Zugauflösung rief die Funktion aber ohne Figur auf,
bekam `null` zurück und brach ab – womit der Zweig, der den Dialog öffnet,
unerreichbarer toter Code war.

Neu ist `ChessEngine.movesBetween(state, from, to)`: alle legalen Züge zwischen
zwei Feldern. Normalerweise null oder einer, bei einer Umwandlung vier. Alles,
was von einem Feldpaar ausgeht – Klick, Drag, Premove, der Zug der KI –, fragt
jetzt dort und lässt die Anzahl entscheiden, ob noch eine Figur zu wählen ist.
Damit verschwinden zugleich drei Kopien desselben Filters.

### Geschlagene Figuren

Werden aus dem Brett abgeleitet, nicht mitgeführt. Umwandlungen können einer
Seite *mehr* Damen bescheren als zu Beginn, was sonst als negative Anzahl
geschlagener Figuren erschiene.

## Tests

```bash
npm test             # JavaScript: Engine, Notation, Analyse, Uhr, KI, UI-Regression
npm run test:python  # Python: Engine-Brücke
npm run test:all     # beides
```

Die JavaScript-Tests laden die Module in eine `vm`-Sandbox. Werte aus dieser
Sandbox tragen deren Prototypen, weshalb `assert.deepEqual` sie sonst als
verschieden ansieht – Vergleiche kopieren sie deshalb erst in Host-Objekte.

Die Python-Tests starten eine geskriptete Stub-Engine statt Stockfish selbst:
geprüft wird das Protokollverhalten der Brücke, das bei jeder UCI-Engine
gleich sein muss. Unter Windows läuft dieser Stub über einen Batch-Wrapper –
Windows ignoriert Shebangs und startet nur `.exe`/`.bat`/`.cmd`, und genau
deshalb akzeptiert die Brücke diese Endungen auch im Echtbetrieb.
