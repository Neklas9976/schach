/**
 * Browser-Tests fuer die Eingabelatenz und die Nebenlaeufigkeit von Zuegen.
 *
 * Hintergrund: `moveTransaction` hielt das Brett frueher die ganze
 * Zuganimation lang gesperrt und lehnte jede Eingabe wortlos ab - je nach
 * Eingabeart 150 bis 320 Millisekunden. Gebraucht wird die Sperre nur fuer
 * den synchronen Lauf von commitMove; die Animation fuehrt inzwischen mit
 * `activeAnimation` ihre eigene Buchhaltung und wird vom naechsten Zug
 * eingeholt, statt ihn zu verbieten.
 *
 * Diese Datei sichert beide Haelften ab: dass das Brett schnell wieder
 * annimmt, und dass die gewonnene Freiheit den Spielzustand nicht beschaedigt.
 */
import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import {
  loadPlaywright, launchBrowser, startServer,
  openBoard, squareCenter, dragPiece, boardState,
  assertNoDragResidue, waitForMoveCount, waitForAnimationRest,
  timeUntilBoardAcceptsDrag, playedMoveCount
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

function boardTest(name, options, body) {
  test(name, async t => {
    if (skipReason) { t.skip(skipReason); return; }
    const { page, consoleErrors } = await openBoard(browser, baseUrl, options);
    try {
      await body({ page, consoleErrors, t });
      assert.deepEqual(consoleErrors, [], 'Die Browser-Konsole meldet Fehler');
    } finally {
      await page.close();
    }
  });
}

/**
 * Wie lange das Brett nach einem Zug taub bleibt.
 *
 * Die Obergrenze ist grosszuegig gewaehlt: gemessen liegt der Wert bei rund
 * 20-50 ms, und davon ist das meiste der Weg ueber die Fernsteuerung. Vor der
 * Entkopplung lagen dieselben Faelle bei 154, 312 und 317 ms. Die Schwelle
 * faellt also bei einer Rueckkehr der Sperre um, ohne auf einem langsamen
 * Rechner grundlos rot zu werden.
 */
const LOCK_BUDGET_MS = 120;

/* ===================================================================== *
 * 1 - Normaler Zug: wie schnell nimmt das Brett wieder an?
 * ===================================================================== */

boardTest('1: nach einem normalen Zug nimmt das Brett sofort wieder einen Griff an', {}, async ({ page, t }) => {
  const released = await dragPiece(page, 6, 4, 4, 4);               // 1. e4
  const acceptedAfter = await timeUntilBoardAcceptsDrag(page, 1, 4, released);

  assert.notEqual(acceptedAfter, null, 'Das Brett nahm innerhalb von vier Sekunden keinen Griff an');
  t.diagnostic(`Brett nimmt wieder an nach ${acceptedAfter} ms`);
  assert.equal(acceptedAfter <= LOCK_BUDGET_MS, true,
    `Das Brett blieb ${acceptedAfter} ms taub - die Eingabesperre haengt wieder an der Animation`);

  // Der Zug selbst ist logisch laengst fertig.
  assert.deepEqual((await boardState(page)).moves, ['e4']);
  await assertNoDragResidue(page, 'nach 1. e4');
});

boardTest('1b: auch der Klickzug gibt das Brett sofort wieder frei', {}, async ({ page, t }) => {
  // Ein Klickzug hat keinen Ablegepunkt, die Figur legt also die volle
  // Feldstrecke zurueck - das war vorher der langsamste Fall mit 317 ms.
  const from = await squareCenter(page, 6, 4);
  const to = await squareCenter(page, 4, 4);
  await page.mouse.click(from.x, from.y);
  await page.waitForTimeout(60);
  const released = Date.now();
  await page.mouse.click(to.x, to.y);

  const acceptedAfter = await timeUntilBoardAcceptsDrag(page, 1, 4, released);
  t.diagnostic(`Klickzug: Brett nimmt wieder an nach ${acceptedAfter} ms`);
  assert.equal(acceptedAfter !== null && acceptedAfter <= LOCK_BUDGET_MS, true,
    `Nach einem Klickzug blieb das Brett ${acceptedAfter} ms taub`);
  assert.deepEqual((await boardState(page)).moves, ['e4']);
});

/* ===================================================================== *
 * 2 + 5 - Schnelle Zugfolgen
 * ===================================================================== */

boardTest('2: schnelle aufeinanderfolgende Zuege kommen alle an', {}, async ({ page }) => {
  // Ohne Wartezeit zwischen den Zuegen - jeder Drop faellt mitten in die
  // Animation des vorigen.
  const line = [[6, 4, 4, 4], [1, 4, 3, 4], [7, 6, 5, 5], [0, 1, 2, 2]];
  for (const [fr, fc, tr, tc] of line) {
    await dragPiece(page, fr, fc, tr, tc, { settleFirst: false });
  }
  await waitForMoveCount(page, 4, 4000);
  const state = await assertNoDragResidue(page, 'nach vier schnellen Zuegen');
  assert.deepEqual(state.moves, ['e4', 'e5', 'Nf3', 'Nc6'],
    `Die schnelle Folge kam falsch an: ${state.moves.join(', ')}`);
});

boardTest('5: zwoelf schnelle Halbzuege hintereinander, ohne Neuladen', {}, async ({ page }) => {
  const line = [
    [6, 4, 4, 4, 'e4'], [1, 4, 3, 4, 'e5'],
    [7, 6, 5, 5, 'Nf3'], [0, 1, 2, 2, 'Nc6'],
    [7, 5, 4, 2, 'Bc4'], [0, 5, 3, 2, 'Bc5'],
    [7, 4, 7, 6, 'O-O'], [0, 6, 2, 5, 'Nf6'],
    [6, 3, 5, 3, 'd3'], [1, 3, 2, 3, 'd6'],
    [7, 2, 5, 4, 'Be3'], [0, 2, 4, 6, 'Bg4']
  ];
  for (const [fr, fc, tr, tc] of line) {
    await dragPiece(page, fr, fc, tr, tc, { settleFirst: false });
  }
  await waitForMoveCount(page, line.length, 6000);
  const state = await assertNoDragResidue(page, 'nach zwoelf schnellen Halbzuegen');
  assert.deepEqual(state.moves, line.map(entry => entry[4]),
    `Die Partie lief anders als erwartet: ${state.moves.join(', ')}`);
});

/* ===================================================================== *
 * 3 - Ein Zug mitten in die laufende Animation hinein
 * ===================================================================== */

boardTest('3: ein Zug mitten in die laufende Animation holt die vorige ein', {}, async ({ page }) => {
  await dragPiece(page, 6, 4, 4, 4);                                 // 1. e4
  await waitForMoveCount(page, 1, 2500);

  // Sofort der Gegenzug, ohne die Animation abzuwarten. Genau hier lag die
  // Sperre, und genau hier muss die vorige Animation eingeholt werden.
  await dragPiece(page, 1, 4, 3, 4, { settleFirst: false });         // 1... e5
  await waitForMoveCount(page, 2, 2500);

  // Es darf nie mehr als eine Animation gleichzeitig geben.
  const overlapping = await page.evaluate(() => document.querySelectorAll('.animation-target-hidden').length);
  assert.equal(overlapping <= 2, true,
    `Es sind ${overlapping} Zielfelder gleichzeitig ausgeblendet - zwei Animationen ueberlagern sich`);

  const state = await assertNoDragResidue(page, 'nach dem Zug in die Animation hinein');
  assert.deepEqual(state.moves, ['e4', 'e5']);
  assert.match(state.turn, /Weiss ist am Zug|Weiß ist am Zug/);
});

/* ===================================================================== *
 * 4 - Schachzug und unmittelbare Antwort
 * ===================================================================== */

boardTest('4: Schachgebot und Antwortzug unmittelbar danach', {}, async ({ page, t }) => {
  await dragPiece(page, 6, 4, 5, 4); await waitForMoveCount(page, 1, 2500);   // 1. e3
  await dragPiece(page, 1, 3, 3, 3); await waitForMoveCount(page, 2, 2500);   // 1... d5
  await dragPiece(page, 7, 4, 6, 4); await waitForMoveCount(page, 3, 2500);   // 2. Ke2

  const released = await dragPiece(page, 0, 2, 4, 6);                          // 2... Bg4+
  await waitForMoveCount(page, 4, 2500);

  const atCheck = await boardState(page);
  assert.equal(atCheck.moves[3], 'Bg4+', `Das Schachgebot wurde als "${atCheck.moves[3]}" notiert`);
  assert.deepEqual(atCheck.checkSquares, ['6,4'], 'Das Feld des weissen Koenigs ist nicht als Schach markiert');
  assert.match(atCheck.statusCard, /check-state/);

  // Und Weiss muss sofort antworten duerfen, nicht erst nach der Animation.
  const acceptedAfter = await timeUntilBoardAcceptsDrag(page, 7, 6, released);
  t.diagnostic(`Nach dem Schachgebot nimmt das Brett wieder an nach ${acceptedAfter} ms`);
  assert.equal(acceptedAfter !== null && acceptedAfter <= LOCK_BUDGET_MS, true,
    `Nach dem Schachgebot blieb das Brett ${acceptedAfter} ms taub`);

  await dragPiece(page, 7, 6, 5, 5, { settleFirst: false });                   // 3. Nf3 pariert
  await waitForMoveCount(page, 5, 2500);
  const after = await assertNoDragResidue(page, 'nach der Antwort auf das Schach');
  assert.equal(after.moves[4], 'Nf3');
  assert.deepEqual(after.checkSquares, [], 'Die Schach-Markierung steht noch, obwohl pariert wurde');
});

/* ===================================================================== *
 * 6 - Gedrosselter Bildtakt
 * ===================================================================== */

boardTest('6: bei gedrosseltem Bildtakt bleibt die Partie korrekt und schnell',
  { throttleFrames: true }, async ({ page, t }) => {
    const frameGap = await page.evaluate(() => new Promise(resolve => {
      const started = performance.now();
      requestAnimationFrame(() => resolve(performance.now() - started));
    }));
    assert.equal(frameGap > 500, true, `Die Drosselung greift nicht - ein Frame kam nach ${Math.round(frameGap)} ms`);

    const line = [
      [6, 4, 4, 4, 'e4'], [1, 4, 3, 4, 'e5'],
      [7, 6, 5, 5, 'Nf3'], [0, 1, 2, 2, 'Nc6'],
      [7, 5, 4, 2, 'Bc4'], [0, 5, 3, 2, 'Bc5']
    ];
    const released = await dragPiece(page, ...line[0].slice(0, 4));
    const acceptedAfter = await timeUntilBoardAcceptsDrag(page, 1, 4, released);
    t.diagnostic(`Bei 1 Hz Bildtakt nimmt das Brett wieder an nach ${acceptedAfter} ms`);
    assert.equal(acceptedAfter !== null && acceptedAfter <= LOCK_BUDGET_MS, true,
      `Bei gedrosseltem Bildtakt blieb das Brett ${acceptedAfter} ms taub`);

    for (const entry of line.slice(1)) {
      await dragPiece(page, ...entry.slice(0, 4), { settleFirst: false });
    }
    await waitForMoveCount(page, line.length, 6000);
    const state = await assertNoDragResidue(page, 'nach der Partie bei gedrosseltem Bildtakt');
    assert.deepEqual(state.moves, line.map(entry => entry[4]),
      `Bei gedrosseltem Bildtakt lief die Partie falsch: ${state.moves.join(', ')}`);
  });

/* ===================================================================== *
 * 7 - Kein doppelter Zug durch schnelle Zeigerereignisse
 * ===================================================================== */

boardTest('7: ein doppelt zugestelltes pointerup erzeugt keinen zweiten Zug', {}, async ({ page }) => {
  const from = await squareCenter(page, 6, 4);
  const to = await squareCenter(page, 4, 4);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();

  // Dasselbe Loslassen noch einmal, direkt an beide Empfaenger. Genau das
  // waere der Weg zu einem zweiten Zug aus einer einzigen Geste.
  await page.evaluate(([x, y]) => {
    for (const target of [document.getElementById('chess-board'), window]) {
      target.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
        button: 0, buttons: 0, clientX: x, clientY: y
      }));
    }
  }, [to.x, to.y]);

  await waitForMoveCount(page, 1, 2500);
  await waitForAnimationRest(page);
  const state = await boardState(page);
  assert.deepEqual(state.moves, ['e4'], `Aus einer Geste wurden mehrere Zuege: ${state.moves.join(', ')}`);
  assert.equal(await playedMoveCount(page), 1, 'Die Zugliste enthaelt mehr als einen Zug');
});

