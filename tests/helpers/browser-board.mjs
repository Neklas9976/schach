/**
 * Gemeinsame Werkzeuge fuer die Browser-Tests am Schachbrett.
 *
 * Hier steht kein Test, sondern das, was jeder Browser-Test braucht: einen
 * statischen Server wie die veroeffentlichte Seite ihn hat, einen Browser,
 * eine frische Partie, echte Mausgesten und ein paar Abfragen auf den
 * sichtbaren Zustand des Bretts.
 *
 * Playwright ist bewusst keine Abhaengigkeit des Projekts. Es wird an den
 * ueblichen Stellen gesucht; findet sich nichts, ueberspringen die Tests sich
 * mit Begruendung, statt die Suite rot zu faerben. Mit PLAYWRIGHT_MODULE
 * laesst sich eine Installation ausserhalb des Projekts benennen.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Das Projektverzeichnis - zwei Ebenen ueber tests/helpers/. */
export const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/* ===================================================================== *
 * Playwright finden, ohne etwas zu installieren
 * ===================================================================== */

export async function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) candidates.push(process.env.PLAYWRIGHT_MODULE);
  candidates.push(path.join(ROOT, 'node_modules', 'playwright', 'index.js'));
  candidates.push(path.join(ROOT, 'node_modules', 'playwright-core', 'index.js'));

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const module = await import(pathToFileURL(candidate).href);
    // Je nach Bauart liegt die API am Modul selbst oder am default-Export.
    const api = module.chromium ? module : module.default;
    if (api && api.chromium) return api;
  }
  try {
    const module = await import('playwright');
    if (module.chromium) return module;
  } catch { /* nicht vorhanden - der Aufrufer ueberspringt dann */ }
  return null;
}

/**
 * Ein Browser, der wirklich startet.
 *
 * Bevorzugt den mitgelieferten Chromium; ist der nicht heruntergeladen, wird
 * der auf dem Rechner installierte Chrome genommen. Beides laedt nichts nach.
 */
export async function launchBrowser(playwright) {
  try {
    return await playwright.chromium.launch();
  } catch {
    return await playwright.chromium.launch({ channel: 'chrome' });
  }
}

/* ===================================================================== *
 * Ein statischer Server, so wie die Seite auch veroeffentlicht wird
 * ===================================================================== */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json'
};

