/**
 * The printed stock labels: the code on the sticker, the sheet it prints on,
 * and what happens when one is scanned at the counter.
 *
 *   npm run test:app
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const work = mkdtempSync(join(tmpdir(), 'snm-labels-'));
process.env.SNM_DB = join(work, 'shop.db');
process.env.SNM_BACKUPS = join(work, 'backups');

const db = await import('../../apps/shop/db.js');
const L = await import('../../apps/shop/logic.js');
const { labelSheet } = await import('../../apps/shop/labels.js');
const { createApp } = await import('../../apps/shop/server.js');

const inDays = n => db.today(new Date(Date.now() + n * 86400000));
let server, base, dolo, oldBatch, newBatch, purchaseId;

before(async () => {
  db.open();
  db.run(`insert into shop_settings (id, name, address1, address2)
          values (1, 'Sri Nachiya Medicals', 'Ettimadai Pirivu', 'Coimbatore 641112')`);
  db.run(`insert into suppliers (name) values ('Sakthi Pharma')`);
  dolo = L.addProduct({ name: 'Dolo 650', unitsPerStrip: 15, gstRate: 5 });

  // Two batches, deliberately in the wrong order: the newer one is received
  // first, so "first expiry first out" and "the one scanned" differ.
  const p = L.receiveDelivery({ supplierId: 1, lines: [
    { productId: dolo.id, batchNo: 'NEW1', expiry: inDays(600), packs: 4, mrpPaise: 3310, costPaise: 2540 },
    { productId: dolo.id, batchNo: 'OLD1', expiry: inDays(120), packs: 4, mrpPaise: 3100, costPaise: 2400 },
  ] });
  purchaseId = p.id;
  const batches = L.batchesOf(dolo.id);
  oldBatch = batches.find(b => b.batch_no === 'OLD1');
  newBatch = batches.find(b => b.batch_no === 'NEW1');

  server = createApp();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server?.close(); db.close(); rmSync(work, { recursive: true, force: true }); });

describe('the code on a label', () => {
  test('names one batch and reads back to it', () => {
    const code = L.batchCode(oldBatch.id);
    assert.match(code, /^SNM-B\d+-[0-9A-Z]$/);
    const back = L.batchByCode(code);
    assert.equal(back.id, oldBatch.id);
    assert.equal(back.batch_no, 'OLD1');
    assert.equal(back.name, 'Dolo 650');
  });

  test('uses only characters that keep the code small', () => {
    const allowed = /^[0-9A-Z $%*+\-./:]+$/;
    for (const id of [1, 9, 10, 99, 100, 4321]) assert.match(L.batchCode(id), allowed);
  });

  test('a damaged or mistyped code is refused, never guessed at', () => {
    const code = L.batchCode(oldBatch.id);
    const wrongCheck = code.slice(0, -1) + (code.slice(-1) === 'A' ? 'B' : 'A');
    assert.equal(L.batchByCode(wrongCheck), null, 'a bad check character must not resolve');
    assert.equal(L.batchByCode('SNM-B999999-0'), null, 'an unknown batch resolves to nothing');
    for (const junk of ['', 'hello', '8901234567890', 'SNM-B', 'SNM-BX-1', null]) {
      assert.ok(!L.batchByCode(junk), `${junk} should not resolve`);
    }
  });

  test('a swapped pair of digits does not land on another batch', () => {
    // 12 and 21 must not share a check character, or a misread sells the wrong stock.
    let clashes = 0;
    for (let a = 10; a < 400; a++) {
      const s = String(a), swapped = s.length > 1 ? s[1] + s[0] + s.slice(2) : s;
      if (swapped !== s && Number(swapped) !== a
          && L.batchCode(a).slice(-1) === L.batchCode(Number(swapped)).slice(-1)
          && String(Number(swapped)) === swapped) clashes++;
    }
    assert.equal(clashes, 0, 'swapped digits must change the check character');
  });

  test('the code is case-insensitive and tolerates spaces around it', () => {
    const code = L.batchCode(newBatch.id);
    assert.equal(L.batchByCode(`  ${code.toLowerCase()} `).id, newBatch.id);
  });
});

describe('the label sheet', () => {
  test('prints one sticker per batch, with what the shelf needs', () => {
    const rows = L.labelData({ batchIds: [oldBatch.id, newBatch.id] });
    assert.equal(rows.length, 2);
    const html = labelSheet(rows, { shopName: 'Sri Nachiya Medicals' });
    assert.equal(html.match(/class="label"/g).length, 2);
    assert.ok(html.includes('Dolo 650'));
    assert.ok(html.includes('OLD1') && html.includes('NEW1'));
    assert.ok(html.includes('₹33.10'), 'the MRP must be on the sticker');
    assert.equal(html.match(/<svg /g).length, 2, 'each sticker carries its own QR');
    assert.ok(html.includes(L.batchCode(oldBatch.id)), 'the code is printed as text too, for a torn label');
  });

  test('every batch of one delivery can be printed at once', () => {
    const rows = L.labelData({ purchaseId });
    assert.deepEqual(rows.map(r => r.batch_no).sort(), ['NEW1', 'OLD1']);
  });

  test('copies repeat the sticker, within reason', () => {
    const rows = L.labelData({ batchIds: [oldBatch.id] });
    assert.equal(labelSheet(rows, { copies: 8 }).match(/class="label"/g).length, 8);
    assert.equal(labelSheet(rows, { copies: 9999 }).match(/class="label"/g).length, 50, 'capped');
    assert.equal(labelSheet(rows, { copies: 0 }).match(/class="label"/g).length, 1, 'never zero');
  });

  test('a shop name with an & or a < cannot break the page', () => {
    const rows = L.labelData({ batchIds: [oldBatch.id] });
    const html = labelSheet(rows, { shopName: 'Ram & Co <script>alert(1)</script>' });
    assert.ok(!html.includes('<script>'), 'it must be escaped, not run');
    assert.ok(html.includes('Ram &amp; Co'));
  });

  test('asking for nothing says so instead of printing a blank page', () => {
    assert.deepEqual(L.labelData({ batchIds: [] }), []);
    assert.ok(labelSheet([]).includes('Nothing to print'));
  });

  test('the page loads nothing from the internet', () => {
    const html = labelSheet(L.labelData({ batchIds: [oldBatch.id] }));
    /* The SVG namespace is a name, not an address — nothing is fetched from it.
       Anything else pointing outward would leave a blank sticker at the shop. */
    const outward = [...html.matchAll(/https?:\/\/[^\s"'`)]+/g)]
      .map(m => m[0]).filter(u => u !== 'http://www.w3.org/2000/svg');
    assert.deepEqual(outward, [], 'a label sheet must print with the cable unplugged');
    assert.doesNotMatch(html, /<img|<link|<script/, 'everything is drawn inline');
  });
});

