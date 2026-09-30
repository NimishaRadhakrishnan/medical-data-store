/**
 * The camera half of the QR story.
 *
 * `qr.js` prints the labels; `public/qr-reader.js` is what reads them back
 * through the camera on browsers that cannot do it themselves. The two are
 * written by different people and must agree, so this puts a label the app
 * printed in front of the reader the app ships and checks the text survives
 * the round trip.
 *
 *   npm run test:app
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { matrix } from '../../apps/shop/qr.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..', 'apps', 'shop');

let jsQR;

before(async () => {
  /* The reader is a plain browser script, not a module: it hands itself to
     `window`. Give it a window, run it, and take what it leaves behind. */
  const src = readFileSync(join(APP, 'public', 'qr-reader.js'), 'utf8');
  const sandbox = { window: {}, self: undefined };
  sandbox.self = sandbox.window;
  new Function('window', 'self', src)(sandbox.window, sandbox.window);
  jsQR = sandbox.window.jsQR;
  assert.equal(typeof jsQR, 'function', 'qr-reader.js did not load');
});

/**
 * Turn a printed code into the kind of picture a camera would send: white
 * paper, black squares, a few pixels per square and a quiet margin.
 */
function picture(text, { scale = 4, quiet = 4 } = {}) {
  const m = matrix(text);
  const n = m.length;
  const w = (n + quiet * 2) * scale;
  const data = new Uint8ClampedArray(w * w * 4).fill(255);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!m[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = ((y + quiet) * scale + dy) * w + (x + quiet) * scale + dx;
          data[px * 4] = data[px * 4 + 1] = data[px * 4 + 2] = 0;
        }
      }
    }
  }
  return { data, width: w, height: w };
}

describe('the camera can read the labels the app prints', () => {
  test('a shop label comes back exactly as it went in', () => {
    const code = 'SNM-B4471-K';
    const p = picture(code);
    const read = jsQR(p.data, p.width, p.height);
    assert.ok(read, 'the reader saw no code at all');
    assert.equal(read.data, code);
  });

  test('every label the shop could ever print is readable', () => {
    // First batch, a middling one, and a number far past what the shop will
    // reach — the code grows a digit at a time and must stay readable.
    for (const digits of ['1', '7', '42', '999', '4471', '99999', '123456']) {
      const code = `SNM-B${digits}-Q`;
      const p = picture(code);
      const read = jsQR(p.data, p.width, p.height);
      assert.ok(read, `no code found for ${code}`);
      assert.equal(read.data, code, `${code} came back wrong`);
    }
  });

  test('it still reads when the camera is held close, or far', () => {
    const code = 'SNM-B4471-K';
    for (const scale of [2, 3, 6, 10]) {
      const p = picture(code, { scale });
      const read = jsQR(p.data, p.width, p.height);
      assert.ok(read && read.data === code, `unreadable at ${scale}px per square`);
    }
  });

  test('blank paper is reported as nothing, not as a wrong answer', () => {
    const blank = new Uint8ClampedArray(200 * 200 * 4).fill(255);
    assert.equal(jsQR(blank, 200, 200), null,
      'a reader that invents a code would put the wrong medicine on a bill');
  });
});
