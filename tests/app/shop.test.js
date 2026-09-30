/**
 * Tests for the offline shop application.
 *
 *   npm run test:app
 *
 * Everything here runs against a real SQLite file in a temporary folder and,
 * for the last group, a real HTTP server. Nothing is mocked, because the point
 * is to prove the shop's own data is safe.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const work = mkdtempSync(join(tmpdir(), 'snm-test-'));
process.env.SNM_DB = join(work, 'shop.db');
process.env.SNM_BACKUPS = join(work, 'backups');

const db = await import('../../apps/shop/db.js');
const L  = await import('../../apps/shop/logic.js');
const X  = await import('../../apps/shop/xlsx.js');

const today = db.today();
const yearsOn = n => db.today(new Date(Date.now() + n * 365 * 86400000));
const daysOn  = n => db.today(new Date(Date.now() + n * 86400000));

let dolo, augmentin, syrup;

before(() => {
  db.open();
  db.run(`insert into shop_settings (id, name, address1, address2, gstin)
          values (1, 'Sri Nachiya Medicals', '5/168, Palaghad Main Road',
                  'Ettimadai, Coimbatore, Tamil Nadu 641112', null)`);
  db.run(`insert into suppliers (name, return_months) values ('Sakthi Pharma', 3)`);
  db.run(`insert into suppliers (name, return_months) values ('Kovai Agencies', 6)`);

  dolo = L.addProduct({ name:'Dolo 650', genericName:'Paracetamol', compositionKey:'para|650',
                        unitsPerStrip:15, gstRate:5, reorderPacks:5, rack:'A-1' });
  augmentin = L.addProduct({ name:'Augmentin 625', genericName:'Amoxiclav', unitsPerStrip:10,
                             gstRate:5, schedule:'H1' });
  syrup = L.addProduct({ name:'Ascoril LS Syrup', baseUnit:'bottle', unitsPerStrip:1, gstRate:5 });
});

after(() => { db.close(); rmSync(work, { recursive:true, force:true }); });

const receive = (product, batchNo, expiry, packs, mrp, cost, supplier = 1, free = 0) =>
  L.receiveDelivery({ supplierId: 1, lines: [{ productId: product.id, batchNo, expiry,
    packs, freePacks: free, mrpPaise: mrp, costPaise: cost }] });

// ============================================================ stock movements

describe('stock', () => {
  test('a delivery puts stock on the shelf, through the stock history', () => {
    receive(dolo, 'DL-A', daysOn(400), 10, 3310, 2540);
    assert.equal(L.stockOf(dolo.id), 150);
    const ledger = db.all('select * from stock_ledger where product_id = ?', dolo.id);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].delta, 150);
    assert.equal(ledger[0].reason, 'purchase');
  });

  test("the invoice's discount is taken off the trade price, not left on it", () => {
    /* Taken line by line from a real Palepu Pharma invoice, CB-26-134190 of
       22/09/2026. The distributor prints a Trade Price and then a "Dis %"
       column; the shop pays the discounted figure. Working margins out from
       the printed price instead understates every one of them. */
    const thyronorm = L.addProduct({ name:'Thyronorm 100mcg', unitsPerStrip:120, gstRate:5 });
    L.receiveDelivery({ supplierId: 1, invoiceNo:'CB-26-134190', discountPct: 4,
      lines: [{ productId: thyronorm.id, batchNo:'TMH26119', expiry: daysOn(500),
                packs: 2, mrpPaise: 16991, costPaise: 12946 }] });

    const batch = db.get('select * from batches where batch_no = ?', 'TMH26119');
    assert.equal(batch.cost_paise, 12428, '129.46 less 4% is 124.28');

    const item = db.get('select * from purchase_items where batch_id = ?', batch.id);
    assert.equal(item.list_cost_paise, 12946, 'the printed trade price is kept, so the invoice can be checked');
    assert.equal(item.discount_bp, 400);
    assert.equal(item.line_paise, 12428 * 2, 'what was actually paid for the line, before GST');
  });

  test('a discount on one line overrides the discount on the invoice', () => {
    const p = L.addProduct({ name:'Sacurise 50mg', unitsPerStrip:4, gstRate:5 });
    L.receiveDelivery({ supplierId: 1, discountPct: 4, lines: [
      { productId: p.id, batchNo:'D2604002', expiry: daysOn(450), packs: 14,
        mrpPaise: 23719, costPaise: 18072, discountPct: 10 }] });
    assert.equal(db.get('select cost_paise from batches where batch_no = ?', 'D2604002').cost_paise,
      Math.round(18072 * 0.90));
  });

  test('a nonsense discount is refused rather than quietly ignored', () => {
    const p = L.addProduct({ name:'Rutoheal Tab', unitsPerStrip:10, gstRate:5 });
    const line = { productId: p.id, batchNo:'RD1', expiry: daysOn(400), packs:1, mrpPaise: 11531, costPaise: 8786 };
    assert.throws(() => L.receiveDelivery({ supplierId: 1, discountPct: 150, lines:[line] }), /between 0 and 99/);
    assert.throws(() => L.receiveDelivery({ supplierId: 1, discountPct: -5, lines:[line] }), /between 0 and 99/);
    assert.equal(db.get('select count(*) as n from batches where batch_no = ?', 'RD1').n, 0,
      'a refused invoice must leave no stock behind');
  });

  test('no discount still behaves exactly as before', () => {
    const p = L.addProduct({ name:'Telmikind 20mg', unitsPerStrip:10, gstRate:5 });
    L.receiveDelivery({ supplierId: 1, lines: [
      { productId: p.id, batchNo:'F0AH2005', expiry: daysOn(400), packs: 10, mrpPaise: 26811, costPaise: 20427 }] });
    assert.equal(db.get('select cost_paise from batches where batch_no = ?', 'F0AH2005').cost_paise, 20427);
  });

  test('a whole real distributor invoice adds up to the total printed on it', () => {
    /* Palepu Pharma invoice CB-26-134190, 22/09/2026, entered line for line as
       the shop received it. The paper says: 14 items, 31 packs, sale value
       ₹3931.22, cash discount ₹157.26 at 4%, taxable ₹3773.96. If what the app
       stores does not come to the same taxable figure, either the discount or
       the arithmetic is wrong, and every margin built on it is wrong too. */
    const monthEnd = (y, m) => db.today(new Date(y, m, 0));   // last day of month m
    const INVOICE = [
      // name,                          per pack, batch,       exp,   qty, MRP,    trade
      ['Thyronorm 100mcg Tab 120s',       120, 'TMH26119',  [2028, 5],  2, 16991, 12946],
      ['Sacurise 50mg Tab 4s',              4, 'D2604002',  [2028, 3],  1, 23719, 18072],
      ['Silverex Ionic Gel 10gm',           1, 'RDD0003',   [2028, 1],  1, 11531,  8786],
      ['Rutoheal Tab 10s',                 10, 'F0AH2005',  [2027, 9],  2, 26811, 20427],
      ['Telmikind 20mg Tab 10s',           10, 'I052005',   [2028, 2],  3,  2544,  1938],
      ['Cefolac XL 200mg Tab 10s',         10, '17251240A', [2027, 5],  1, 27172, 20703],
      ['Budamate 200 Transcaps 30s',       30, 'UCO1099',   [2028, 3],  2, 18435, 14046],
      ['Dolopar 250mg 60ml Syp',            1, 'DLPSN083',  [2028, 6],  1,  4280,  3261],
      ['Calcimax 500mg Tab 30s',           30, '25BD82608', [2028, 5],  1, 41600, 31695],
      ['Lipvas 10mg Tab 10s',              10, '6BA1297',   [2028, 5],  3,  5344,  2315],
      ['Dytor Plus 20mg Tab 15s',          15, '6SN1276',   [2028, 5],  1, 14520, 11063],
      ['Fluticone Nasal Spray 12ml',        1, 'AFC1068',   [2028, 4],  1, 54620, 41615],
      ['Pentids 400mg Tab 10s',            10, 'MRL1003',   [2027, 5],  2,  2737,  2085],
      ['Human Mixtard 40iu 10ml Inj',       1, 'B-53371',   [2028, 9], 10, 18270, 14616],
    ];

    const lines = INVOICE.map(([name, per, batchNo, [y, m], packs, mrpPaise, costPaise]) => ({
      productId: L.addProduct({ name, unitsPerStrip: per, gstRate: 5 }).id,
      batchNo, expiry: monthEnd(y, m), packs, mrpPaise, costPaise,
    }));

    const out = L.receiveDelivery({ supplierId: 2, invoiceNo:'CB-26-134190',
      invoiceDate:'2026-09-22', discountPct: 4, lines });

    assert.equal(out.lines, 14, 'the invoice says 14 items');
    const purchase = db.get('select * from purchases where id = ?', out.id);

    // Sale value before the discount, from what was stored.
    const listTotal = db.get(`select sum(list_cost_paise * packs) as t from purchase_items where purchase_id = ?`,
      out.id).t;
    assert.equal(listTotal, 393122, 'sale value should be ₹3931.22');
    assert.equal(purchase.total_paise, 377396, 'taxable amount should be ₹3773.96, after the 4% discount');
    assert.equal(listTotal - purchase.total_paise, 15726, 'the cash discount should be ₹157.26');

    const packsTotal = db.get(`select sum(packs) as n from purchase_items where purchase_id = ?`, out.id).n;
    assert.equal(packsTotal, 31, 'the invoice says 31 packs in total');

    // And GST at 5% on the taxable amount is what the invoice charged.
    assert.equal(Math.round(purchase.total_paise * 0.05), 18870, 'GST ≈ ₹188.70, split CGST/SGST');
  });

  test('the cost shown on the screen is the cost put in the database', () => {
    /* The Add stock screen shows the owner what each pack really cost. That
       figure used to be worked out three different ways — one in the table,
       another in the note beside it, and a third in the database. With a
       discount and free packs together they disagreed badly. This pins the
       screen's formula to the one that actually stores the money. */
    const onScreen = (listCostPaise, packs, freePacks, discountPct) => {
      const bp = Math.round((Number(discountPct) || 0) * 100);
      const linePaise = Math.round(Number(listCostPaise) * packs * (10000 - bp) / 10000);
      return Math.round(linePaise / (packs + (Number(freePacks) || 0)));
    };

    const cases = [
      // listCost, packs, free, discount%
      [12946,  2, 0, 4],       // the Thyronorm line from the real invoice
      [10000, 10, 2, 10],      // discount and free packs together — the case that broke
      [ 9650, 10, 2, 0],       // free packs only
      [ 8786,  1, 0, 0],       // neither
      [ 3333,  7, 1, 7.5],     // a fractional discount, to catch rounding
    ];

    for (const [listCost, packs, free, disc] of cases) {
      const p = L.addProduct({ name:`Costcheck ${listCost}-${packs}-${free}-${disc}`, unitsPerStrip:10, gstRate:5 });
      L.receiveDelivery({ supplierId: 1, discountPct: disc, lines: [{
        productId: p.id, batchNo:`CC${listCost}${packs}${free}`, expiry: daysOn(400),
        packs, freePacks: free, mrpPaise: 99999, costPaise: listCost }] });
      const stored = db.get('select cost_paise from batches where product_id = ?', p.id).cost_paise;
      assert.equal(stored, onScreen(listCost, packs, free, disc),
        `screen and database disagree for ${listCost} × ${packs} (+${free} free) at ${disc}%`);
    }
  });

  test('free packs lower the real cost per pack', () => {
    receive(syrup, 'AS-1', daysOn(300), 10, 12800, 9650, 3 > 2 ? 1 : 1, 2);
    const b = db.get('select * from batches where batch_no = ?', 'AS-1');
    assert.equal(b.qty, 12);                                  // 10 paid + 2 free
    assert.equal(b.cost_paise, Math.round(9650 * 10 / 12));   // what each really cost
  });

  test('stock that has already expired is refused at the door', () => {
    assert.throws(() => receive(dolo, 'OLD-1', daysOn(-2), 5, 3310, 2540), /already expired/i);
  });

  test('cost above MRP is refused — it would lose money on every sale', () => {
    assert.throws(() => receive(dolo, 'BAD-1', daysOn(200), 5, 3310, 9900), /more than the MRP/i);
  });

  test('a counted difference is recorded with a reason', () => {
    const batch = db.get('select * from batches where batch_no = ?', 'DL-A');
    const before = batch.qty;
    L.adjustStock({ batchId: batch.id, delta: -5, reason:'damage', note:'crushed in transit' });
    assert.equal(db.get('select qty from batches where id = ?', batch.id).qty, before - 5);
    assert.throws(() => L.adjustStock({ batchId: batch.id, delta: -1, reason:'damage', note:'' }), /why/i);
  });

  test('stock history cannot be edited or deleted', () => {
    const row = db.get('select * from stock_ledger limit 1');
    assert.throws(() => db.run('update stock_ledger set delta = 999 where id = ?', row.id), /cannot be changed/i);
    assert.throws(() => db.run('delete from stock_ledger where id = ?', row.id), /cannot be deleted/i);
  });

  test('stock can never go below zero', () => {
    const batch = db.get('select * from batches where batch_no = ?', 'DL-A');
    assert.throws(() => L.adjustStock({ batchId: batch.id, delta: -99999, reason:'damage', note:'test' }),
      /Not enough stock/i);
  });
});

