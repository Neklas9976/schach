(() => {
  'use strict';

  const modal = document.getElementById('settings-modal');
  const openBtn = document.getElementById('settings-btn');
  const closeBtn = document.getElementById('settings-close');
  const animationToggle = document.getElementById('piece-animation-toggle');
  const animationOptions = [...document.querySelectorAll('input[name="piece-animation"]')];
  const movementSelect = document.getElementById('piece-movement-select');
  const animationOptionsWrap = document.getElementById('animation-options');

  const DEFAULTS = {
    pieceAnimationEnabled: true,
    pieceAnimation: 'medium',
    pieceMovement: 'drag-or-click'
  };

  const ANIMATION = {
    slow: { duration: 560, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)' },
    medium: { duration: 280, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' },
    fast: { duration: 120, easing: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)' },
    natural: { duration: 420, easing: 'cubic-bezier(0.18, 0.78, 0.22, 1)' },
    arcade: { duration: 500, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    dynamic: { duration: 420, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' }
  };

  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(`chess-${key}`);
      return raw == null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  }

  function write(key, value) {
    try { localStorage.setItem(`chess-${key}`, JSON.stringify(value)); } catch { /* ignore */ }
  }

  let settings = {
    pieceAnimationEnabled: read('piece-animation-enabled', DEFAULTS.pieceAnimationEnabled),
    pieceAnimation: read('piece-animation', DEFAULTS.pieceAnimation),
    pieceMovement: read('piece-movement', DEFAULTS.pieceMovement)
  };

  function setDomState() {
    document.documentElement.dataset.pieceAnimationEnabled = settings.pieceAnimationEnabled ? '1' : '0';
    document.documentElement.dataset.pieceAnimation = settings.pieceAnimation;
    document.documentElement.dataset.pieceMovement = settings.pieceMovement;
  }

  function syncControls() {
    if (!animationToggle) return;
    animationToggle.checked = !!settings.pieceAnimationEnabled;
    animationOptions.forEach(r => { r.checked = r.value === settings.pieceAnimation; r.disabled = !settings.pieceAnimationEnabled; });
    if (movementSelect) movementSelect.value = settings.pieceMovement;
    if (animationOptionsWrap) animationOptionsWrap.classList.toggle('disabled', !settings.pieceAnimationEnabled);
  }

  function persist() {
    write('piece-animation-enabled', !!settings.pieceAnimationEnabled);
    write('piece-animation', settings.pieceAnimation);
    write('piece-movement', settings.pieceMovement);
    setDomState();
    syncControls();
    window.dispatchEvent(new CustomEvent('chess-settings-changed', { detail: getSettings() }));
  }

  function getSettings() {
    return { ...settings, animation: ANIMATION[settings.pieceAnimation] || ANIMATION.medium };
  }

  if (openBtn) openBtn.addEventListener('click', () => { modal.hidden = false; syncControls(); });
  if (closeBtn) closeBtn.addEventListener('click', () => { modal.hidden = true; });
  if (modal) {
    modal.addEventListener('click', e => { if (e.target === modal) modal.hidden = true; });
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && modal) modal.hidden = true; });

  if (animationToggle) animationToggle.addEventListener('change', () => {
    settings.pieceAnimationEnabled = animationToggle.checked;
    persist();
  });
  animationOptions.forEach(r => r.addEventListener('change', () => {
    if (r.checked) { settings.pieceAnimation = r.value; persist(); }
  }));
  if (movementSelect) movementSelect.addEventListener('change', () => {
    settings.pieceMovement = movementSelect.value;
    persist();
  });

  setDomState();
  syncControls();
  window.getChessSettings = getSettings;
})();
