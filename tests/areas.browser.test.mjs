/**
 * Browser-Tests fuer die vier Bereiche: Spielen, Puzzles, Lernen, Analyse.
 *
 * Der Kern dieser Datei ist nicht, dass sich etwas ein- und ausblendet - das
 * saehe man auch ohne Test. Der Kern ist, dass der Bereichswechsel den
 * Spielzustand nicht anfasst: eine laufende Partie muss den Ausflug nach
 * Lernen und zurueck ueberstehen, und eine Aufgabe muss die Partie danach
 * wieder freigeben. Genau daran waere ein Router zerbrochen, der jede Ansicht
 * neu aufbaut.
 */
import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import {
  loadPlaywright, launchBrowser, startServer,
  openBoard, dragPiece, boardState, waitForMoveCount, waitForAnimationRest
} from './helpers/browser-board.mjs';

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
  try { browser = await launchBrowser(playwright); }
  catch (error) { skipReason = `Kein startbarer Browser: ${error.message.split('\n')[0]}`; return; }
  const started = await startServer();
  server = started.server;
  baseUrl = `http://127.0.0.1:${started.port}`;
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

function areaTest(name, options, body) {
  test(name, async t => {
    if (skipReason) { t.skip(skipReason); return; }
    const { page, consoleErrors } = await openBoard(browser, baseUrl, options);
    try {
      await body({ page, consoleErrors, t });
      assert.deepEqual(consoleErrors, [], 'Die Browser-Konsole meldet Fehler');
    } finally { await page.close(); }
  });
}

const goto = async (page, view) => {
  await page.click(`#area-nav [data-view="${view}"]`);
  await page.waitForTimeout(320);
};

const viewState = page => page.evaluate(() => ({
  view: document.body.dataset.view,
  mode: document.body.dataset.mode,
  aktiv: [...document.querySelectorAll('#area-nav .mode-tab')]
    .filter(t => t.classList.contains('active')).map(t => t.dataset.view),
  ariaCurrent: [...document.querySelectorAll('#area-nav .mode-tab[aria-current]')].map(t => t.dataset.view),
  sichtbar: {
    brett: !!document.querySelector('.game-layout')?.offsetParent,
    lernen: !!document.getElementById('view-learn')?.offsetParent,
    analyse: !!document.getElementById('view-analysis')?.offsetParent
  }
}));

/* ===================================================================== *
 * Navigation
 * ===================================================================== */

areaTest('Navigation: jeder der vier Bereiche laesst sich oeffnen', {}, async ({ page }) => {
  const start = await viewState(page);
  assert.equal(start.view, 'play', 'Die Anwendung startet nicht im Bereich Spielen');
  assert.deepEqual(start.aktiv, ['play']);

  for (const view of ['learn', 'analysis', 'play']) {
    await goto(page, view);
    const state = await viewState(page);
    assert.equal(state.view, view, `Der Bereich ${view} wurde nicht geoeffnet`);
    assert.deepEqual(state.aktiv, [view], `In ${view} ist der falsche Eintrag hervorgehoben`);
  }
});

areaTest('Navigation: genau ein Eintrag ist als aktuell ausgezeichnet', {}, async ({ page }) => {
  for (const view of ['play', 'learn', 'analysis']) {
    await goto(page, view);
    const state = await viewState(page);
    assert.deepEqual(state.ariaCurrent, [view],
      `aria-current steht auf [${state.ariaCurrent.join(', ')}] statt auf [${view}]`);
  }
});

areaTest('Navigation: Lernen zeigt sein Gebiet, Spielen das Brett', {}, async ({ page }) => {
  await goto(page, 'learn');
  let state = await viewState(page);
  assert.equal(state.sichtbar.lernen, true, 'Der Lernbereich ist nicht zu sehen');
  assert.equal(state.sichtbar.brett, false, 'Das Brett steht noch im Lernbereich');

  await goto(page, 'play');
  state = await viewState(page);
  assert.equal(state.sichtbar.brett, true, 'Das Brett kam nicht zurueck');
  assert.equal(state.sichtbar.lernen, false, 'Der Lernbereich steht noch im Spielbereich');
});

