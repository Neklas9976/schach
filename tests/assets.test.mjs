import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guards the licence position of the shipped artwork.
 *
 * An earlier version pulled board and piece images from a public mirror of a
 * commercial site's assets. Nothing in the code stopped that from coming back
 * - a single URL is all it takes - so the rule is checked rather than
 * remembered.
 */

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function filesUnder(dir, extensions) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full, extensions));
    else if (extensions.includes(path.extname(entry.name))) out.push(full);
  }
  return out;
}

const SHIPPED = [
  ...filesUnder(path.join(root, 'static'), ['.js', '.css']),
  ...filesUnder(path.join(root, 'templates'), ['.html'])
];

const PIECES = [
  'white-king', 'white-queen', 'white-rook', 'white-bishop', 'white-knight', 'white-pawn',
  'black-king', 'black-queen', 'black-rook', 'black-bishop', 'black-knight', 'black-pawn'
];

const pieceDir = path.join(root, 'static', 'pieces', 'cburnett');

test('the app loads nothing from outside itself', () => {
  // The SVG namespace is a identifier, not a fetch, and is the one allowed
  // absolute URL.
  const allowed = /^https?:\/\/www\.w3\.org\//;
  const offenders = [];
  for (const file of SHIPPED) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/https?:\/\/[^\s"'`)]+/g)) {
      if (!allowed.test(match[0])) offenders.push(`${path.relative(root, file)}: ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `external references found:\n${offenders.join('\n')}`);
});

test('no reference to the mirror the artwork used to come from survives', () => {
  for (const file of SHIPPED) {
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(/githubusercontent/i.test(text), false, `${path.relative(root, file)} still points at a raw GitHub host`);
    assert.equal(/chess\.com-boards/i.test(text), false, `${path.relative(root, file)} still names the asset mirror`);
  }
});

test('the old raster piece folder is gone', () => {
  // Six megabytes of upscaled, vaguely documented derivatives. Their presence
  // is what made the licence question hard to answer.
  assert.equal(fs.existsSync(path.join(root, 'static', 'chess-pieces')), false);
});

test('all twelve pieces ship with the project', () => {
  for (const name of PIECES) {
    const file = path.join(pieceDir, `${name}.svg`);
    assert.ok(fs.existsSync(file), `${name}.svg is missing`);
  }
});

test('every piece is a real SVG that scales', () => {
  for (const name of PIECES) {
    const text = fs.readFileSync(path.join(pieceDir, `${name}.svg`), 'utf8');
    assert.match(text, /<svg[\s>]/, `${name} is not an SVG`);
    // Without a viewBox an <img> renders the file at its intrinsic 45px and
    // comes out soft on a board square many times that size.
    assert.match(text, /viewBox="0 0 45 45"/, `${name} has no viewBox`);
    assert.equal(/<!DOCTYPE html/i.test(text), false, `${name} is an error page, not artwork`);
  }
});

test('white and black pieces are actually different drawings', () => {
  // A rate-limited download once produced twelve copies of the same error
  // page; before that, four identical files. Both look fine in a directory
  // listing.
  const seen = new Map();
  for (const name of PIECES) {
    const text = fs.readFileSync(path.join(pieceDir, `${name}.svg`), 'utf8');
    assert.equal(seen.has(text), false, `${name} is a duplicate of ${seen.get(text)}`);
    seen.set(text, name);
  }
});

test('the piece filenames are the ones the board asks for', () => {
  const appearance = fs.readFileSync(path.join(root, 'static', 'appearance.js'), 'utf8');
  for (const name of PIECES) {
    assert.ok(appearance.includes(`'${name}'`), `appearance.js never asks for ${name}`);
  }
  assert.match(appearance, /\/static\/pieces\//);
});

test('the artwork licence is documented where it can be found', () => {
  const text = fs.readFileSync(path.join(root, 'ATTRIBUTIONS.md'), 'utf8');
  // Attribution is a condition of every licence the set is offered under, so
  // the credit itself is part of the deliverable.
  assert.match(text, /Cburnett/);
  assert.match(text, /commons\.wikimedia\.org/);
  assert.match(text, /CC BY-SA 3\.0/);
  assert.match(text, /GFDL/);
  assert.match(text, /BSD/);
  assert.match(text, /Stockfish/);
  assert.match(text, /GNU General Public License/);
});
