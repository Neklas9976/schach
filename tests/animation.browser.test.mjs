/**
 * Browser-Tests fuer die Zuganimationen.
 *
 * Der Grundsatz, den diese Datei absichert: die Animation ist reine
 * Darstellung. Sie darf die Partie weder aufhalten noch verfaelschen. Deshalb
 * prueft fast jeder Test hier am Ende dieselbe Invariante - die Stellung, die
 * auf dem Brett zu sehen ist, muss der Stellung entsprechen, die die
 * Regel-Engine aus der Zugliste ableitet.
 *
 * Was sich in Stufe 3 geaendert hat und hier festgehalten wird:
 *
 *  - Eine gezogene Figur fliegt nicht mehr. Die Hand hat die Bewegung schon
 *    gemacht; sie ein zweites Mal zu animieren war der Grund, warum die
 *    Animation an der Mausposition hing.
 *  - Die Dauer waechst mit der Strecke, aber unterlinear - ein Einfelderzug
 *    ist kuerzer als einer ueber das halbe Brett, aber nicht siebenmal.
 *  - Die geschlagene Figur weicht erst, wenn die schlagende ankommt.
 */
import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import {
  loadPlaywright, launchBrowser, startServer,
  openBoard, squareCenter, dragPiece, boardState,
  waitForMoveCount, waitForAnimationRest, timeUntilBoardAcceptsDrag
} from './helpers/browser-board.mjs';

/* ===================================================================== *
 * Aufbau
 * ===================================================================== */

let browser = null;
let baseUrl = null;
let server = null;
let skipReason = null;

