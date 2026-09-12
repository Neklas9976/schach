/**
 * Browser-Regressionstests fuer das Ziehen und Ablegen einer Figur.
 *
 * Warum diese Datei neben ui-interaction-regression.test.mjs steht: jene
 * prueft den Quelltext von app.js mit regulaeren Ausdruecken. Das haelt
 * Architekturentscheidungen fest, kann aber kein Verhalten sehen - und der
 * Fehler, den diese Datei absichert, war unter 325 gruenen Tests am Leben.
 *
 * Hier wird nichts gelesen, hier wird gespielt: echter Chrome, echte
 * Maustasten, echte Koordinaten, und danach wird der sichtbare Zustand des
 * Bretts befragt.
 *
 * Der eigentliche Fehler: finishDrag fuehrte den Zug in einem
 * requestAnimationFrame aus. Bei vollem Bildtakt sind das unsichtbare 16 ms,
 * bei gedrosseltem Takt eine Sekunde und mehr - die Figur sprang zurueck und
 * der Zug kam erst, wenn eine spaetere Eingabe den Takt weckte. Deshalb laeuft
 * jeder Kernfall hier zweimal: einmal normal, einmal mit auf 1 Hz gedrosseltem
 * requestAnimationFrame. Der gedrosselte Durchgang ist der Test, der den
 * Fehler gefunden haette.
 *
 * Die Werkzeuge liegen in helpers/browser-board.mjs, geteilt mit
 * move-latency.browser.test.mjs.
 */
import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import {
  loadPlaywright, launchBrowser, startServer,
  openBoard, squareCenter, dragPiece, boardState,
  assertNoDragResidue, waitForMoveCount
} from './helpers/browser-board.mjs';

/* ===================================================================== *
 * Aufbau
 * ===================================================================== */

let playwright = null;
let browser = null;
let baseUrl = null;
let server = null;
let skipReason = null;

