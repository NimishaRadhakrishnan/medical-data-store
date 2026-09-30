/**
 * The things that went wrong when the app was poked hard.
 *
 * Every test here was a real defect found in a pre-production review, most of
 * them reachable by a shopkeeper with a number pad and a busy counter. They
 * are kept as tests so they cannot come back.
 *
 *   npm run test:app
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'apps', 'shop');

const work = mkdtempSync(join(tmpdir(), 'snm-robust-'));
process.env.SNM_DB = join(work, 'shop.db');
process.env.SNM_BACKUPS = join(work, 'backups');

const db = await import('../../apps/shop/db.js');
const L = await import('../../apps/shop/logic.js');
const { createApp } = await import('../../apps/shop/server.js');

const soon = () => db.today(new Date(Date.now() + 400 * 86400000));
let server, base, med;

const call = async (path, body) => {
  const res = await fetch(base + path, body === undefined ? {}
    : { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

before(async () => {
  db.open();
  db.run(`insert into shop_settings (id, name, address1, address2)
          values (1, 'Sri Nachiya Medicals', '5/168, Palaghad Main Road', 'Ettimadai')`);
  L.addSupplier({ name: 'Palepu Pharma' });
  med = L.addProduct({ name:'Dolo 650', unitsPerStrip:15, gstRate:5 });
  L.receiveDelivery({ supplierId:1, invoiceNo:'INV-1', lines:[{ productId: med.id, batchNo:'D1',
    expiry: soon(), packs:10, mrpPaise:3310, costPaise:2540 }] });

  server = createApp();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server?.close(); db.close(); rmSync(work, { recursive:true, force:true }); });

describe('a slip on the number pad cannot break the shop', () => {
  test('an absurd quantity is refused, and everything still works afterwards', async () => {
    /* This was the worst bug found. SQLite stores a 64-bit integer happily,
       but Node cannot read one back above 2^53, and the error arrived where
       nothing expected it. One extra row of zeros in "Free strips" used to
       leave every screen in the shop answering "something went wrong" —
       including "Check the figures", which cheerfully reported all was well.
       The only way back was a restore, losing the day's bills. */
    const r = await call('/api/delivery', { supplierId:1, invoiceNo:'INV-BIG', lines:[{
      productId: med.id, batchNo:'BIG', expiry: soon(), packs:1,
      freePacks: 1_000_000_000_000_000, mrpPaise:3310, costPaise:2540 }] });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /too large/i);

    // The shop must be exactly as it was.
    assert.equal((await call('/api/search?q=dolo')).status, 200);
    assert.equal((await call('/api/reports/inventory')).status, 200);
    assert.equal((await call(`/api/product?id=${med.id}`)).status, 200);
    assert.equal(L.integrityCheck().ok, true);
    assert.equal(db.get(`select count(*) as n from batches where batch_no = ?`, 'BIG').n, 0);
  });

  test('every doorway to that is closed', () => {
    const line = { productId: med.id, batchNo:'X', expiry: soon(), mrpPaise:3310, costPaise:2540 };
    for (const bad of [
      { ...line, packs: 1e15 },
      { ...line, packs: 1, freePacks: 1e15 },
      { ...line, packs: 1e12, mrpPaise: 1e12 },
      { ...line, packs: 1, costPaise: 1e15 },
    ]) {
      assert.throws(() => L.receiveDelivery({ supplierId:1, lines:[bad] }), /too large|too large/i);
    }
    assert.equal(db.get('select count(*) as n from batches').n, 1, 'and none of them left anything behind');
  });

  test('letters typed into a number box are answered, not crashed on', async () => {
    for (const [path, payload, expect] of [
      ['/api/supplier', { name:'Junk Co', leadDays:'abc' }, /must be a number/i],
      ['/api/product', { name:'Junk Tab', reorderPacks:'abc' }, /must be a number/i],
      ['/api/product', { name:'Junk Tab 2', unitsPerStrip:'abc' }, /must be a number/i],
    ]) {
      const r = await call(path, payload);
      assert.equal(r.status, 400, `${path} should answer, not crash`);
      assert.match(r.body.error, expect);
      assert.equal(r.body.code, 'invalid');
    }
  });
});