// ============================================================ billing

describe('billing', () => {
  test('the money is exact: GST comes out of the MRP, and the bill rounds once', () => {
    const bill = L.createBill({ items:[{ productId: dolo.id, qty: 15 }], payMode:'cash', clientUuid:'t-1' });
    const line = bill.items[0];
    assert.equal(line.gross_paise, 3310);                       // one strip at its MRP
    assert.equal(line.taxable_paise, Math.round(3310 * 100 / 105));
    assert.equal(line.taxable_paise + line.gst_paise, 3310);    // nothing lost in the split
    assert.equal(bill.total_paise, 3300);                       // rounded to the rupee
    assert.equal(bill.total_paise - (bill.taxable_paise + bill.gst_paise), bill.round_paise);
  });

  test('loose tablets are priced from the strip', () => {
    const bill = L.createBill({ items:[{ productId: dolo.id, qty: 4 }], clientUuid:'t-2' });
    assert.equal(bill.items[0].gross_paise, Math.round(3310 * 4 / 15));
  });

  test('selling takes the stock down, and the history explains it', () => {
    const before = L.stockOf(dolo.id);
    const bill = L.createBill({ items:[{ productId: dolo.id, qty: 30 }], clientUuid:'t-3' });
    assert.equal(L.stockOf(dolo.id), before - 30);
    const moves = db.all(`select * from stock_ledger where ref_type='sale' and ref_id=?`, bill.id);
    assert.equal(moves.reduce((s, m) => s + m.delta, 0), -30);
  });

  test('the earliest expiry sells first, across two batches', () => {
    receive(dolo, 'DL-SOON', daysOn(40), 2, 3310, 2540);       // expires sooner, smaller
    const soon = db.get('select * from batches where batch_no = ?', 'DL-SOON');
    const bill = L.createBill({ items:[{ productId: dolo.id, qty: 45 }], clientUuid:'t-4' });
    assert.equal(bill.items.length, 2, 'the quantity is split across two batches');
    assert.equal(bill.items[0].batch_no, 'DL-SOON');
    assert.equal(bill.items[0].qty, 30, 'the soonest batch empties first');
    assert.equal(db.get('select qty from batches where id = ?', soon.id).qty, 0);
  });

  test('an expired batch is never sold, even when it is the only stock', () => {
    const p = L.addProduct({ name:'Test Expired', unitsPerStrip:10 });
    receive(p, 'EXP-1', daysOn(20), 5, 1000, 700);
    const batch = db.get('select * from batches where batch_no = ?', 'EXP-1');
    db.run(`update batches set expiry = ? where id = ?`, daysOn(-1), batch.id);   // time passes
    assert.throws(() => L.createBill({ items:[{ productId: p.id, qty: 5 }], clientUuid:'t-exp' }), /left in stock/i);
    assert.equal(db.get('select qty from batches where id = ?', batch.id).qty, 50, 'stock untouched');
  });

  test('the same bill sent twice is saved once', () => {
    const before = L.stockOf(dolo.id);
    const first = L.createBill({ items:[{ productId: dolo.id, qty: 15 }], clientUuid:'same-uuid' });
    const second = L.createBill({ items:[{ productId: dolo.id, qty: 15 }], clientUuid:'same-uuid' });
    assert.equal(second.bill_no, first.bill_no);
    assert.equal(second.duplicate, true);
    assert.equal(L.stockOf(dolo.id), before - 15, 'stock came down only once');
    assert.equal(db.get('select count(*) as n from sales where client_uuid = ?', 'same-uuid').n, 1);
  });

  test('if any line fails, the whole bill rolls back — no stock moves, no bill', () => {
    const beforeStock = L.stockOf(dolo.id);
    const beforeBills = db.get('select count(*) as n from sales').n;
    assert.throws(() => L.createBill({
      items: [{ productId: dolo.id, qty: 15 }, { productId: syrup.id, qty: 99999 }],
      clientUuid: 't-rollback',
    }), /left in stock/i);
    assert.equal(L.stockOf(dolo.id), beforeStock, 'the good line did not move stock');
    assert.equal(db.get('select count(*) as n from sales').n, beforeBills, 'no bill was written');
    assert.equal(db.get('select count(*) as n from sales where client_uuid = ?', 't-rollback').n, 0);
  });

  test('a Schedule H1 medicine needs the doctor and patient', () => {
    receive(augmentin, 'AG-1', daysOn(300), 5, 22350, 17120, 2);
    assert.throws(() => L.createBill({ items:[{ productId: augmentin.id, qty: 10 }], clientUuid:'t-h1' }),
      /doctor and patient/i);
    const ok = L.createBill({ items:[{ productId: augmentin.id, qty: 10 }], clientUuid:'t-h1b',
      doctorName:'Dr. S. Ramanathan', patientName:'M. Suresh', patientAddress:'Ettimadai' });
    assert.equal(ok.items.length, 1);
  });

  test('a saved bill cannot be edited or deleted', () => {
    const bill = db.get('select * from sales order by id desc limit 1');
    assert.throws(() => db.run('update sales set total_paise = 1 where id = ?', bill.id), /cannot be changed/i);
    assert.throws(() => db.run('delete from sales where id = ?', bill.id), /cannot be deleted/i);
  });

  test('cancelling a bill puts every unit back and leaves the bill on record', () => {
    const before = L.stockOf(dolo.id);
    const bill = L.createBill({ items:[{ productId: dolo.id, qty: 15 }], clientUuid:'t-cancel' });
    assert.equal(L.stockOf(dolo.id), before - 15);
    L.cancelBill(bill.id, 'billed twice by mistake');
    assert.equal(L.stockOf(dolo.id), before, 'stock is back');
    const after = L.billById(bill.id);
    assert.equal(after.is_cancelled, 1);
    assert.equal(after.cancel_reason, 'billed twice by mistake');
    assert.throws(() => L.cancelBill(bill.id, 'again'), /already cancelled/i);
  });
});