before(async () => {
  playwright = await loadPlaywright();
  if (!playwright) {
    skipReason = 'Playwright ist nicht verfuegbar (PLAYWRIGHT_MODULE setzen oder playwright im Projekt bereitstellen).';
    return;
  }
  try {
    browser = await launchBrowser(playwright);
  } catch (error) {
    skipReason = `Kein startbarer Browser: ${error.message.split('\n')[0]}`;
    return;
  }
  const started = await startServer();
  server = started.server;
  baseUrl = `http://127.0.0.1:${started.port}`;
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

/** Nimmt dem Test den Aufbau ab und ueberspringt ihn sauber, wenn nichts da ist. */
function boardTest(name, options, body) {
  test(name, async t => {
    if (skipReason) { t.skip(skipReason); return; }
    const { page, consoleErrors } = await openBoard(browser, baseUrl, options);
    try {
      await body({ page, consoleErrors });
      assert.deepEqual(consoleErrors, [], 'Die Browser-Konsole meldet Fehler');
    } finally {
      await page.close();
    }
  });
}

/* ===================================================================== *
 * TEST 1 - Weiss zieht, Schwarz zieht, Weiss zieht wieder
 * ===================================================================== */

for (const throttled of [false, true]) {
  const label = throttled ? ' (bei gedrosseltem Bildtakt)' : '';

  boardTest(`TEST 1: Weiss zieht, Schwarz zieht, Weiss zieht wieder${label}`, { throttleFrames: throttled }, async ({ page }) => {
    await dragPiece(page, 6, 4, 4, 4);            // 1. e4
    await waitForMoveCount(page, 1, 2500);
    let state = await assertNoDragResidue(page, 'nach 1. e4');
    assert.deepEqual(state.moves, ['e4']);
    assert.match(state.turn, /Schwarz ist am Zug/);

    await dragPiece(page, 1, 4, 3, 4);            // 1... e5
    await waitForMoveCount(page, 2, 2500);
    state = await assertNoDragResidue(page, 'nach 1... e5');
    assert.deepEqual(state.moves, ['e4', 'e5']);
    assert.match(state.turn, /Weiss ist am Zug|Weiß ist am Zug/);

    await dragPiece(page, 7, 6, 5, 5);            // 2. Nf3
    await waitForMoveCount(page, 3, 2500);
    state = await assertNoDragResidue(page, 'nach 2. Sf3');
    assert.equal(state.moves.length, 3, 'Weiss konnte nach dem schwarzen Zug nicht wieder ziehen');
    assert.match(state.turn, /Schwarz ist am Zug/);
  });

  /* =================================================================== *
   * TEST 2 - Schwarz gibt Schach, Weiss antwortet unmittelbar
   * =================================================================== */

  boardTest(`TEST 2: Schwarz setzt Schach, Weiss kann sofort antworten${label}`, { throttleFrames: throttled }, async ({ page }) => {
    await dragPiece(page, 6, 4, 5, 4);            // 1. e3
    await waitForMoveCount(page, 1, 2500);
    await dragPiece(page, 1, 3, 3, 3);            // 1... d5
    await waitForMoveCount(page, 2, 2500);
    await dragPiece(page, 7, 4, 6, 4);            // 2. Ke2
    await waitForMoveCount(page, 3, 2500);

    // Der eigentliche Fall: der schwarze Laeufer setzt den weissen Koenig ins
    // Schach. Genau hier hing das Brett.
    const releasedAt = await dragPiece(page, 0, 2, 4, 6);   // 2... Lg4+
    await waitForMoveCount(page, 4, 2500);
    const landedAfter = Date.now() - releasedAt;

    const state = await assertNoDragResidue(page, 'nach 2... Lg4+');

    assert.equal(state.moves[3], 'Bg4+', `Der schwarze Zug wurde nicht als Schachgebot notiert: ${state.moves.join(', ')}`);
    assert.deepEqual(state.checkSquares, ['6,4'], 'Das Feld des weissen Koenigs (e2) ist nicht als Schach markiert');
    assert.match(state.statusCard, /check-state/, 'Die Statuskarte zeigt keinen Schach-Zustand');
    assert.match(state.statusExtra, /Schach/, `Die Statuszeile meldet kein Schach: "${state.statusExtra}"`);
    assert.match(state.turn, /Weiss ist am Zug|Weiß ist am Zug/);

    // "sofort abgeschlossen": ohne den Fix wartete der Zug auf den naechsten
    // Frame - bei gedrosseltem Takt also rund eine Sekunde.
    assert.equal(landedAfter < 700, true,
      `Der schwarze Zug brauchte ${landedAfter} ms bis zum Abschluss - das ist die Frame-Abhaengigkeit`);

    // Und jetzt muss Weiss aus dem Schach heraus ziehen koennen: Sg1-f3
    // stellt sich auf die Diagonale g4-e2 und hebt das Schach auf.
    await dragPiece(page, 7, 6, 5, 5);            // 3. Nf3
    await waitForMoveCount(page, 5, 2500);
    const after = await assertNoDragResidue(page, 'nach 3. Sf3');
    assert.equal(after.moves.length, 5, 'Weiss konnte nach dem Schachgebot nicht antworten');
    assert.deepEqual(after.checkSquares, [], 'Die Schach-Markierung steht noch, obwohl das Schach pariert ist');
    assert.match(after.turn, /Schwarz ist am Zug/);
  });

  /* =================================================================== *
   * TEST 5 - viele Zuege hintereinander, ohne Neuladen
   * =================================================================== */

  boardTest(`TEST 5: zehn Halbzuege am Stueck ohne Neuladen${label}`, { throttleFrames: throttled }, async ({ page }) => {
    const line = [
      [6, 4, 4, 4, 'e4'], [1, 4, 3, 4, 'e5'],
      [7, 6, 5, 5, 'Nf3'], [0, 1, 2, 2, 'Nc6'],
      [7, 5, 4, 2, 'Bc4'], [0, 5, 3, 2, 'Bc5'],
      [7, 4, 7, 6, 'O-O'],                              // Rochade ueber das Koenigsfeld
      [0, 6, 2, 5, 'Nf6'],
      [6, 3, 5, 3, 'd3'], [1, 3, 2, 3, 'd6']
    ];

    for (let i = 0; i < line.length; i++) {
      const [fr, fc, tr, tc, expected] = line[i];
      await dragPiece(page, fr, fc, tr, tc);
      await waitForMoveCount(page, i + 1, 2500);
      const state = await assertNoDragResidue(page, `nach Halbzug ${i + 1} (${expected})`);
      assert.equal(state.moves[i], expected,
        `Halbzug ${i + 1} wurde als "${state.moves[i]}" statt "${expected}" notiert`);
    }

    const final = await boardState(page);
    assert.equal(final.moves.length, 10, 'Nicht alle zehn Halbzuege sind angekommen');
  });
}

/* ===================================================================== *
 * TEST 3 - der Drag wird abgebrochen
 * ===================================================================== */

boardTest('TEST 3: ein abgebrochener Drag laesst das Brett voll benutzbar', {}, async ({ page }) => {
  const from = await squareCenter(page, 6, 4);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, from.y - 70, { steps: 4 });

  // Mitten im Zug: der Ghost haengt am Zeiger, das Quellfeld ist leer.
  const during = await boardState(page);
  assert.equal(during.dragging, true, 'Der Drag ist gar nicht erst angelaufen');
  assert.equal(during.ghosts, 1, 'Es haengt keine Ghost-Figur am Zeiger');
  assert.equal(during.hiddenSources, 1, 'Das Quellfeld ist nicht ausgeblendet');

  // Ein echtes pointercancel laesst sich mit der Maus nicht ausloesen - der
  // Browser schickt es bei Gesten, die er selbst uebernimmt. Das Ereignis wird
  // deshalb an denselben Empfaenger geschickt, den der Browser adressieren
  // wuerde: das Brett, mit der Zeiger-Kennung der Maus.
  await page.evaluate(() => {
    document.getElementById('chess-board').dispatchEvent(new PointerEvent('pointercancel', {
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse'
    }));
  });

  await assertNoDragResidue(page, 'nach pointercancel');
  await page.mouse.up();
  await assertNoDragResidue(page, 'nach dem Loslassen im Anschluss an pointercancel');

  // Und das Brett muss weiterhin spielbar sein.
  await dragPiece(page, 6, 4, 4, 4);
  await waitForMoveCount(page, 1, 2500);
  const state = await assertNoDragResidue(page, 'nach dem Zug im Anschluss an den Abbruch');
  assert.deepEqual(state.moves, ['e4'], 'Nach einem Abbruch nimmt das Brett keinen Zug mehr an');
});

/* ===================================================================== *
 * TEST 4 - das Loslassen geht verloren oder kommt zur Unzeit
 * ===================================================================== */

boardTest('TEST 4a: ausserhalb des Bretts losgelassen - kein haengender Drag', {}, async ({ page }) => {
  const from = await squareCenter(page, 6, 3);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, from.y - 60, { steps: 3 });
  await page.mouse.move(12, 12, { steps: 6 });    // weit weg vom Brett
  await page.mouse.up();

  await assertNoDragResidue(page, 'nach dem Loslassen ausserhalb des Bretts');
  const state = await boardState(page);
  assert.deepEqual(state.moves, [], 'Ein Loslassen neben dem Brett darf keinen Zug erzeugen');

  await dragPiece(page, 6, 3, 4, 3);
  await waitForMoveCount(page, 1, 2500);
  assert.deepEqual((await boardState(page)).moves, ['d4'], 'Das Brett nimmt danach keinen Zug mehr an');
});

