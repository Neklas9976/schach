# Verwendete Fremdinhalte

Dieses Projekt enthält zwei Dinge, die nicht hier entstanden sind: den
Figurensatz und die Schach-Engine Stockfish. Alles andere (Quelltext, Layout,
Brettfarben, Klänge) stammt aus diesem Projekt.

**Das Gesamtwerk steht unter der GNU General Public License v3** – siehe
`LICENSE`. Das ist keine freie Wahl gewesen: Stockfish steht selbst unter
GPLv3, und es wird mitgeliefert (siehe unten).

> Hinweis: Das hier ist eine sorgfältige Zusammenstellung, keine
> Rechtsberatung. Für eine Veröffentlichung mit echtem Risiko lohnt der Blick
> einer Anwältin oder eines Anwalts.

---

## Schachfiguren — Cburnett

**Verzeichnis:** `static/pieces/cburnett/` (12 SVG-Dateien)

**Urheber:** Colin M. L. Burnett („Cburnett")

**Quelle:** Wikimedia Commons, z. B.
<https://commons.wikimedia.org/wiki/File:Chess_klt45.svg>
(die übrigen elf Dateien heißen `Chess_{k,q,r,b,n,p}{l,d}t45.svg`)

**Lizenz:** Der Urheber hat den Satz mehrfach lizenziert:

* GNU Free Documentation License (GFDL)
* Creative Commons Attribution-ShareAlike 3.0 (CC BY-SA 3.0)
* BSD-Lizenz

Man darf sich **eine** davon aussuchen. Für ein veröffentlichtes Programm ist
die BSD-Variante am unkompliziertesten: sie verlangt Namensnennung und den
Lizenztext, aber **kein** Share-alike. Wählt man CC BY-SA, müssten Bearbeitungen
der Zeichnungen unter derselben Lizenz weitergegeben werden.

**Änderungen durch dieses Projekt:** Den `<svg>`-Elementen wurde
`viewBox="0 0 45 45"` hinzugefügt, damit Browser sie sauber skalieren. Die
Zeichnungen selbst – jeder Pfad, jede Farbe – sind unverändert.

**Das ist zu tun, wenn du veröffentlichst:** Diese Datei mitliefern und im
Impressum oder README auf sie verweisen. Der Hinweis im Darstellungsmenü der
App erfüllt das bereits im Programm selbst.

Dieser Satz ist der De-facto-Standard für freie Schachdarstellungen; Wikipedia
zeichnet damit seine Schachdiagramme.

---

## Schach-Engine — Stockfish

Stockfish kommt hier in **zwei** Ausführungen vor.

### 1. WebAssembly-Build — mitgeliefert

**Dateien:** `static/stockfish.js`, `static/stockfish.wasm` (zusammen ~430 KB)

**Herkunft:** Stockfish.js von Nathan Rugg, <https://github.com/nmrugg/stockfish.js>,
eine Übersetzung von Stockfish nach WebAssembly. Bezogen aus dem npm-Paket
`stockfish@10.0.2`. Unverändert übernommen.

**Lizenz:** GNU General Public License v3 (wie Stockfish selbst)

Dieser Build ist der Grund, warum die veröffentlichte Seite ohne Server
auskommt: Gegner, Bewertungsbalken, Hinweis und Partie-Analyse laufen alle im
Browser des Besuchers. Es wird dabei nichts an einen Server geschickt.

Warum ein einthreadiger Build: Mehrthreadige WebAssembly-Builds brauchen
`SharedArrayBuffer` und dafür die Header `Cross-Origin-Opener-Policy` und
`Cross-Origin-Embedder-Policy`. Statische Hoster wie GitHub Pages können keine
eigenen Header setzen – ein solcher Build würde dort schlicht nicht starten.

**Die Folge für dieses Projekt:** Wer GPL-Software weitergibt, muss das
Gesamtwerk unter GPL stellen und den Quelltext verfügbar machen. Genau das
passiert hier: Das Projekt steht unter GPLv3 (`LICENSE`), und der Quelltext
liegt offen. Wer den Build wieder entfernt, ist an diese Bindung nicht mehr
gebunden – dann entfallen allerdings Analyse, Hinweis und Bewertungsbalken.

### 2. Nativer Build — **nicht** mitgeliefert, optional für lokal

**Lizenz:** ebenfalls GNU General Public License v3

Für die lokale Entwicklung kann zusätzlich die native Stockfish-Programmdatei
in den Ordner `engine/` gelegt werden (siehe `engine/README.md`). Sie ist über
100 MB groß, spielt deutlich stärker als der WebAssembly-Build und wird
bewusst nicht mit verteilt. Das Programm läuft ohne sie; es nimmt dann den
Browser-Build.

---

## Entfernt: Brett- und Figurenbilder von chess.com

Frühere Fassungen luden Brett- und Figurenbilder zur Laufzeit aus dem
öffentlichen Repository
`GiorgioMegrelli/chess.com-boards-and-pieces` nach. Dessen README benennt die
Dateien als Material von chess.com; eine Weitergabe- oder Nutzungserlaubnis
liegt dafür nicht vor. Nachladen ist rechtlich keine bessere Lage als
Mitliefern — benutzt wird das Material so oder so.

**Vollständig entfernt.** Es gibt im Programm keine Netzwerkadresse mehr, die
nach außen zeigt: die App lädt ausschließlich eigene Dateien. Nachprüfbar mit

```bash
grep -rn "githubusercontent\|chess\.com" static/ templates/
```

Ebenfalls entfernt wurden die früheren lokalen Ersatzfiguren unter
`static/chess-pieces/` (rund 6 MB hochskalierte PNG-Dateien). Sie waren
Bearbeitungen desselben Cburnett-Satzes, nur unscharf, unklar dokumentiert und
hundertmal so groß wie die Originale.

---

## Schachregeln — chess.js

**Datei:** `static/vendor/chess.js` (~105 KB), Lizenztext in
`static/vendor/LICENSE-chess.js.txt`

**Herkunft:** chess.js 1.4.0 von Jeff Hlywa,
<https://github.com/jhlywa/chess.js>, bezogen aus dem npm-Paket `chess.js`.

**Lizenz:** BSD-2-Clause (Copyright © 2025 Jeff Hlywa). Die Lizenz verlangt,
dass Copyright-Hinweis und Lizenztext bei jeder Weitergabe beiliegen — beides
wird mit ausgeliefert. BSD-2-Clause ist mit der GPLv3 verträglich, unter der
dieses Projekt als Ganzes steht.

**Änderungen gegenüber dem Original:** zwei, beide rein mechanisch. Das
abschließende `export`-Statement des ESM-Builds wurde zu einer Zuweisung an den
globalen Namensraum, und der Verweis auf die nicht mitgelieferte Sourcemap ist
entfernt. Der Grund steht in `tools/vendor-chess-js.mjs`: die Seite hat bewusst
keinen Build-Schritt, und ein `<script type="module">` liefe erst nach allen
klassischen Skripten. Die Umwandlung ist dort als wiederholbares Werkzeug
hinterlegt und lässt sich mit `npm run vendor` jederzeit neu ausführen.

**Warum überhaupt:** die Schachregeln sind der Teil des Programms, bei dem ein
Fehler am teuersten ist — ein falsch beurteilter Zug entscheidet eine Partie.
chess.js ist über Jahre an genau dieser Aufgabe geprüft worden.

---

## Taktikaufgaben

`static/puzzles.json` ist **in diesem Projekt selbst erzeugt** worden und stammt
aus keiner fremden Sammlung – weder von lichess noch von chess.com noch aus
einer Aufgabendatenbank.

Das Verfahren steht in `tools/make_puzzles.py` und ist nachvollziehbar: zwei
absichtlich schwach eingestellte Stockfish-Instanzen spielen gegeneinander, und
aus ihren Fehlern wird jede Stellung herausgesucht, in der genau ein Zug
deutlich gewinnt. Jede Lösung ist danach von Stockfish auf voller Stärke
geprüft. Wer den Satz neu erzeugen will, braucht nur eine lokale
Stockfish-Binärdatei:

```
python -m pip install chess
python tools/make_puzzles.py --count 320 --out static/puzzles.json
```

Schachstellungen und Zugfolgen sind ohnehin keine schutzfähigen Werke – hier
kommt hinzu, dass sie nirgends abgeschrieben, sondern gerechnet wurden.

## Brettfarben, Klänge, Eröffnungsnamen

* **Brettfarben:** Zwölf Farbpaare, in diesem Projekt gewählt. Ein
  zweifarbiges Schachbrettmuster ist keine schutzfähige Gestaltung, sondern
  das Spiel selbst.
* **Klänge:** Werden zur Laufzeit mit der Web Audio API erzeugt
  (`static/sound.js`). Es gibt keine Audiodateien und damit auch keine
  Samplelizenz.
* **Eröffnungsnamen und ECO-Codes** (`static/openings.js`): ECO-Codes sind eine
  Systematik, Eröffnungsnamen sind allgemeines Schachwissen. Die Auswahl und
  die deutschen Bezeichnungen stammen aus diesem Projekt; es wurde keine
  fremde Datenbank kopiert.