// ============================================================ returns

describe('returns', () => {
  test('a return refunds in proportion, puts the stock back, and shows on the day', () => {
    const bill = L.createBill({ items:[{ productId: dolo.id, qty: 30 }], clientUuid:'t-ret' });
    const line = bill.items[0];
    const salesBefore = L.dailyReport(today).sales_paise;
    const stockBefore = L.stockOf(dolo.id);

    const ret = L.createReturn({ saleId: bill.id, items:[{ saleItemId: line.id, qty: 15 }], refundMode:'cash' });
    /* In proportion to what the customer actually paid, not to the gross: the
       bill was rounded on the way out, so it must be rounded on the way back. */
    const saved = db.get('select * from sales where id = ?', bill.id);
    const paidRatio = saved.total_paise / (saved.taxable_paise + saved.gst_paise);
    assert.equal(ret.refund_paise, Math.round(line.gross_paise * 15 / 30 * paidRatio));
    assert.ok(ret.refund_paise <= saved.total_paise, 'never more than was taken');
    assert.equal(L.stockOf(dolo.id), stockBefore + 15);
    assert.equal(L.dailyReport(today).sales_paise, salesBefore - ret.refund_paise);
  });

  test('more cannot be given back than was sold', () => {
    const bill = db.get('select * from sales where client_uuid = ?', 't-ret');
    const line = db.get('select * from sale_items where sale_id = ?', bill.id);
    /* Refused before it reaches the database, so the counter gets a sentence
       that says how many are actually left rather than a bare abort. */
    assert.throws(() => L.createReturn({ saleId: bill.id, items:[{ saleItemId: line.id, qty: 999 }] }),
      /already came back|can still be returned|returned in full/i);
  });

  test('a second return cannot take back more than what is left', () => {
    // The screen shows a free-text quantity box, so this has to hold on its own.
    const p = L.addProduct({ name:'Return Guard Tab', unitsPerStrip:10, gstRate:5 });
    receive(p, 'RG-1', daysOn(300), 5, 2000, 1400);
    const bill = L.createBill({ items:[{ productId: p.id, qty: 10 }], clientUuid:'ret-guard' });
    const line = db.get('select * from sale_items where sale_id = ?', bill.id);

    L.createReturn({ saleId: bill.id, items:[{ saleItemId: line.id, qty: 6 }] });
    assert.throws(() => L.createReturn({ saleId: bill.id, items:[{ saleItemId: line.id, qty: 6 }] }),
      /Only 4 of that line/i);
    L.createReturn({ saleId: bill.id, items:[{ saleItemId: line.id, qty: 4 }] });
    assert.throws(() => L.createReturn({ saleId: bill.id, items:[{ saleItemId: line.id, qty: 1 }] }),
      /returned in full/i);
  });

  test('returning a whole bill gives back exactly what was paid', () => {
    /* The bill's gross is before the round-off; the customer handed over the
       rounded total. Refunding the gross would quietly shortchange the till on
       every fully returned bill. */
    const p = L.addProduct({ name:'Roundoff Return Tab', unitsPerStrip:10, gstRate:5 });
    receive(p, 'RR-1', daysOn(300), 5, 1540, 1000);
    const bill = L.createBill({ items:[{ productId: p.id, qty: 10 }], clientUuid:'ret-round' });
    const saved = db.get('select * from sales where id = ?', bill.id);
    assert.notEqual(saved.round_paise, 0, 'this bill must actually be rounded, or it proves nothing');

    const line = db.get('select * from sale_items where sale_id = ?', bill.id);
    const out = L.createReturn({ saleId: bill.id, items:[{ saleItemId: line.id, qty: line.qty }] });
    assert.equal(out.refund_paise, saved.total_paise,
      'the credit note must equal the invoice the customer was given');
  });

  test('a credit note cannot be edited', () => {
    const cn = db.get('select * from sale_returns order by id desc limit 1');
    assert.throws(() => db.run('update sale_returns set reason = ? where id = ?', 'x', cn.id), /cannot be changed/i);
  });
});

