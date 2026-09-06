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
   `stockfish` beginnen und eine Programmdatei sein (`.exe` oder ohne
   Endung) – Textdateien wie `Copying.txt` werden ignoriert.
3. Den Server neu starten.
4. In der App unter **Einstellungen → Spielmodus → Engine** den Eintrag
   **Stockfish nativ (volle Stärke)** auswählen.

Ob die Engine gefunden wurde, steht direkt im Hinweistext unter der Auswahl.

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
