# Verwendete Fremdinhalte

Dieses Projekt enthält genau zwei Dinge, die nicht hier entstanden sind: den
Figurensatz und – optional und nicht mitgeliefert – die Schach-Engine
Stockfish. Alles andere (Quelltext, Layout, Brettfarben, Klänge) stammt aus
diesem Projekt.

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

## Schach-Engine — Stockfish (optional, **nicht** mitgeliefert)

**Lizenz:** GNU General Public License v3

Stockfish wird bewusst nicht mit ausgeliefert. Das Programm läuft ohne; wer die
volle Spielstärke will, legt die Datei selbst in den Ordner `engine/` (siehe
`engine/README.md`).

Warum das wichtig ist: Die GPL verlangt bei einer **Weitergabe** von Stockfish,
dass der Quelltext des Gesamtwerks unter GPL verfügbar gemacht wird. Solange
die Engine nicht mitgeliefert wird, sondern der Nutzer sie selbst installiert,
stellt sich diese Frage nicht.

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