// ============================================================ prices and the catalogue

describe('medicines', () => {
  test('the same medicine cannot be added twice under the same name', () => {
    /* The damage is quiet: the stock splits between the two, so the counter
       shows one name twice and neither half ever looks low enough to reorder. */
    assert.throws(() => L.addProduct({ name:'Dolo 650' }), /already in the list/i);
    // A person reads these as the same name, so the app must too.
    assert.throws(() => L.addProduct({ name:'  dolo 650 ' }), /already in the list/i);
    assert.throws(() => L.addProduct({ name:'DOLO 650' }), /already in the list/i);
    assert.throws(() => L.addProduct({ name:'Dolo  650' }), /already in the list/i,
      'a stray double space is exactly how a duplicate gets typed');
    assert.equal(db.get(`select count(*) as n from products where lower(trim(name)) = 'dolo 650'`).n, 1);
  });

  test('a different medicine with a similar name is still allowed', () => {
    const p = L.addProduct({ name:'Dolo 650 DS', unitsPerStrip:10, gstRate:5 });
    assert.ok(p.id, 'a genuinely different medicine must not be blocked');
    L.archiveProduct(p.id);
  });

  test('renaming one medicine onto another is refused', () => {
    assert.throws(() => L.updateProduct(augmentin.id, { name:'Dolo 650' }), /cannot share a name/i);
    assert.equal(L.productById(augmentin.id).name, 'Augmentin 625', 'the rename must not have half-happened');
  });

  test('the database refuses a duplicate even if the screens are bypassed', () => {
    // The rule lives in the database too, so an import or a future screen
    // cannot quietly reintroduce the problem.
    assert.throws(() => db.run(`insert into products (name, base_unit, units_per_strip) values (' DOLO 650 ', 'tablet', 1)`),
      /unique/i);
  });

  test('the figures check notices two medicines sharing a name', () => {
    assert.equal(L.integrityCheck().duplicates.length, 0);
    assert.equal(L.integrityCheck().ok, true);
  });

  test('a medicine added by mistake can be deleted outright', () => {
    const p = L.addProduct({ name:'Typo Medicine', unitsPerStrip:10, gstRate:5 });
    assert.equal(L.removeProduct(p.id).deleted, true);
    assert.equal(L.productById(p.id), undefined);
    // and the name is free again, so the correction can be typed properly
    assert.ok(L.addProduct({ name:'Typo Medicine', unitsPerStrip:10, gstRate:5 }).id);
  });

  test('a medicine that has ever been stocked or sold refuses to be deleted', () => {
    /* Deleting it would leave saved bills pointing at nothing. The law needs
       those readable for years, so archiving is the only way out. */
    assert.throws(() => L.removeProduct(dolo.id), /cannot be deleted/i);
    assert.ok(L.productById(dolo.id), 'it must still be there after the refusal');
    assert.throws(() => L.removeProduct(dolo.id), /Archive this medicine/i);
  });

  test('a wrongly linked scanned code can be taken off', () => {
    const p = L.addProduct({ name:'Codecheck Tab', unitsPerStrip:10, gstRate:5 });
    db.run('insert into product_codes (product_id, code) values (?, ?)', p.id, '8901234567890');
    const [code] = L.codesFor(p.id);
    assert.equal(code.code, '8901234567890');

    L.removeCode(code.id);
    assert.equal(L.codesFor(p.id).length, 0);
    // and it may now be learned against the right medicine
    db.run('insert into product_codes (product_id, code) values (?, ?)', dolo.id, '8901234567890');
    assert.equal(db.get('select product_id from product_codes where code = ?', '8901234567890').product_id, dolo.id);
  });

  test('a distributor never used is deleted; one with deliveries is only hidden', () => {
    db.run(`insert into suppliers (name) values ('Typed By Mistake')`);
    const unused = db.get('select id from suppliers where name = ?', 'Typed By Mistake').id;
    assert.equal(L.removeSupplier(unused).deleted, true);
    assert.equal(db.get('select count(*) as n from suppliers where id = ?', unused).n, 0);

    // Supplier 1 has deliveries from the tests above.
    const used = L.removeSupplier(1);
    assert.equal(used.deleted, false, 'deleting it would orphan the deliveries');
    assert.equal(db.get('select is_active from suppliers where id = ?', 1).is_active, 0,
      'it should be off the list but still on record');
    assert.match(used.message, /deliveries on record/i);
    db.run('update suppliers set is_active = 1 where id = ?', 1);   // put it back for later tests
  });

  test('a distributor typed wrongly can be corrected', () => {
    db.run(`insert into suppliers (name, phone) values ('Vinayaga Agences', '99999')`);
    const id = db.get('select id from suppliers where name = ?', 'Vinayaga Agences').id;

    const out = L.updateSupplier(id, { name:'Vinayaga Agencies', phone:'9876543210', leadDays: 2 });
    assert.equal(out.supplier.name, 'Vinayaga Agencies');
    assert.equal(out.supplier.phone, '9876543210');
    assert.equal(out.supplier.lead_days, 2);
    assert.deepEqual(Object.keys(out.changed).sort(), ['leadDays', 'name', 'phone']);

    // and it cannot be renamed onto another distributor
    assert.throws(() => L.updateSupplier(id, { name:'Sakthi Pharma' }), /already in the list/i);
    assert.equal(L.updateSupplier(id, { name:'Vinayaga Agencies' }).changed.name, undefined,
      'saving the same name again is not a change');
    db.run('delete from suppliers where id = ?', id);
  });

  test('past deliveries can be looked at again, line by line', () => {
    /* A delivery used to be enterable but never viewable, so there was no way
       to check what a distributor actually sent, or what an invoice came to. */
    const p = L.addProduct({ name:'Delivery View Tab', unitsPerStrip:10, gstRate:5 });
    const out = L.receiveDelivery({ supplierId: 1, invoiceNo:'CB-26-999', discountPct: 4, lines: [
      { productId: p.id, batchNo:'DV1', expiry: daysOn(400), packs: 10, freePacks: 2,
        mrpPaise: 5000, costPaise: 3000 }] });

    const listed = L.recentDeliveries().find(d => d.id === out.id);
    assert.ok(listed, 'the delivery should appear in the list');
    assert.equal(listed.invoice_no, 'CB-26-999');
    assert.equal(listed.lines, 1);
    assert.equal(listed.supplier, 'Sakthi Pharma');

    const { purchase, items } = L.deliveryById(out.id);
    assert.equal(purchase.discount_bp, 400);
    assert.equal(items[0].name, 'Delivery View Tab');
    assert.equal(items[0].batch_no, 'DV1');
    assert.equal(items[0].packs, 10);
    assert.equal(items[0].free_packs, 2);
    assert.equal(items[0].list_cost_paise, 3000, 'the printed trade price is kept for checking');
    assert.equal(items[0].line_paise, Math.round(3000 * 10 * 0.96), 'what was actually paid');
    assert.throws(() => L.deliveryById(999999), /No such delivery/i);
  });

  test('a price correction is kept in the history, and old bills keep their price', () => {
    const batch = db.get('select * from batches where batch_no = ?', 'DL-A');
    const soldBefore = db.get(`select mrp_paise from sale_items where batch_id = ? order by id limit 1`, batch.id);
    L.setBatchPrice({ batchId: batch.id, mrpPaise: 3500, costPaise: null, reason:'Company changed the MRP' });
    assert.equal(db.get('select mrp_paise from batches where id = ?', batch.id).mrp_paise, 3500);
    assert.equal(db.get(`select mrp_paise from sale_items where batch_id = ? order by id limit 1`, batch.id).mrp_paise,
      soldBefore.mrp_paise, 'the old bill is untouched');
    const history = L.productHistory(dolo.id).prices;
    assert.equal(history[0].new_mrp_paise, 3500);
    assert.match(history[0].reason, /Company changed/);
  });

  test('a cost above MRP, or no reason, is refused', () => {
    const batch = db.get('select * from batches where batch_no = ?', 'DL-A');
    assert.throws(() => L.setBatchPrice({ batchId: batch.id, costPaise: 999999, reason:'typo' }), /more than the MRP/i);
    assert.throws(() => L.setBatchPrice({ batchId: batch.id, mrpPaise: 3600, reason:'' }), /why/i);
  });

  test('details can be changed, and every change is written down', () => {
    const { changed } = L.updateProduct(dolo.id, { rack:'A-2', reorderPacks:8 });
    assert.equal(changed.rack.to, 'A-2');
    assert.equal(L.productById(dolo.id).rack, 'A-2');
    const audit = db.get(`select * from audit_log where entity='product' and entity_id=? order by id desc`, dolo.id);
    assert.match(audit.detail, /A-2/);
  });

  test('the strip size is locked while there is stock', () => {
    assert.throws(() => L.updateProduct(dolo.id, { unitsPerStrip: 10 }), /stock on hand/i);
  });

  test('a medicine with stock cannot be archived; one without can, and can come back', () => {
    assert.throws(() => L.archiveProduct(dolo.id), /still has stock/i);
    const spare = L.addProduct({ name:'Test Spare', unitsPerStrip:1 });
    assert.equal(L.archiveProduct(spare.id).is_active, 0);
    assert.equal(L.archiveProduct(spare.id, false).is_active, 1);
  });

  test('a medicine that appears on a bill can never be deleted', () => {
    assert.throws(() => db.run('delete from products where id = ?', dolo.id), /only be archived/i);
  });
});

