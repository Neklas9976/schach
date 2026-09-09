/**
 * Macht aus dem ESM-Paket chess.js ein klassisches Browserskript.
 *
 * Warum ueberhaupt: die Seite hat bewusst keinen Build-Schritt. Sie besteht aus
 * <script>-Tags, die static/ direkt ausliefern - GitHub Pages legt nichts
 * dazwischen. chess.js wird aber nur als ESM und CommonJS veroeffentlicht, und
 * ein <script type="module"> laeuft erst NACH allen klassischen Skripten. Die
 * Regel-Engine waere also noch nicht da, wenn app.js sie braucht.
 *
 * Statt deshalb einen Bundler in das Projekt zu holen, wird das Paket hier
 * einmal umgeschrieben und das Ergebnis eingecheckt. Zur Laufzeit bleibt alles
 * wie vorher: eine Datei, ein <script>-Tag, kein Werkzeug dazwischen.
 *
 * Der Trick traegt, weil der ESM-Build von chess.js sich selbst genuegt: keine
 * Importe, ein einziges export-Statement ganz am Ende. Genau das wird geprueft,
 * bevor irgendetwas geschrieben wird - laeuft chess.js kuenftig anders vom Band,
 * bricht dieses Skript laut ab, statt still eine kaputte Datei zu erzeugen.
 *
 * Aufruf:  node tools/vendor-chess-js.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'node_modules', 'chess.js', 'dist', 'esm', 'chess.js');
const target = path.join(root, 'static', 'vendor', 'chess.js');

if (!fs.existsSync(source)) {
  throw new Error(`chess.js nicht gefunden unter ${source} - erst "npm install" ausfuehren`);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'chess.js', 'package.json'), 'utf8'));
let code = fs.readFileSync(source, 'utf8');

// 1. Kein Import darf drin sein: sonst waere die Datei nicht eigenstaendig und
//    das Ergebnis wuerde im Browser beim ersten Aufruf scheitern.
const imports = code.match(/^\s*import[\s{'"]/gm);
if (imports) {
  throw new Error(`chess.js bringt jetzt ${imports.length} Import(e) mit - eine einzelne Datei reicht nicht mehr`);
}

// 2. Genau ein export-Statement, und zwar am Ende. Mehrere Exportstellen
//    hiessen, dass die Namen verstreut sind und das Ersetzen unten nicht mehr
//    alles erwischt.
const exports = [...code.matchAll(/^export\s*\{([^}]*)\};?\s*$/gm)];
if (exports.length !== 1) {
  throw new Error(`Erwartet war genau ein export-Statement, gefunden: ${exports.length}`);
}

const names = exports[0][1].split(',').map(s => s.trim()).filter(Boolean);
if (!names.includes('Chess')) {
  throw new Error('chess.js exportiert kein "Chess" mehr - der Umbau waere sinnlos');
}

// 3. Die Sourcemap-Zeile zeigt auf eine Datei, die nicht mitgeliefert wird.
//    Stehen bleiben wuerde sie im Browser einen 404 in der Konsole erzeugen.
code = code.replace(/^\/\/# sourceMappingURL=.*$/gm, '');

// 4. Das export-Statement wird zur Zuweisung an den globalen Namensraum.
const assignment = `global.ChessJs = { ${names.join(', ')} };`;
code = code.replace(exports[0][0], assignment);

const banner = `/**
 * chess.js ${pkg.version} - BSD-2-Clause, Copyright (c) 2025 Jeff Hlywa.
 * https://github.com/jhlywa/chess.js
 *
 * ERZEUGT - NICHT VON HAND AENDERN.
 * Quelle: node_modules/chess.js/dist/esm/chess.js
 * Erzeugt von: tools/vendor-chess-js.mjs
 *
 * Gegenueber dem Original ist nur zweierlei geaendert: das abschliessende
 * export-Statement wurde zur Zuweisung an den globalen Namensraum, und der
 * Verweis auf die nicht mitgelieferte Sourcemap ist entfernt. Der Rest ist
 * unveraendert - siehe ATTRIBUTIONS.md und LICENSE-chess.js.txt.
 */
(function (global) {
  'use strict';

`;

// Dieselbe Klammer wie in chess-engine.js: die Datei muss auch im Web Worker
// laden, wo es kein window gibt, und in der vm-Sandbox des Servers, wo eines
// gestellt wird.
const footer = `
})(typeof window !== 'undefined' ? window : self);
`;

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, banner + code.trimEnd() + footer, 'utf8');

// Die Lizenz muss mitreisen: BSD-2-Clause verlangt, dass der Copyright-Hinweis
// bei jeder Weitergabe dabei ist, und ausgeliefert wird hier alles in static/.
fs.copyFileSync(
  path.join(root, 'node_modules', 'chess.js', 'LICENSE'),
  path.join(root, 'static', 'vendor', 'LICENSE-chess.js.txt')
);

const size = fs.statSync(target).size;
console.log(`static/vendor/chess.js geschrieben: chess.js ${pkg.version}, ${size} Bytes, ${names.length} Exporte`);