areaTest('Navigation: die Analyse zeigt das Brett mit', {}, async ({ page }) => {
  await goto(page, 'analysis');
  const state = await viewState(page);
  assert.equal(state.sichtbar.analyse, true, 'Der Analysebereich ist nicht zu sehen');
  assert.equal(state.sichtbar.brett, true,
    'Die Analyse zeigt kein Brett - eine Bewertung ohne die Stellung dazu ist nur eine Zahl');
});

/* ===================================================================== *
 * Der Spielzustand ueberlebt
 * ===================================================================== */

areaTest('Zustand: eine laufende Partie ueberlebt den Ausflug nach Lernen', {}, async ({ page }) => {
  await dragPiece(page, 6, 4, 4, 4); await waitForMoveCount(page, 1, 2500);
  await dragPiece(page, 1, 4, 3, 4); await waitForMoveCount(page, 2, 2500);
  await dragPiece(page, 7, 6, 5, 5); await waitForMoveCount(page, 3, 2500);
  await waitForAnimationRest(page);
  const vorher = await boardState(page);

  await goto(page, 'learn');
  await goto(page, 'analysis');
  await goto(page, 'play');

  const nachher = await boardState(page);
  assert.deepEqual(nachher.moves, vorher.moves,
    `Die Zugliste hat sich geaendert: ${vorher.moves.join(', ')} -> ${nachher.moves.join(', ')}`);
  assert.equal(nachher.turn, vorher.turn, 'Das Zugrecht hat sich geaendert');

  // Und das Brett nimmt danach weiter Zuege an.
  await dragPiece(page, 0, 1, 2, 2); await waitForMoveCount(page, 4, 2500);
  assert.equal((await boardState(page)).moves.length, 4, 'Nach der Rueckkehr nimmt das Brett keinen Zug mehr an');
});

areaTest('Zustand: die Aufgabe gibt die Partie wieder frei', {}, async ({ page }) => {
  await dragPiece(page, 6, 4, 4, 4); await waitForMoveCount(page, 1, 2500);
  await dragPiece(page, 1, 4, 3, 4); await waitForMoveCount(page, 2, 2500);
  await waitForAnimationRest(page);
  const vorher = await boardState(page);

  await goto(page, 'puzzles');
  // Der Auswahldialog geht auf; die Aufgabe selbst startet auf Knopfdruck.
  const start = await page.$('#puzzle-start');
  if (start) { await start.click(); await page.waitForTimeout(800); }
  const imTraining = await viewState(page);
  assert.equal(imTraining.mode, 'puzzle', 'Das Training ist nicht angelaufen');

  await goto(page, 'play');
  const nachher = await boardState(page);
  assert.equal((await viewState(page)).mode, 'game', 'Der Spielmodus kam nicht zurueck');
  assert.deepEqual(nachher.moves, vorher.moves,
    `Die Partie kam nicht zurueck: ${vorher.moves.join(', ')} -> ${nachher.moves.join(', ')}`);
});

areaTest('Zustand: waehrend einer Aufgabe verschwinden die Partieknoepfe', {}, async ({ page }) => {
  await goto(page, 'puzzles');
  const start = await page.$('#puzzle-start');
  if (start) { await start.click(); await page.waitForTimeout(800); }

  const sichtbar = await page.evaluate(() => ({
    modus: document.body.dataset.mode,
    zurueck: !!document.getElementById('undo-btn')?.offsetParent,
    aufgeben: !!document.getElementById('resign-btn')?.offsetParent,
    online: !!document.getElementById('online-start')?.offsetParent,
    puzzleKarte: !!document.getElementById('puzzle-card')?.offsetParent
  }));
  assert.equal(sichtbar.modus, 'puzzle');
  assert.equal(sichtbar.puzzleKarte, true, 'Die Aufgabenkarte fehlt');
  assert.equal(sichtbar.zurueck, false, 'Waehrend einer Aufgabe steht noch "Zurueck" da');
  assert.equal(sichtbar.aufgeben, false, 'Waehrend einer Aufgabe steht noch "Aufgeben" da');
  assert.equal(sichtbar.online, false, 'Waehrend einer Aufgabe steht noch "Online spielen" da');
});

/* ===================================================================== *
 * Keine doppelten Handler
 * ===================================================================== */