// ============================================================ reports

describe('reports', () => {
  test('the day adds up to its own bills', () => {
    const r = L.dailyReport(today);
    const bills = db.get(`select coalesce(sum(total_paise),0) as t, count(*) as n
                            from sales where business_date = ? and is_cancelled = 0`, today);
    const refunds = db.get(`select coalesce(sum(ri.refund_paise),0) as t from sale_returns r
                              join sale_return_items ri on ri.return_id = r.id where r.business_date = ?`, today);
    assert.equal(r.bills, bills.n);
    assert.equal(r.sales_paise, bills.t - refunds.t);
    assert.equal(r.average_bill_paise, Math.round(bills.t / bills.n));
  });

  test('cancelled bills are left out of the takings', () => {
    const cancelled = db.get(`select * from sales where is_cancelled = 1 order by id desc limit 1`);
    assert.ok(cancelled, 'there is a cancelled bill to check');
    const r = L.dailyReport(cancelled.business_date);
    const counted = db.get(`select count(*) as n from sales where business_date = ? and is_cancelled = 0`,
                           cancelled.business_date).n;
    assert.equal(r.bills, counted);
  });

  test('profit leaves GST out on both sides', () => {
    const r = L.dailyReport(today);
    assert.equal(r.profit_paise, r.taxable_paise - r.cost_paise);
    assert.ok(r.profit_paise < r.sales_paise, 'profit is not confused with sales');
  });

  test('a range is exactly the sum of its days', () => {
    const from = daysOn(-3), to = today;
    const range = L.rangeReport(from, to);
    let sales = 0, profit = 0, bills = 0;
    for (let d = new Date(from); db.today(d) <= to; d.setDate(d.getDate() + 1)) {
      const day = L.dailyReport(db.today(d));
      sales += day.sales_paise; profit += day.profit_paise; bills += day.bills;
    }
    assert.equal(range.sales_paise, sales);
    assert.equal(range.profit_paise, profit);
    assert.equal(range.bills, bills);
  });

  test('payment-wise adds back to the same total', () => {
    const p = L.paymentReport(daysOn(-3), today);
    const sum = p.modes.reduce((s, m) => s + m.total_paise, 0);
    assert.equal(sum, p.total_paise);
    assert.equal(p.total_paise, db.get(`select coalesce(sum(total_paise),0) as t from sales
      where business_date between ? and ? and is_cancelled = 0`, daysOn(-3), today).t);
  });

  test('stock on hand is valued at what was paid for it', () => {
    const inv = L.inventoryReport();
    const byHand = db.all(`select b.qty, b.cost_paise, p.units_per_strip from batches b
                             join products p on p.id = b.product_id`)
      .reduce((s, b) => s + Math.trunc(b.qty * b.cost_paise / b.units_per_strip), 0);
    assert.equal(inv.total_value_paise, byHand);
    assert.ok(inv.rows.length >= 3);
  });

  test('low stock lists only what is at or below its reminder level', () => {
    const low = L.lowStockReport();
    for (const row of low.rows) assert.ok(row.packs <= row.reorder_packs, `${row.name} should not be listed`);
    const dolo_row = db.get('select * from v_stock where product_id = ?', dolo.id);
    if (dolo_row.packs <= dolo_row.reorder_packs)
      assert.ok(low.rows.some(r => r.product_id === dolo.id), 'Dolo is below its level and should be listed');
  });

  test('the expiry report sorts every batch into the right window', () => {
    receive(dolo, 'DL-30', daysOn(20), 2, 3310, 2540);
    receive(dolo, 'DL-120', daysOn(120), 2, 3310, 2540, 1);
    const r = L.expiryReport(365);
    assert.ok(r.buckets['0-30'].rows.some(x => x.batch_no === 'DL-30'));
    assert.ok(r.buckets['91-180'].rows.some(x => x.batch_no === 'DL-120'));
    // Sakthi takes returns up to 3 months before expiry, so a 120-day batch can go back.
    assert.ok(r.returnable.rows.some(x => x.batch_no === 'DL-120'), 'should still be returnable');
    for (const row of r.buckets['0-30'].rows) assert.ok(row.days_left <= 30 && row.days_left >= 0);
  });

  test('the stock figures always match the stock history', () => {
    const check = L.integrityCheck();
    assert.equal(check.ok, true, JSON.stringify(check.drift));
  });
});

