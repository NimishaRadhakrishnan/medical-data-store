/**
 * One clock, not two.
 *
 * SQLite's date('now','localtime') comes from the operating system. The app's
 * today() comes from the Node process. On a machine where those differ — which
 * is common, and was true of the machine this was written on — they disagree
 * about what day it is for hours at a time. While they disagreed, a batch that
 * had expired yesterday was still sellable, because the refusal asked SQLite
 * and the allocation asked the app.
 *
 * These tests fix the app's own date as the only authority.
 *
 *   npm run test:app
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const work = mkdtempSync(join(tmpdir(), 'snm-drift-'));
process.env.SNM_DB = join(work, 'shop.db');
process.env.SNM_BACKUPS = join(work, 'backups');

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..', 'apps', 'shop');

const db = await import('../../apps/shop/db.js');
const L = await import('../../apps/shop/logic.js');

const dayShift = n => db.today(new Date(Date.now() + n * 86400000));
let med;

before(() => {
  db.open();
  db.run(`insert into shop_settings (id, name, address1, address2) values (1, 'Sri Nachiya Medicals', 'Ettimadai', 'Coimbatore 641112')`);
  db.run(`insert into suppliers (name) values ('Sakthi Pharma')`);
  med = L.addProduct({ name: 'Drift Test Tab', unitsPerStrip: 10, gstRate: 5 });
});

after(() => { db.close(); rmSync(work, { recursive: true, force: true }); });

describe('the app keeps its own calendar', () => {
  test('nothing that decides anything asks SQLite what day it is', () => {
    /* Timestamps written as a record of when something happened are fine. What
       must not happen is a *decision* — is this expired, may this be sold —
       being taken from a second clock. */
    for (const file of ['logic.js', 'schema.sql']) {
      const text = readFileSync(join(APP, file), 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (/^\s*(--|\/\/|\*)/.test(line)) return;                 // a comment explaining this rule
        if (/\bdefault\s*\(datetime\('now'/.test(line)) return;     // a created_at stamp, not a decision
        assert.doesNotMatch(line, /\bdate\('now'/,
          `${file}:${i + 1} decides something from SQLite's clock: ${line.trim()}`);
      });
    }
  });

  test('a batch expiring today is still sellable all day', () => {
    // The last day is a selling day: stock is good until the end of the month
    // printed on the pack, not until the day before.
    L.receiveDelivery({ supplierId: 1, lines: [{ productId: med.id, batchNo: 'TODAY-1',
      expiry: dayShift(0), packs: 2, mrpPaise: 1000, costPaise: 700 }] });

    const bill = L.createBill({ items: [{ productId: med.id, qty: 5 }], clientUuid: 'drift-today' });
    assert.ok(bill.bill_no, 'stock expiring today must not be refused');
    assert.equal(db.get(`select expiry from batches where batch_no = ?`, 'TODAY-1').expiry, dayShift(0));
  });

  test('a batch that expired yesterday is refused, whatever SQLite thinks the date is', () => {
    L.receiveDelivery({ supplierId: 1, lines: [{ productId: med.id, batchNo: 'GONE-1',
      expiry: dayShift(30), packs: 2, mrpPaise: 1000, costPaise: 700 }] });
    const gone = db.get(`select * from batches where batch_no = ?`, 'GONE-1');
    db.run(`update batches set expiry = ? where id = ?`, dayShift(-1), gone.id);

    // Nothing else is in stock, so this is the only batch it could come from.
    db.run(`update batches set qty = 0 where batch_no = ?`, 'TODAY-1');
    assert.throws(() => L.createBill({ items: [{ productId: med.id, qty: 5 }], clientUuid: 'drift-gone' }),
      /left in stock/i, 'expired stock must never be allocated');
    assert.equal(gone.qty, db.get('select qty from batches where id = ?', gone.id).qty,
      'and none of it may move');
  });

  test('the database refuses expired stock even if the screens are bypassed', () => {
    /* The rule lives in a trigger as well, so an import or a future screen
       obeys it too. It compares against the bill's own business_date — the
       app's date — which is the whole point of this file. */
    const gone = db.get(`select * from batches where batch_no = ?`, 'GONE-1');
    db.run(`insert into sales (bill_no, business_date, pay_mode) values ('DRIFT-1', ?, 'cash')`, db.today());
    const saleId = db.get(`select id from sales where bill_no = ?`, 'DRIFT-1').id;

    assert.throws(() => db.run(
      `insert into sale_items (sale_id, product_id, batch_id, qty, mrp_paise, cost_paise,
         gst_rate, gross_paise, taxable_paise, gst_paise)
       values (?,?,?,?,?,?,?,?,?,?)`,
      saleId, med.id, gone.id, 1, 1000, 700, 5, 100, 95, 5),
      /expired/i, 'the trigger must refuse it');
  });

  test('a bill dated yesterday may still sell stock that expired today', () => {
    /* The comparison is against the bill's date, not against right now, so a
       bill being finished a moment after midnight behaves sensibly rather than
       rejecting stock that was good when the customer was served. */
    L.receiveDelivery({ supplierId: 1, lines: [{ productId: med.id, batchNo: 'EDGE-1',
      expiry: dayShift(0), packs: 1, mrpPaise: 1000, costPaise: 700 }] });
    const edge = db.get(`select * from batches where batch_no = ?`, 'EDGE-1');

    db.run(`insert into sales (bill_no, business_date, pay_mode) values ('DRIFT-2', ?, 'cash')`, dayShift(-1));
    const saleId = db.get(`select id from sales where bill_no = ?`, 'DRIFT-2').id;

    db.run(`insert into sale_items (sale_id, product_id, batch_id, qty, mrp_paise, cost_paise,
              gst_rate, gross_paise, taxable_paise, gst_paise)
            values (?,?,?,?,?,?,?,?,?,?)`,
      saleId, med.id, edge.id, 1, 1000, 700, 5, 100, 95, 5);
    assert.equal(db.get('select count(*) as n from sale_items where sale_id = ?', saleId).n, 1);
  });

  test('the expiry report counts the days from the app\'s date', () => {
    const report = L.expiryReport(365);
    assert.equal(report.generated, db.today());
    const rows = Object.values(report.buckets).flatMap(b => b.rows);
    const today = rows.find(r => r.batch_no === 'EDGE-1');
    assert.ok(today, 'a batch expiring today belongs in the report');
    assert.equal(today.days_left, 0, 'expiring today is zero days left, not minus one');
    const expired = rows.find(r => r.batch_no === 'GONE-1');
    assert.equal(expired.days_left, -1);
  });
});
