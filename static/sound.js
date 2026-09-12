/**
 * Board sounds, synthesised in the browser.
 *
 * Why synthesis instead of audio files: samples would be another set of
 * third-party assets with their own licence question - exactly the problem the
 * board and piece graphics already had - and several hundred kilobytes of
 * binaries in a project that otherwise ships only source.
 *
 * How the sounds are built
 * ------------------------
 * A piece landing on a wooden board is two things at once:
 *
 *   1. a very short broadband transient - the click of the two surfaces
 *      meeting, over in a few milliseconds, and
 *   2. the board ringing afterwards at a handful of its own frequencies,
 *      each fading at its own rate.
 *
 * The earlier version had only the first part, one filtered noise burst, which
 * is why every move sounded like the same flat tap. Adding the resonances -
 * modal synthesis, three damped sines - is what makes it read as wood rather
 * than as a click.
 *
 * Every hit is also detuned slightly at random. Two identical impacts in a row
 * are the giveaway that a sound is synthetic; real pieces never land twice the
 * same way.
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

  /** Half a second of white noise, reused by every transient. */
  function ensureNoise(ctx) {
    if (noiseBuffer) return noiseBuffer;
    const length = Math.floor(ctx.sampleRate * 0.5);
    noiseBuffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return noiseBuffer;
  }

  /** A small random multiplier, so no two hits are identical. */
  function vary(spread = 0.06) {
    return 1 + (Math.random() * 2 - 1) * spread;
  }

  /**
   * The click: a noise burst through a band-pass, gone in milliseconds.
   * `tone` is where the two surfaces meet - higher for a hard tap, lower for
   * something heavy landing flat.
   */
  function transient(ctx, at, { gain = 0.5, tone = 2200, q = 0.9, decay = 0.02 } = {}) {
    const source = ctx.createBufferSource();
    source.buffer = ensureNoise(ctx);
    source.playbackRate.value = vary(0.12);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = tone * vary(0.08);
    filter.Q.value = q;

    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(gain, at + 0.001);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + decay);

    source.connect(filter).connect(envelope).connect(ctx.destination);
    source.start(at);
    source.stop(at + decay + 0.02);
  }

  /**
   * One resonance of the board: a sine that starts loud and dies away. Several
   * of these together are what the ear hears as "wood".
   */
  function mode(ctx, at, { freq, gain, decay, type = 'sine' }) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq * vary(0.03);

    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(gain, at + 0.004);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + decay);

    osc.connect(envelope).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + decay + 0.02);
  }

  /**
   * A piece meeting the board.
   *
   * `weight` shifts the resonances down and lengthens them - a queen landing
   * rather than a pawn. `brightness` moves the initial click, which is mostly
   * how hard the contact was.
   */
  function woodImpact(ctx, at, { gain = 1, weight = 1, brightness = 1 } = {}) {
    transient(ctx, at, { gain: 0.42 * gain, tone: 2300 * brightness, decay: 0.018, q: 0.8 });

    // Three modes, falling in level and decaying faster as they rise - which
    // is how a struck solid body actually behaves.
    const base = 196 / weight;
    mode(ctx, at, { freq: base,        gain: 0.30 * gain, decay: 0.11 * weight });
    mode(ctx, at, { freq: base * 1.74, gain: 0.17 * gain, decay: 0.07 * weight });
    mode(ctx, at, { freq: base * 3.12, gain: 0.08 * gain, decay: 0.04 * weight });
  }

  /** A short wooden scrape - one piece sliding against another. */
  function scrape(ctx, at, { gain = 0.2, duration = 0.05 } = {}) {
    const source = ctx.createBufferSource();
    source.buffer = ensureNoise(ctx);
    source.playbackRate.value = 0.55 * vary(0.1);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(900 * vary(), at);
    filter.frequency.exponentialRampToValueAtTime(1700, at + duration);
    filter.Q.value = 2.4;

    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(gain, at + duration * 0.35);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration);

    source.connect(filter).connect(envelope).connect(ctx.destination);
    source.start(at);
    source.stop(at + duration + 0.02);
  }

  /** A clean musical note, for the sounds that are signals rather than events. */
  function tone(ctx, at, { freq = 440, gain = 0.2, duration = 0.15, type = 'sine' } = {}) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;

    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(gain, at + 0.012);
    envelope.gain.setValueAtTime(gain, at + duration * 0.55);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration);

    osc.connect(envelope).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + duration + 0.02);
  }

  const VOICES = {
    /** A piece set down on an empty square. One impact, nothing else. */
    move(ctx, t, v) {
      woodImpact(ctx, t, { gain: 0.9 * v, weight: 1, brightness: 1 });
    },

    /**
     * A capture is three sounds, not one.
     *
     *   1. the piece being taken is knocked off its square - lighter, higher,
     *      with the scrape of the two pieces touching,
     *   2. a beat later the capturing piece settles where it stood: heavier
     *      and louder, landing with the whole move behind it, and
     *   3. further off, the captured piece is set down beside the board -
     *      quiet, dull, and without the board's resonance under it.
     *
     * A single thump is what the earlier version had, and it is why a capture
     * used to sound exactly like an ordinary move, only louder.
     */
    capture(ctx, t, v, { settle = 0.062 } = {}) {
      // Zwei Grenzen, aus zwei Gruenden: zu dicht beieinander verschmelzen die
      // beiden Schlaege zu einem, und zu weit auseinander zerfaellt der
      // Schlagzug in zwei Ereignisse, die nichts mehr miteinander zu tun haben.
      const land = Math.min(0.34, Math.max(0.045, settle));
      woodImpact(ctx, t, { gain: 0.62 * v, weight: 0.78, brightness: 1.25 });
      scrape(ctx, t + 0.004, { gain: 0.16 * v, duration: 0.06 });
      woodImpact(ctx, t + land, { gain: 1.05 * v, weight: 1.22, brightness: 0.88 });
      // Set down off the board: soft, short and dark. Loud enough to be part
      // of the gesture, quiet enough not to become a third beat you count.
      // Relativ zum Aufsetzen, nicht absolut - sonst holt es bei einem langen
      // Klickzug den zweiten Schlag ein und die drei Ereignisse verschmieren.
      woodImpact(ctx, t + land + 0.168, { gain: 0.2 * v, weight: 0.7, brightness: 0.45 });
    },

    /**
     * Two pieces land, king first and rook after - as the board shows it.
     *
     * `settle` ist der Abstand, den die Darstellung tatsaechlich zeigt: seit
     * Stufe 3 faehrt beim gezogenen Koenig nur der Turm, und der braucht
     * laenger als die 78 ms, die hier frueher fest verdrahtet waren.
     */
    castle(ctx, t, v, { settle = 0.078 } = {}) {
      const land = Math.min(0.34, Math.max(0.05, settle));
      woodImpact(ctx, t, { gain: 0.85 * v, weight: 1.05 });
      woodImpact(ctx, t + land, { gain: 0.72 * v, weight: 0.92, brightness: 1.1 });
    },

    /**
     * Das Schach - nur das Intervall, ohne eigenen Aufschlag.
     *
     * Frueher brachte diese Stimme ihren eigenen Aufschlag mit und ersetzte
     * damit den Zug, zu dem sie gehoerte: ein Schlagzug, der Schach bot, klang
     * wie ein gewoehnliches Schach, und das Schlagen war schlicht weg. Als
     * reiner Akzent legt sie sich statt dessen ueber den Zug - Schlagen und
     * Schach sind dann beide zu hoeren, und zwar in dieser Reihenfolge.
     */
    check(ctx, t, v) {
      tone(ctx, t, { freq: 784, gain: 0.13 * v, duration: 0.1, type: 'triangle' });
      tone(ctx, t + 0.07, { freq: 1046, gain: 0.12 * v, duration: 0.14, type: 'triangle' });
    },

    /**
     * Das Matt - kein Jubel, sondern ein Schlusspunkt.
     *
     * Der Jubel gehoert zur Meldung, die eine gute halbe Sekunde spaeter
     * aufgeht, nicht zu dem Zug, der sie ausloest. Hier steht deshalb eine
     * fallende Quinte unter dem Zug: sie sagt "zu Ende", und sie sagt es
     * leise genug, dass der Aufschlag des Zuges davor noch zu hoeren ist.
     */
    checkmate(ctx, t, v) {
      tone(ctx, t, { freq: 392, gain: 0.13 * v, duration: 0.22, type: 'triangle' });
      tone(ctx, t + 0.15, { freq: 262, gain: 0.14 * v, duration: 0.42, type: 'triangle' });
    },

    /** The pawn is set down, then something better is put in its place. */
    promote(ctx, t, v) {
      woodImpact(ctx, t, { gain: 0.7 * v, weight: 0.9 });
      [659, 880, 1318].forEach((freq, i) =>
        tone(ctx, t + 0.05 + i * 0.06, { freq, gain: 0.11 * v, duration: 0.2, type: 'triangle' }));
    },

    gameStart(ctx, t, v) {
      woodImpact(ctx, t, { gain: 0.5 * v, weight: 1.3, brightness: 0.8 });
      tone(ctx, t + 0.03, { freq: 392, gain: 0.11 * v, duration: 0.16 });
      tone(ctx, t + 0.13, { freq: 587, gain: 0.11 * v, duration: 0.24 });
    },

    gameEndWin(ctx, t, v) {
      [523, 659, 784, 1046].forEach((freq, i) =>
        tone(ctx, t + i * 0.1, { freq, gain: 0.15 * v, duration: 0.34 }));
    },

    gameEndLoss(ctx, t, v) {
      [523, 440, 349, 262].forEach((freq, i) =>
        tone(ctx, t + i * 0.13, { freq, gain: 0.15 * v, duration: 0.36 }));
    },

    gameEndDraw(ctx, t, v) {
      tone(ctx, t, { freq: 440, gain: 0.14 * v, duration: 0.28 });
      tone(ctx, t + 0.17, { freq: 440, gain: 0.11 * v, duration: 0.32 });
    },

    /** A refusal: dull and short, deliberately not musical. */
    illegal(ctx, t, v) {
      transient(ctx, t, { gain: 0.3 * v, tone: 320, decay: 0.05, q: 1.6 });
      mode(ctx, t, { freq: 118, gain: 0.2 * v, decay: 0.1, type: 'triangle' });
    },

    lowTime(ctx, t, v) {
      tone(ctx, t, { freq: 1046, gain: 0.11 * v, duration: 0.07, type: 'square' });
    },

    /** A premove going on the board: quieter than a real move, because it is
        not one yet. */
    notify(ctx, t, v) {
      transient(ctx, t, { gain: 0.16 * v, tone: 2600, decay: 0.012 });
      mode(ctx, t, { freq: 660, gain: 0.07 * v, decay: 0.05 });
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

    /**
     * Spielt eine Stimme.
     *
     * `options.delay` verschiebt den Einsatz in Sekunden - damit legt sich ein
     * Akzent hinter den Zug, zu dem er gehoert, statt mit ihm zusammenzufallen.
     * Alles Weitere in `options` reicht die Stimme selbst aus; wer davon nichts
     * kennt, ignoriert es.
     */
    play(name, options = {}) {
      if (!settings.enabled) return false;
      const voice = VOICES[name];
      if (!voice) return false;
      const ctx = ensureContext();
      if (!ctx) return false;
      try {
        const delay = Number(options.delay) > 0 ? Number(options.delay) : 0;
        voice(ctx, ctx.currentTime + 0.005 + delay, settings.volume, options);
        return true;
      } catch { /* a sound must never break the move it belongs to */ }
      return false;
    },

    /**
     * Writes a voice into a context the caller owns, at a time it chooses.
     *
     * Exists so the sounds can be rendered offline and looked at rather than
     * only listened to - a capture is supposed to be two impacts, and that is
     * a claim a waveform can settle. Also what a settings preview would use.
     */
    renderTo(ctx, name, at = 0, volume = settings.volume) {
      const voice = VOICES[name];
      if (!voice || !ctx) return false;
      voice(ctx, at, volume);
      return true;
    },

    /**
     * Der Klang eines gerade gespielten Zuges.
     *
     * Zwei Schichten statt einer Rangfolge, und das ist die eigentliche
     * Aenderung. Frueher entschied eine Kette von else-if, WELCHER einzelne
     * Klang gespielt wird - und weil `check` darin ueber `captured` stand,
     * klang ein Schlagzug, der Schach bot, wie ein gewoehnliches Schach. Das
     * Schlagen war nicht leiser, es war weg.
     *
     * Jetzt gibt es unten immer den Zug selbst: aufsetzen, schlagen,
     * rochieren oder umwandeln - genau eines davon, denn ein Zug ist genau
     * eine Bewegung. Darueber legt sich, falls faellig, der Akzent: Schach
     * oder Matt. Beides zusammen ist zu hoeren, und zwar in der Reihenfolge,
     * in der es passiert ist.
     *
     * `settle` sagt, wann die ziehende Figur ankommt - siehe capture/castle.
     * Gibt den Namen der gespielten Grundstimme zurueck, damit ein Test nicht
     * auf Toene hoeren muss, um zu wissen, was ausgeloest wurde.
     */
    playForMove({ captured = false, castle = false, promotion = false,
                  check = false, mate = false, gameOver = null, settle } = {}) {
      if (gameOver) {
        const voice = gameOver === 'win' ? 'gameEndWin' : gameOver === 'loss' ? 'gameEndLoss' : 'gameEndDraw';
        api.play(voice);
        return voice;
      }

      const base = promotion ? 'promote'
        : castle ? 'castle'
        : captured ? 'capture'
        : 'move';
      // Nur capture und castle kennen `settle`; die anderen ignorieren es.
      api.play(base, settle == null ? {} : { settle });

      // Der Akzent setzt hinter dem Aufschlag ein, nicht auf ihm. Beim Matt
      // etwas spaeter: es ist der Schlusspunkt, nicht der Zug.
      if (mate) api.play('checkmate', { delay: 0.16 });
      else if (check) api.play('check', { delay: 0.05 });

      return base;
    }
  };

  if (typeof window !== 'undefined') window.ChessSound = api;
  else (typeof self !== 'undefined' ? self : globalThis).ChessSound = api;
})();