// ============================================================ excel

describe('excel export', () => {
  const python = spawnSync('python3', ['-c', 'import openpyxl'], { encoding:'utf8' }).status === 0;

  test('a sales workbook is produced, and a spreadsheet reader opens it', { skip: !python ? 'no spreadsheet reader here' : false }, () => {
    const report = L.rangeReport(daysOn(-3), today);
    const bills = db.all('select * from sales order by id');
    const lines = db.all(`select s.bill_no, s.business_date, p.name, b.batch_no, b.expiry, si.qty,
                                 si.mrp_paise, si.gross_paise, si.gst_rate
                            from sale_items si join sales s on s.id = si.sale_id
                            join products p on p.id = si.product_id join batches b on b.id = si.batch_id`);
    const file = join(work, 'sales.xlsx');
    writeFileSync(file, X.salesWorkbook(report, L.settings(), bills, lines));
    assert.ok(readFileSync(file).length > 3000, 'the file has real content');

    const out = spawnSync('python3', ['-c', `
import openpyxl, json, warnings
warnings.simplefilter('error')
wb = openpyxl.load_workbook(${JSON.stringify(file)})
ws = wb['Day by day']
rows = [[c for c in r] for r in ws.iter_rows(values_only=True)]
total = [r for r in rows if r[0] == 'Total'][0]
print(json.dumps({'sheets': wb.sheetnames, 'total_sales': total[2], 'rows': len(rows)}))`], { encoding:'utf8' });
    assert.equal(out.status, 0, out.stderr);
    const got = JSON.parse(out.stdout);
    assert.deepEqual(got.sheets, ['Summary', 'Day by day', 'Medicines', 'Bills', 'Bill lines']);
    assert.equal(Math.round(got.total_sales * 100), report.sales_paise, 'the workbook total matches the report');
  });

  test('stock, low-stock and expiry workbooks are produced', () => {
    for (const [name, buf] of [
      ['inventory', X.inventoryWorkbook(L.inventoryReport(), L.settings())],
      ['low', X.lowStockWorkbook(L.lowStockReport(), L.settings())],
      ['expiry', X.expiryWorkbook(L.expiryReport(180), L.settings())],
    ]) {
      assert.ok(buf.length > 1200, `${name} workbook looks empty`);
      assert.equal(buf.subarray(0, 2).toString(), 'PK', `${name} is not a zip`);
    }
  });
});