areaTest('Navigation: ein Klick zaehlt einmal, auch nach vielen Wechseln', {}, async ({ page }) => {
  // Zwanzig Wechsel. Haenge sich bei jedem Wechsel ein weiterer Listener an
  // die Leiste, waere der Zustand danach nicht mehr der erwartete - ein
  // doppelt gezaehlter Klick auf Puzzles wuerde etwa die Aufgabe zweimal
  // starten und dabei die Partie ueberschreiben.
  await dragPiece(page, 6, 4, 4, 4); await waitForMoveCount(page, 1, 2500);
  await waitForAnimationRest(page);

  for (let i = 0; i < 5; i++) {
    for (const view of ['learn', 'analysis', 'play', 'learn']) await goto(page, view);
  }
  await goto(page, 'play');

  const state = await viewState(page);
  assert.equal(state.view, 'play');
  assert.deepEqual(state.aktiv, ['play'], 'Nach vielen Wechseln sind mehrere Eintraege aktiv');
  assert.deepEqual((await boardState(page)).moves, ['e4'], 'Die Partie hat die Wechsel nicht ueberstanden');

  // Ein zweiter Klick auf den bereits offenen Bereich darf nichts tun.
  await goto(page, 'play');
  assert.deepEqual((await boardState(page)).moves, ['e4'], 'Ein Klick auf den offenen Bereich hat die Partie angefasst');
});

/* ===================================================================== *
 * Inhalte der neuen Bereiche
 * ===================================================================== */

areaTest('Lernen: fuenf Gebiete, und keines behauptet Inhalte zu haben', {}, async ({ page }) => {
  await goto(page, 'learn');
  const learn = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#view-learn .learn-card')];
    return {
      anzahl: cards.length,
      themen: cards.map(c => c.dataset.topic),
      ueberschriften: cards.map(c => c.querySelector('h3')?.textContent.trim()),
      zustaende: cards.map(c => c.querySelector('.learn-state')?.textContent.trim()),
      ueberschriftEbene: !!document.querySelector('#view-learn h2')
    };
  });
  assert.equal(learn.anzahl, 5, `Es sind ${learn.anzahl} Gebiete statt fuenf`);
  assert.deepEqual(learn.themen, ['grundlagen', 'taktik', 'eroeffnungen', 'mittelspiel', 'endspiel']);
  assert.equal(learn.ueberschriftEbene, true, 'Dem Lernbereich fehlt seine Ueberschrift');
  // Ehrlichkeit: jede Karte sagt, woran man ist.
  assert.equal(learn.zustaende.every(z => z && z.length > 0), true,
    'Eine Karte sagt nicht, ob es dort schon Inhalte gibt');
});

areaTest('Lernen: der Verweis auf die Puzzles fuehrt wirklich dorthin', {}, async ({ page }) => {
  await goto(page, 'learn');
  await page.click('#view-learn [data-goto="puzzles"]');
  await page.waitForTimeout(400);
  assert.equal((await viewState(page)).view, 'puzzles', 'Der Verweis hat den Bereich nicht gewechselt');
});

areaTest('Analyse: leerer Zustand erklaert sich, und die Auswertung hat ihren Ort', {}, async ({ page }) => {
  await goto(page, 'analysis');
  const before = await page.evaluate(() => ({
    leerText: document.getElementById('analysis-empty')?.textContent.trim().slice(0, 24),
    leerSichtbar: !!document.getElementById('analysis-empty')?.offsetParent,
    karteImBereich: document.getElementById('review-card')?.parentElement?.id,
    knopf: !!document.getElementById('analysis-run')
  }));
  assert.equal(before.leerSichtbar, true, 'Der leere Analysebereich erklaert sich nicht');
  assert.match(before.leerText, /Noch nicht ausgewertet/);
  assert.equal(before.karteImBereich, 'analysis-slot', 'Die Analysekarte liegt nicht im Analysebereich');
  assert.equal(before.knopf, true, 'Es gibt keinen Knopf, der die Auswertung startet');

  // Zurueck zur Partie: die Karte gehoert wieder an ihren alten Platz, damit
  // sie dort nicht zweimal existiert.
  await goto(page, 'play');
  const back = await page.evaluate(() => ({
    karten: document.querySelectorAll('#review-card').length,
    imSlot: document.getElementById('review-card')?.parentElement?.id === 'analysis-slot'
  }));
  assert.equal(back.karten, 1, 'Die Analysekarte existiert mehrfach');
  assert.equal(back.imSlot, false, 'Die Analysekarte blieb im Analysebereich haengen');
});

/* ===================================================================== *
 * Tastatur und Zugaenglichkeit
 * ===================================================================== */

