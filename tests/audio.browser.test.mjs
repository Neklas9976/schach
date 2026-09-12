/**
 * Browser-Tests fuer die Zug-Klaenge.
 *
 * Was hier geprueft wird, ist nicht der Ton, sondern die Absicht: welcher
 * Klang fuer welche Art Zug ausgeloest wurde, wie oft, in welcher Reihenfolge
 * und mit welchem Versatz. Ob dabei wirklich etwas aus den Lautsprechern kommt,
 * haengt an der Umgebung und waere kein brauchbares Testkriterium - die
 * Wellenform selbst ist ohnehin schon in tests/sound.test.mjs festgehalten.
 *
 * Der Beobachter ist ein Spy, der in der Seite ueber ChessSound.play gelegt
 * wird. Er ruft die echte Funktion weiter auf und veraendert nichts an ihr;
 * die Produktionslogik laeuft also unveraendert. Weil playForMove intern
 * ueber dasselbe Objekt geht, sieht der Spy auch die Klaenge, die nicht die
 * Anwendung selbst, sondern die Tonschicht ausloest - und genau darauf kommt
 * es an: ein Schlagzug mit Schach muss beides ausloesen, nicht eines davon.
 */
import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import {
  loadPlaywright, launchBrowser, startServer,
  openBoard, squareCenter, dragPiece, boardState,
  waitForMoveCount, waitForAnimationRest
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

/**
 * Legt den Beobachter ueber ChessSound.play.
 *
 * Bewusst erst nach dem Laden und nicht als addInitScript: ChessSound gibt es
 * zu dem Zeitpunkt noch nicht, und jeder Klang dieser Anwendung haengt an
 * einer Eingabe, die lange nach dem Laden kommt. Es geht also nichts verloren.
 */
async function installSoundSpy(page) {
  await page.evaluate(() => {
    window.__sounds = [];
    const original = window.ChessSound.play.bind(window.ChessSound);
    window.ChessSound.play = (name, options = {}) => {
      const played = original(name, options);
      window.__sounds.push({
        name,
        delay: Number(options.delay) || 0,
        settle: options.settle,
        played: played === true,
        at: performance.now()
      });
      return played;
    };
  });
}

const soundLog = page => page.evaluate(() => window.__sounds.map(entry => entry.name));
const soundDetail = page => page.evaluate(() => window.__sounds);
const clearSounds = page => page.evaluate(() => { window.__sounds.length = 0; });

/** Einen Zug per Klick eingeben. */
async function clickMove(page, fr, fc, tr, tc) {
  await waitForAnimationRest(page);
  const from = await squareCenter(page, fr, fc);
  const to = await squareCenter(page, tr, tc);
  await page.mouse.click(from.x, from.y);
  await page.waitForTimeout(40);
  await page.mouse.click(to.x, to.y);
}

/** Eine Stellung ueber den vorhandenen FEN-Dialog aufs Brett legen. */
async function loadPosition(page, fen) {
  await page.evaluate(position => {
    const overlay = document.getElementById('pgn-overlay');
    if (overlay) overlay.hidden = false;
    const field = document.getElementById('fen-text');
    field.value = position;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('button')]
      .find(button => /stellung laden/i.test(button.textContent || ''))?.click();
  }, fen);
  await page.waitForTimeout(300);
}

function audioTest(name, options, body) {
  test(name, async t => {
    if (skipReason) { t.skip(skipReason); return; }
    const { page, consoleErrors } = await openBoard(browser, baseUrl, options);
    try {
      await installSoundSpy(page);
      await body({ page, consoleErrors, t });
      assert.deepEqual(consoleErrors, [], 'Die Browser-Konsole meldet Fehler');
    } finally {
      await page.close();
    }
  });
}

/* ===================================================================== *
 * Normale Zuege
 * ===================================================================== */

audioTest('Zug: gezogen und geklickt ergeben denselben einen Klang', {}, async ({ page }) => {
  await dragPiece(page, 6, 4, 4, 4);                       // 1. e4 gezogen
  await waitForMoveCount(page, 1, 2500);
  assert.deepEqual(await soundLog(page), ['move'], 'Ein gezogener Zug klingt nicht nach genau einem Zug');

  await clearSounds(page);
  await clickMove(page, 1, 4, 3, 4);                       // 1... e5 geklickt
  await waitForMoveCount(page, 2, 2500);
  assert.deepEqual(await soundLog(page), ['move'], 'Ein Klickzug klingt anders als ein gezogener Zug');
});

