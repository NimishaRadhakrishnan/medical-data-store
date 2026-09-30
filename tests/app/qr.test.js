/**
 * The QR codes the shop prints on its own stock labels.
 *
 * A code that looks right but does not decode is worthless: the owner finds out
 * weeks later, with the stickers already on the boxes. So these tests check the
 * squares themselves, and `npm run test:qr` (see tests/app/decode-qr.py) hands
 * the same codes to a real reader.
 *
 *   npm run test:app
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { matrix, svg } from '../../apps/shop/qr.js';

/** Read the three big corner squares, which every reader looks for first. */
function hasFinder(grid, top, left) {
  for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
    const ring = r === 0 || r === 6 || c === 0 || c === 6;
    const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
    if (grid[top + r][left + c] !== (ring || core ? 1 : 0)) return false;
  }
  return true;
}

describe('the QR encoder', () => {
  test('makes a well-formed code', () => {
    const g = matrix('SNM-B1-7');
    assert.equal(g.length, 21, 'a short code should fit the smallest size');
    assert.ok(g.every(row => row.length === 21), 'the grid must be square');
    assert.ok(g.flat().every(v => v === 0 || v === 1),
      'every square must be light or dark — an unfilled one decodes as nothing');
  });

  test('puts the three corner squares where a reader looks', () => {
    const g = matrix('SNM-B1-7');
    const n = g.length;
    assert.ok(hasFinder(g, 0, 0), 'top left');
    assert.ok(hasFinder(g, 0, n - 7), 'top right');
    assert.ok(hasFinder(g, n - 7, 0), 'bottom left');
    assert.equal(g[n - 8][8], 1, 'the module that is always dark');
  });

  test('the dotted timing lines alternate', () => {
    const g = matrix('SNM-B1-7');
    for (let i = 8; i < g.length - 8; i++) {
      assert.equal(g[6][i], i % 2 === 0 ? 1 : 0, `row timing at ${i}`);
      assert.equal(g[i][6], i % 2 === 0 ? 1 : 0, `column timing at ${i}`);
    }
  });

  test('the format bits say which correction level and mask were used', () => {
    /* Straight from the standard's table. Getting these backwards leaves a code
       that looks perfect and reads as nothing at all. */
    const TABLE = {
      L: [0x77C4,0x72F3,0x7DAA,0x789D,0x662F,0x6318,0x6C41,0x6976],
      M: [0x5412,0x5125,0x5E7C,0x5B4B,0x45F9,0x40CE,0x4F97,0x4AA0],
      Q: [0x355F,0x3068,0x3F31,0x3A06,0x24B4,0x2183,0x2EDA,0x2BED],
      H: [0x1689,0x13BE,0x1CE7,0x19D0,0x0762,0x0255,0x0D0C,0x083B],
    };
    for (const level of ['L', 'M', 'Q', 'H']) {
      const g = matrix('SNM-B1-7', { level });
      const n = g.length;
      const spots = [...Array(6).keys()].map(i => [8, i])
        .concat([[8, 7], [8, 8], [7, 8]], [...Array(6).keys()].map(i => [5 - i, 8]));
      const value = spots.reduce((acc, [r, c], i) => acc | (g[r][c] << (14 - i)), 0);
      assert.ok(TABLE[level].includes(value),
        `level ${level}: format bits ${value.toString(16)} are not a valid pattern`);

      // The second copy has to agree with the first, or readers disagree.
      const spots2 = [...Array(7).keys()].map(i => [n - 1 - i, 8])
        .concat([...Array(8).keys()].map(i => [8, n - 8 + i]));
      const value2 = spots2.reduce((acc, [r, c], i) => acc | (g[r][c] << (14 - i)), 0);
      assert.equal(value2, value, `level ${level}: the two format copies disagree`);
    }
  });

  test('grows only as much as the content needs', () => {
    assert.equal(matrix('SNM-B1-7').length, 21, 'version 1');
    assert.ok(matrix('A'.repeat(60)).length > 21, 'longer text needs a bigger code');
    assert.ok(matrix('A'.repeat(200), { level: 'L' }).length <= 57, 'and not more than version 10');
  });

  test('refuses what it cannot encode instead of printing nonsense', () => {
    assert.throws(() => matrix(''), /Nothing to put/);
    assert.throws(() => matrix('x'.repeat(5000)), /too much text/);
    assert.throws(() => matrix('hello', { level: 'Z' }), /Unknown correction level/);
  });

  test('handles plain text, digits and Indian rupee signs alike', () => {
    for (const text of ['SNM-B99-0', '1234567890', 'Dolo 650 ₹33.10', 'மாத்திரை']) {
      const g = matrix(text);
      assert.ok(g.length >= 21 && g.flat().every(v => v === 0 || v === 1), text);
    }
  });

  test('the SVG is self-contained and has a quiet margin', () => {
    const out = svg('SNM-B1-7', { size: 20 });
    assert.match(out, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(out, /width="20mm"/);
    assert.match(out, /viewBox="0 0 29 29"/, '21 squares plus 4 of margin each side');
    assert.doesNotMatch(out, /<image|href=/, 'nothing may be fetched to draw this');
    assert.ok(out.includes('</svg>'));
  });

  test('the same text always gives the same code', () => {
    assert.deepEqual(matrix('SNM-B42-9'), matrix('SNM-B42-9'),
      'a reprinted label must match the one already on the box');
  });
});
