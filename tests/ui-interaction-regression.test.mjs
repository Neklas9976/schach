import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const code = fs.readFileSync(new URL('../static/app.js', import.meta.url), 'utf8');

test('board owns the pointer lifecycle instead of individual pieces', () => {
  assert.equal((code.match(/wrap\.addEventListener\(['"]pointerdown/g) || []).length, 0);
  assert.equal((code.match(/boardEl\.addEventListener\(['"]pointerdown/g) || []).length, 1);
  assert.equal((code.match(/boardEl\.addEventListener\(['"]pointermove/g) || []).length, 1);
  assert.equal((code.match(/boardEl\.addEventListener\(['"]pointerup/g) || []).length, 1);
  assert.equal((code.match(/boardEl\.addEventListener\(['"]pointercancel/g) || []).length, 1);
});

test('drop coordinate calculation is independent of DOM hit testing', () => {
  // The board never uses elementFromPoint for drop detection. Overlay
  // elements (legal-move markers, the check outline, drag ghosts) must never
  // be able to steal the drop target away from the actual square.
  assert.equal(code.includes('elementFromPoint'), false);
  assert.equal(code.includes('getBoundingClientRect()'), true);
  assert.equal(code.includes('function pointerToSquare'), true);

  // The target square is resolved once, synchronously, from the pointerup
  // coordinates - not from continuously tracked pointer state that could go
  // stale between move and up.
  assert.equal(code.includes('const target=pointerToSquare(e.clientX,e.clientY);'), true);
});

test('a resolved target square survives into the move pipeline unchanged', () => {
  // finishDrag may defer the actual tryMove call (e.g. via requestAnimationFrame)
  // for animation sequencing, but it must reuse the already-resolved `target`
  // rather than recomputing it later, which is what would let a checking move
  // (or any move) silently drop.
  assert.match(code, /const target=pointerToSquare\(e\.clientX,e\.clientY\);[\s\S]*?if\(target\) tryMove\(fromR,fromC,target\.row,target\.col/);
});
