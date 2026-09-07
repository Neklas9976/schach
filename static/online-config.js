/**
 * Wo der Spielserver steht.
 *
 * Die Seite selbst ist eine reine Dateiablage (GitHub Pages) und kann keinen
 * Serverprozess betreiben - der laeuft woanders, und seine Adresse steht hier.
 * Diese eine Zeile ist alles, was nach dem Aufsetzen des Servers zu aendern
 * ist; die Anleitung dazu steht in server/README.md.
 *
 * Leer bedeutet: online spielen ist ausgeschaltet. Auf dem eigenen Rechner
 * wird auch ohne Eintrag ws://localhost:8787 versucht, damit das Ausprobieren
 * ohne Konfiguration laeuft.
 *
 * Muss mit wss:// beginnen, nicht ws:// - eine mit https ausgelieferte Seite
 * darf keine unverschluesselte Verbindung oeffnen, der Browser verbietet es.
 */
window.CHESS_SERVER_URL = '';
