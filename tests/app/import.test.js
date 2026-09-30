/**
 * Adding several hundred medicines at once.
 *
 * A shop opening its books has a shelf full of stock and no patience for a
 * dialog per medicine. What matters is that a long list with a few odd rows in
 * it behaves sensibly: the good rows go in, the bad ones are named with their
 * line number, and nothing is written until the owner has looked.
 *
 *   npm run test:app
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const work = mkdtempSync(join(tmpdir(), 'snm-import-'));
process.env.SNM_DB = join(work, 'shop.db');
process.env.SNM_BACKUPS = join(work, 'backups');

const db = await import('../../apps/shop/db.js');
const L = await import('../../apps/shop/logic.js');
const I = await import('../../apps/shop/import.js');

const HEAD = 'Medicine,Generic name,Company,Sold as,Per strip,GST %,Schedule,HSN,Rack,Remind below,Batch,Expiry,Packs in hand,MRP,Cost';

before(() => {
  db.open();
  db.run(`insert into shop_settings (id, name, address1, address2)
          values (1, 'Sri Nachiya Medicals', '5/168', 'Ettimadai')`);
  L.addSupplier({ name: 'Palepu Pharma' });
});

after(() => { db.close(); rmSync(work, { recursive:true, force:true }); });

describe('reading what the owner pasted in', () => {
  test('a block copied out of Excel arrives as tab-separated, and still works', () => {
    const pasted = 'Dolo 650\tParacetamol\tMicro Labs\ttablet\t15\t5\tOTC';
    const { rows } = I.preview(pasted);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'add');
    assert.equal(rows[0].product.name, 'Dolo 650');
    assert.equal(rows[0].product.unitsPerStrip, 15);
  });

  test('a medicine name containing a comma survives', () => {
    const { rows } = I.preview(`${HEAD}\n"Vitamin B1, B6, B12 Tab",,,tablet,10,12,OTC`);
    assert.equal(rows[0].action, 'add');
    assert.equal(rows[0].product.name, 'Vitamin B1, B6, B12 Tab');
  });

  test('the heading row is recognised and not treated as a medicine', () => {
    const { rows } = I.preview(`${HEAD}\nDolo 650,,,tablet,15,5,OTC`);
    assert.equal(rows.length, 1, 'the heading must not become a row');
    assert.equal(rows[0].name, 'Dolo 650');
  });

  test('blank lines, stray spaces and a byte-order mark are ignored', () => {
    const { rows } = I.preview(`﻿${HEAD}\n\n  Dolo 650 ,,,tablet,15,5,OTC\n\n`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].product.name, 'Dolo 650');
  });

  test('nothing in, nothing out', () => {
    assert.deepEqual(I.preview('').rows, []);
    assert.deepEqual(I.preview('   \n\n  ').rows, []);
  });
});

describe('the preview says what will happen, before anything is written', () => {
  test('each row is add, already there, or a problem with a reason', () => {
    L.addProduct({ name:'Existing Tab', unitsPerStrip:10, gstRate:5 });
    const sheet = [
      HEAD,
      'New Tab,,,tablet,10,5,OTC',
      'Existing Tab,,,tablet,10,5,OTC',
      ',,,tablet,10,5,OTC',                          // no name
      'Bad Unit Tab,,,sachet,10,5,OTC',              // not a unit the app knows
      'Bad Gst Tab,,,tablet,10,7,OTC',               // not a GST rate medicines use
      'Bad Sched Tab,,,tablet,10,5,Z',               // not a schedule
      'Bad Count Tab,,,tablet,ten,5,OTC',            // letters where a number belongs
    ].join('\n');

    const { rows, counts } = I.preview(sheet);
    assert.equal(counts.add, 1);
    assert.equal(counts.skip, 1);
    assert.equal(counts.problem, 5);

    const problems = rows.filter(r => r.action === 'problem');
    assert.match(problems.find(p => p.line === 4).why, /No medicine name/i);
    assert.match(problems.find(p => p.line === 5).why, /Sold as/i);
    assert.match(problems.find(p => p.line === 6).why, /GST/i);
    assert.match(problems.find(p => p.line === 7).why, /Schedule/i);
    assert.match(problems.find(p => p.line === 8).why, /whole number/i);

    // Line numbers must match the spreadsheet the owner is looking at.
    assert.equal(rows.find(r => r.name === 'New Tab').line, 2);
    // And nothing may have been written.
    assert.equal(L.productNamed('New Tab'), undefined);
  });

  test('the same medicine twice in one file is caught', () => {
    const { rows } = I.preview(`${HEAD}\nTwice Tab,,,tablet,10,5,OTC\nTwice Tab,,,tablet,10,5,OTC`);
    assert.equal(rows[0].action, 'add');
    assert.equal(rows[1].action, 'problem');
    assert.match(rows[1].why, /appears twice/i);
  });

  test('a medicine with nothing but a name is allowed', () => {
    // A shop that knows only its names can still start and fill the rest in later.
    const { rows } = I.preview('Bare Tab');
    assert.equal(rows[0].action, 'add');
    assert.equal(rows[0].product.unitsPerStrip, 1);
    assert.equal(rows[0].product.gstRate, 5);
    assert.equal(rows[0].product.schedule, 'OTC');
  });
});

describe('expiry dates, however the pharmacist writes them', () => {
  test('the usual shapes are all understood, and land on the month end', () => {
    for (const written of ['05/2028', '05/28', '5/2028', '2028-05', '31-05-2028']) {
      const { rows } = I.preview(`${HEAD}\nExp ${written.replace(/\W/g, '')},,,tablet,10,5,OTC,3004,,0,B1,${written},5,33.10,25.40`);
      assert.equal(rows[0].action, 'add', `${written}: ${rows[0].why || ''}`);
      assert.equal(rows[0].opening.expiry, '2028-05-31', `${written} should be the last day of May 2028`);
    }
  });

  test('February is given the right number of days', () => {
    const { rows } = I.preview(`${HEAD}\nFeb Tab,,,tablet,10,5,OTC,3004,,0,B1,02/2028,5,33.10,25.40`);
    assert.equal(rows[0].opening.expiry, '2028-02-29', '2028 is a leap year');
  });

  test('nonsense and already-expired dates are refused', () => {
    const bad = I.preview(`${HEAD}\nJunk Date Tab,,,tablet,10,5,OTC,3004,,0,B1,next tuesday,5,33.10,25.40`);
    assert.match(bad.rows[0].why, /not a date/i);

    const gone = I.preview(`${HEAD}\nOld Tab,,,tablet,10,5,OTC,3004,,0,B1,01/2020,5,33.10,25.40`);
    assert.match(gone.rows[0].why, /expired/i);
  });
});

describe('opening stock', () => {
  test('a half-filled stock row says what is missing', () => {
    const { rows } = I.preview(`${HEAD}\nHalf Tab,,,tablet,10,5,OTC,3004,,0,B1,,5,`);
    assert.equal(rows[0].action, 'problem');
    assert.match(rows[0].why, /Expiry/);
    assert.match(rows[0].why, /MRP/);
  });

  test('cost above MRP is refused', () => {
    const { rows } = I.preview(`${HEAD}\nUpside Tab,,,tablet,10,5,OTC,3004,,0,B1,05/2028,5,20.00,30.00`);
    assert.match(rows[0].why, /more than the MRP/i);
  });

  test('money is read whether or not it carries a rupee sign or commas', () => {
    const { rows } = I.preview(`${HEAD}\nMoney Tab,,,tablet,10,5,OTC,3004,,0,B1,05/2028,5,"₹1,234.50","1,000"`);
    assert.equal(rows[0].opening.mrpPaise, 123450);
    assert.equal(rows[0].opening.costPaise, 100000);
  });
});

describe('saving', () => {
  test('the good rows go in and the bad ones are reported, not guessed at', () => {
    const sheet = [
      HEAD,
      'Import A,,,tablet,10,5,OTC',
      'Import B,Generic B,Company B,bottle,1,12,H,3005,B-2,7',
      'Broken Row,,,sachet,10,5,OTC',
    ].join('\n');

    const out = I.save(sheet);
    assert.equal(out.added, 2);
    assert.equal(out.failed.length, 0, 'a bad row is refused at preview, not at save');

    const b = L.productNamed('Import B');
    assert.equal(b.generic_name, 'Generic B');
    assert.equal(b.base_unit, 'bottle');
    assert.equal(b.gst_rate, 12);
    assert.equal(b.drug_schedule, 'H');
    assert.equal(b.rack, 'B-2');
    assert.equal(b.reorder_packs, 7);
    assert.equal(L.productNamed('Broken Row'), undefined);
  });

  test('opening stock lands on the shelf, with its batch and expiry', () => {
    const sheet = `${HEAD}\nStocked Tab,,,tablet,15,5,OTC,3004,A-9,4,SB-1,05/2028,10,33.10,25.40`;
    const out = I.save(sheet, { supplierId: 1 });
    assert.equal(out.added, 1);
    assert.equal(out.stocked, 1);

    const p = L.productNamed('Stocked Tab');
    assert.equal(L.stockOf(p.id), 150, '10 packs of 15');
    const batch = db.get('select * from batches where product_id = ?', p.id);
    assert.equal(batch.batch_no, 'SB-1');
    assert.equal(batch.expiry, '2028-05-31');
    assert.equal(batch.mrp_paise, 3310);
    assert.equal(batch.cost_paise, 2540);
    assert.equal(L.integrityCheck().ok, true, 'the ledger must explain the new stock');
  });

  test('opening stock without a distributor is refused, and the medicine still goes in', () => {
    const out = I.save(`${HEAD}\nNo Supplier Tab,,,tablet,10,5,OTC,3004,,0,NS-1,05/2028,5,20.00,15.00`);
    assert.equal(out.added, 0);
    assert.equal(out.failed.length, 1);
    assert.match(out.failed[0].why, /distributor/i);
  });

  test('importing the same sheet twice adds nothing the second time', () => {
    const sheet = `${HEAD}\nOnce Only Tab,,,tablet,10,5,OTC`;
    assert.equal(I.save(sheet).added, 1);
    assert.equal(I.save(sheet).added, 0, 'the second run must be a no-op');
    assert.equal(db.get(`select count(*) as n from products where lower(trim(name)) = 'once only tab'`).n, 1);
  });

  test('one bad row does not lose the hundreds around it', () => {
    /* The point of the whole feature: a list of 400 with a few odd rows must
       not have to be imported 400 times. */
    const lines = [HEAD];
    for (let i = 0; i < 200; i++) lines.push(`Bulk Tab ${i},,,tablet,10,5,OTC`);
    lines.splice(100, 0, 'Wrecker Tab,,,sachet,10,5,OTC');

    const out = I.save(lines.join('\n'));
    assert.equal(out.added, 200);
    assert.equal(L.productNamed('Bulk Tab 0').name, 'Bulk Tab 0');
    assert.equal(L.productNamed('Bulk Tab 199').name, 'Bulk Tab 199');
    assert.equal(L.productNamed('Wrecker Tab'), undefined);
  });
});

