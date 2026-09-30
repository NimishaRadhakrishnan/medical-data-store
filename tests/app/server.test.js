/**
 * The local server, and the promise that matters most: nothing in this app
 * reaches the internet.
 *
 *   npm run test:app
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const work = mkdtempSync(join(tmpdir(), 'snm-http-'));
process.env.SNM_DB = join(work, 'shop.db');
process.env.SNM_BACKUPS = join(work, 'backups');

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..', 'apps', 'shop');

const db = await import('../../apps/shop/db.js');
const L = await import('../../apps/shop/logic.js');
const { createApp } = await import('../../apps/shop/server.js');

let server, base, dolo;

before(async () => {
  db.open();
  db.run(`insert into shop_settings (id, name, address1, address2) values (1, 'Sri Nachiya Medicals', 'Ettimadai Pirivu', 'Coimbatore 641112')`);
  db.run(`insert into suppliers (name) values ('Sakthi Pharma')`);
  dolo = L.addProduct({ name:'Dolo 650', unitsPerStrip:15, gstRate:5, reorderPacks:99 });
  L.receiveDelivery({ supplierId:1, lines:[{ productId:dolo.id, batchNo:'B1',
    expiry: db.today(new Date(Date.now() + 200 * 86400000)), packs:10, mrpPaise:3310, costPaise:2540 }] });

  server = createApp();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server?.close(); db.close(); rmSync(work, { recursive:true, force:true }); });

const call = async (path, body) => {
  const res = await fetch(base + path, body === undefined ? {}
    : { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

describe('the local server', () => {
  test('listens on this computer only, never on the network', () => {
    assert.equal(server.address().address, '127.0.0.1',
      'binding anything else would expose the shop to the whole network');
  });

  test('serves the screens and answers the API', async () => {
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Sri Nachiya Medicals/);
    assert.equal((await call('/api/health')).body.ok, true);
    assert.ok((await call('/api/search?q=dolo')).body.length >= 1);
  });

  test('a bill saved over HTTP moves the stock', async () => {
    const before = L.stockOf(dolo.id);
    const { status, body } = await call('/api/bill', {
      items:[{ productId: dolo.id, qty: 15 }], payMode:'upi', clientUuid:'http-1' });
    assert.equal(status, 200);
    assert.match(body.bill_no, /^SNM-\d{6}$/);
    assert.equal(L.stockOf(dolo.id), before - 15);
  });

  test('a double click does not make a second bill', async () => {
    const [a, b] = await Promise.all([
      call('/api/bill', { items:[{ productId: dolo.id, qty: 15 }], clientUuid:'http-dbl' }),
      call('/api/bill', { items:[{ productId: dolo.id, qty: 15 }], clientUuid:'http-dbl' }),
    ]);
    assert.equal(a.body.bill_no, b.body.bill_no);
    assert.equal(db.get('select count(*) as n from sales where client_uuid = ?', 'http-dbl').n, 1);
  });

  test('a mistake comes back as a plain sentence, not a crash', async () => {
    const { status, body } = await call('/api/bill', { items:[{ productId: dolo.id, qty: 999999 }], clientUuid:'http-bad' });
    assert.equal(status, 400);
    assert.match(body.error, /left in stock/i);
    assert.equal(db.get('select count(*) as n from sales where client_uuid = ?', 'http-bad').n, 0);
  });

  test('every report answers, and the Excel files download', async () => {
    const today = db.today();
    for (const path of [`/api/reports/daily?date=${today}`, `/api/reports/range?from=${today}&to=${today}`,
                        `/api/reports/payments?from=${today}&to=${today}`, '/api/reports/inventory',
                        '/api/reports/low-stock', '/api/reports/expiry?days=180']) {
      assert.equal((await fetch(base + path)).status, 200, path);
    }
    for (const [name, query] of [['sales', `?from=${today}&to=${today}`], ['payments', `?from=${today}&to=${today}`],
                                 ['inventory', ''], ['low-stock', ''], ['expiry', '']]) {
      const res = await fetch(`${base}/api/export/${name}.xlsx${query}`);
      assert.equal(res.status, 200, name);
      assert.match(res.headers.get('content-type'), /spreadsheetml\.sheet/);
      assert.match(res.headers.get('content-disposition'), /attachment; filename=".+\.xlsx"/);
      const buf = Buffer.from(await res.arrayBuffer());
      assert.equal(buf.subarray(0, 2).toString(), 'PK', `${name} is not a real xlsx`);
      assert.ok(buf.length > 1200, `${name} is empty`);
    }
  });

  test('a brand-new install asks for the shop details instead of showing an error', async () => {
    // The very first thing a fresh shop PC does is ask /api/settings with no
    // row in the table. That must answer politely, not crash the server.
    const saved = db.get('select * from shop_settings where id = 1');
    db.run('delete from shop_settings where id = 1');
    try {
      const res = await fetch(base + '/api/settings');
      assert.equal(res.status, 200, 'a fresh install must not see an error banner');
      assert.equal(await res.json(), null, 'the screens read this as "ask the owner to set up"');
    } finally {
      db.run(`insert into shop_settings (id, name, address1, address2) values (1, ?, ?, ?)`,
        saved.name, saved.address1, saved.address2);
    }
  });

  test('an unknown address is refused politely', async () => {
    assert.equal((await fetch(base + '/api/nonsense')).status, 404);
    assert.equal((await fetch(base + '/../../etc/passwd')).status, 404);
  });
});

describe('no internet needed', () => {
  test('nothing in the screens loads from another computer', () => {
    /* What matters is whether the shop's browser would go and *fetch*
       something. A web address written in a comment — a licence notice, a link
       to where a piece of code came from — is just words on a page and is
       fetched by nobody, so comments are taken out before looking. */
    const stripComments = text => text
      .replace(/\/\*[\s\S]*?\*\//g, ' ')      // /* ... */  (js and css)
      .replace(/<!--[\s\S]*?-->/g, ' ')       // <!-- ... --> (html)
      .replace(/^\s*(\/\/|\*).*$/gm, ' ')     // // ...  and continued * lines
      .replace(/(\s)\/\/[^'"`\n]*$/gm, '$1'); // trailing // ... , never inside a string

    /* Only the files the browser actually runs or renders. A licence notice
       sitting in a .txt file is read by people, never by the browser. */
    const files = readdirSync(join(APP, 'public'))
      .filter(f => /\.(html|js|css)$/i.test(f))
      .map(f => join(APP, 'public', f));
    assert.ok(files.length >= 3, 'the screens went missing');
    const offenders = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'));

      for (const m of code.matchAll(/https?:\/\/[^\s"'`)]+/g)) {
        // The app's own address is the only one allowed to appear in code.
        if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(m[0])) continue;
        // `xmlns` is a name, not a place: it identifies SVG to the browser and
        // is never fetched. Anything else is a real trip to the internet.
        if (m[0] === 'http://www.w3.org/2000/svg' && /xmlns=/.test(code)) continue;
        offenders.push(`${file}: ${m[0]}`);
      }
      // The ways a page actually reaches out, named one by one, so a new one
      // cannot slip in behind a cleverly written address.
      for (const re of [/\b(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\//gi,   // <script src>, <link href>
                        /\burl\(\s*["']?\s*(?:https?:)?\/\//gi,             // css url()
                        /\b(?:fetch|importScripts|XMLHttpRequest)\b[^\n]{0,40}(?:https?:)?\/\//gi,
                        /\bimport\s*\(?\s*["']\s*(?:https?:)?\/\//gi]) {
        for (const m of code.matchAll(re)) {
          if (!/(localhost|127\.0\.0\.1)/.test(m[0])) offenders.push(`${file}: ${m[0].trim()}`);
        }
      }
      assert.doesNotMatch(code, /fonts\.(googleapis|gstatic)\.com/, `${file} pulls fonts from the internet`);
      assert.doesNotMatch(code, /cdn(js)?\./, `${file} loads a library from a CDN`);
    }
    assert.deepEqual(offenders, [], 'these would fail with the internet unplugged');
  });

  test('the QR reader is a real file on this computer, not a download', () => {
    // The camera falls back to /qr-reader.js on browsers that cannot read a
    // code themselves. If that file were ever fetched rather than shipped,
    // scanning would quietly stop working the moment the shop went offline.
    const app = readFileSync(join(APP, 'public', 'app.js'), 'utf8');
    assert.match(app, /s\.src\s*=\s*'\/qr-reader\.js'/,
      'the reader must be loaded from this computer by an absolute local path');
    const reader = readFileSync(join(APP, 'public', 'qr-reader.js'), 'utf8');
    assert.ok(reader.length > 50_000, 'qr-reader.js looks like a stub, not the real reader');
    assert.match(reader, /Apache License/i, 'the licence notice must stay with the code');
  });

  test('the app itself needs no packages to be installed', () => {
    const pkg = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8'));
    assert.deepEqual(pkg.dependencies ?? {}, {},
      'a dependency would mean npm install — and an internet connection — on the shop PC');
    for (const file of ['db.js', 'logic.js', 'server.js', 'xlsx.js', 'qr.js', 'labels.js']) {
      const text = readFileSync(join(APP, file), 'utf8');
      for (const m of text.matchAll(/^\s*import .* from '([^']+)'/gm)) {
        const source = m[1];
        assert.ok(source.startsWith('node:') || source.startsWith('.'),
          `${file} imports ${source}, which would have to be installed`);
      }
    }
  });

  test('the screens survive the server being stopped and started again', async () => {
    const before = db.get('select count(*) as n from sales').n;
    await new Promise(r => server.close(r));
    db.close();

    db.open();
    server = createApp();
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;

    assert.equal((await call('/api/health')).body.ok, true);
    assert.equal(db.get('select count(*) as n from sales').n, before, 'the bills are all still there');
    assert.equal(L.integrityCheck().ok, true);
  });

  test('a power cut mid-bill leaves no half-sold stock', () => {
    // The journal mode that makes this safe must actually be on.
    const mode = db.get('pragma journal_mode');
    assert.equal(String(Object.values(mode)[0]).toLowerCase(), 'wal');
    const sync = db.get('pragma synchronous');
    assert.equal(Number(Object.values(sync)[0]), 2, 'full sync: a saved bill is on the disk');
  });
});
