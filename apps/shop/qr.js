/**
 * QR codes, written from scratch.
 *
 * The shop has no barcode scanner, so the app prints its own QR label for every
 * batch that comes in. A webcam then does the job a ₹5,000 scanner would.
 *
 * This is ISO/IEC 18004 by hand because the app has no dependencies and the
 * shop PC has no internet to install one. Versions 1-10, which is far more than
 * a batch label needs (version 2 holds our codes with room to spare).
 *
 * Verified by generating codes here and decoding them with OpenCV, an
 * unrelated reader — see tests/app/qr.test.js.
 */

/* ---------------------------------------------------------------- tables -- */

/* Total codewords (data + error correction) in each version. */
const TOTAL = [null, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

/* Per version and correction level:
   [ec codewords per block, blocks in group 1, data per block, blocks in group 2, data per block] */
const BLOCKS = {
  L: [null, [7,1,19], [10,1,34], [15,1,55], [20,1,80], [26,1,108], [18,2,68],
      [20,2,78], [24,2,97], [30,2,116], [18,2,68,2,69]],
  M: [null, [10,1,16], [16,1,28], [26,1,44], [18,2,32], [24,2,43], [16,4,27],
      [18,4,31], [22,2,38,2,39], [22,3,36,2,37], [26,4,43,1,44]],
  Q: [null, [13,1,13], [22,1,22], [18,2,17], [26,2,24], [18,2,15,2,16], [24,4,19],
      [18,2,14,4,15], [22,4,18,2,19], [20,4,16,4,17], [24,6,19,2,20]],
  H: [null, [17,1,9], [28,1,16], [22,2,13], [16,4,9], [22,2,11,2,12], [28,4,15],
      [26,4,13,1,14], [26,4,14,2,15], [24,4,12,4,13], [28,6,15,2,16]],
};

/* Where the small alignment squares sit, by version. */
const ALIGN = [null, [], [6,18], [6,22], [6,26], [6,30], [6,34],
               [6,22,38], [6,24,42], [6,26,46], [6,28,50]];

const EC_BITS = { L: 1, M: 0, Q: 3, H: 2 };
const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

/* ------------------------------------------------------- galois field 256 -- */

const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

/** The generator polynomial for `n` error-correction codewords. */
function generator(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** The error-correction codewords protecting one block of data. */
function ecc(data, n) {
  const gen = generator(n);
  const rest = [...data, ...new Array(n).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const lead = rest[i];
    if (lead === 0) continue;
    for (let j = 0; j < gen.length; j++) rest[i + j] ^= mul(gen[j], lead);
  }
  return rest.slice(data.length);
}

/* --------------------------------------------------------------- encoding -- */

class Bits {
  constructor() { this.bits = []; }
  push(value, length) { for (let i = length - 1; i >= 0; i--) this.bits.push((value >> i) & 1); }
  get length() { return this.bits.length; }
  bytes() {
    const out = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | (this.bits[i + j] ?? 0);
      out.push(b);
    }
    return out;
  }
}

const isNumeric = s => /^[0-9]+$/.test(s);
const isAlnum = s => [...s].every(c => ALNUM.includes(c));

const utf8 = s => [...new TextEncoder().encode(s)];

/** How many bits the content itself takes, in the given mode and version. */
function countBits(mode, version) {
  const small = version <= 9;
  if (mode === 'numeric') return small ? 10 : 12;
  if (mode === 'alnum') return small ? 9 : 11;
  return small ? 8 : 16;
}

function pickMode(text) {
  if (isNumeric(text)) return 'numeric';
  if (isAlnum(text)) return 'alnum';
  return 'byte';
}

function dataBitCount(text, mode, version) {
  const head = 4 + countBits(mode, version);
  if (mode === 'numeric') {
    const full = Math.floor(text.length / 3), rest = text.length % 3;
    return head + full * 10 + (rest === 2 ? 7 : rest === 1 ? 4 : 0);
  }
  if (mode === 'alnum') return head + Math.floor(text.length / 2) * 11 + (text.length % 2) * 6;
  return head + utf8(text).length * 8;
}

/** Data codewords available at a version and correction level. */
function dataCapacity(version, level) {
  const [ecPer, n1, d1, n2 = 0, d2 = 0] = BLOCKS[level][version];
  return n1 * d1 + n2 * d2;
}

function pickVersion(text, mode, level, min = 1) {
  for (let v = Math.max(1, min); v <= 10; v++) {
    if (dataBitCount(text, mode, v) <= dataCapacity(v, level) * 8) return v;
  }
  throw new Error('That is too much text for one QR label. Keep it short.');
}

/** Content -> the full run of codewords, error correction included and interleaved. */
function codewords(text, version, level, mode) {
  const bits = new Bits();
  bits.push(mode === 'numeric' ? 1 : mode === 'alnum' ? 2 : 4, 4);

  if (mode === 'numeric') {
    bits.push(text.length, countBits(mode, version));
    for (let i = 0; i < text.length; i += 3) {
      const chunk = text.slice(i, i + 3);
      bits.push(Number(chunk), chunk.length === 3 ? 10 : chunk.length === 2 ? 7 : 4);
    }
  } else if (mode === 'alnum') {
    bits.push(text.length, countBits(mode, version));
    for (let i = 0; i < text.length; i += 2) {
      if (i + 1 < text.length) bits.push(ALNUM.indexOf(text[i]) * 45 + ALNUM.indexOf(text[i + 1]), 11);
      else bits.push(ALNUM.indexOf(text[i]), 6);
    }
  } else {
    const bytes = utf8(text);
    bits.push(bytes.length, countBits(mode, version));
    for (const b of bytes) bits.push(b, 8);
  }

  const capacity = dataCapacity(version, level) * 8;
  bits.push(0, Math.min(4, capacity - bits.length));           // terminator
  while (bits.length % 8) bits.push(0, 1);                      // up to a whole byte
  const data = bits.bytes();
  for (let i = 0; data.length < capacity / 8; i++) data.push(i % 2 ? 0x11 : 0xec);

  /* Split into blocks, protect each, then interleave as the standard requires. */
  const [ecPer, n1, d1, n2 = 0, d2 = 0] = BLOCKS[level][version];
  const blocks = [], checks = [];
  let at = 0;
  for (let i = 0; i < n1 + n2; i++) {
    const size = i < n1 ? d1 : d2;
    const block = data.slice(at, at + size); at += size;
    blocks.push(block);
    checks.push(ecc(block, ecPer));
  }

  const out = [];
  for (let i = 0; i < Math.max(d1, d2); i++)
    for (const block of blocks) if (i < block.length) out.push(block[i]);
  for (let i = 0; i < ecPer; i++) for (const check of checks) out.push(check[i]);
  return out;
}

/* --------------------------------------------------------------- the grid -- */

const EMPTY = -1;

function frame(version) {
  const size = version * 4 + 17;
  const grid = Array.from({ length: size }, () => new Array(size).fill(EMPTY));
  const put = (r, c, v) => { if (r >= 0 && r < size && c >= 0 && c < size) grid[r][c] = v; };

  /* Three big squares in the corners, with their light separators. */
  for (const [br, bc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const edge = r === -1 || r === 7 || c === -1 || c === 7;
      const ring = r === 0 || r === 6 || c === 0 || c === 6;
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      put(br + r, bc + c, edge ? 0 : (ring || core) ? 1 : 0);
    }
  }

  /* Small squares that keep a big code from drifting. */
  const spots = ALIGN[version];
  for (const r of spots) for (const c of spots) {
    if (grid[r][c] !== EMPTY) continue;                       // never over a finder
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++)
      put(r + dr, c + dc, (Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0)) ? 1 : 0);
  }

  /* The dotted lines that tell a reader how wide one square is. */
  for (let i = 8; i < size - 8; i++) {
    if (grid[6][i] === EMPTY) grid[6][i] = i % 2 === 0 ? 1 : 0;
    if (grid[i][6] === EMPTY) grid[i][6] = i % 2 === 0 ? 1 : 0;
  }
  grid[size - 8][8] = 1;                                       // always dark

  return grid;
}

