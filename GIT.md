# Versionsverwaltung mit Git

Das Projekt ist bereits ein Git-Repository. Ab sofort brauchst du keine
Ordner wie `Schachprogramm_v2.8`, `_v2.9`, `_v3.0` mehr – Git speichert jede
Version für dich und du kannst jederzeit zurückspringen.

## Einmalig einrichten

1. Git installieren: <https://git-scm.com/download/win>
   (bei allen Fragen die Voreinstellungen übernehmen)
2. VS Code neu starten, damit es Git findet.
3. Im Terminal des Projektordners einmal deinen Namen hinterlegen:

   ```bat
   git config --global user.name "Niklas"
   git config --global user.email "deine@mail.de"
   ```

Fertig. Ab hier arbeitest du nur noch mit den drei Befehlen unten.

## Der Alltag

Nach jeder Änderung, mit der du zufrieden bist:

```bat
git add -A
git commit -m "Kurze Beschreibung der Aenderung"
```

Das ist das Gegenstück zu "neuen Ordner anlegen" – nur ohne Ordner.

Was hat sich seit dem letzten Stand geändert?

```bat
git status
git diff
```

Welche Versionen gibt es?

```bat
git log --oneline
```

## Zurück zu einer alten Version

Nur anschauen (ohne etwas zu verändern):

```bat
git checkout <die-id-aus-git-log>
git switch -                      && rem zurueck zum aktuellen Stand
```

Eine einzelne Datei auf den letzten Commit zurücksetzen:

```bat
git restore static/app.js
```

Alles verwerfen, was seit dem letzten Commit passiert ist:

```bat
git restore .
```

## Was bewusst nicht im Repository liegt

* `engine/` – die Stockfish-Datei ist über 100 MB groß und GPL-lizenziert.
  Sie würde das Repository dauerhaft aufblähen, denn Git behält jede Version
  für immer. Sie bleibt lokal auf deinem Rechner.
* `static/stockfish.js` / `.wasm` – aus demselben Grund.
* `__pycache__/`, `node_modules/`, `.vscode/` – automatisch erzeugte Dateien.

Geregelt wird das in `.gitignore`.

## Später: Backup und Zugriff von überall

Wenn du das Projekt zusätzlich online sichern willst, legst du dir ein
kostenloses Konto bei GitHub an, erstellst dort ein **privates** Repository und
verbindest es einmalig:

```bat
git remote add origin https://github.com/DEINNAME/schachprogramm.git
git push -u origin main
```

Danach genügt nach jedem Commit ein `git push`.

Beachte: Solange die Lizenzfrage der Brett- und Figuren-Designs offen ist
(siehe `ATTRIBUTIONS.md`), sollte das Repository **privat** bleiben.