areaTest('Tastatur: Pfeiltasten wandern durch die Bereiche', {}, async ({ page }) => {
  await page.focus('#nav-play');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'nav-puzzles');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'nav-learn');
  await page.keyboard.press('End');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'nav-analysis');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'nav-play', 'Die Leiste laeuft nicht um');
  await page.keyboard.press('Home');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'nav-play');

  // Und die Eingabetaste oeffnet den Bereich, auf dem der Fokus steht.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(350);
  assert.equal((await viewState(page)).view, 'learn', 'Die Eingabetaste hat den Bereich nicht geoeffnet');
});

areaTest('Zugaenglichkeit: keine namenlosen Knoepfe in irgendeinem Bereich', {}, async ({ page }) => {
  for (const view of ['play', 'learn', 'analysis']) {
    await goto(page, view);
    const ohneNamen = await page.evaluate(() => [...document.querySelectorAll('button')]
      .filter(b => getComputedStyle(b).display !== 'none' && !b.closest('[hidden]'))
      .filter(b => !(b.textContent || '').trim() && !b.getAttribute('aria-label') && !b.title).length);
    assert.equal(ohneNamen, 0, `Im Bereich ${view} gibt es ${ohneNamen} Knoepfe ohne Namen`);
  }
});

areaTest('Zugaenglichkeit: die Leiste ist benannt und die Ueberschriften bauen aufeinander auf', {}, async ({ page }) => {
  const structure = await page.evaluate(() => ({
    navLabel: document.getElementById('area-nav')?.getAttribute('aria-label'),
    h1: document.querySelectorAll('h1').length,
    lernenBeschriftet: document.getElementById('view-learn')?.getAttribute('aria-labelledby'),
    analyseBeschriftet: document.getElementById('view-analysis')?.getAttribute('aria-labelledby')
  }));
  assert.equal(structure.navLabel, 'Bereiche', 'Die Bereichsleiste hat keinen Namen');
  assert.equal(structure.h1, 1, 'Es gibt nicht genau eine Hauptueberschrift');
  assert.equal(structure.lernenBeschriftet, 'learn-heading');
  assert.equal(structure.analyseBeschriftet, 'analysis-heading');
});

/* ===================================================================== *
 * Responsive
 * ===================================================================== */

test('Responsive: kein Bereich laeuft auf irgendeiner Breite ueber', async t => {
  if (skipReason) { t.skip(skipReason); return; }
  for (const [w, h] of [[1920, 1080], [1440, 900], [1280, 800], [1024, 768], [768, 900], [390, 844]]) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, colorScheme: 'dark' });
    try {
      await page.addInitScript(() => {
        try { localStorage.setItem('chess-ai-mode', JSON.stringify('human-vs-human')); } catch { /* egal */ }
      });
      await page.goto(`${baseUrl}/index.html`);
      await page.waitForFunction(() => !!window.ChessEngine);
      await page.waitForTimeout(300);

      for (const view of ['play', 'learn', 'analysis']) {
        await goto(page, view);
        const messung = await page.evaluate(() => {
          const vw = innerWidth;
          let ueber = 0, beschnitten = 0;
          for (const el of document.querySelectorAll('body *')) {
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || el.closest('[hidden]')) continue;
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            if (r.right > vw + 1 || r.left < -1) ueber++;
            if (el.scrollWidth > Math.ceil(r.width) + 1 && !['auto', 'scroll'].includes(cs.overflowX)) beschnitten++;
          }
          const nav = document.getElementById('area-nav').getBoundingClientRect();
          return { ueber, beschnitten, navGanzImBild: nav.left >= -1 && nav.right <= vw + 1,
            quer: document.documentElement.scrollWidth > document.documentElement.clientWidth };
        });
        assert.equal(messung.ueber, 0, `${w}x${h} / ${view}: ${messung.ueber} Elemente ragen aus dem Bild`);
        assert.equal(messung.beschnitten, 0, `${w}x${h} / ${view}: ${messung.beschnitten} Elemente sind beschnitten`);
        assert.equal(messung.quer, false, `${w}x${h} / ${view}: die Seite scrollt seitlich`);
        assert.equal(messung.navGanzImBild, true, `${w}x${h} / ${view}: die Bereichsleiste ist angeschnitten`);
      }
    } finally { await page.close(); }
  }
});