/** The cells reserved for format and version information, which data skips. */
function reserved(version) {
  const size = version * 4 + 17;
  const keep = new Set();
  const mark = (r, c) => keep.add(r * size + c);
  for (let i = 0; i < 9; i++) { mark(8, i); mark(i, 8); }
  for (let i = 0; i < 8; i++) { mark(8, size - 1 - i); mark(size - 1 - i, 8); }
  if (version >= 7) {
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) {
      mark(i, size - 11 + j); mark(size - 11 + j, i);
    }
  }
  return keep;
}

/** Lay the codewords into the grid, up one two-wide column and down the next. */
function place(grid, bytes, version) {
  const size = grid.length;
  const skip = reserved(version);
  const bits = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);

  let at = 0, upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right--;                                  // the timing column
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (grid[row][col] !== EMPTY || skip.has(row * size + col)) continue;
        grid[row][col] = bits[at++] ?? 0;                      // remainder bits are light
      }
    }
    upward = !upward;
  }
  return grid;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r, _c) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** How hard this arrangement would be to read. Lower is better. */
function penalty(grid) {
  const size = grid.length;
  let score = 0;

  const run = line => {
    let total = 0, len = 1;
    for (let i = 1; i < line.length; i++) {
      if (line[i] === line[i - 1]) len++;
      else { if (len >= 5) total += 3 + (len - 5); len = 1; }
    }
    if (len >= 5) total += 3 + (len - 5);
    return total;
  };
  const FALSE_FINDER = [1,0,1,1,1,0,1,0,0,0,0];
  const looksLikeFinder = line => {
    let total = 0;
    for (let i = 0; i + 11 <= line.length; i++) {
      const window = line.slice(i, i + 11);
      if (window.every((v, j) => v === FALSE_FINDER[j])) total += 40;
      if (window.every((v, j) => v === FALSE_FINDER[10 - j])) total += 40;
    }
    return total;
  };

  for (let r = 0; r < size; r++) {
    const row = grid[r], col = grid.map(line => line[r]);
    score += run(row) + run(col) + looksLikeFinder(row) + looksLikeFinder(col);
  }

  for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
    const v = grid[r][c];
    if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) score += 3;
  }

  const dark = grid.flat().filter(v => v === 1).length;
  score += Math.floor(Math.abs(dark * 100 / (size * size) - 50) / 5) * 10;
  return score;
}

