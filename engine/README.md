# Engine-Ordner

Hier gehört die native Schach-Engine hinein (empfohlen: Stockfish).

## Einrichtung

1. Stockfish von <https://stockfishchess.org/download/> herunterladen
   (Windows: `stockfish-windows-x86-64-*.zip`).
2. Das Archiv entpacken und den entpackten Ordner **oder** direkt die
   `.exe` hierher kopieren. Beides funktioniert:

   ```
   engine/stockfish-windows-x86-64-universal.exe
   engine/stockfish-windows-x86-64-universal/stockfish/stockfish-...exe
   ```

   Unterordner werden bis drei Ebenen tief durchsucht. Der Dateiname muss mit
   `stockfish` beginnen und eine Programmdatei sein (`.exe`, `.bin` oder ohne
   Endung; unter Windows zusätzlich `.bat`/`.cmd` für einen Wrapper, der die
   Engine mit festen Optionen startet) – Textdateien wie `Copying.txt` werden
   ignoriert.
3. Den Server neu starten.

Mehr ist nicht nötig: Die App fragt beim Start `/api/engine/status` ab und
schaltet automatisch auf die native Engine um, sobald eine gefunden wird. Nur
wenn unter **Einstellungen → Spielmodus → Engine** einmal von Hand etwas
ausgewählt wurde, bleibt diese Wahl bestehen und wird nicht überschrieben.

Ob die Engine gefunden wurde, steht im Hinweistext unter der Auswahl – dort
erscheint dann der Name, den die Engine selbst meldet (z. B. „Stockfish 19").

## Alternativer Pfad

Statt die Datei hierher zu kopieren, kann der Pfad auch über die
Umgebungsvariable `CHESS_ENGINE_PATH` gesetzt werden:

```bat
set CHESS_ENGINE_PATH=C:\Tools\stockfish\stockfish.exe
python app.py
```

## Warum nicht mitgeliefert?

Die Engine ist über 100 MB groß und steht unter der GPL. Sie wird deshalb
bewusst nicht mit dem Projekt verteilt, sondern nur lokal eingebunden. Solange
das Programm auf dem eigenen Rechner bleibt, entstehen daraus keine Pflichten.
