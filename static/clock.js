(() => {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Time controls
   * ------------------------------------------------------------------ */

  const TIME_CONTROLS = [
    { id: 'unlimited', label: 'Ohne Zeit',  category: 'Ohne Uhr',  base: null, increment: 0 },
    { id: '1+0',   label: '1 + 0',   category: 'Bullet', base:  60_000, increment:     0 },
    { id: '2+1',   label: '2 + 1',   category: 'Bullet', base: 120_000, increment: 1_000 },
    { id: '3+0',   label: '3 + 0',   category: 'Blitz',  base: 180_000, increment:     0 },
    { id: '3+2',   label: '3 + 2',   category: 'Blitz',  base: 180_000, increment: 2_000 },
    { id: '5+0',   label: '5 + 0',   category: 'Blitz',  base: 300_000, increment:     0 },
    { id: '5+3',   label: '5 + 3',   category: 'Blitz',  base: 300_000, increment: 3_000 },
    { id: '10+0',  label: '10 + 0',  category: 'Rapid',  base: 600_000, increment:     0 },
    { id: '10+5',  label: '10 + 5',  category: 'Rapid',  base: 600_000, increment: 5_000 },
    { id: '15+10', label: '15 + 10', category: 'Rapid',  base: 900_000, increment:10_000 },
    { id: '30+0',  label: '30 + 0',  category: 'Classical', base: 1_800_000, increment: 0 }
  ];

  const DEFAULT_CONTROL = 'unlimited';

  function findControl(id) {
    return TIME_CONTROLS.find(tc => tc.id === id) || TIME_CONTROLS[0];
  }

  /* ------------------------------------------------------------------ *
   * Pure helpers (kept side-effect free so they can be unit tested)
   * ------------------------------------------------------------------ */

  /**
   * Formats a remaining duration the way players expect to read it:
   * tenths of a second only once the position is genuinely urgent, so the
   * digits are not flickering for the whole game.
   */
  function formatTime(ms) {
    const clamped = Math.max(0, ms);
    const totalSeconds = clamped / 1000;

    if (clamped < 10_000) {
      // Round DOWN so a clock never shows a time the player does not have.
      const whole = Math.floor(totalSeconds);
      const tenths = Math.floor((clamped - whole * 1000) / 100);
      return `${whole}.${tenths}`;
    }

    const seconds = Math.floor(totalSeconds);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    const pad = n => String(n).padStart(2, '0');

    return hours > 0
      ? `${hours}:${pad(minutes)}:${pad(rest)}`
      : `${minutes}:${pad(rest)}`;
  }

  /**
   * FIDE 6.9 / competition rule: losing on time is only a loss if the
   * opponent could still deliver mate by *some* legal sequence. A lone king,
   * king + single bishop and king + single knight cannot, so those cases are
   * scored as a draw instead of a win.
   *
   * Note that king + two knights CAN mate (it just cannot be forced), so it
   * deliberately counts as sufficient material here.
   */
  function hasMatingMaterial(board, color) {
    const isWhite = color === 'white';
    const minors = [];

    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const piece = board[r][c];
        if (!piece) continue;
        if ((piece === piece.toUpperCase()) !== isWhite) continue;

        const type = piece.toLowerCase();
        if (type === 'k') continue;
        if (type === 'p' || type === 'r' || type === 'q') return true;
        minors.push(type);
      }
    }

    return minors.length >= 2;
  }

  /**
   * Decides the outcome once `flagged` has run out of time.
   * Returns { type: 'timeout', winner } or { type: 'timeout-draw', winner: null }.
   */
  function resolveFlag(board, flagged) {
    const opponent = flagged === 'white' ? 'black' : 'white';
    return hasMatingMaterial(board, opponent)
      ? { type: 'timeout', winner: opponent, flagged }
      : { type: 'timeout-draw', winner: null, flagged };
  }

  /* ------------------------------------------------------------------ *
   * Clock state machine
   * ------------------------------------------------------------------ */

  // Timing is anchored to a single absolute timestamp per turn rather than
  // accumulated per frame. Frame-by-frame subtraction accumulates rounding
  // error and silently drifts whenever the tab is throttled or a frame is
  // dropped; anchoring means the remaining time is always derived from one
  // subtraction against the real clock and cannot drift at all.
  const now = () => (typeof performance !== 'undefined' && performance.now)
    ? performance.now()
    : Date.now();

  function createClock() {
    let control = findControl(DEFAULT_CONTROL);
    let remaining = { white: 0, black: 0 };
    let active = null;      // color whose clock is counting, or null
    let turnStartedAt = 0;  // timestamp at which `active` began thinking
    let running = false;
    let flaggedColor = null;
    let flagListeners = [];

    function enabled() {
      return control.base != null;
    }

    function liveRemaining(color) {
      if (!enabled()) return null;
      if (running && active === color) {
        return Math.max(0, remaining[color] - (now() - turnStartedAt));
      }
      return remaining[color];
    }

    /** Commits the elapsed time of the running side back into `remaining`. */
    function settle() {
      if (!running || !active) return;
      remaining[active] = Math.max(0, remaining[active] - (now() - turnStartedAt));
      turnStartedAt = now();
    }

    function reset(controlId) {
      if (controlId !== undefined) control = findControl(controlId);
      const base = control.base ?? 0;
      remaining = { white: base, black: base };
      active = null;
      running = false;
      flaggedColor = null;
      turnStartedAt = 0;
    }

    /** Called when `mover` has completed a move; hands the clock to `next`. */
    function onMoveMade(mover, next) {
      if (!enabled() || flaggedColor) return;

      if (running && active === mover) {
        settle();
        // Fischer increment is credited only for moves actually played on
        // the clock - never for the very first hand-off, and never to a side
        // whose flag has already fallen.
        remaining[mover] = remaining[mover] + control.increment;
      }

      active = next;
      turnStartedAt = now();
      running = true;
    }

    function stop() {
      settle();
      running = false;
      active = null;
    }

    /**
     * Recomputes remaining time and reports a flag fall.
     * Returns the flagged color once, then null on subsequent calls.
     */
    function poll() {
      if (!enabled() || !running || !active || flaggedColor) return null;

      const left = liveRemaining(active);
      if (left > 0) return null;

      remaining[active] = 0;
      flaggedColor = active;
      running = false;
      const flagged = flaggedColor;
      flagListeners.forEach(fn => { try { fn(flagged); } catch { /* listener errors must not stall the clock */ } });
      return flagged;
    }

    /** Serialisable snapshot, used so undo restores clocks atomically too. */
    function getState() {
      settle();
      return {
        controlId: control.id,
        remaining: { ...remaining },
        active,
        running,
        flaggedColor
      };
    }

    function restoreState(snapshot) {
      if (!snapshot) return;
      control = findControl(snapshot.controlId);
      remaining = { ...snapshot.remaining };
      active = snapshot.active;
      running = snapshot.running;
      flaggedColor = snapshot.flaggedColor ?? null;
      turnStartedAt = now();
    }

    return {
      TIME_CONTROLS,
      formatTime,
      hasMatingMaterial,
      resolveFlag,
      findControl,
      get control() { return control; },
      isEnabled: enabled,
      remainingFor: liveRemaining,
      activeColor: () => active,
      isRunning: () => running,
      flagged: () => flaggedColor,
      reset,
      onMoveMade,
      stop,
      poll,
      getState,
      restoreState,
      onFlag(fn) { flagListeners.push(fn); },
      _clearFlagListeners() { flagListeners = []; }
    };
  }

  const clock = createClock();

  /* ------------------------------------------------------------------ *
   * DOM binding (skipped entirely in non-browser contexts, e.g. tests)
   * ------------------------------------------------------------------ */

  if (typeof document !== 'undefined') {
    const whiteEl = document.getElementById('white-clock');
    const blackEl = document.getElementById('black-clock');
    const select = document.getElementById('time-control-select');
    const hint = document.getElementById('time-control-hint');

    const STORAGE_KEY = 'chess-time-control';

    function readStored() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw == null ? DEFAULT_CONTROL : JSON.parse(raw);
      } catch { return DEFAULT_CONTROL; }
    }

    function writeStored(id) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(id)); } catch { /* ignore */ }
    }

    // Only touch the DOM when the rendered text actually changes. At 240 Hz
    // the render loop fires ~240x/second, but the displayed string changes at
    // most ~10x/second, so this avoids ~96% of otherwise pointless layout work.
    const lastText = { white: null, black: null };
    const lastLow = { white: null, black: null };

    function paint(color, el) {
      if (!el) return;

      if (!clock.isEnabled()) {
        if (lastText[color] !== '—') {
          el.textContent = '—';
          lastText[color] = '—';
        }
        el.classList.add('placeholder-clock');
        el.classList.remove('clock-active', 'clock-low', 'clock-flagged');
        return;
      }

      const ms = clock.remainingFor(color);
      const text = clock.formatTime(ms);
      if (lastText[color] !== text) {
        el.textContent = text;
        lastText[color] = text;
      }

      el.classList.remove('placeholder-clock');
      el.classList.toggle('clock-active', clock.activeColor() === color && clock.isRunning());
      el.classList.toggle('clock-flagged', clock.flagged() === color);

      const low = ms <= 20_000 && ms > 0;
      if (lastLow[color] !== low) {
        el.classList.toggle('clock-low', low);
        // Sounded on the transition only. A tick every second would be the
        // obvious alternative and is exactly the kind of noise people turn
        // sound off over; the colour change already carries the ongoing state.
        if (low && lastLow[color] !== null && clock.activeColor() === color && clock.isRunning()) {
          if (typeof window !== 'undefined') window.ChessSound?.play('lowTime');
        }
        lastLow[color] = low;
      }
    }

    function paintAll() {
      paint('white', whiteEl);
      paint('black', blackEl);
    }

    let frame = null;
    function loop() {
      clock.poll();
      paintAll();
      frame = requestAnimationFrame(loop);
    }
    function ensureLoop() {
      if (frame == null) frame = requestAnimationFrame(loop);
    }

    // requestAnimationFrame is suspended while the tab is hidden, so a flag
    // could otherwise go unnoticed until the player returns. A coarse timer
    // keeps running in the background and catches exactly that case.
    setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) clock.poll();
    }, 1000);

    function populateSelect() {
      if (!select) return;
      const groups = new Map();
      for (const tc of TIME_CONTROLS) {
        if (!groups.has(tc.category)) groups.set(tc.category, []);
        groups.get(tc.category).push(tc);
      }
      select.innerHTML = '';
      for (const [category, items] of groups) {
        const group = document.createElement('optgroup');
        group.label = category;
        for (const tc of items) {
          const option = document.createElement('option');
          option.value = tc.id;
          option.textContent = tc.label;
          group.appendChild(option);
        }
        select.appendChild(group);
      }
    }

    function setHint(text) {
      if (hint) hint.textContent = text;
    }

    populateSelect();
    const stored = readStored();
    clock.reset(stored);
    if (select) select.value = clock.control.id;
    paintAll();
    ensureLoop();

    if (select) {
      select.addEventListener('change', () => {
        const id = select.value;
        writeStored(id);
        window.dispatchEvent(new CustomEvent('chess-time-control-changed', { detail: { id } }));
      });
    }

    window.ChessClock = clock;
    window.ChessClock.repaint = paintAll;
    window.ChessClock.resetDisplayCache = () => {
      lastText.white = lastText.black = null;
      lastLow.white = lastLow.black = null;
    };
    window.ChessClock.setHint = setHint;
  } else {
    // Test / non-DOM environment.
    const target = (typeof window !== 'undefined') ? window : globalThis;
    target.ChessClock = clock;
  }
})();