function writeFormat(grid, level, mask) {
  const size = grid.length;
  let bits = (EC_BITS[level] << 3) | mask;
  let rest = bits << 10;
  for (let i = 14; i >= 10; i--) if ((rest >> i) & 1) rest ^= 0x537 << (i - 10);
  const format = ((bits << 10) | rest) ^ 0x5412;

  /* The most significant bit goes first, at (8,0) — the order real readers
     expect. Getting this backwards leaves a code that looks perfect and
     decodes as nothing. */
  for (let i = 0; i < 15; i++) {
    const bit = (format >> (14 - i)) & 1;
    if (i < 6) grid[8][i] = bit;
    else if (i < 8) grid[8][i + 1] = bit;
    else if (i === 8) grid[7][8] = bit;
    else grid[14 - i][8] = bit;

    /* The second copy: the first seven bits run up the left column, the rest
       run along the top row. Seven, not eight — the eighth cell is the module
       that is always dark. */
    if (i < 7) grid[size - 1 - i][8] = bit;
    else grid[8][size - 15 + i] = bit;
  }
}

function writeVersion(grid, version) {
  if (version < 7) return;
  const size = grid.length;
  let rest = version << 12;
  for (let i = 17; i >= 12; i--) if ((rest >> i) & 1) rest ^= 0x1f25 << (i - 12);
  const info = (version << 12) | rest;
  for (let i = 0; i < 18; i++) {
    const bit = (info >> i) & 1;
    const r = Math.floor(i / 3), c = i % 3;
    grid[r][size - 11 + c] = bit;
    grid[size - 11 + c][r] = bit;
  }
}

/* ------------------------------------------------------------------ public -- */

/**
 * The QR grid for `text` as rows of 0 and 1. Correction level Q by default:
 * a label on a medicine box gets rubbed and creased, and Q still reads with
 * about a quarter of it damaged.
 */
export function matrix(text, { level = 'Q', minVersion = 1 } = {}) {
  if (typeof text !== 'string' || text === '') throw new Error('Nothing to put in the QR code.');
  if (!BLOCKS[level]) throw new Error(`Unknown correction level ${level}.`);

  const mode = pickMode(text);
  const version = pickVersion(text, mode, level, minVersion);
  const bytes = codewords(text, version, level, mode);

  let best = null, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const grid = place(frame(version), bytes, version);
    const skip = reserved(version);
    const size = grid.length;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
      if (skip.has(r * size + c)) continue;
      if (isFunction(version, r, c)) continue;
      if (MASKS[mask](r, c)) grid[r][c] ^= 1;
    }
    writeFormat(grid, level, mask);
    writeVersion(grid, version);
    const score = penalty(grid);
    if (score < bestScore) { bestScore = score; best = grid; }
  }
  return best;
}

/** True where the grid holds a pattern rather than data — never masked. */
function isFunction(version, r, c) {
  const size = version * 4 + 17;
  if (r === 6 || c === 6) return true;                                   // timing
  if (r < 9 && c < 9) return true;                                       // top-left
  if (r < 9 && c >= size - 8) return true;                               // top-right
  if (r >= size - 8 && c < 9) return true;                               // bottom-left
  for (const ar of ALIGN[version]) for (const ac of ALIGN[version]) {
    if (ar < 9 && ac < 9) continue;
    if (ar < 9 && ac >= size - 9) continue;
    if (ar >= size - 9 && ac < 9) continue;
    if (Math.abs(r - ar) <= 2 && Math.abs(c - ac) <= 2) return true;
  }
  if (version >= 7) {
    if (r < 6 && c >= size - 11 && c < size - 8) return true;
    if (c < 6 && r >= size - 11 && r < size - 8) return true;
  }
  return false;
}

/**
 * The same code as an SVG, ready to drop into a page or a label.
 * `size` is the finished width in millimetres; `quiet` is the blank margin
 * a reader needs, counted in modules — four is the standard minimum.
 */
export function svg(text, { level = 'Q', size = 22, quiet = 4, minVersion = 1 } = {}) {
  const grid = matrix(text, { level, minVersion });
  const n = grid.length + quiet * 2;

  /* One rectangle per run of dark squares keeps the file small. */
  const parts = [];
  for (let r = 0; r < grid.length; r++) {
    let start = -1;
    for (let c = 0; c <= grid.length; c++) {
      const dark = c < grid.length && grid[r][c] === 1;
      if (dark && start < 0) start = c;
      if (!dark && start >= 0) {
        parts.push(`<rect x="${start + quiet}" y="${r + quiet}" width="${c - start}" height="1"/>`);
        start = -1;
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" `
    + `width="${size}mm" height="${size}mm" shape-rendering="crispEdges" role="img" `
    + `aria-label="QR code">`
    + `<rect width="${n}" height="${n}" fill="#fff"/>`
    + `<g fill="#000">${parts.join('')}</g></svg>`;
}