audioTest('Zug: der Klang kommt ohne Verzoegerung mit dem Zug', {}, async ({ page, t }) => {
  const released = Date.now();
  await dragPiece(page, 6, 4, 4, 4, { settleFirst: false });
  await waitForMoveCount(page, 1, 2500);
  const detail = await soundDetail(page);
  const elapsed = Date.now() - released;
  t.diagnostic(`Klang ausgeloest innerhalb von ${elapsed} ms nach dem Griff`);
  assert.equal(detail.length, 1);
  assert.equal(detail[0].delay, 0, 'Der Zug-Klang wird verzoegert abgespielt');
  assert.equal(elapsed < 300, true, `Der Zug brauchte ${elapsed} ms bis zum Klang`);
});

/* ===================================================================== *
 * Schlagen
 * ===================================================================== */

audioTest('Schlagen: klingt nach Schlagen, nicht nach einem Zug', {}, async ({ page }) => {
  await dragPiece(page, 6, 4, 4, 4); await waitForMoveCount(page, 1, 2500);
  await dragPiece(page, 1, 3, 3, 3); await waitForMoveCount(page, 2, 2500);
  await clearSounds(page);

  await dragPiece(page, 4, 4, 3, 3); await waitForMoveCount(page, 3, 2500);   // exd5
  const log = await soundLog(page);
  assert.deepEqual(log, ['capture'], `Ein Schlagzug loeste ${log.join(', ')} aus`);
  assert.equal(log.includes('move'), false, 'Ein Schlagzug darf nicht wie ein gewoehnlicher Zug klingen');
});

audioTest('Schlagen: das Aufsetzen folgt der Animation aus Stufe 3', {}, async ({ page, t }) => {
  await dragPiece(page, 6, 4, 4, 4); await waitForMoveCount(page, 1, 2500);
  await dragPiece(page, 1, 3, 3, 3); await waitForMoveCount(page, 2, 2500);
  await clearSounds(page);

  // Gezogen: die Figur liegt schon auf dem Feld, es gibt nichts abzuwarten.
  await dragPiece(page, 4, 4, 3, 3); await waitForMoveCount(page, 3, 2500);
  const dragged = (await soundDetail(page))[0];
  t.diagnostic(`gezogener Schlagzug: settle ${Math.round(dragged.settle * 1000)} ms`);
  assert.equal(dragged.settle, 0, 'Beim gezogenen Schlagzug darf der Klang nicht auf eine Reise warten');

  // Geklickt: die Figur reist wirklich, der zweite Schlag gehoert ans Ende.
  const { page: second } = await openBoard(browser, baseUrl);
  try {
    await installSoundSpy(second);
    await dragPiece(second, 6, 4, 4, 4); await waitForMoveCount(second, 1, 2500);
    await dragPiece(second, 1, 3, 3, 3); await waitForMoveCount(second, 2, 2500);
    await clearSounds(second);
    await clickMove(second, 4, 4, 3, 3); await waitForMoveCount(second, 3, 2500);
    const clicked = (await soundDetail(second))[0];
    t.diagnostic(`geklickter Schlagzug: settle ${Math.round(clicked.settle * 1000)} ms`);
    assert.equal(clicked.settle > 0.1, true,
      `Beim Klickzug reist die Figur, der Klang setzt aber nach ${Math.round(clicked.settle * 1000)} ms auf`);
  } finally {
    await second.close();
  }
});

/* ===================================================================== *
 * Schach und Matt
 * ===================================================================== */

audioTest('Schach: Zug und Schach sind beide zu hoeren, in dieser Reihenfolge', {}, async ({ page }) => {
  await dragPiece(page, 6, 4, 5, 4); await waitForMoveCount(page, 1, 2500);   // 1. e3
  await dragPiece(page, 1, 3, 3, 3); await waitForMoveCount(page, 2, 2500);   // 1... d5
  await dragPiece(page, 7, 4, 6, 4); await waitForMoveCount(page, 3, 2500);   // 2. Ke2
  await clearSounds(page);

  await dragPiece(page, 0, 2, 4, 6); await waitForMoveCount(page, 4, 2500);   // 2... Bg4+
  const detail = await soundDetail(page);
  assert.deepEqual(detail.map(entry => entry.name), ['move', 'check'],
    'Ein Schachgebot muss nach Zug UND Schach klingen');
  assert.equal(detail[1].delay > 0, true, 'Der Schach-Akzent faellt mit dem Aufschlag zusammen');
});