describe('the screens and the server agree', () => {
  test('every address the screens call actually exists, with the right method', async () => {
    /* The "Lock now" button shipped sending GET to a POST-only route: it
       404'd, the shop never locked, and nothing said so. A spelling mistake
       between the two files is invisible until someone presses the button. */
    const app = readFileSync(join(APP, 'public', 'app.js'), 'utf8');

    const called = new Map();          // path -> needs a POST?
    // api('/api/x')  and  api('/api/x', body)  — a body means POST
    for (const m of app.matchAll(/\b(?:rawApi|api)\(\s*[`'"]([^`'"]*\/api\/[^`'"?]*)[^`'"]*[`'"]\s*(,)?/g)) {
      const path = m[1].replace(/\$\{[^}]*\}/g, '').replace(/\/$/, '');
      called.set(path, called.get(path) || Boolean(m[2]));
    }
    assert.ok(called.size > 15, `only found ${called.size} calls — the scan is not working`);

    const missing = [];
    for (const [path, isPost] of called) {
      const res = isPost
        ? await fetch(base + path, { method:'POST', headers:{ 'content-type':'application/json' }, body:'{}' })
        : await fetch(base + path);
      // 400 is fine: the route exists and refused the empty body. 404 is not.
      if (res.status === 404) missing.push(`${isPost ? 'POST' : 'GET'} ${path}`);
      await res.arrayBuffer();
    }
    assert.deepEqual(missing, [], 'the screens call addresses the server does not answer');
  });
});

describe('the counter is told what is wrong, in words', () => {
  test('a duplicate distributor name says so', async () => {
    const r = await call('/api/supplier', { name:'Palepu Pharma' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /already in the list/i);
  });

  test('the same invoice cannot be entered twice', async () => {
    const before = L.stockOf(med.id);
    const r = await call('/api/delivery', { supplierId:1, invoiceNo:'INV-1', lines:[{
      productId: med.id, batchNo:'D1', expiry: soon(), packs:10, mrpPaise:3310, costPaise:2540 }] });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /already entered/i);
    assert.equal(L.stockOf(med.id), before, 'the stock must not have doubled');
  });

  test('a database refusal arrives as its own sentence', async () => {
    const r = await call('/api/bill', { items:[{ productId: med.id, qty: 999999 }], clientUuid:'over' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /left in stock/i);
    assert.doesNotMatch(r.body.error, /went wrong/i);
  });
});

describe('stock cannot go somewhere it can never be found', () => {
  test('an archived medicine refuses a delivery', () => {
    const p = L.addProduct({ name:'Archived Tab', unitsPerStrip:10, gstRate:5 });
    L.archiveProduct(p.id);
    assert.throws(() => L.receiveDelivery({ supplierId:1, invoiceNo:'INV-ARC', lines:[{
      productId: p.id, batchNo:'A1', expiry: soon(), packs:5, mrpPaise:2000, costPaise:1500 }] }),
      /archived/i);
    assert.equal(L.stockOf(p.id), 0, 'no invisible stock may exist');
  });

  test('a medicine the app logged a stockout against can still be deleted', () => {
    /* The app writes that row itself when a customer asks for something out of
       stock, so this used to make a mistyped name permanent. */
    const p = L.addProduct({ name:'Stockout Tab', unitsPerStrip:10, gstRate:5 });
    L.logStockout('stockout tab', p.id);
    assert.equal(L.removeProduct(p.id).deleted, true);
    assert.equal(L.productById(p.id), undefined);
    assert.ok(db.get(`select 1 as n from stockout_log where search_term = ?`, 'stockout tab'),
      'the note of what was asked for is still worth keeping');
  });
});

describe('a closed day stays closed', () => {
  test('correcting a strip size does not move yesterday\'s profit', () => {
    /* Reports used to divide the snapshotted per-pack cost by the product's
       *current* pack size, so fixing a strip size typed wrongly rewrote the
       profit of days already counted and reported. */
    const p = L.addProduct({ name:'Packsize Tab', unitsPerStrip:10, gstRate:5 });
    L.receiveDelivery({ supplierId:1, invoiceNo:'INV-PS', lines:[{ productId: p.id, batchNo:'PS1',
      expiry: soon(), packs:10, mrpPaise:5000, costPaise:3000 }] });
    L.createBill({ items:[{ productId: p.id, qty: 20 }], clientUuid:'packsize' });

    const day = db.today();
    const before = L.dailyReport(day);

    // Sell out, then correct the pack size — which the app only allows at zero stock.
    const batch = db.get('select * from batches where batch_no = ?', 'PS1');
    L.adjustStock({ batchId: batch.id, delta: -batch.qty, reason:'damage', note:'clearing for the test' });
    L.updateProduct(p.id, { unitsPerStrip: 5 });

    const after = L.dailyReport(day);
    assert.equal(after.cost_paise, before.cost_paise, 'the day\'s cost must not have moved');
    assert.equal(after.profit_paise, before.profit_paise, 'nor its profit');
  });
});

describe('backups', () => {
  test('two in the same second both succeed', () => {
    const a = db.backup('manual');
    const b = db.backup('manual');
    assert.notEqual(a.file, b.file, 'the second must not collide with the first');
    assert.ok(a.size > 0 && b.size > 0);
  });

  test('old ones are actually deleted, not just counted', () => {
    // The folder used to grow for ever: prune reported a number and removed nothing.
    for (let i = 0; i < 8; i++) {
      writeFileSync(join(work, 'backups', `shop-2026-09-0${i}-00-00-00-auto.db`), 'x');
    }
    const before = readdirSync(join(work, 'backups')).filter(f => f.endsWith('.db')).length;
    assert.ok(before >= 8);

    const deleted = db.pruneBackups(3);
    const after = readdirSync(join(work, 'backups')).filter(f => f.endsWith('.db')).length;
    assert.equal(after, 3, 'exactly the newest three should remain');
    assert.equal(deleted, before - 3, 'and the count should match what went');
  });
});

describe('refunds', () => {
  test('a card refund comes off the card column, not only cash', async () => {
    /* Only cash was netted, so a UPI or card refund left the four payment
       figures adding up to more than the day's takings. */
    const p = L.addProduct({ name:'Refund Mode Tab', unitsPerStrip:10, gstRate:5 });
    L.receiveDelivery({ supplierId:1, invoiceNo:'INV-RM', lines:[{ productId: p.id, batchNo:'RM1',
      expiry: soon(), packs:5, mrpPaise:2000, costPaise:1200 }] });
    const bill = L.createBill({ items:[{ productId: p.id, qty: 10 }], payMode:'card', clientUuid:'rm' });
    const line = db.get('select * from sale_items where sale_id = ?', bill.id);

    const day = db.today();
    const before = L.dailyReport(day);
    L.createReturn({ saleId: bill.id, items:[{ saleItemId: line.id, qty: line.qty }], refundMode:'card' });
    const after = L.dailyReport(day);

    assert.equal(after.card_paise, before.card_paise - bill.total_paise,
      'the refund must come off the card figure');
    const modes = after.cash_paise + after.upi_paise + after.card_paise + after.credit_paise;
    assert.equal(modes, after.sales_paise, 'the four payment figures must add up to the takings');
  });
});
