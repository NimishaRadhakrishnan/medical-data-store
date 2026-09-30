/**
 * Adding a lot of medicines at once.
 *
 * A pharmacy opening its books has several hundred medicines on the shelves.
 * Typing them one at a time through a dialog would take days, so they arrive
 * here instead — as a file, or simply copied out of Excel and pasted in.
 *
 * Two rules shape everything below:
 *
 *   Nothing is written until the owner has seen what will happen. The preview
 *   shows every row as "will be added", "already there" or "cannot be used,
 *   because…", with the line number from the file. A list of 400 medicines
 *   always has a few odd rows, and finding them afterwards is miserable.
 *
 *   One bad row does not stop the other 399. The good rows go in, the bad ones
 *   are listed, and the owner fixes those few by hand. A wholesale refusal
 *   would mean editing a spreadsheet blind, over and over.
 */

import * as L from './logic.js';

/* The columns, in the order the template writes them. Only the name is
   required; a shop that knows nothing but its medicine names can still start,
   and fill in the rest as each one is first bought. */
export const COLUMNS = [
  { key: 'name',          heading: 'Medicine',        required: true },
  { key: 'genericName',   heading: 'Generic name' },
  { key: 'manufacturer',  heading: 'Company' },
  { key: 'baseUnit',      heading: 'Sold as' },
  { key: 'unitsPerStrip', heading: 'Per strip' },
  { key: 'gstRate',       heading: 'GST %' },
  { key: 'schedule',      heading: 'Schedule' },
  { key: 'hsn',           heading: 'HSN' },
  { key: 'rack',          heading: 'Rack' },
  { key: 'reorderPacks',  heading: 'Remind below' },
  // Opening stock. Leave blank for a medicine the shop does not hold yet.
  { key: 'batchNo',       heading: 'Batch' },
  { key: 'expiry',        heading: 'Expiry' },
  { key: 'packs',         heading: 'Packs in hand' },
  { key: 'mrpPaise',      heading: 'MRP' },
  { key: 'costPaise',     heading: 'Cost' },
];

const UNITS = ['tablet', 'capsule', 'bottle', 'piece'];
const SCHEDULES = ['OTC', 'G', 'H', 'H1', 'X'];

/**
 * Split a sheet of text into rows of cells.
 *
 * Handles both shapes the owner can produce without thinking about it: a .csv
 * saved from Excel, and a block of cells copied from Excel and pasted, which
 * arrives separated by tabs. Quoted fields are respected, because a medicine
 * name may contain a comma.
 */
export function splitRows(text) {
  const clean = String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (!clean.trim()) return [];

  // Whichever separator appears more outside quotes is the one in use.
  const bare = clean.replace(/"[^"]*"/g, '');
  const sep = (bare.match(/\t/g) || []).length > (bare.match(/,/g) || []).length ? '\t' : ',';

  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (quoted) {
      if (c === '"') {
        if (clean[i + 1] === '"') { cell += '"'; i++; }   // "" inside a quoted field
        else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"' && cell === '') { quoted = true; continue; }
    if (c === sep) { row.push(cell); cell = ''; continue; }
    if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += c;
  }
  row.push(cell);
  rows.push(row);

  return rows
    .map(r => r.map(v => v.trim()))
    .filter(r => r.some(v => v !== ''));           // blank lines, and Excel's trailing one
}

/** Is this first row a heading rather than a medicine? */
const looksLikeHeading = row =>
  /^(medicine|name|product|item)$/i.test(String(row[0] ?? '').trim());

/** Money as typed — "33.10", "₹33.10", "33" — in paise. */
function toPaise(value, what) {
  const raw = String(value ?? '').replace(/[₹,\s]/g, '');
  if (!raw) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) throw new Error(`${what} "${value}" is not an amount`);
  return Math.round(Number(raw) * 100);
}

/** An expiry as a pharmacist writes it: 05/28, 05/2028, 2028-05, 31-05-2028. */
function toExpiry(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const lastDay = (y, m) => {
    if (m < 1 || m > 12) throw new Error(`Expiry "${raw}" has no such month`);
    const d = new Date(y, m, 0);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  let m;
  if ((m = /^(\d{4})-(\d{1,2})$/.exec(raw))) return lastDay(+m[1], +m[2]);
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw))) return raw;
  if ((m = /^(\d{1,2})[/-](\d{2})$/.exec(raw))) return lastDay(2000 + +m[2], +m[1]);
  if ((m = /^(\d{1,2})[/-](\d{4})$/.exec(raw))) return lastDay(+m[2], +m[1]);
  if ((m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(raw))) return lastDay(+m[3], +m[2]);
  throw new Error(`Expiry "${raw}" is not a date. Write it as 05/2028.`);
}

