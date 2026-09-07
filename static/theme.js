/**
 * Light or dark interface.
 *
 * Loaded before the stylesheet is applied to anything visible, because a theme
 * decided later means the page paints once in the wrong one first - a white
 * flash on a dark setup, which is exactly what people notice.
 *
 * Three states, not two: "auto" follows the operating system and is the
 * default, and only an explicit choice writes an attribute. That distinction
 * matters - without it, someone who picked dark in summer keeps it when their
 * system switches to light, with no way back to "just follow the system".
 */
(() => {
  'use strict';

  const KEY = 'chess-theme';
  const VALID = new Set(['auto', 'dark', 'light']);

  function stored() {
    try {
      const value = localStorage.getItem(KEY);
      return VALID.has(value) ? value : 'auto';
    } catch { return 'auto'; }
  }

  function apply(choice) {
    // "auto" removes the attribute entirely rather than writing the resolved
    // value, so the CSS media query stays in charge and follows the system
    // while the page is open.
    if (choice === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = choice;
  }

  const api = {
    get() { return stored(); },
    set(choice) {
      const value = VALID.has(choice) ? choice : 'auto';
      try { localStorage.setItem(KEY, value); } catch { /* ignore */ }
      apply(value);
      return value;
    },
    /** What is actually on screen right now, auto resolved. */
    resolved() {
      const choice = stored();
      if (choice !== 'auto') return choice;
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
  };

  apply(stored());
  window.ChessTheme = api;
})();