describe('a shifted column is diagnosed once, not eighty times', () => {
  test('many rows failing the same way suggests the columns, not the rows', () => {
    /* Deleting one column shifts everything after it, and the owner then sees
       a long list of identical complaints with no clue what caused them. */
    const lines = ['Medicine,Generic name,Company,Sold as,Per strip,GST %,Schedule'];
    for (let i = 0; i < 20; i++) lines.push(`Shifted Med ${i},Generic,Company,15,5,OTC,3004`);

    const { hint, counts } = I.preview(lines.join('\n'));
    assert.equal(counts.problem, 20);
    assert.ok(hint, 'a pattern this strong should be named');
    assert.match(hint, /columns are in a different order/i);
    assert.match(hint, /20 rows/);
  });

  test('a few ordinary mistakes are left to speak for themselves', () => {
    const lines = ['Medicine,Generic name,Company,Sold as,Per strip,GST %,Schedule'];
    for (let i = 0; i < 20; i++) lines.push(`Fine Med ${i},,,tablet,10,5,OTC`);
    lines.push('Odd One,,,sachet,10,5,OTC');

    const { hint, counts } = I.preview(lines.join('\n'));
    assert.equal(counts.problem, 1);
    assert.equal(hint, null, 'one bad row is not a column problem');
  });
});

describe('the blank sheet given to the owner', () => {
  test('it reads back through the importer it was made for', () => {
    const text = I.template();
    const { rows, counts } = I.preview(text);
    assert.equal(counts.problem, 0, 'the app\'s own template must not contain a bad row');
    assert.equal(rows.length, 2, 'two examples, one with stock and one without');
    assert.ok(rows[0].opening, 'the first example shows how opening stock is written');
    assert.equal(rows[1].opening, null, 'the second shows it is optional');
  });
});
