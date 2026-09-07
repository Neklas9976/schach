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

// Third-party code that ships as-is. It is never edited here, so scanning it
// for our own rules would only report its own documentation.
const VENDORED = ['stockfish.js'];

// Exactly what a static host would serve: the page and everything under
// static/. Named rather than discovered from the root, which would wander into
// .git, node_modules and the engine/ download.
const SHIPPED = [
  path.join(root, 'index.html'),
  ...filesUnder(path.join(root, 'static'), ['.js', '.css'])
].filter(f => !VENDORED.includes(path.basename(f)));

const PIECES = [
  'white-king', 'white-queen', 'white-rook', 'white-bishop', 'white-knight', 'white-pawn',
  'black-king', 'black-queen', 'black-rook', 'black-bishop', 'black-knight', 'black-pawn'
];

const pieceDir = path.join(root, 'static', 'pieces', 'cburnett');

/**
 * Strips comments before scanning for forbidden patterns.
 *
 * Otherwise a rule fires on the comment that explains it: ai.js documents why
 * "/static/..." must not be used, and that sentence is not a use of it. The
 * guard on the line-comment pattern keeps it from eating "https://".
 */
function code(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('the bundled engine fetches nothing from the network', () => {
  // Emscripten loads the .wasm through XMLHttpRequest. That request must stay
  // relative - an absolute one would put a third-party host in the load path
  // of every visitor.
  const file = path.join(root, 'static', 'stockfish.js');
  const text = fs.readFileSync(file, 'utf8');
  const urls = [...text.matchAll(/https?:\/\/[^\s"'`)]+/g)].map(m => m[0]);
  // The only one is the project's own homepage, in the licence header.
  assert.deepEqual(urls, ['http://github.com/nmrugg/stockfish.js']);
  assert.ok(fs.existsSync(path.join(root, 'static', 'stockfish.wasm')), 'the wasm payload must ship alongside');
});

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
  // Relative, never rooted: a project page lives under /<repo>/.
  assert.match(appearance, /static\/pieces\//);
  assert.equal(/['"`]\/static\//.test(appearance), false, 'paths must not start at the domain root');
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

test('no runtime path starts at the domain root', () => {
  // Published as a project page the site lives at /<repo>/, where a leading
  // slash resolves to the domain root and every asset and endpoint 404s.
  for (const file of SHIPPED) {
    if (path.extname(file) !== '.js') continue;
    for (const match of code(fs.readFileSync(file, 'utf8')).matchAll(/['"`](\/(?:static|api)\/[^'"`]*)['"`]/g)) {
      assert.fail(`${path.relative(root, file)} uses the absolute path ${match[1]}`);
    }
  }
});

test('the page is a plain file, not a template', () => {
  // The published site is static, so a server-rendered page would mean the
  // version people play on is not the version developed here.
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.equal(/\{\{|\{%/.test(html), false, 'index.html still contains template syntax');
  assert.match(html, /src="static\//);
  assert.equal(/(src|href)="\//.test(html), false, 'asset paths must not start at the domain root');
});

test('the project is licensed, and under the licence Stockfish forces', () => {
  // Shipping the WebAssembly build means distributing GPL software, which
  // binds the whole work. Without a LICENSE file the code is formally "all
  // rights reserved" - the opposite of what is intended, and incompatible
  // with what is bundled.
  const licence = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
  assert.match(licence, /GNU GENERAL PUBLIC LICENSE/);
  assert.match(licence, /Version 3, 29 June 2007/);

  const notes = fs.readFileSync(path.join(root, 'ATTRIBUTIONS.md'), 'utf8');
  assert.match(notes, /stockfish\.wasm/, 'the bundled engine must be declared');
  assert.match(notes, /nmrugg\/stockfish\.js/, 'with where it came from');
});

test('colours are tokens, so both themes can exist', () => {
  // The stylesheet used 28 different alpha steps of plain white for what were
  // really five kinds of surface. That is why the interface looked restless -
  // and why a light theme was impossible: white-on-white lightens nothing.
  const css = fs.readFileSync(path.join(root, 'static', 'style.css'), 'utf8');
  const mediaAt = css.indexOf('prefers-color-scheme: light');
  assert.ok(mediaAt > 0, 'the light palette must be defined');
  // Everything past the closing brace of the media query, i.e. past both
  // palettes - the palettes are the one place raw colours belong.
  const body = css.slice(css.indexOf('\n}\n', css.indexOf('\n    }\n', mediaAt)));

  // Things that deliberately do not follow the interface theme: the board
  // carries its own square colours from the appearance picker, the filled half
  // of the evaluation bar stands for White, and #fff on an accent-filled
  // button is the label on top of it.
  const ALLOWED = new Set(['#fff', '#f0d9b5', '#b58863', '#efd9b4', '#b07d4e', '#f4f6fb', '#d9dee9']);
  const hex = [...body.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(m => m[0]).filter(c => !ALLOWED.has(c));
  assert.deepEqual(hex, [], `hardcoded colours left in the rules: ${hex.join(', ')}`);
});

test('an explicit theme choice beats the system, and auto defers to it', () => {
  const theme = fs.readFileSync(path.join(root, 'static', 'theme.js'), 'utf8');
  // "auto" must remove the attribute rather than write the resolved value,
  // or the page stops following the system while it is open.
  assert.match(theme, /delete document\.documentElement\.dataset\.theme/);
  const css = fs.readFileSync(path.join(root, 'static', 'style.css'), 'utf8');
  assert.match(css, /:root\[data-theme="light"\]/);
  assert.match(css, /:root:not\(\[data-theme="dark"\]\)/);
});

test('the theme is decided before the page paints', () => {
  // Deciding later means painting once in the wrong theme first - a white
  // flash on a dark setup, which is the thing people actually notice.
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const themeAt = html.indexOf('theme.js');
  const bodyAt = html.indexOf('<body');
  assert.ok(themeAt > 0 && themeAt < bodyAt, 'theme.js must load in <head>, before <body>');
});

test('every panel button fits its label', () => {
  // "Einstellungen" needs 111px and had 78px, so it spilled out of its own
  // border. Two columns give 166px; a fourth column would take it back.
  const css = fs.readFileSync(path.join(root, 'static', 'style.css'), 'utf8');
  assert.match(css, /\.side-panel \.action-row \{[^}]*grid-template-columns: 1fr 1fr;/);
  assert.equal(/\.action-row \{ grid-template-columns: 1fr 1fr 1fr/.test(css), false,
    'a four-column rule would squeeze the labels again');
});