audioTest('Schach: kein Schach-Klang bei einem gewoehnlichen Zug', {}, async ({ page }) => {
  const line = [[6, 4, 4, 4], [1, 4, 3, 4], [7, 6, 5, 5], [0, 1, 2, 2]];
  for (const move of line) { await dragPiece(page, ...move); }
  await waitForMoveCount(page, line.length, 4000);
  const log = await soundLog(page);
  assert.equal(log.includes('check'), false, `In einer ruhigen Eroeffnung erklang Schach: ${log.join(', ')}`);
  assert.deepEqual(log, ['move', 'move', 'move', 'move']);
});

audioTest('Schach: ein Schlagzug mit Schach verliert das Schlagen nicht', {}, async ({ page }) => {
  // Genau die Stelle, an der die alte Rangfolge das Schlagen verschluckte:
  // `check` stand ueber `captured`, also klang der Schlagzug wie ein Schach.
  // 1. e4 d5 2. Bb5+ ... 2... Bd7 3. Bxd7+ - schlagen und Schach zugleich.
  await dragPiece(page, 6, 4, 4, 4); await waitForMoveCount(page, 1, 2500);   // 1. e4
  await dragPiece(page, 1, 3, 3, 3); await waitForMoveCount(page, 2, 2500);   // 1... d5
  await dragPiece(page, 7, 5, 3, 1); await waitForMoveCount(page, 3, 2500);   // 2. Bb5+
  await dragPiece(page, 0, 2, 1, 3); await waitForMoveCount(page, 4, 2500);   // 2... Bd7
  await clearSounds(page);
  await dragPiece(page, 3, 1, 1, 3); await waitForMoveCount(page, 5, 2500);   // 3. Bxd7+

  const state = await boardState(page);
  assert.match(state.moves[4], /^Bxd7\+/, `Der Zug wurde als "${state.moves[4]}" notiert`);
  const log = await soundLog(page);
  assert.deepEqual(log, ['capture', 'check'],
    `Ein Schlagzug mit Schach loeste ${log.join(', ')} aus - das Schlagen darf nicht verschwinden`);
});

audioTest('Matt: Schlusspunkt am Zug, Fanfare erst zur Meldung', {}, async ({ page }) => {
  // Narrenmatt: 1. f3 e5 2. g4 Qh4#
  await dragPiece(page, 6, 5, 5, 5); await waitForMoveCount(page, 1, 2500);
  await dragPiece(page, 1, 4, 3, 4); await waitForMoveCount(page, 2, 2500);
  await dragPiece(page, 6, 6, 4, 6); await waitForMoveCount(page, 3, 2500);
  await clearSounds(page);
  await dragPiece(page, 0, 3, 4, 7); await waitForMoveCount(page, 4, 2500);

  // Unmittelbar nach dem Zug: der Zug selbst und der Schlusspunkt. Frueher
  // war hier nur die Fanfare - der Mattzug setzte lautlos auf.
  const atMove = await soundLog(page);
  assert.deepEqual(atMove, ['move', 'checkmate'],
    `Der Mattzug loeste ${atMove.join(', ')} aus`);

  // Die Meldung geht 650 ms spaeter auf, und dort gehoert die Fanfare hin.
  await page.waitForTimeout(1100);
  const afterDialog = await soundLog(page);
  const fanfares = afterDialog.filter(name => name.startsWith('gameEnd'));
  assert.equal(fanfares.length, 1, `Die Fanfare erklang ${fanfares.length}-mal statt einmal`);
  assert.equal(afterDialog.indexOf(fanfares[0]) > afterDialog.indexOf('checkmate'), true,
    'Die Fanfare kam vor dem Mattzug');
  assert.equal(afterDialog.filter(name => name === 'checkmate').length, 1,
    'Der Matt-Klang wurde mehrfach ausgeloest');
});

/* ===================================================================== *
 * Rochade
 * ===================================================================== */

async function prepareShortCastle(page) {
  const line = [[6, 4, 4, 4], [1, 4, 3, 4], [7, 6, 5, 5], [0, 1, 2, 2], [7, 5, 4, 2], [0, 5, 3, 2]];
  for (const move of line) { await dragPiece(page, ...move); }
  await waitForMoveCount(page, line.length, 4000);
}

