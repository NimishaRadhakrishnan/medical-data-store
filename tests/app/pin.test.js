/**
 * The PIN, tested through the real server.
 *
 * The promise is narrow and must hold exactly: billing is never blocked, and
 * the handful of actions that can do damage are refused until the PIN is
 * given. Everything here goes over HTTP, because a check that only exists in
 * the browser is not a check at all.
 *
 *   npm run test:app
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const work = mkdtempSync(join(tmpdir(), 'snm-pin-'));
process.env.SNM_DB = join(work, 'shop.db');
process.env.SNM_BACKUPS = join(work, 'backups');

const db = await import('../../apps/shop/db.js');
const L = await import('../../apps/shop/logic.js');
const { createApp } = await import('../../apps/shop/server.js');

const PIN = '4713';
let server, base, med, batch;

const call = async (path, body) => {
  const res = await fetch(base + path, body === undefined ? {}
    : { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const unlock = () => call('/api/pin/unlock', { pin: PIN });
const lock = () => call('/api/pin/lock', {});

before(async () => {
  db.open();
  db.run(`insert into shop_settings (id, name, address1, address2)
          values (1, 'Sri Nachiya Medicals', '5/168, Palaghad Main Road', 'Ettimadai, Coimbatore 641112')`);
  db.run(`insert into suppliers (name) values ('Palepu Pharma')`);
  med = L.addProduct({ name:'Pin Test Tab', unitsPerStrip:10, gstRate:5 });
  L.receiveDelivery({ supplierId:1, lines:[{ productId: med.id, batchNo:'PIN-1',
    expiry: db.today(new Date(Date.now() + 400 * 86400000)), packs:20, mrpPaise:5000, costPaise:3000 }] });
  batch = db.get('select * from batches where batch_no = ?', 'PIN-1');

  server = createApp();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server?.close(); db.close(); rmSync(work, { recursive:true, force:true }); });

describe('before a PIN is set, nothing is locked', () => {
  test('the shop behaves exactly as it did without the feature', async () => {
    assert.equal((await call('/api/pin/status')).body.configured, false);
    const r = await call('/api/price', { batchId: batch.id, mrpPaise: 5100, costPaise: null,
                                         reason: 'Revised MRP' });
    assert.equal(r.status, 200, 'with no PIN set, a price change must just work');
    db.run('update batches set mrp_paise = ? where id = ?', 5000, batch.id);   // put it back
  });

  test('the cost of stock is shown', async () => {
    const { body } = await call(`/api/product?id=${med.id}`);
    assert.equal(body.costsHidden, false);
    assert.equal(body.batches[0].cost_paise, 3000);
  });
});

describe('setting a PIN', () => {
  test('an easily guessed PIN is refused', async () => {
    for (const bad of ['1234', '0000', '7777', '12', 'abcd']) {
      assert.equal((await call('/api/pin/set', { pin: bad })).status, 400, `${bad} should be refused`);
    }
    assert.equal(L.hasPin(), false);
  });

  test('a sensible PIN is accepted, and is never stored as itself', async () => {
    assert.equal((await call('/api/pin/set', { pin: PIN })).status, 200);
    const row = db.get('select pin_hash, pin_salt from shop_settings where id = 1');
    assert.ok(row.pin_hash && row.pin_salt);
    assert.doesNotMatch(row.pin_hash, new RegExp(PIN), 'the PIN itself must not appear in the hash');
    assert.notEqual(row.pin_hash, PIN);
  });

  test('the PIN never reaches the screens, and never reaches the log', async () => {
    const { body } = await call('/api/settings');
    assert.equal(body.hasPin, true);
    assert.equal(body.pin_hash, undefined, 'the hash must never be sent to the browser');
    assert.equal(body.pin_salt, undefined);

    const trail = db.all(`select detail from audit_log where action like 'pin.%'`);
    assert.ok(trail.length, 'setting a PIN should be recorded');
    for (const row of trail) assert.doesNotMatch(String(row.detail ?? ''), new RegExp(PIN));
  });
});

describe('locked', () => {
  test('billing is never blocked', async () => {
    await lock();
    const before = L.stockOf(med.id);
    const r = await call('/api/bill', { items:[{ productId: med.id, qty: 10 }],
                                        payMode:'cash', clientUuid:'pin-locked-bill' });
    assert.equal(r.status, 200, 'the till must work while locked');
    assert.equal(L.stockOf(med.id), before - 10);

    // and so must everything else the counter needs
    for (const path of ['/api/search?q=pin', '/api/products', '/api/bills',
                        `/api/reports/daily?date=${db.today()}`]) {
      assert.equal((await call(path)).status, 200, path);
    }
  });

  test('every guarded action is refused, and nothing changes', async () => {
    await lock();
    const attempts = [
      ['/api/price', { batchId: batch.id, mrpPaise: 9999, costPaise: null, reason:'x' }],
      ['/api/stock/adjust', { batchId: batch.id, delta: -1, reason:'damage', note:'test' }],
      ['/api/product/update', { id: med.id, name:'Renamed While Locked' }],
      ['/api/product/archive', { id: med.id }],
      ['/api/supplier/update', { id: 1, name:'Renamed Distributor' }],
      ['/api/supplier/delete', { id: 1 }],
      ['/api/settings', { name:'Someone Elses Shop', address1:'Nowhere' }],
    ];
    for (const [path, payload] of attempts) {
      const r = await call(path, payload);
      assert.equal(r.status, 400, `${path} should be refused while locked`);
      assert.equal(r.body.code, 'locked', `${path} should say it is locked, not something else`);
    }
    // Prove none of it landed.
    assert.equal(db.get('select mrp_paise from batches where id = ?', batch.id).mrp_paise, 5000);
    assert.equal(L.productById(med.id).name, 'Pin Test Tab');
    assert.equal(L.productById(med.id).is_active, 1);
    assert.equal(db.get('select name from suppliers where id = 1').name, 'Palepu Pharma');
    assert.equal(L.settings().name, 'Sri Nachiya Medicals');
  });

  test('the cost of stock is withheld, not merely hidden', async () => {
    await lock();
    const { body } = await call(`/api/product?id=${med.id}`);
    assert.equal(body.costsHidden, true);
    assert.equal(body.batches[0].cost_paise, null,
      'a figure sent to the browser can be read there, so it must not be sent');
    assert.equal(body.batches[0].mrp_paise, 5000, 'everything else stays visible');
  });
});

describe('unlocking', () => {
  test('a wrong PIN does not unlock', async () => {
    await lock();
    const r = await call('/api/pin/unlock', { pin: '9999' });
    assert.equal(r.status, 400);
    assert.equal((await call('/api/pin/status')).body.unlocked, false);
  });

  test('the right PIN unlocks, and the guarded actions then work', async () => {
    assert.equal((await unlock()).status, 200);
    assert.equal((await call('/api/pin/status')).body.unlocked, true);

    const r = await call('/api/price', { batchId: batch.id, mrpPaise: 5200, costPaise: null,
                                         reason:'Revised MRP' });
    assert.equal(r.status, 200);
    assert.equal(db.get('select mrp_paise from batches where id = ?', batch.id).mrp_paise, 5200);
  });

  test('cost comes back once unlocked', async () => {
    await unlock();
    const { body } = await call(`/api/product?id=${med.id}`);
    assert.equal(body.costsHidden, false);
    assert.equal(body.batches[0].cost_paise, 3000);
  });

  test('repeated wrong tries get slower, but never lock the owner out', async () => {
    await lock();
    for (let i = 0; i < 6; i++) await call('/api/pin/unlock', { pin: '1111' });
    const started = Date.now();
    const r = await unlock();
    assert.equal(r.status, 200, 'the right PIN must still work after many wrong ones');
    assert.ok(Date.now() - started >= 1000, 'and the answer should have been slowed down');
  });

  test('locking again takes the figures away', async () => {
    await unlock();
    await lock();
    assert.equal((await call('/api/pin/status')).body.unlocked, false);
    assert.equal((await call(`/api/product?id=${med.id}`)).body.batches[0].cost_paise, null);
  });
});

describe('forgetting the PIN', () => {
  test('RESET-PIN.txt clears it on the next start, then removes itself', async () => {
    assert.equal(L.hasPin(), true);
    const flag = join(work, 'RESET-PIN.txt');
    writeFileSync(flag, '');

    db.close();
    db.open();                       // what happens when the shop PC is switched on

    assert.equal(L.hasPin(), false, 'the PIN should be gone');
    assert.equal(existsSync(flag), false, 'and the file removed, so it cannot clear it again tomorrow');
    assert.ok(db.get(`select 1 as n from audit_log where action = 'pin.reset'`), 'and recorded');
  });

  test('with the PIN gone, the shop is open again', async () => {
    const r = await call('/api/price', { batchId: batch.id, mrpPaise: 5300, costPaise: null, reason:'Revised MRP' });
    assert.equal(r.status, 200);
    assert.equal((await call(`/api/product?id=${med.id}`)).body.costsHidden, false);
  });
});
