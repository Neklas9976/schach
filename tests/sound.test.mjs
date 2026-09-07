import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

/**
 * The sounds are synthesised, so what they are made of is checkable even
 * without an audio device: each voice is scheduled through a small set of
 * primitives, and a fake context records the calls.
 *
 * Node has no Web Audio, so this stands in for it. That is enough to pin the
 * things that actually went wrong before - a capture that was one flat thump,
 * and a castling sound that did not match a move involving two pieces.
 */

const code = fs.readFileSync(new URL('../static/sound.js', import.meta.url), 'utf8');

/** Records every node created and every value scheduled on it. */
function fakeContext(log) {
  const param = name => ({
    value: 0,
    setValueAtTime: (v, t) => log.push({ node: name, call: 'set', v, t }),
    linearRampToValueAtTime: (v, t) => log.push({ node: name, call: 'linear', v, t }),
    exponentialRampToValueAtTime: (v, t) => log.push({ node: name, call: 'exp', v, t })
  });
  const connectable = obj => Object.assign(obj, { connect: next => next, disconnect() {} });

  return {
    sampleRate: 44100,
    currentTime: 0,
    destination: {},
    createBuffer: (channels, length) => ({ getChannelData: () => new Float32Array(length) }),
    createBufferSource: () => {
      const node = connectable({ buffer: null, playbackRate: { value: 1 }, stop() {} });
      // The rate tells an impact from a scrape: a scrape is the same noise
      // buffer played slowed down and swept, and it belongs to the impact it
      // accompanies rather than counting as one of its own.
      node.start = t => log.push({ type: 'noise', t, rate: node.playbackRate.value });
      return node;
    },
    createBiquadFilter: () => connectable({ type: '', frequency: param('filter'), Q: { value: 1 } }),
    createGain: () => connectable({ gain: param('gain') }),
    createOscillator: () => {
      const node = connectable({ type: 'sine', frequency: param('osc'), stop() {} });
      node.start = t => log.push({ type: 'osc', t, freq: node.frequency.value });
      return node;
    }
  };
}

function render(voice) {
  const sandbox = { window: {}, localStorage: undefined };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox);
  const log = [];
  const ok = sandbox.window.ChessSound.renderTo(fakeContext(log), voice, 0, 1);
  assert.equal(ok, true, `voice ${voice} did not render`);
  return log;
}

/** Onset times of the impact transients, scrapes excluded. */
function impactTimes(log) {
  const times = log.filter(e => e.type === 'noise' && e.rate > 0.8).map(e => Number(e.t.toFixed(4)));
  return [...new Set(times)].sort((a, b) => a - b);
}

test('every voice the board asks for exists', () => {
  const sandbox = { window: {}, localStorage: undefined };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox);
  const voices = new Set(sandbox.window.ChessSound.VOICES);
  for (const name of ['move', 'capture', 'castle', 'check', 'promote',
                      'gameStart', 'gameEndWin', 'gameEndLoss', 'gameEndDraw',
                      'illegal', 'lowTime', 'notify']) {
    assert.ok(voices.has(name), `missing voice: ${name}`);
  }
});

test('an ordinary move is a single impact', () => {
  assert.equal(impactTimes(render('move')).length, 1);
});

test('a capture is several impacts, not one thump', () => {
  // The piece is knocked away, the capturing piece lands, and the captured one
  // is set down off the board. One transient is what it used to be, and it is
  // why a capture sounded like a move played louder.
  const times = impactTimes(render('capture'));
  assert.ok(times.length >= 3, `expected at least three impacts, got ${times.length}`);
  // Far enough apart to be heard as separate events rather than a smear.
  assert.ok(times[1] - times[0] > 0.03, 'the first two impacts run together');
});

test('the capturing piece lands harder than the piece it displaces', () => {
  // The order matters: a capture that peaks on the first hit sounds like
  // something being dropped, not like a piece taking another.
  const log = render('capture');
  const peaks = log.filter(e => e.call === 'linear' && e.node === 'gain' && e.v > 0);
  const first = peaks.find(p => p.t < 0.03);
  const second = peaks.find(p => p.t > 0.05 && p.t < 0.1);
  assert.ok(first && second, 'expected a gain ramp for each of the first two impacts');
  assert.ok(second.v > first.v, `landing (${second.v}) must be louder than displacement (${first.v})`);
});

test('castling sounds like the two pieces the board moves', () => {
  const times = impactTimes(render('castle'));
  assert.equal(times.length, 2);
  // Staggered, the way the animation staggers them - simultaneous reads as one
  // muddy hit rather than a king followed by a rook.
  assert.ok(times[1] - times[0] > 0.04, 'the rook has to follow the king, not land with it');
});

test('a piece landing rings the board, it does not just click', () => {
  // Three damped resonances under the transient are what makes it wood; the
  // earlier version had the click alone and sounded like a tap on plastic.
  const log = render('move');
  const oscillators = log.filter(e => e.type === 'osc');
  assert.ok(oscillators.length >= 3, `expected at least three modes, got ${oscillators.length}`);
  // Falling in level as they rise in pitch, as a struck solid body does.
  const freqs = oscillators.map(o => o.freq).sort((a, b) => a - b);
  assert.ok(freqs[0] < freqs[freqs.length - 1], 'the modes must differ in pitch');
});

test('no two impacts are identical', () => {
  // Two hits that match sample for sample is the giveaway that a sound is
  // synthetic. Real pieces never land twice the same way.
  const a = render('move').filter(e => e.type === 'osc').map(e => e.freq);
  const b = render('move').filter(e => e.type === 'osc').map(e => e.freq);
  assert.equal(a.length, b.length);
  assert.notDeepEqual(a, b, 'every hit came out at exactly the same pitches');
});

test('a sound never breaks the move it belongs to', () => {
  const sandbox = { window: {}, localStorage: undefined };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox);
  // No audio support at all: play must be a no-op, not a throw.
  assert.doesNotThrow(() => sandbox.window.ChessSound.play('move'));
  assert.doesNotThrow(() => sandbox.window.ChessSound.play('does-not-exist'));
  assert.equal(sandbox.window.ChessSound.renderTo(null, 'move'), false);
});

test('settings survive without localStorage', () => {
  const sandbox = { window: {}, localStorage: undefined };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox);
  const sound = sandbox.window.ChessSound;
  assert.equal(typeof sound.isEnabled(), 'boolean');
  assert.doesNotThrow(() => sound.setVolume(0.4));
  assert.equal(sound.getVolume(), 0.4);
  // Out of range values are clamped rather than passed to the audio graph.
  sound.setVolume(9);
  assert.equal(sound.getVolume(), 1);
  sound.setVolume(-3);
  assert.equal(sound.getVolume(), 0);
});