audioTest('Rochade kurz: genau ein Klang, obwohl zwei Figuren ziehen', {}, async ({ page }) => {
  await prepareShortCastle(page);
  await clearSounds(page);
  await dragPiece(page, 7, 4, 7, 6); await waitForMoveCount(page, 7, 2500);

  const log = await soundLog(page);
  assert.deepEqual(log, ['castle'], `Die kurze Rochade loeste ${log.join(', ')} aus`);
  assert.equal(log.filter(name => name === 'castle').length, 1,
    'Der Rochade-Klang wurde zweimal ausgeloest - einmal je Figur');
});

audioTest('Rochade lang: derselbe Klang, laengerer Turmweg', {}, async ({ page, t }) => {
  const line = [[6, 3, 4, 3], [1, 3, 3, 3], [7, 2, 4, 5], [0, 2, 4, 6], [7, 1, 5, 2], [0, 1, 2, 2], [7, 3, 6, 3], [0, 3, 1, 3]];
  for (const move of line) { await dragPiece(page, ...move); }
  await waitForMoveCount(page, line.length, 6000);
  await clearSounds(page);

  await dragPiece(page, 7, 4, 7, 2); await waitForMoveCount(page, line.length + 1, 2500);
  const detail = await soundDetail(page);
  t.diagnostic(`lange Rochade: settle ${Math.round(detail[0].settle * 1000)} ms`);
  assert.deepEqual(detail.map(entry => entry.name), ['castle'], 'Die lange Rochade klingt nicht nach Rochade');
  // Der Turm faehrt drei Felder statt zwei - das muss der Klang mitmachen.
  assert.equal(detail[0].settle > 0.15, true,
    `Der Turm braucht laenger, der Klang setzt aber nach ${Math.round(detail[0].settle * 1000)} ms auf`);
});

/* ===================================================================== *
 * Umwandlung
 * ===================================================================== */

audioTest('Umwandlung: ein Klang, nicht Zug plus Umwandlung', {}, async ({ page }) => {
  await loadPosition(page, '8/1P6/8/8/3k4/8/8/4K3 w - - 0 1');
  await clearSounds(page);

  await dragPiece(page, 1, 1, 0, 1, { settleFirst: false });          // b7-b8
  await page.waitForFunction(() => !document.getElementById('promotion-overlay').hidden,
    null, { timeout: 2000 });
  // Kein Klang, solange die Figur noch nicht gewaehlt ist: der Zug ist noch
  // nicht gespielt.
  assert.deepEqual(await soundLog(page), [], 'Die offene Umwandlung hat schon einen Zug-Klang ausgeloest');

  await page.click('.promotion-option');
  await waitForMoveCount(page, 1, 2500);
  const log = await soundLog(page);
  assert.deepEqual(log, ['promote'], `Die Umwandlung loeste ${log.join(', ')} aus`);
  assert.equal(log.includes('move'), false, 'Umwandlung und Zug wurden beide gespielt');
});

/* ===================================================================== *
 * Ungueltige Zuege
 * ===================================================================== */

audioTest('Ungueltig: eine Absage, aber kein Zug-Klang', {}, async ({ page }) => {
  // Der weisse Koenig kann nicht drei Felder weit.
  await dragPiece(page, 7, 4, 4, 4, { settleFirst: false });
  await page.waitForTimeout(200);

  const log = await soundLog(page);
  assert.equal(log.includes('move'), false, 'Ein ungueltiger Zug klang wie ein gespielter Zug');
  assert.deepEqual(log, ['illegal'], `Der abgelehnte Zug loeste ${log.join(', ')} aus`);
  assert.deepEqual((await boardState(page)).moves, [], 'Der ungueltige Zug wurde gespielt');
});

audioTest('Ungueltig: das Zuruecklegen auf das Ausgangsfeld bleibt stumm', {}, async ({ page }) => {
  // Aufnehmen und wieder ablegen ist ein Zuruecknehmen, kein Fehlversuch.
  const at = await squareCenter(page, 6, 4);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 30, at.y - 30, { steps: 3 });
  await page.mouse.move(at.x, at.y, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(250);

  assert.deepEqual(await soundLog(page), [],
    'Das Zuruecklegen auf das eigene Feld hat eine Absage ausgeloest');
});

/* ===================================================================== *
 * Schnelle Folgen
 * ===================================================================== */