before(async () => {
  const playwright = await loadPlaywright();
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

/* ===================================================================== *
 * Werkzeuge
 * ===================================================================== */

/** Einen Zug per Klick eingeben - so fliegt die Figur wirklich. */
async function clickMove(page, fr, fc, tr, tc) {
  await waitForAnimationRest(page);
  const from = await squareCenter(page, fr, fc);
  const to = await squareCenter(page, tr, tc);
  await page.mouse.click(from.x, from.y);
  await page.waitForTimeout(40);
  const releasedAt = Date.now();
  await page.mouse.click(to.x, to.y);
  return releasedAt;
}

/**
 * Beobachtet, was waehrend eines Zuges an Animationen entsteht.
 *
 * Gemessen wird aus der Seite heraus mit einem kurzen Takt, damit auch eine
 * Animation von 150 ms mehrfach gesehen wird.
 */
async function observeAnimation(page, act, settleMs = 800) {
  await waitForAnimationRest(page);
  await page.evaluate(() => {
    window.__anim = { peakAnimators: 0, peakHidden: 0, items: [], startedAt: null };
    const seen = new WeakSet();
    window.__animTimer = setInterval(() => {
      const animators = document.querySelectorAll('.move-animator');
      if (animators.length && window.__anim.startedAt === null) window.__anim.startedAt = Date.now();
      window.__anim.peakAnimators = Math.max(window.__anim.peakAnimators, animators.length);
      window.__anim.peakHidden = Math.max(window.__anim.peakHidden,
        document.querySelectorAll('.animation-target-hidden').length);
      for (const element of animators) {
        if (seen.has(element)) continue;
        seen.add(element);
        const timing = element.getAnimations()[0]?.effect?.getTiming?.();
        window.__anim.items.push({
          kind: element.classList.contains('captured') ? 'captured' : 'travel',
          delay: Math.round(timing?.delay || 0),
          duration: Math.round(timing?.duration || 0)
        });
      }
    }, 4);
  });

  const releasedAt = await act();
  await page.waitForTimeout(settleMs);
  const observed = await page.evaluate(() => {
    clearInterval(window.__animTimer);
    return window.__anim;
  });
  await waitForAnimationRest(page);
  return { ...observed, releasedAt };
}

/**
 * Die Invariante, die alles zusammenhaelt.
 *
 * Links die Stellung, die auf dem Brett steht. Rechts die Stellung, die die
 * Regel-Engine bekommt, wenn sie die notierte Partie von der Grundstellung an
 * nachspielt. Beides muss Feld fuer Feld uebereinstimmen - sonst hat die
 * Darstellung sich von der Partie geloest, und genau das ist die Klasse von
 * Fehler, gegen die eine Animation abgesichert gehoert.
 */
async function assertBoardMatchesEngine(page, when) {
  await waitForAnimationRest(page);
  const result = await page.evaluate(() => {
    const dom = [];
    const doubles = [];
    for (let r = 0; r < 8; r++) {
      const row = [];
      for (let c = 0; c < 8; c++) {
        const square = document.querySelector(`.square[data-row="${r}"][data-col="${c}"]`);
        const pieces = square.querySelectorAll('.piece');
        if (pieces.length > 1) doubles.push(`${r},${c} traegt ${pieces.length} Figuren`);
        row.push(pieces[0] ? pieces[0].dataset.piece : null);
      }
      dom.push(row);
    }

    const notated = [...document.querySelectorAll('#moves-list .move-cell')]
      .map(cell => cell.textContent.trim()).filter(Boolean);
    let position = window.ChessEngine.createInitialState();
    for (const san of notated) {
      const move = window.ChessEngine.moveFromSan(position, san.replace(/[+#!?]/g, ''));
      if (!move) return { failure: `Notation nicht aufloesbar: ${san}` };
      position = window.ChessEngine.applyMove(position, move);
    }
    return {
      dom, engine: position.board, turn: position.turn, doubles,
      orphanAnimators: document.querySelectorAll('.move-animator').length,
      orphanGhosts: document.querySelectorAll('.drag-ghost').length,
      stillHidden: document.querySelectorAll('.animation-target-hidden').length,
      moveCount: notated.length
    };
  });

  assert.equal(result.failure, undefined, `${when}: ${result.failure}`);
  assert.deepEqual(result.doubles, [], `${when}: doppelte Figuren auf einem Feld`);
  assert.equal(result.orphanAnimators, 0, `${when}: verwaiste Animationsfigur im DOM`);
  assert.equal(result.orphanGhosts, 0, `${when}: verwaiste Ghost-Figur im DOM`);
  assert.equal(result.stillHidden, 0, `${when}: ein Zielfeld ist dauerhaft ausgeblendet`);
  assert.deepEqual(result.dom, result.engine,
    `${when}: das Brett zeigt eine andere Stellung als die Regel-Engine aus der Zugliste ableitet`);
  return result;
}

/* ===================================================================== *
 * 1 - Normale Bewegung
 * ===================================================================== */

boardTest('Bewegung: eine gezogene Figur wird nicht noch einmal animiert', {}, async ({ page }) => {
  const observed = await observeAnimation(page, () => dragPiece(page, 6, 4, 4, 4, { settleFirst: false }));

  // Die Hand hat die Figur schon abgelegt. Eine Animation von dort aus haette
  // an der Mausposition gehangen - je nach Treffgenauigkeit ein Nachzieher.
  assert.equal(observed.peakAnimators, 0,
    `Ein gezogener Zug hat ${observed.peakAnimators} Animationsfiguren erzeugt`);
  assert.equal(observed.peakHidden, 0,
    'Das Zielfeld wurde ausgeblendet, obwohl dort nichts hinfliegt - die Figur waere kurz unsichtbar');

  await assertBoardMatchesEngine(page, 'nach einem gezogenen Zug');
});

boardTest('Bewegung: ein Klickzug fliegt, von Feldmitte zu Feldmitte', {}, async ({ page }) => {
  const observed = await observeAnimation(page, () => clickMove(page, 6, 4, 5, 4));   // 1. e3

  assert.equal(observed.peakAnimators, 1, 'Der Klickzug hat keine Figur fliegen lassen');
  assert.equal(observed.items[0].kind, 'travel');
  assert.equal(observed.peakHidden, 1, 'Das Zielfeld war nicht ausgeblendet - die Figur waere doppelt zu sehen');
  await assertBoardMatchesEngine(page, 'nach einem Klickzug');
});

boardTest('Bewegung: die Dauer waechst mit der Strecke, aber unterlinear', {}, async ({ page, t }) => {
  const kurz = await observeAnimation(page, () => clickMove(page, 6, 4, 5, 4));       // 1. e3, ein Feld
  await dragPiece(page, 1, 4, 3, 4); await waitForMoveCount(page, 2, 2500);           // 1... e5
  await dragPiece(page, 6, 4, 5, 4).catch(() => {});                                  // (Zug schon gemacht)
  const lang = await observeAnimation(page, () => clickMove(page, 7, 3, 4, 6));       // 2. Qg4, vier Felder

  const kurzMs = kurz.items[0]?.duration;
  const langMs = lang.items.find(item => item.kind === 'travel')?.duration;
  t.diagnostic(`ein Feld: ${kurzMs} ms · vier Felder: ${langMs} ms`);

  assert.equal(typeof kurzMs, 'number', 'Der kurze Zug wurde nicht animiert');
  assert.equal(typeof langMs, 'number', 'Der lange Zug wurde nicht animiert');
  assert.equal(langMs > kurzMs, true,
    `Der lange Zug (${langMs} ms) dauert nicht laenger als der kurze (${kurzMs} ms)`);
  // Unterlinear: viermal die Strecke darf nicht viermal die Zeit kosten.
  assert.equal(langMs < kurzMs * 2, true,
    `Die Dauer waechst zu stark mit der Strecke: ${kurzMs} ms gegen ${langMs} ms`);
  // Und keiner der beiden darf sich zaeh anfuehlen.
  assert.equal(langMs <= 360, true, `Der lange Zug dauert mit ${langMs} ms zu lange`);
  await assertBoardMatchesEngine(page, 'nach kurzem und langem Zug');
});

/* ===================================================================== *
 * 2 - Schlagen
 * ===================================================================== */

boardTest('Schlagen: die geschlagene Figur weicht sichtbar und verschwindet dann ganz', {}, async ({ page, t }) => {
  await dragPiece(page, 6, 4, 4, 4); await waitForMoveCount(page, 1, 2500);    // 1. e4
  await dragPiece(page, 1, 3, 3, 3); await waitForMoveCount(page, 2, 2500);    // 1... d5

  const observed = await observeAnimation(page, () => clickMove(page, 4, 4, 3, 3));   // 2. exd5

  const travel = observed.items.find(item => item.kind === 'travel');
  const captured = observed.items.find(item => item.kind === 'captured');
  t.diagnostic(`Schlagender: ${travel?.duration} ms · Geschlagener: Versatz ${captured?.delay} ms, Dauer ${captured?.duration} ms`);

  assert.notEqual(captured, undefined, 'Die geschlagene Figur bekam keine Exit-Animation - sie verschwindet abrupt');
  assert.notEqual(travel, undefined, 'Die schlagende Figur wurde nicht bewegt');
  // Die Reihenfolge ist der Punkt: erst die Ankunft, dann das Weichen.
  assert.equal(captured.delay > 0, true,
    'Die geschlagene Figur verblasst ab dem ersten Bild - das Feld wird leer, bevor jemand darauf steht');
  assert.equal(captured.delay < travel.duration, true,
    'Die geschlagene Figur weicht erst, nachdem die schlagende laengst angekommen ist');
  // Zurueckhaltend, nicht spektakulaer.
  assert.equal(captured.duration <= 240, true, `Die Exit-Animation dauert mit ${captured.duration} ms zu lange`);

  const after = await assertBoardMatchesEngine(page, 'nach dem Schlagzug');
  assert.equal(after.moveCount, 3);
});

boardTest('Schlagen: ein gezogener Schlagzug laesst die Figur sofort weichen', {}, async ({ page }) => {
  await dragPiece(page, 6, 4, 4, 4); await waitForMoveCount(page, 1, 2500);
  await dragPiece(page, 1, 3, 3, 3); await waitForMoveCount(page, 2, 2500);

  const observed = await observeAnimation(page, () => dragPiece(page, 4, 4, 3, 3, { settleFirst: false }));
  const captured = observed.items.find(item => item.kind === 'captured');

  assert.notEqual(captured, undefined, 'Auch beim Ziehen braucht die geschlagene Figur eine Exit-Animation');
  // Hier fliegt nichts, auf das man warten muesste - die schlagende Figur
  // liegt bereits auf dem Feld.
  assert.equal(captured.delay, 0, 'Beim gezogenen Schlagzug darf die geschlagene Figur nicht warten');
  assert.equal(observed.items.filter(item => item.kind === 'travel').length, 0,
    'Beim gezogenen Schlagzug darf die schlagende Figur nicht zusaetzlich fliegen');
  await assertBoardMatchesEngine(page, 'nach dem gezogenen Schlagzug');
});

/* ===================================================================== *
 * 3 - Rochade
 * ===================================================================== */

async function prepareShortCastle(page) {
  const line = [[6, 4, 4, 4], [1, 4, 3, 4], [7, 6, 5, 5], [0, 1, 2, 2], [7, 5, 4, 2], [0, 5, 3, 2]];
  for (const move of line) { await dragPiece(page, ...move); }
  await waitForMoveCount(page, line.length, 4000);
}

async function prepareLongCastle(page) {
  const line = [[6, 3, 4, 3], [1, 3, 3, 3], [7, 2, 4, 5], [0, 2, 4, 6], [7, 1, 5, 2], [0, 1, 2, 2], [7, 3, 6, 3], [0, 3, 1, 3]];
  for (const move of line) { await dragPiece(page, ...move); }
  await waitForMoveCount(page, line.length, 6000);
}

boardTest('Rochade kurz: der Koenig liegt schon, der Turm laeuft', {}, async ({ page }) => {
  await prepareShortCastle(page);
  const observed = await observeAnimation(page, () => dragPiece(page, 7, 4, 7, 6, { settleFirst: false }));

  // Der Spieler hat den Koenig selbst gezogen - erklaert werden muss der Turm.
  assert.equal(observed.peakAnimators, 1,
    `Die kurze Rochade erzeugte ${observed.peakAnimators} Animationsfiguren statt einer (nur der Turm)`);
  assert.equal(observed.items[0].kind, 'travel');
  assert.equal(observed.peakHidden, 1, 'Genau das Turmzielfeld gehoert ausgeblendet, sonst nichts');

  const after = await assertBoardMatchesEngine(page, 'nach der kurzen Rochade');
  assert.equal(after.dom[7][6], 'K', 'Der Koenig steht nicht auf g1');
  assert.equal(after.dom[7][5], 'R', 'Der Turm steht nicht auf f1');
  assert.equal(after.dom[7][7], null, 'Auf h1 steht noch etwas');
});

boardTest('Rochade lang: dieselbe Bewegung, laengerer Turmweg', {}, async ({ page, t }) => {
  await prepareLongCastle(page);
  const observed = await observeAnimation(page, () => dragPiece(page, 7, 4, 7, 2, { settleFirst: false }));
  t.diagnostic(`Turmweg lange Rochade: ${observed.items[0]?.duration} ms`);

  assert.equal(observed.peakAnimators, 1, 'Die lange Rochade erzeugte nicht genau eine Animationsfigur');
  assert.equal(observed.peakHidden, 1);

  const after = await assertBoardMatchesEngine(page, 'nach der langen Rochade');
  assert.equal(after.dom[7][2], 'K', 'Der Koenig steht nicht auf c1');
  assert.equal(after.dom[7][3], 'R', 'Der Turm steht nicht auf d1');
  assert.equal(after.dom[7][0], null, 'Auf a1 steht noch etwas');
});

boardTest('Rochade per Klick: Koenig und Turm laufen gleichzeitig los', {}, async ({ page }) => {
  await prepareShortCastle(page);
  const observed = await observeAnimation(page, () => clickMove(page, 7, 4, 7, 6));

  assert.equal(observed.peakAnimators, 2, 'Beim Klick muessen Koenig und Turm beide fliegen');
  assert.equal(observed.items.every(item => item.delay === 0), true,
    'Eine der beiden Figuren startet versetzt - eine Rochade ist eine Bewegung, keine zwei');
  assert.equal(observed.peakHidden, 2, 'Beide Zielfelder gehoeren waehrend des Fluges ausgeblendet');
  await assertBoardMatchesEngine(page, 'nach der Rochade per Klick');
});

/* ===================================================================== *
 * 4 - Schach und Schachmatt
 * ===================================================================== */

boardTest('Schach: die Markierung erscheint auf dem Koenigsfeld und faehrt ein', {}, async ({ page }) => {
  await dragPiece(page, 6, 4, 5, 4); await waitForMoveCount(page, 1, 2500);   // 1. e3
  await dragPiece(page, 1, 3, 3, 3); await waitForMoveCount(page, 2, 2500);   // 1... d5
  await dragPiece(page, 7, 4, 6, 4); await waitForMoveCount(page, 3, 2500);   // 2. Ke2
  await dragPiece(page, 0, 2, 4, 6); await waitForMoveCount(page, 4, 2500);   // 2... Bg4+

  const marked = await page.evaluate(() => {
    const square = document.querySelector('.square.check');
    if (!square) return null;
    const names = square.getAnimations().map(animation => animation.animationName || '');
    return {
      at: `${square.dataset.row},${square.dataset.col}`,
      outline: getComputedStyle(square).outlineStyle,
      animations: names
    };
  });

  assert.notEqual(marked, null, 'Kein Feld ist als Schach markiert');
  assert.equal(marked.at, '6,4', 'Die Markierung sitzt nicht auf dem Feld des weissen Koenigs (e2)');
  assert.equal(marked.outline, 'solid', 'Die Markierung wird nicht als Umriss gezeichnet');
  assert.equal(marked.animations.includes('check-settle'), true,
    'Die Schach-Markierung erscheint hart statt einzufahren');

  const state = await boardState(page);
  assert.match(state.statusCard, /check-state/);
  await assertBoardMatchesEngine(page, 'nach dem Schachgebot');
});

boardTest('Schachmatt: Markierung, Status und Stellung stimmen ueberein', {}, async ({ page }) => {
  // Narrenmatt: 1. f3 e5 2. g4 Qh4#
  await dragPiece(page, 6, 5, 5, 5); await waitForMoveCount(page, 1, 2500);
  await dragPiece(page, 1, 4, 3, 4); await waitForMoveCount(page, 2, 2500);
  await dragPiece(page, 6, 6, 4, 6); await waitForMoveCount(page, 3, 2500);
  await dragPiece(page, 0, 3, 4, 7); await waitForMoveCount(page, 4, 2500);

  const state = await boardState(page);
  assert.equal(state.moves[3], 'Qh4#', `Der Mattzug wurde als "${state.moves[3]}" notiert`);
  assert.deepEqual(state.checkSquares, ['7,4'], 'Das Feld des matten Koenigs (e1) ist nicht markiert');
  assert.match(state.statusCard, /game-over/, 'Die Statuskarte meldet kein Partieende');
  assert.match(state.turn, /Schachmatt/, `Die Statuszeile sagt "${state.turn}"`);

  await assertBoardMatchesEngine(page, 'nach dem Schachmatt');
});

/* ===================================================================== *
 * 5 - Animationen bei schnellen Zuegen
 * ===================================================================== */

boardTest('Schnell: acht Zuege ohne Pause, nie mehr als eine Zuganimation', {}, async ({ page }) => {
  const line = [
    [6, 4, 4, 4], [1, 4, 3, 4], [7, 6, 5, 5], [0, 1, 2, 2],
    [7, 5, 4, 2], [0, 5, 3, 2], [6, 3, 5, 3], [1, 3, 2, 3]
  ];
  const observed = await observeAnimation(page, async () => {
    for (const move of line) await dragPiece(page, ...move, { settleFirst: false });
    return Date.now();
  }, 900);

  // Eine Rochade bringt zwei Zielfelder mit, mehr darf nie gleichzeitig
  // ausgeblendet sein - sonst liegen zwei Zuganimationen uebereinander.
  assert.equal(observed.peakHidden <= 2, true,
    `${observed.peakHidden} Zielfelder gleichzeitig ausgeblendet - zwei Animationen ueberlagern sich`);

  await waitForMoveCount(page, line.length, 5000);
  const after = await assertBoardMatchesEngine(page, 'nach acht schnellen Zuegen');
  assert.equal(after.moveCount, line.length, 'Ein Zug wurde verschluckt');
});

boardTest('Schnell: Schlagzug und sofort der naechste Zug', {}, async ({ page }) => {
  await dragPiece(page, 6, 4, 4, 4); await waitForMoveCount(page, 1, 2500);
  await dragPiece(page, 1, 3, 3, 3); await waitForMoveCount(page, 2, 2500);

  await dragPiece(page, 4, 4, 3, 3, { settleFirst: false });          // 2. exd5
  await dragPiece(page, 0, 3, 3, 3, { settleFirst: false });          // 2... Qxd5
  await waitForMoveCount(page, 4, 4000);

  const after = await assertBoardMatchesEngine(page, 'nach Schlagzug und sofortigem Gegenschlag');
  assert.equal(after.dom[3][3], 'q', 'Auf d5 steht nicht die schwarze Dame');
  assert.equal(after.moveCount, 4);
});

boardTest('Schnell: Rochade und sofort der naechste Zug', {}, async ({ page }) => {
  await prepareShortCastle(page);
  await dragPiece(page, 7, 4, 7, 6, { settleFirst: false });          // 4. O-O
  await dragPiece(page, 0, 6, 2, 5, { settleFirst: false });          // 4... Nf6
  await waitForMoveCount(page, 8, 4000);

  const after = await assertBoardMatchesEngine(page, 'nach Rochade und sofortigem Gegenzug');
  assert.equal(after.dom[7][6], 'K');
  assert.equal(after.dom[7][5], 'R');
  assert.equal(after.dom[2][5], 'n', 'Der schwarze Springer steht nicht auf f6');
});

boardTest('Schnell: Schachgebot und sofortige Antwort', {}, async ({ page }) => {
  await dragPiece(page, 6, 4, 5, 4); await waitForMoveCount(page, 1, 2500);
  await dragPiece(page, 1, 3, 3, 3); await waitForMoveCount(page, 2, 2500);
  await dragPiece(page, 7, 4, 6, 4); await waitForMoveCount(page, 3, 2500);

  await dragPiece(page, 0, 2, 4, 6, { settleFirst: false });          // 2... Bg4+
  await dragPiece(page, 7, 6, 5, 5, { settleFirst: false });          // 3. Nf3 pariert
  await waitForMoveCount(page, 5, 4000);

  const state = await boardState(page);
  assert.deepEqual(state.checkSquares, [], 'Die Schach-Markierung steht noch, obwohl pariert wurde');
  await assertBoardMatchesEngine(page, 'nach Schach und sofortiger Antwort');
});

/* ===================================================================== *
 * 6 - Gedrosselter Darstellungstakt
 * ===================================================================== */

boardTest('Gedrosselt: die Partie bleibt korrekt, auch wenn die Animation hinterherhinkt',
  { throttleFrames: true }, async ({ page }) => {
    const line = [[6, 4, 4, 4], [1, 4, 3, 4], [7, 6, 5, 5], [0, 1, 2, 2], [7, 5, 4, 2], [0, 5, 3, 2]];
    for (const move of line) await dragPiece(page, ...move, { settleFirst: false });
    await waitForMoveCount(page, line.length, 6000);

    // Ein Klickzug bei gedrosseltem Takt: die Figur fliegt, der Zustand steht
    // aber schon.
    await clickMove(page, 7, 4, 7, 6);                                // O-O
    await waitForMoveCount(page, line.length + 1, 4000);

    const after = await assertBoardMatchesEngine(page, 'nach der Partie bei gedrosseltem Takt');
    assert.equal(after.dom[7][6], 'K');
    assert.equal(after.dom[7][5], 'R');
  });

/* ===================================================================== *
 * 8 - Messung
 * ===================================================================== */

boardTest('Messung: die Animation blockiert die Eingabe nicht', {}, async ({ page, t }) => {
  // Gezogener Zug: logischer Abschluss und Wiederfreigabe.
  const released = await dragPiece(page, 6, 4, 4, 4, { settleFirst: false });
  await waitForMoveCount(page, 1, 2500);
  const logicMs = Date.now() - released;
  const freeMs = await timeUntilBoardAcceptsDrag(page, 1, 4, released);
  t.diagnostic(`gezogen: Zugabschluss ${logicMs} ms, Eingabe frei nach ${freeMs} ms`);
  assert.equal(logicMs < 250, true, `Der Zugabschluss dauerte ${logicMs} ms`);
  assert.equal(freeMs < 250, true, `Die Eingabe war erst nach ${freeMs} ms wieder frei`);

  // Klickzug: hier fliegt wirklich etwas - auch das darf nicht blockieren.
  await waitForAnimationRest(page);
  const clicked = await clickMove(page, 1, 4, 3, 4);
  const started = await page.waitForFunction(() => document.querySelector('.move-animator') ? Date.now() : false,
    null, { timeout: 2000, polling: 4 }).then(handle => handle.jsonValue()).catch(() => null);
  await waitForMoveCount(page, 2, 2500);
  const clickLogicMs = Date.now() - clicked;
  const animStartMs = started === null ? null : started - clicked;
  const clickFreeMs = await timeUntilBoardAcceptsDrag(page, 6, 3, clicked);
  t.diagnostic(`Klick: Zugabschluss ${clickLogicMs} ms, Animationsstart ${animStartMs} ms, Eingabe frei nach ${clickFreeMs} ms`);

  assert.equal(clickLogicMs < 250, true, `Der Klickzug brauchte ${clickLogicMs} ms bis zum Abschluss`);
  assert.equal(animStartMs !== null && animStartMs < 120, true,
    `Die Animation begann erst nach ${animStartMs} ms`);
  assert.equal(clickFreeMs < 250, true,
    `Nach einem Klickzug war die Eingabe erst nach ${clickFreeMs} ms wieder frei`);

  await assertBoardMatchesEngine(page, 'nach der Messung');
});