describe('scanning a label at the counter', () => {
  test('sells the batch that was scanned, not the one first in line', async () => {
    // Left alone, the older batch goes first. Scanning the newer strip must
    // bill the newer one, so the expiry printed matches what is handed over.
    const res = await fetch(base + '/api/quote', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ productId: dolo.id, qty: 15, batchId: newBatch.id }] }),
    });
    const quote = await res.json();
    assert.equal(quote.lines.length, 1);
    assert.equal(quote.lines[0].batchNo, 'NEW1');
    assert.equal(quote.lines[0].expiry, newBatch.expiry);
  });

  test('without a scan it still sells the oldest stock first', () => {
    const quote = L.quoteBill({ items: [{ productId: dolo.id, qty: 15 }] });
    assert.equal(quote.lines[0].batchNo, 'OLD1', 'first expiry, first out is still the default');
  });

  test('a scan bigger than that batch takes the rest off the oldest stock', () => {
    const quote = L.quoteBill({ items: [{ productId: dolo.id, qty: 75, batchId: newBatch.id }] });
    assert.equal(quote.lines[0].batchNo, 'NEW1');
    assert.equal(quote.lines[0].qty, 60, 'the scanned batch is emptied first');
    assert.equal(quote.lines[1].batchNo, 'OLD1');
    assert.equal(quote.lines[1].qty, 15);
  });

  test('scanning an expired batch does not make it sellable', () => {
    const expired = L.receiveDelivery({ supplierId: 1, lines: [
      { productId: dolo.id, batchNo: 'GONE1', expiry: inDays(20), packs: 2, mrpPaise: 3310, costPaise: 2540 }] });
    const batch = L.batchesOf(dolo.id).find(b => b.batch_no === 'GONE1');
    db.run(`update batches set expiry = ? where id = ?`, inDays(-5), batch.id);

    // Pointing at it by name changes nothing: it is simply not on offer.
    const quote = L.quoteBill({ items: [{ productId: dolo.id, qty: 15, batchId: batch.id }] });
    assert.ok(quote.lines.every(l => l.batchNo !== 'GONE1'), 'expired stock is never billed');

    // It is not merely hidden: the allocator does not offer it at all.
    assert.ok(L.allocate(dolo.id, 15, batch.id).every(a => a.batch.id !== batch.id));

    // And the database itself refuses an expired line, whatever asks for it.
    const sale = db.run(`insert into sales (bill_no, business_date, client_uuid, total_paise)
                         values ('SNM-TEST1', ?, 'expiry-guard', 0)`, db.today());
    assert.throws(() => db.run(
      `insert into sale_items (sale_id, product_id, batch_id, qty, mrp_paise, gst_rate,
                               gross_paise, taxable_paise, gst_paise, cost_paise)
       values (?,?,?,?,?,?,?,?,?,?)`,
      Number(sale.lastInsertRowid), dolo.id, batch.id, 15, 3310, 5, 3310, 3152, 158, 2540),
      /expired/i, 'the database is the last line, not the screens');
  });

  test('the server answers a scanned label with the batch behind it', async () => {
    const code = L.batchCode(oldBatch.id);
    const res = await fetch(`${base}/api/by-code?code=${encodeURIComponent(code)}`);
    const body = await res.json();
    assert.equal(body.batch.id, oldBatch.id);
    assert.equal(body.product.name, 'Dolo 650');

    const none = await (await fetch(`${base}/api/by-code?code=SNM-B99999-0`)).json();
    assert.equal(none.product, null, 'an unknown label must not resolve to some other medicine');
  });

  test('the sheet is served as a printable page', async () => {
    const res = await fetch(`${base}/labels?purchase=${purchaseId}&copies=2`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.equal(html.match(/class="label"/g).length, 4, 'two batches, two copies each');
    assert.ok(html.includes('Sri Nachiya Medicals'));
  });
});
