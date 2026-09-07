/**
 * Taktikaufgaben: Katalog, Fortschritt und der Ablauf einer einzelnen Aufgabe.
 *
 * Hier steht bewusst nichts ueber das Brett. Diese Datei kennt Zuege nur als
 * UCI-Zeichenketten und weiss nichts von Feldern, Bildern oder Klicks - dadurch
 * laesst sich der ganze Ablauf einer Aufgabe pruefen, ohne einen Browser zu
 * starten. Das Zeichnen macht app.js.
 *
 * Die Aufgaben selbst stammen aus tools/make_puzzles.py: selbst erzeugt und von
 * Stockfish auf voller Staerke geprueft, damit die Seite ohne fremde
 * Datenlizenz auskommt.
 */
(function () {
  'use strict';

  const global = typeof window !== 'undefined' ? window : globalThis;

  const STORAGE_KEY = 'chess-puzzle-progress';
  const START_RATING = 1000;
  const MIN_RATING = 400;
  const MAX_RATING = 2800;
  /** Wie stark ein Ergebnis die eigene Wertung bewegt. */
  const K_FACTOR = 28;
  /** Aus so vielen passenden Aufgaben wird die naechste gezogen. */
  const POOL_SIZE = 24;

  const THEME_LABELS = {
    mateIn1: 'Matt in 1',
    mateIn2: 'Matt in 2',
    mateIn3: 'Matt in 3',
    backRankMate: 'Grundreihenmatt',
    fork: 'Gabel',
    sacrifice: 'Opfer',
    promotion: 'Umwandlung',
    hangingPiece: 'Figur steht ein',
    check: 'Schachzug',
    long: 'Lange Kombination',
    advantage: 'Vorteil herausholen'
  };

  /** Reihenfolge in der Themenauswahl - das Greifbare zuerst. */
  const THEME_ORDER = ['mateIn1', 'mateIn2', 'mateIn3', 'backRankMate', 'fork',
    'sacrifice', 'hangingPiece', 'promotion', 'check', 'long', 'advantage'];

  function themeLabel(theme) {
    return THEME_LABELS[theme] || theme;
  }

  /* ===================================================================== *
   * Katalog
   * ===================================================================== */

  let catalogue = null;
  let loading = null;

  function dataUrl() {
    // Dokumentrelativ, damit die Seite auch unter einem Unterpfad wie
    // /schach/ funktioniert - ein fuehrender Schrägstrich wuerde dort auf die
    // Domainwurzel zeigen und nichts finden.
    const base = typeof document !== 'undefined' ? document.baseURI : '';
    return base ? new URL('static/puzzles.json', base).href : 'static/puzzles.json';
  }

  function normalise(raw) {
    const list = Array.isArray(raw) ? raw : (raw && raw.puzzles) || [];
    return list
      .filter(p => p && typeof p.fen === 'string' && Array.isArray(p.moves) && p.moves.length)
      .map((p, index) => ({
        id: p.id || `p${index + 1}`,
        fen: p.fen,
        moves: p.moves.slice(),
        rating: Number(p.rating) || 1000,
        themes: Array.isArray(p.themes) && p.themes.length ? p.themes.slice() : ['advantage'],
        mateIn: p.mateIn || null,
        setupFen: p.setupFen || null,
        lastMove: p.lastMove || null
      }));
  }

  function load() {
    if (catalogue) return Promise.resolve(catalogue);
    if (loading) return loading;
    loading = fetch(dataUrl(), { cache: 'force-cache' })
      .then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then(data => {
        catalogue = normalise(data);
        if (!catalogue.length) throw new Error('Der Aufgabensatz ist leer.');
        return catalogue;
      })
      .catch(error => {
        // Ein zweiter Versuch soll moeglich sein; ein festgehaltener
        // abgelehnter Promise wuerde die Funktion dauerhaft blockieren.
        loading = null;
        throw error;
      });
    return loading;
  }

  /** Nur fuer Tests und fuer selbst erzeugte Aufgaben aus eigenen Partien. */
  function setCatalogue(list) {
    catalogue = normalise(list);
    loading = null;
    return catalogue;
  }

  function all() {
    return catalogue ? catalogue.slice() : [];
  }

  function availableThemes() {
    const seen = new Set();
    for (const puzzle of catalogue || []) for (const theme of puzzle.themes) seen.add(theme);
    const known = THEME_ORDER.filter(t => seen.has(t));
    const rest = [...seen].filter(t => !THEME_ORDER.includes(t)).sort();
    return known.concat(rest);
  }

  /* ===================================================================== *
   * Fortschritt
   * ===================================================================== */

  function emptyProgress() {
    return { rating: START_RATING, solved: {}, streak: 0, bestStreak: 0, attempts: 0, correct: 0 };
  }

  function readProgress() {
    try {
      const raw = global.localStorage && global.localStorage.getItem(STORAGE_KEY);
      if (!raw) return emptyProgress();
      const parsed = JSON.parse(raw);
      const base = emptyProgress();
      return {
        rating: clampRating(Number(parsed.rating) || START_RATING),
        solved: (parsed.solved && typeof parsed.solved === 'object') ? parsed.solved : base.solved,
        streak: Number(parsed.streak) || 0,
        bestStreak: Number(parsed.bestStreak) || 0,
        attempts: Number(parsed.attempts) || 0,
        correct: Number(parsed.correct) || 0
      };
    } catch (error) {
      // Privater Modus, volle Quote, abgeschaltete Speicherung: kein Grund,
      // das Training zu verweigern - es merkt sich dann eben nichts.
      return emptyProgress();
    }
  }

  function writeProgress(progress) {
    try {
      global.localStorage && global.localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
    } catch (error) {
      /* siehe oben */
    }
  }

  function clampRating(value) {
    return Math.max(MIN_RATING, Math.min(MAX_RATING, Math.round(value)));
  }

  /**
   * Elo-Anpassung nach einer Aufgabe.
   *
   * Bewusst dieselbe Formel wie beim Schach selbst: eine schwere Aufgabe zu
   * loesen bringt viel, eine leichte zu verpatzen kostet viel. Wer einen
   * Hinweis nimmt, bekommt die Aufgabe nicht als geloest angerechnet - sonst
   * waere die eigene Wertung nur noch Dekoration.
   */
  function nextRating(playerRating, puzzleRating, solved) {
    const expected = 1 / (1 + Math.pow(10, (puzzleRating - playerRating) / 400));
    return clampRating(playerRating + K_FACTOR * ((solved ? 1 : 0) - expected));
  }

  function record(puzzle, outcome) {
    const progress = readProgress();
    const solved = outcome.solved && !outcome.usedHint;
    progress.attempts += 1;
    if (outcome.solved) progress.correct += 1;
    progress.rating = nextRating(progress.rating, puzzle.rating, solved);
    if (solved) {
      progress.streak += 1;
      progress.bestStreak = Math.max(progress.bestStreak, progress.streak);
      const previous = progress.solved[puzzle.id];
      progress.solved[puzzle.id] = {
        at: outcome.at || Date.now(),
        tries: (previous ? previous.tries || 0 : 0) + (outcome.mistakes || 0) + 1
      };
    } else {
      progress.streak = 0;
    }
    writeProgress(progress);
    return progress;
  }

  function resetProgress() {
    const fresh = emptyProgress();
    writeProgress(fresh);
    return fresh;
  }

  function stats(progress) {
    const p = progress || readProgress();
    const solvedCount = Object.keys(p.solved).length;
    const total = catalogue ? catalogue.length : 0;
    return {
      rating: p.rating,
      solved: solvedCount,
      total,
      remaining: Math.max(0, total - solvedCount),
      streak: p.streak,
      bestStreak: p.bestStreak,
      attempts: p.attempts,
      accuracy: p.attempts ? Math.round((p.correct / p.attempts) * 100) : null
    };
  }

  /* ===================================================================== *
   * Auswahl
   * ===================================================================== */

  /**
   * Waehlt die naechste Aufgabe: noch nicht geloest, thematisch passend und
   * moeglichst nah an der eigenen Wertung.
   *
   * Nicht einfach die allernaechste, sondern eine aus den naechstgelegenen -
   * sonst kaeme nach einem Ergebnis, das die Wertung kaum bewegt, wieder
   * dieselbe Aufgabe.
   */
  function pick(options) {
    const opts = options || {};
    const list = catalogue || [];
    if (!list.length) return null;
    const progress = opts.progress || readProgress();
    const rating = opts.rating != null ? opts.rating : progress.rating;
    const random = opts.random || Math.random;

    let pool = list;
    if (opts.theme) pool = pool.filter(p => p.themes.includes(opts.theme));
    if (!pool.length) pool = list;

    const unsolved = pool.filter(p => !progress.solved[p.id]);
    // Alles geloest? Dann von vorn, statt die Uebung zu beenden.
    const source = unsolved.length ? unsolved : pool;

    const sorted = source
      .map(p => ({ puzzle: p, distance: Math.abs(p.rating - rating) }))
      .sort((a, b) => a.distance - b.distance || (a.puzzle.id < b.puzzle.id ? -1 : 1));

    const window = sorted.slice(0, Math.min(POOL_SIZE, sorted.length));
    let candidates = window;
    if (opts.exclude) candidates = window.filter(e => e.puzzle.id !== opts.exclude) || window;
    if (!candidates.length) candidates = window;
    return candidates[Math.floor(random() * candidates.length)].puzzle;
  }

  function byId(id) {
    return (catalogue || []).find(p => p.id === id) || null;
  }

  /* ===================================================================== *
   * Ablauf einer Aufgabe
   * ===================================================================== */

  /**
   * Der Zustand einer laufenden Aufgabe.
   *
   * `moves` wechselt sich ab: Spieler, Gegner, Spieler, ... Der Gegnerzug wird
   * vom Programm gespielt und muss deshalb nicht erraten werden; nur die Zuege
   * des Spielers werden geprueft.
   */
  function createSession(puzzle) {
    let index = 0;
    let mistakes = 0;
    let usedHint = false;
    let finished = false;

    function expected() {
      return finished ? null : (puzzle.moves[index] || null);
    }

    return {
      puzzle,
      get index() { return index; },
      get mistakes() { return mistakes; },
      get usedHint() { return usedHint; },
      get finished() { return finished; },
      /** Wie viele Zuege der Spieler insgesamt zu finden hat. */
      get totalMoves() { return Math.ceil(puzzle.moves.length / 2); },
      /** Der wievielte davon gerade ansteht, ab 1. */
      get moveNumber() { return Math.floor(index / 2) + 1; },
      expected,

      /**
       * Prueft den Zug des Spielers.
       *
       * `mates` sagt, ob der gespielte Zug mattsetzt. Damit wird ein zweites
       * Matt in derselben Stellung anerkannt: es gibt oft mehrere, und eines
       * davon als falsch abzustempeln, nur weil Stockfish ein anderes zuerst
       * gefunden hat, waere schlicht verkehrt.
       */
      submit(uci, info) {
        if (finished) return { result: 'done', reply: null };
        const want = puzzle.moves[index];
        const mates = !!(info && info.mates);
        const lastPlayerMove = index === puzzle.moves.length - 1;
        const correct = uci === want || (mates && lastPlayerMove && !!puzzle.mateIn);
        if (!correct) {
          mistakes += 1;
          return { result: 'wrong', reply: null, expected: want };
        }
        index += 1;
        if (mates || index >= puzzle.moves.length) {
          finished = true;
          return { result: 'solved', reply: null };
        }
        const reply = puzzle.moves[index];
        index += 1;
        if (index >= puzzle.moves.length) {
          // Eine Loesung endet immer mit einem Spielerzug; landet hier
          // trotzdem der Gegner zuletzt, ist die Aufgabe danach vorbei.
          finished = true;
          return { result: 'solved', reply };
        }
        return { result: 'correct', reply };
      },

      /** Gibt den gesuchten Zug preis - und merkt sich, dass geholfen wurde. */
      hint() {
        usedHint = true;
        return expected();
      },

      /** Aufgeben: die Loesung wird vorgefuehrt, gezaehlt wird sie als Fehler. */
      giveUp() {
        usedHint = true;
        finished = true;
        return puzzle.moves.slice(index);
      },

      outcome(solved) {
        return { solved, usedHint, mistakes, at: Date.now() };
      }
    };
  }

  global.ChessPuzzles = {
    STORAGE_KEY,
    THEME_LABELS,
    THEME_ORDER,
    themeLabel,
    load,
    setCatalogue,
    all,
    byId,
    availableThemes,
    readProgress,
    writeProgress,
    resetProgress,
    record,
    stats,
    nextRating,
    pick,
    createSession
  };
})();