audioTest('Schnell: je Zug genau ein Grundklang, nichts bleibt haengen', {}, async ({ page }) => {
  const line = [
    [6, 4, 4, 4], [1, 4, 3, 4], [7, 6, 5, 5], [0, 1, 2, 2],
    [7, 5, 4, 2], [0, 5, 3, 2], [7, 4, 7, 6], [0, 6, 2, 5]
  ];
  for (const move of line) await dragPiece(page, ...move, { settleFirst: false });
  await waitForMoveCount(page, line.length, 6000);
  await page.waitForTimeout(500);

  const log = await soundLog(page);
  const base = log.filter(name => ['move', 'capture', 'castle', 'promote'].includes(name));
  assert.equal(base.length, line.length,
    `${line.length} Zuege, aber ${base.length} Grundklaenge: ${log.join(', ')}`);
  assert.equal(log.filter(name => name === 'castle').length, 1, 'Die Rochade klang mehr als einmal');

  // Nichts kommt nachtraeglich noch hinterher.
  await clearSounds(page);
  await page.waitForTimeout(700);
  assert.deepEqual(await soundLog(page), [], 'Nach dem letzten Zug wurde noch ein Klang nachgereicht');
});

audioTest('Schnell: Schlagzug und sofort der Gegenschlag', {}, async ({ page }) => {
  await dragPiece(page, 6, 4, 4, 4); await waitForMoveCount(page, 1, 2500);
  await dragPiece(page, 1, 3, 3, 3); await waitForMoveCount(page, 2, 2500);
  await clearSounds(page);

  await dragPiece(page, 4, 4, 3, 3, { settleFirst: false });    // 2. exd5
  await dragPiece(page, 0, 3, 3, 3, { settleFirst: false });    // 2... Qxd5
  await waitForMoveCount(page, 4, 4000);

  const log = await soundLog(page);
  assert.deepEqual(log, ['capture', 'capture'],
    `Zwei Schlagzuege in Folge loesten ${log.join(', ')} aus`);
});

/* ===================================================================== *
 * Einstellungen
 * ===================================================================== */

audioTest('Einstellungen: abgeschaltet wird nichts gespielt', {}, async ({ page }) => {
  await page.evaluate(() => window.ChessSound.setEnabled(false));
  await dragPiece(page, 6, 4, 4, 4); await waitForMoveCount(page, 1, 2500);

  const detail = await soundDetail(page);
  assert.equal(detail.length > 0, true, 'Der Zug hat gar keinen Klang angefordert');
  assert.equal(detail.every(entry => entry.played === false), true,
    'Bei abgeschaltetem Ton wurde trotzdem etwas abgespielt');

  await page.evaluate(() => window.ChessSound.setEnabled(true));
  await clearSounds(page);
  await dragPiece(page, 1, 4, 3, 4); await waitForMoveCount(page, 2, 2500);
  const after = await soundDetail(page);
  assert.equal(after.every(entry => entry.played === true), true,
    'Nach dem Wiedereinschalten kam kein Klang mehr durch');
});

audioTest('Einstellungen: die Lautstaerke gilt fuer jeden neuen Klang', {}, async ({ page }) => {
  await page.evaluate(() => window.ChessSound.setVolume(0.25));
  assert.equal(await page.evaluate(() => window.ChessSound.getVolume()), 0.25);
  await dragPiece(page, 6, 4, 4, 4); await waitForMoveCount(page, 1, 2500);
  // Die Lautstaerke geht in jede Stimme als Faktor ein; hier zaehlt, dass sie
  // ueberhaupt zentral gilt und nicht an einzelnen Aufrufstellen haengt.
  assert.equal(await page.evaluate(() => window.ChessSound.getVolume()), 0.25,
    'Die Lautstaerke hat den Zug nicht ueberlebt');
  assert.equal((await soundDetail(page)).every(entry => entry.played === true), true);
});

/* ===================================================================== *
 * Leistung
 * ===================================================================== */

audioTest('Leistung: der Klang haelt den Zug nicht auf', {}, async ({ page, t }) => {
  const released = Date.now();
  await dragPiece(page, 6, 4, 4, 4, { settleFirst: false });
  await waitForMoveCount(page, 1, 2500);
  const logicMs = Date.now() - released;
  t.diagnostic(`Zugabschluss mit aktivem Ton: ${logicMs} ms`);
  assert.equal(logicMs < 250, true, `Der Zug brauchte mit Ton ${logicMs} ms`);
  assert.deepEqual(await soundLog(page), ['move']);
});
