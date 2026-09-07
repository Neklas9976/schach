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

test('a move animation always cleans up its floating piece', () => {
  // Regression: the animator clone was only removed from `onfinish`, which a
  // backgrounded tab may deliver minutes late or not at all - the animation
  // clock all but stops there. Every missed callback left a piece-sized node
  // in the DOM, invisible only because it came to rest exactly on top of the
  // real piece. A timeout has to remove it the same way the move transaction
  // already has a timeout releasing the board.
  assert.match(code, /window\.setTimeout\(finish,longest\+\d+\);/);
  // The net has to outlast the slowest leg, not the first one: castling starts
  // the rook after the king.
  assert.match(code, /longest=Math\.max\(longest,duration\+leg\.delay\)/);
});

test('every piece a move involves is animated, not just the mover', () => {
  // Castling moves two. The board used to animate only the king, so the rook
  // appeared at its destination the moment the final position was painted -
  // which is what made castling look broken.
  assert.match(code, /if\(move\.isCastle && move\.rookFrom && move\.rookTo\)\{/);
  assert.match(code, /travellers\.push\(\{piece:rook/);
  // And both destinations are covered while their pieces are still in flight.
  assert.match(code, /if\(move\.isCastle && move\.rookTo\) landing\.push\(move\.rookTo\);/);
});

test('the move is over only once the last piece has landed', () => {
  assert.match(code, /Promise\.all\(animations\.map\(a=>a\.finished\.catch\(\(\)=>\{\}\)\)\)\.then\(finish\)/);
});

test('a new game clears anything still animating from the old one', () => {
  assert.match(code, /querySelectorAll\('\.move-animator,\.drag-ghost'\)\.forEach\(el=>el\.remove\(\)\)/);
});

test('looking back through the game cannot move a piece', () => {
  // Every input path funnels through humanMayAct, so the guard belongs there
  // rather than in the click and drag handlers separately.
  assert.match(code, /function humanMayAct\(\)\{[\s\S]*?if\(!isLive\(\)\) return false;/);
});

test('the board is flipped by reordering, never by rotating', () => {
  // A CSS rotation would turn every piece upside down and would need a
  // counter-rotation per image; `order` leaves the pointer geometry and the
  // diff renderer untouched.
  assert.equal(/transform:\s*rotate\(180/.test(code), false);
  assert.match(code, /sq\.style\.order=String\(flipped\?63-index:index\)/);
});

test('the engine score is converted to White’s perspective exactly once', () => {
  // UCI reports from the side to move. Two conversion sites is how an
  // evaluation bar ends up pointing the wrong way after a black move.
  assert.equal((code.match(/function whiteRelative/g) || []).length, 1);
  assert.match(code, /const sign=turn==='white'\?1:-1;/);
});

test('a click and a drag both resolve through movesBetween', () => {
  // findLegalMove without a promotion piece matches no promotion, so using it
  // to resolve a pair of squares silently swallowed every pawn reaching the
  // last rank.
  assert.match(code, /const candidates=ChessEngine\.movesBetween\(state,\[fr,fc\],\[tr,tc\]\);/);
  assert.equal(/const move=ChessEngine\.findLegalMove\(state,\[fr,fc\],\[tr,tc\]\);/.test(code), false);
});

test('the promotion dialog is reachable from the move resolution', () => {
  assert.match(code, /if\(candidates\.length>1&&candidates\[0\]\.promotion\)\{[\s\S]{0,120}openPromotion\(piece\);/);
});

test('every input path asks inputColor, never state.turn', () => {
  // During a premove the piece belongs to the side that is *not* to move.
  // Any path still comparing against state.turn would refuse it.
  assert.match(code, /function inputColor\(\)/);
  assert.match(code, /if\(!piece \|\| ChessEngine\.colorOf\(piece\)!==acting\) return;/);
  assert.match(code, /if\(p && ChessEngine\.colorOf\(p\)===acting\)/);
  assert.match(code, /if\(acting!==state\.turn\)\{ queuePremove/);
});

test('committing still requires the piece to belong to the side to move', () => {
  // The premove relaxation must stop at the door: a move only reaches the
  // board once it really is that side's turn, so this last check stays exact.
  assert.match(code, /function commitMove\(move, interaction=\{dragged:false\}\)\{[\s\S]{0,160}ChessEngine\.colorOf\(piece\)!==state\.turn\) return;/);
});

test('a landed move gives the premove its turn before the engine', () => {
  // The other order would let the engine answer a position the player has
  // already committed a move for. Puzzle mode takes the whole function over
  // before either of them, so what matters is the order of the two, not that
  // they sit on adjacent lines.
  const start = code.indexOf('function afterMoveSettled(){');
  assert.ok(start >= 0, 'afterMoveSettled not found');
  const body = code.slice(start, code.indexOf('\n  }', start));
  const premove = body.indexOf('if(runPremove()) return;');
  const engine = body.indexOf('maybeRequestComputerMove();');
  assert.ok(premove >= 0 && engine >= 0, 'both paths must still be reached');
  assert.ok(premove < engine, 'the premove has to get its turn first');
  assert.equal((code.match(/setTimeout\(maybeRequestComputerMove,duration/g) || []).length, 0);
});

test('committing a move does not discard the queued premove', () => {
  // Regression: the opponent's move landing is exactly what the premove was
  // waiting for, and clearing it in commitMove killed it one tick early.
  assert.match(code, /viewPly=movesLog\.length;arrows=\[\];marks=\[\];hintMove=null;\s*$/m);
});

test('a loaded position hands over to the engine if it is on move', () => {
  assert.match(code, /refreshEvaluation\(\);[\s\S]{0,220}setTimeout\(maybeRequestComputerMove,0\);\s*\}\s*function loadFen/);
});

test('a finished game is archived, and finishing again replaces its record', () => {
  // Take the mate back, play on, finish again: the archive must hold the game
  // as completed, not two versions of it.
  assert.match(code, /let archivedGameId=null;/);
  assert.match(code, /id:archivedGameId\|\|undefined/);
  assert.match(code, /archivedGameId=saved\?saved\.id:null;/);
});

test('the record shown after a game is derived, not a running counter', () => {
  // Counters drift - a game saved twice, a deleted game, a path that forgets
  // to increment. Deriving from the archive means they cannot disagree.
  assert.match(code, /window\.ChessArchive\.stats\(window\.ChessArchive\.list\(\)\)/);
  assert.equal(/localStorage\.getItem\('chess-stats'/.test(code), false);
});

test('loading a resigned or timed-out game does not restart the engine', () => {
  // The move list cannot express either result, so the archive carries them
  // alongside - otherwise the engine plays on from a position someone had
  // already given up.
  assert.match(code, /function loadGame\(startFen,plies,finished=null\)/);
  assert.match(code, /if\(finished&&finished\.resignedBy\) resignedBy=finished\.resignedBy;/);
  assert.match(code, /if\(!gameEnded\) window\.setTimeout\(maybeRequestComputerMove,0\);/);
});

test('archive rows are built with escaped text', () => {
  // Opening names and level labels are ours, but they land in innerHTML and
  // the archive is the one place holding data written earlier and re-read.
  assert.match(code, /function escapeHtml\(text\)/);
  assert.match(code, /escapeHtml\(game\.opening\)/);
});

test('clicking the king onto its own rook castles instead of reselecting', () => {
  // Both input paths have to honour the gesture. Drag goes straight to
  // tryMove, but click-to-move sees a friendly piece on the target square and
  // used to just move the selection there - so castling by clicking the rook
  // did nothing at all, and only the e1-g1 click worked.
  assert.match(code, /const gesture=ChessEngine\.castlingTarget\(shownState\(\),selected,\[r,c\]\);/);
  assert.match(code, /if\(!gesture && p && ChessEngine\.colorOf\(p\)===acting\)\{selected=\[r,c\];render\(\);return;\}/);
  // And the drag path still translates the square before resolving the move.
  assert.match(code, /const castled=ChessEngine\.castlingTarget\(state,\[fr,fc\],\[tr,tc\]\);/);
});
