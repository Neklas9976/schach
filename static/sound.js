/**
 * Board sounds, synthesised in the browser.
 *
 * Why synthesis instead of audio files: samples would be another set of
 * third-party assets with their own licence question - exactly the problem the
 * board and piece graphics already have - and several hundred kilobytes of
 * binaries in a project that otherwise ships only source. The Web Audio API
 * can produce a convincing wooden click from a noise burst and a short pitched
 * body, so nothing has to be downloaded or licensed.
 *
 * The AudioContext is created on the first real user gesture. Browsers start
 * one in the "suspended" state otherwise, and a suspended context swallows
 * every sound silently until something resumes it.
 */
(() => {
  'use strict';

  const STORAGE_KEY = 'chess-sound';
  const AudioCtor = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;

  let context = null;
  let noiseBuffer = null;

  function readSetting(key, fallback) {
    try {
      const raw = localStorage.getItem(`${STORAGE_KEY}-${key}`);
      return raw == null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  }

  function writeSetting(key, value) {
    try { localStorage.setItem(`${STORAGE_KEY}-${key}`, JSON.stringify(value)); } catch { /* ignore */ }
  }

  const settings = {
    enabled: readSetting('enabled', true),
    volume: readSetting('volume', 0.6)
  };

  function ensureContext() {
    if (!AudioCtor) return null;
    if (!context) {
      try { context = new AudioCtor(); } catch { return null; }
    }
    // A context can be suspended again at any time (tab hidden, autoplay
    // policy), so this is checked on every play, not just at creation.
    if (context.state === 'suspended') context.resume().catch(() => {});
    return context;
  }

  /** One second of white noise, reused by every percussive sound. */
  function ensureNoise(ctx) {
    if (noiseBuffer) return noiseBuffer;
    const length = Math.floor(ctx.sampleRate * 0.4);
    noiseBuffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return noiseBuffer;
  }

  /**
   * The percussive part of a piece landing: a filtered noise burst with a very
   * short decay. `tone` shifts the band-pass, which is what separates a light
   * tap from a heavier thud.
   */
  function click(ctx, at, { gain = 0.5, tone = 1800, decay = 0.055, q = 1.2 } = {}) {
    const source = ctx.createBufferSource();
    source.buffer = ensureNoise(ctx);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = tone;
    filter.Q.value = q;

    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(gain, at + 0.004);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + decay);

    source.connect(filter).connect(envelope).connect(ctx.destination);
    source.start(at);
    source.stop(at + decay + 0.02);
  }

  /** The pitched body under a click, or a standalone musical note. */
  function tone(ctx, at, { freq = 220, gain = 0.25, duration = 0.12, type = 'sine', glide = null } = {}) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    if (glide !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(20, glide), at + duration);

    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(gain, at + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration);

    osc.connect(envelope).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + duration + 0.02);
  }

  const VOICES = {
    move(ctx, t, v) {
      click(ctx, t, { gain: 0.55 * v, tone: 1900, decay: 0.05 });
      tone(ctx, t, { freq: 180, gain: 0.18 * v, duration: 0.07, type: 'triangle' });
    },
    capture(ctx, t, v) {
      // Heavier and grittier than a quiet move: a lower band and a longer tail.
      click(ctx, t, { gain: 0.75 * v, tone: 950, decay: 0.1, q: 0.8 });
      tone(ctx, t, { freq: 120, gain: 0.26 * v, duration: 0.11, type: 'triangle' });
    },
    castle(ctx, t, v) {
      // Two pieces land, so the sound is two taps rather than one.
      VOICES.move(ctx, t, v * 0.9);
      VOICES.move(ctx, t + 0.085, v * 0.75);
    },
    check(ctx, t, v) {
      click(ctx, t, { gain: 0.4 * v, tone: 2600, decay: 0.04 });
      tone(ctx, t + 0.01, { freq: 880, gain: 0.2 * v, duration: 0.1, type: 'square' });
      tone(ctx, t + 0.1, { freq: 1174, gain: 0.18 * v, duration: 0.12, type: 'square' });
    },
    promote(ctx, t, v) {
      const notes = [523, 659, 784, 1046];
      notes.forEach((freq, i) => tone(ctx, t + i * 0.07, { freq, gain: 0.2 * v, duration: 0.16, type: 'triangle' }));
    },
    gameStart(ctx, t, v) {
      tone(ctx, t, { freq: 392, gain: 0.18 * v, duration: 0.14, type: 'sine' });
      tone(ctx, t + 0.1, { freq: 587, gain: 0.18 * v, duration: 0.2, type: 'sine' });
    },
    gameEndWin(ctx, t, v) {
      const notes = [523, 659, 784, 1046];
      notes.forEach((freq, i) => tone(ctx, t + i * 0.11, { freq, gain: 0.22 * v, duration: 0.3, type: 'sine' }));
    },
    gameEndLoss(ctx, t, v) {
      const notes = [523, 440, 349, 262];
      notes.forEach((freq, i) => tone(ctx, t + i * 0.13, { freq, gain: 0.22 * v, duration: 0.32, type: 'sine' }));
    },
    gameEndDraw(ctx, t, v) {
      tone(ctx, t, { freq: 440, gain: 0.2 * v, duration: 0.25, type: 'sine' });
      tone(ctx, t + 0.16, { freq: 440, gain: 0.16 * v, duration: 0.3, type: 'sine' });
    },
    illegal(ctx, t, v) {
      tone(ctx, t, { freq: 160, gain: 0.22 * v, duration: 0.13, type: 'sawtooth', glide: 90 });
    },
    lowTime(ctx, t, v) {
      tone(ctx, t, { freq: 1046, gain: 0.16 * v, duration: 0.07, type: 'square' });
    },
    notify(ctx, t, v) {
      tone(ctx, t, { freq: 784, gain: 0.16 * v, duration: 0.1, type: 'sine' });
    }
  };

  const api = {
    /** Names a caller may pass to play(); also what the settings UI previews. */
    VOICES: Object.keys(VOICES),

    isEnabled() { return !!settings.enabled; },
    getVolume() { return settings.volume; },

    setEnabled(value) {
      settings.enabled = !!value;
      writeSetting('enabled', settings.enabled);
      // Creating the context here rather than at the next move means the
      // toggle itself counts as the unlocking user gesture.
      if (settings.enabled) ensureContext();
    },

    setVolume(value) {
      settings.volume = Math.max(0, Math.min(Number(value) || 0, 1));
      writeSetting('volume', settings.volume);
    },

    play(name) {
      if (!settings.enabled) return;
      const voice = VOICES[name];
      if (!voice) return;
      const ctx = ensureContext();
      if (!ctx) return;
      try {
        voice(ctx, ctx.currentTime + 0.005, settings.volume);
      } catch { /* a sound must never break the move it belongs to */ }
    },

    /**
     * Picks the sound for a move that was just played. Kept here so the board
     * code does not have to know the precedence rules: check outranks the
     * capture that delivered it, and promotion outranks both.
     */
    playForMove({ captured = false, castle = false, promotion = false, check = false, gameOver = null } = {}) {
      if (gameOver) {
        api.play(gameOver === 'win' ? 'gameEndWin' : gameOver === 'loss' ? 'gameEndLoss' : 'gameEndDraw');
        return;
      }
      if (promotion) api.play('promote');
      else if (check) api.play('check');
      else if (castle) api.play('castle');
      else if (captured) api.play('capture');
      else api.play('move');
    }
  };

  if (typeof window !== 'undefined') window.ChessSound = api;
  else (typeof self !== 'undefined' ? self : globalThis).ChessSound = api;
})();