export function startServer() {
  const server = http.createServer((req, res) => {
    const relative = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, relative);
    // Kein Ausbruch aus dem Projektverzeichnis.
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* ===================================================================== *
 * Brett-Werkzeuge
 * ===================================================================== */

/** Zeile 0 ist Reihe 8, Spalte 0 ist Linie a - so wie im Brett-DOM. */
export const SQ = (r, c) => `.square[data-row="${r}"][data-col="${c}"]`;

/**
 * Eine frische Partie im Zwei-Personen-Modus.
 *
 * Gegen den Computer waere jeder Test von der Engine abhaengig, die eine
 * Stellung unterschiedlich beantworten darf. Beide Farben von Hand zu ziehen
 * macht die Faelle deterministisch - und trifft genau den gemeldeten Fall,
 * denn Zwei-Personen ist die Voreinstellung des Programms.
 */
export async function openBoard(browser, baseUrl, { throttleFrames = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  const consoleErrors = [];
  page.on('console', message => {
    if (message.type() !== 'error') return;
    // Bei fehlgeschlagenen Anforderungen steht die Adresse nicht im Text,
    // sondern im Fundort der Meldung.
    const where = `${message.location()?.url || ''}`;
    // Der lokale Flask-Server laeuft hier nicht; sein Fehlen ist vorgesehen.
    if (where.includes('/api/engine/') || where.includes('favicon')) return;
    consoleErrors.push(`${message.text()} @ ${where}`);
  });
  page.on('pageerror', error => consoleErrors.push(`pageerror: ${error.message}`));

  await page.addInitScript(() => {
    try {
      localStorage.setItem('chess-ai-mode', JSON.stringify('human-vs-human'));
      localStorage.setItem('chess-ai-human-color', JSON.stringify('white'));
    } catch { /* privater Modus - dann eben die Vorgabewerte */ }
  });

  if (throttleFrames) {
    // Genau der Zustand, in dem der Freeze auftrat: der Bildtakt steht fast
    // still, waehrend die Seite sich fuer sichtbar und fokussiert haelt.
    await page.addInitScript(() => {
      window.__frameHz = 1;
      window.requestAnimationFrame = callback => window.setTimeout(() => callback(performance.now()), 1000);
      window.cancelAnimationFrame = handle => window.clearTimeout(handle);
    });
  }

  await page.goto(`${baseUrl}/index.html`);
  await page.waitForFunction(() => !!document.querySelector('.square[data-row="0"][data-col="0"]'));
  await page.waitForFunction(() => !!window.ChessEngine);
  return { page, consoleErrors };
}

/** Mitte eines Feldes in Ansichtskoordinaten. */
export async function squareCenter(page, r, c) {
  return page.evaluate(([r, c]) => {
    const box = document.querySelector(`.square[data-row="${r}"][data-col="${c}"]`).getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2, size: box.width };
  }, [r, c]);
}

/** Wartet, bis keine Figur mehr fliegt und kein Zielfeld mehr ausgeblendet ist. */
export function waitForAnimationRest(page, budgetMs = 3000) {
  return page.waitForFunction(() =>
    !document.body.classList.contains('piece-dragging') &&
    !document.querySelector('.move-animator') &&
    !document.querySelector('.animation-target-hidden'),
  null, { timeout: budgetMs, polling: 20 }).catch(() => { /* der Test meldet es deutlicher */ });
}

/**
 * Eine Figur ziehen - mit echten Maustasten, nicht mit erzeugten Ereignissen.
 *
 * Playwrights dragTo wird hier bewusst nicht benutzt: es prueft vor dem
 * Loslassen die Bedienbarkeit des Zielfeldes und wartet dabei auf einen
 * Zustand, den ein laufender Zeiger-Fang nicht hergibt. Maustaste, Bewegung,
 * Loslassen ist genau das, was ein Mensch tut.
 *
 * `settleFirst` wartet vorher die laufende Animation ab. Fuer Tests, die
 * gerade das Gegenteil pruefen wollen - einen Zug mitten in die Animation
 * hinein - wird es auf false gesetzt.
 */
export async function dragPiece(page, fr, fc, tr, tc, { settleFirst = true } = {}) {
  if (settleFirst) await waitForAnimationRest(page);

  const from = await squareCenter(page, fr, fc);
  const to = await squareCenter(page, tr, tc);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + (to.x - from.x) * 0.35, from.y + (to.y - from.y) * 0.35, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  const releasedAt = Date.now();
  await page.mouse.up();
  return releasedAt;
}

/**
 * Ab wann nimmt das Brett wieder einen Griff an?
 *
 * Gemessen am Zeiger-Fang: beginDrag nimmt ihn als Erstes, und nur dann, wenn
 * die Eingabe wirklich angenommen wurde. Das ist praeziser als das Warten auf
 * `piece-dragging`, das erst nach fuenf Pixeln Bewegung gesetzt wird.
 *
 * Laesst die Maustaste am Ende los, aendert also nichts am Spielzustand.
 */
export async function timeUntilBoardAcceptsDrag(page, r, c, startedAt, deadlineMs = 4000) {
  const at = await squareCenter(page, r, c);
  for (;;) {
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    const held = await page.evaluate(() => document.getElementById('chess-board').hasPointerCapture(1));
    await page.mouse.up();
    if (held) return Date.now() - startedAt;
    if (Date.now() - startedAt > deadlineMs) return null;
    await page.waitForTimeout(10);
  }
}

/** Alles, woran man einen haengengebliebenen Drag oder Zugrest erkennt. */
export async function boardState(page) {
  return page.evaluate(() => ({
    moves: [...document.querySelectorAll('#moves-list .move-cell')].map(cell => cell.textContent.trim()).filter(Boolean),
    turn: document.getElementById('turn-text').textContent.trim(),
    statusExtra: document.getElementById('status-extra').textContent.trim(),
    statusCard: document.getElementById('status-card').className,
    dragging: document.body.classList.contains('piece-dragging'),
    ghosts: document.querySelectorAll('.drag-ghost').length,
    hiddenSources: document.querySelectorAll('.drag-source-hidden').length,
    hiddenTargets: document.querySelectorAll('.animation-target-hidden').length,
    orphanAnimators: document.querySelectorAll('.move-animator').length,
    checkSquares: [...document.querySelectorAll('.square.check')].map(sq => `${sq.dataset.row},${sq.dataset.col}`),
    piecesOnBoard: document.querySelectorAll('.square .piece').length,
    fen: window.ChessEngine ? null : null
  }));
}

/**
 * Die Kernzusicherung: nach einem abgeschlossenen Vorgang darf vom Ziehen
 * nichts uebrig sein. Jede einzelne dieser Spuren stand bei der gemeldeten
 * Blockade im DOM.
 *
 * Es wird zuerst auf Ruhe gewartet und erst dann geprueft. Waehrend der
 * Zuganimation ist das Zielfeld absichtlich ausgeblendet - dort fliegt gerade
 * eine Kopie der Figur hin - und eine Pruefung mitten hinein wuerde gesundes
 * Verhalten als Rueckstand melden.
 */
export async function assertNoDragResidue(page, when, budgetMs = 2500) {
  await waitForAnimationRest(page, budgetMs);

  const state = await boardState(page);
  assert.equal(state.dragging, false, `${when}: body traegt noch piece-dragging`);
  assert.equal(state.ghosts, 0, `${when}: es haengt noch eine Ghost-Figur im DOM`);
  assert.equal(state.hiddenSources, 0, `${when}: ein Quellfeld ist noch ausgeblendet`);
  assert.equal(state.hiddenTargets, 0, `${when}: ein Zielfeld ist noch ausgeblendet`);
  assert.equal(state.orphanAnimators, 0, `${when}: eine Animationsfigur wurde nicht aufgeraeumt`);
  assert.equal(state.piecesOnBoard > 0, true, `${when}: auf dem Brett steht keine Figur mehr`);
  return state;
}

/**
 * Wartet, bis die Zugliste die erwartete Laenge hat - oder scheitert laut.
 *
 * Gezaehlt werden nur gefuellte Zellen. Die Liste legt jeden Zug in einer
 * Zeile mit zwei Feldern an, und das Feld der noch nicht gezogenen Farbe
 * steht als leere Zelle schon da - wer alle Zellen zaehlt, haelt einen
 * einzelnen weissen Zug bereits fuer zwei.
 */
export async function waitForMoveCount(page, count, budgetMs) {
  try {
    await page.waitForFunction(
      expected => [...document.querySelectorAll('#moves-list .move-cell')]
        .filter(cell => cell.textContent.trim()).length >= expected,
      count, { timeout: budgetMs, polling: 25 });
  } catch {
    const state = await boardState(page);
    assert.fail(`Zug Nr. ${count} kam nicht innerhalb von ${budgetMs} ms an. Zugliste: [${state.moves.join(', ')}], ` +
      `dragging=${state.dragging}, ghosts=${state.ghosts}, versteckteQuellen=${state.hiddenSources}`);
  }
}

/** Anzahl tatsaechlich notierter Halbzuege. */
export function playedMoveCount(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('#moves-list .move-cell')].filter(cell => cell.textContent.trim()).length);
}