boardTest('7b: hektisches Klicken auf eigene Figuren beschaedigt den Zustand nicht', {}, async ({ page }) => {
  // Zwanzig Klicks quer ueber das Brett, so schnell die Fernsteuerung sie
  // schickt: auf eigene Figuren, fremde Figuren und leere Felder.
  const targets = [[6, 4], [4, 4], [7, 1], [5, 2], [1, 4], [0, 3], [6, 0], [4, 0], [7, 6], [5, 5]];
  for (const [r, c] of targets) {
    const at = await squareCenter(page, r, c);
    await page.mouse.click(at.x, at.y, { delay: 0 });
  }
  await waitForAnimationRest(page);

  const state = await assertNoDragResidue(page, 'nach hektischem Klicken');
  // Der Zustand muss in sich stimmig sein: die Zugliste und das Zugrecht
  // duerfen sich nicht widersprechen, und die Figurenzahl muss plausibel sein.
  const consistent = await page.evaluate(() => {
    const played = [...document.querySelectorAll('#moves-list .move-cell')].filter(c => c.textContent.trim()).length;
    const turnText = document.getElementById('turn-text').textContent;
    const whiteToMove = /Wei(ss|ß)/.test(turnText);
    return { played, whiteToMove, pieces: document.querySelectorAll('.square .piece').length };
  });
  assert.equal(consistent.pieces >= 30, true, `Es stehen nur noch ${consistent.pieces} Figuren auf dem Brett`);
  assert.equal(consistent.whiteToMove, consistent.played % 2 === 0,
    `Zugrecht und Zugliste widersprechen sich: ${consistent.played} Halbzuege, Weiss am Zug = ${consistent.whiteToMove}`);
  assert.equal(state.moves.length, consistent.played);
});

boardTest('7c: zwei Zuege derselben Farbe hintereinander sind unmoeglich', {}, async ({ page }) => {
  await dragPiece(page, 6, 4, 4, 4);                                 // 1. e4
  await waitForMoveCount(page, 1, 2500);

  // Sofort noch ein weisser Zug, mitten in die Animation. Das Zugrecht steht
  // bereits bei Schwarz, also muss er folgenlos abprallen.
  await dragPiece(page, 6, 3, 4, 3, { settleFirst: false });          // versuchtes d4
  await page.waitForTimeout(400);

  const state = await assertNoDragResidue(page, 'nach dem zweiten weissen Zugversuch');
  assert.deepEqual(state.moves, ['e4'], `Weiss konnte zweimal hintereinander ziehen: ${state.moves.join(', ')}`);
  assert.match(state.turn, /Schwarz ist am Zug/);
});