// ============================================================ the computer restarting

describe('restarting and backups', () => {
  test('everything is still there after the app closes and opens again', () => {
    const before = { bills: db.get('select count(*) as n from sales').n, stock: L.stockOf(dolo.id) };
    db.close();
    db.open();
    assert.equal(db.get('select count(*) as n from sales').n, before.bills);
    assert.equal(L.stockOf(dolo.id), before.stock);
    assert.equal(L.integrityCheck().ok, true);
  });

  test('a backup can be taken, and restoring it brings that moment back', () => {
    const { file } = db.backup('test');
    assert.ok(existsSync(file));
    const billsAtBackup = db.get('select count(*) as n from sales').n;

    L.createBill({ items:[{ productId: dolo.id, qty: 15 }], clientUuid:'after-backup' });
    assert.equal(db.get('select count(*) as n from sales').n, billsAtBackup + 1);

    db.restore(file.split('/').pop());
    assert.equal(db.get('select count(*) as n from sales').n, billsAtBackup, 'the later bill is gone');
    assert.equal(db.get('select count(*) as n from sales where client_uuid = ?', 'after-backup').n, 0);
    assert.equal(L.integrityCheck().ok, true, 'the restored file is consistent');
  });

  test('a file that is not a backup of this shop is refused', () => {
    const junk = join(process.env.SNM_BACKUPS, 'not-a-backup.db');
    writeFileSync(junk, 'hello');
    assert.throws(() => db.restore('not-a-backup.db'), /not a Sri Nachiya backup|file is not a database/i);
  });
});