const whole = (value, what, { min = 0, fallback = null } = {}) => {
  const raw = String(value ?? '').replace(/,/g, '').trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${what} "${value}" is not a whole number`);
  const n = Number(raw);
  if (n < min) throw new Error(`${what} cannot be less than ${min}`);
  return n;
};

/**
 * Read the text and say what each row would do, without writing anything.
 *
 * Every row comes back with its line number, so a problem can be found in the
 * spreadsheet it came from.
 */
export function preview(text) {
  const rows = splitRows(text);
  if (!rows.length) return { rows: [], counts: { add: 0, skip: 0, problem: 0 } };

  let start = 0;
  if (looksLikeHeading(rows[0])) start = 1;

  const seen = new Set();                 // duplicates inside the file itself
  const out = [];

  for (let i = start; i < rows.length; i++) {
    const cells = rows[i];
    const line = i + 1;
    const value = key => {
      const at = COLUMNS.findIndex(c => c.key === key);
      return at >= 0 ? (cells[at] ?? '') : '';
    };

    const name = L.tidyName(value('name'));
    const row = { line, name, raw: cells };

    try {
      if (!name) throw new Error('No medicine name');

      const key = name.toLowerCase();
      if (seen.has(key)) throw new Error('This medicine appears twice in the file');
      seen.add(key);

      if (L.productNamed(name)) {
        out.push({ ...row, action: 'skip', why: 'Already in the list' });
        continue;
      }

      const baseUnit = String(value('baseUnit') || 'tablet').toLowerCase().replace(/s$/, '');
      if (!UNITS.includes(baseUnit))
        throw new Error(`"Sold as" must be one of ${UNITS.join(', ')}`);

      const schedule = String(value('schedule') || 'OTC').toUpperCase();
      if (!SCHEDULES.includes(schedule))
        throw new Error(`Schedule must be one of ${SCHEDULES.join(', ')}`);

      const gstRate = whole(value('gstRate'), 'GST %', { fallback: 5 });
      if (![0, 5, 12, 18, 28].includes(gstRate))
        throw new Error(`GST of ${gstRate}% is not a rate medicines use`);

      const product = {
        name,
        genericName: value('genericName') || null,
        manufacturer: value('manufacturer') || null,
        baseUnit,
        unitsPerStrip: whole(value('unitsPerStrip'), 'Per strip', { min: 1, fallback: 1 }),
        gstRate,
        schedule,
        hsn: value('hsn') || '3004',
        rack: value('rack') || null,
        reorderPacks: whole(value('reorderPacks'), 'Remind below', { fallback: 0 }),
      };

      /* Opening stock is optional, but all of it or none: a quantity with no
         expiry would be stock the app could never judge the age of. */
      const stockCells = ['batchNo', 'expiry', 'packs', 'mrpPaise'].map(k => String(value(k) || '').trim());
      const opening = stockCells.some(Boolean) ? (() => {
        const missing = ['Batch', 'Expiry', 'Packs in hand', 'MRP']
          .filter((_, n) => !stockCells[n]);
        if (missing.length)
          throw new Error(`Opening stock needs ${missing.join(', ')} as well`);
        return {
          batchNo: value('batchNo'),
          expiry: toExpiry(value('expiry')),
          packs: whole(value('packs'), 'Packs in hand', { min: 1 }),
          mrpPaise: toPaise(value('mrpPaise'), 'MRP'),
          costPaise: toPaise(value('costPaise'), 'Cost') ?? 0,
        };
      })() : null;

      if (opening) {
        if (opening.expiry < L.todayForImport())
          throw new Error(`That batch expired on ${opening.expiry}`);
        if (opening.costPaise > opening.mrpPaise)
          throw new Error('Cost is more than the MRP');
      }

      out.push({ ...row, action: 'add', product, opening });
    } catch (e) {
      out.push({ ...row, action: 'problem', why: e.message });
    }
  }

  const problems = out.filter(r => r.action === 'problem');

  /* When a great many rows fail in the same way, the columns are almost
     certainly in the wrong order — one inserted or deleted column shifts
     everything after it. Saying so once is far more use than listing eighty
     identical complaints and leaving the owner to notice the pattern. */
  let hint = null;
  if (problems.length >= 5 && problems.length > out.length * 0.3) {
    const kinds = new Map();
    for (const p of problems) {
      const kind = p.why.replace(/"[^"]*"/g, '…');
      kinds.set(kind, (kinds.get(kind) || 0) + 1);
    }
    const [worst, n] = [...kinds].sort((a, b) => b[1] - a[1])[0];
    if (n >= 5) {
      hint = `${n} rows have the same trouble (${worst}). That usually means the columns are ` +
             `in a different order from the blank sheet — check that each heading sits above the ` +
             `right values, and that no column has been inserted or removed.`;
    }
  }

  return {
    rows: out,
    hint,
    counts: {
      add: out.filter(r => r.action === 'add').length,
      skip: out.filter(r => r.action === 'skip').length,
      problem: problems.length,
    },
  };
}

/**
 * Write the rows that were good. The bad ones are reported, never guessed at.
 *
 * Each medicine is added in its own transaction rather than all in one, so a
 * surprise on row 300 leaves the first 299 safely in place — importing 400
 * medicines twice because of one bad row is exactly the misery this is for.
 */
export function save(text, { supplierId = null } = {}) {
  const { rows } = preview(text);
  const added = [], failed = [];
  let stocked = 0;

  for (const row of rows) {
    if (row.action !== 'add') continue;
    try {
      const product = L.addProduct(row.product);
      if (row.opening) {
        if (!supplierId) throw new Error('Choose which distributor the opening stock came from');
        L.receiveDelivery({
          supplierId,
          invoiceNo: `OPENING-${product.id}`,
          lines: [{ productId: product.id, ...row.opening }],
        });
        stocked++;
      }
      added.push(product.name);
    } catch (e) {
      failed.push({ line: row.line, name: row.name, why: e.message });
    }
  }

  return { added: added.length, stocked, failed, names: added };
}

/** A blank sheet with the right headings, for the owner to fill in. */
export const template = () => [
  COLUMNS.map(c => c.heading).join(','),
  'Dolo 650,Paracetamol 650mg,Micro Labs,tablet,15,5,OTC,3004,A-1,4,B4471,05/2028,10,33.10,25.40',
  'Pan 40,Pantoprazole 40mg,Alkem,tablet,15,5,H,3004,A-2,3,,,,,',
].join('\n') + '\n';