boardTest('TEST 4b: verlorener Zeiger-Fang mitten im Zug - kein haengender Drag', {}, async ({ page }) => {
  const from = await squareCenter(page, 6, 4);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, from.y - 70, { steps: 4 });
  assert.equal((await boardState(page)).dragging, true, 'Der Drag ist nicht angelaufen');

  // Genau der Fall aus dem Befund: der Fang wird entzogen, das Brett hoert
  // danach nichts mehr. Frueher blieb die Sitzung dadurch fuer immer offen.
  await page.evaluate(() => {
    const board = document.getElementById('chess-board');
    try { board.releasePointerCapture(1); } catch { /* schon weg */ }
    board.dispatchEvent(new PointerEvent('lostpointercapture', {
      bubbles: true, pointerId: 1, pointerType: 'mouse'
    }));
  });

  await assertNoDragResidue(page, 'nach lostpointercapture');
  await page.mouse.up();
  await assertNoDragResidue(page, 'nach dem Loslassen im Anschluss');

  await dragPiece(page, 6, 4, 4, 4);
  await waitForMoveCount(page, 1, 2500);
  assert.deepEqual((await boardState(page)).moves, ['e4'], 'Nach dem verlorenen Fang nimmt das Brett keinen Zug mehr an');
});

boardTest('TEST 4c: das Fenster verliert mitten im Zug den Fokus', {}, async ({ page }) => {
  const from = await squareCenter(page, 6, 2);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, from.y - 70, { steps: 4 });
  assert.equal((await boardState(page)).dragging, true, 'Der Drag ist nicht angelaufen');

  /* Grenze dieses Tests, offen benannt.
   *
   * Ein echtes Alt-Tab laesst sich ferngesteuert nicht erzeugen: eine zweite
   * Seite nach vorn zu holen laesst diese hier nachweislich fokussiert und
   * sichtbar - geprueft, es kommt kein blur. Verschickt wird deshalb dasselbe
   * Ereignis, das der Browser beim Fokusverlust an dasselbe Ziel schickt.
   * Das sichert den Behandlungspfad ab; dass das Betriebssystem ihn ausloest,
   * bleibt ungeprueft.
   */
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));

  await assertNoDragResidue(page, 'nach dem Fokusverlust');
  await page.mouse.up();
  await assertNoDragResidue(page, 'nach dem Loslassen im Anschluss an den Fokusverlust');

  await dragPiece(page, 6, 2, 4, 2);
  await waitForMoveCount(page, 1, 2500);
  assert.deepEqual((await boardState(page)).moves, ['c4'], 'Nach dem Fokusverlust nimmt das Brett keinen Zug mehr an');
});

/* ===================================================================== *
 * Die Zusicherung, die den Fehler ueberhaupt erst sichtbar macht
 * ===================================================================== */

boardTest('Der Zug haengt nicht am Bildtakt: er landet im Loslassen selbst', { throttleFrames: true }, async ({ page }) => {
  // Belegt, dass die Drosselung wirklich greift - sonst wuerde dieser Test
  // stillschweigend nichts pruefen.
  const frameGap = await page.evaluate(() => new Promise(resolve => {
    const started = performance.now();
    requestAnimationFrame(() => resolve(performance.now() - started));
  }));
  assert.equal(frameGap > 500, true, `Die Drosselung greift nicht - ein Frame kam nach ${Math.round(frameGap)} ms`);

  const releasedAt = await dragPiece(page, 6, 4, 4, 4);
  await waitForMoveCount(page, 1, 2500);
  const landedAfter = Date.now() - releasedAt;

  assert.equal(landedAfter < 700, true,
    `Der Zug brauchte ${landedAfter} ms, obwohl ein Frame ueber 1000 ms braucht - er wartet noch auf einen Frame`);
  await assertNoDragResidue(page, 'nach dem Zug bei gedrosseltem Bildtakt');
});
