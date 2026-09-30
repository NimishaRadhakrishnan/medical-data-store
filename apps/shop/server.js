/**
 * The shop's own little server. It listens only on this computer
 * (127.0.0.1), talks to a SQLite file beside it, and never calls out to the
 * internet. Unplug the network and everything below still works.
 *
 *   node server.js            then open http://localhost:8123
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as db from './db.js';
import * as L from './logic.js';
import * as X from './xlsx.js';
import { labelSheet } from './labels.js';
import * as Import from './import.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, 'public');
const PORT = Number(process.env.PORT || process.env.SNM_PORT || 8123);
const HOST = process.env.HOST || '127.0.0.1';                       // use 0.0.0.0 for cloud deployments

const TYPES = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json', '.woff2':'font/woff2',
  '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon' };

const json = (res, code, body) => {
  // A route with nothing to say (no shop settings yet on a brand-new install)
  // must answer `null`, not crash: JSON.stringify(undefined) is undefined.
  const text = JSON.stringify(body === undefined ? null : body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
};

const sheet = (res, buf, filename) => {
  res.writeHead(200, {
    'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'content-disposition': `attachment; filename="${filename}"`,
    'content-length': buf.length,
  });
  res.end(buf);
};

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 2_000_000) throw new L.ShopError('That request is too large.');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new L.ShopError('The app sent something the server could not read.'); }
}

// ---------------------------------------------------------------- the PIN

/*
 * Whether the shop is unlocked is kept here, in memory, and nowhere else.
 * Closing the black window or restarting the computer therefore locks it
 * again, which is what an owner expects after walking away.
 */
const UNLOCK_MINUTES = 15;
let unlockedUntil = 0;
let wrongTries = 0;

const locked = () => L.hasPin() && Date.now() >= unlockedUntil;
const keepAwake = () => { if (L.hasPin() && !locked()) unlockedUntil = Date.now() + UNLOCK_MINUTES * 60_000; };

/* The actions worth guarding: the ones that change history, remove something,
   or show what the shop pays. Billing is deliberately absent — the till must
   work whatever else is going on. */
const GUARDED = new Set([
  'POST /api/bill/cancel',
  'POST /api/price',
  'POST /api/stock/adjust',
  'POST /api/product/update',
  'POST /api/product/archive',
  'POST /api/product/delete',
  'POST /api/supplier/delete',
  'POST /api/supplier/update',
  'POST /api/code/delete',
  'POST /api/settings',
  'POST /api/import/save',
  'POST /api/restore',
  'POST /api/pin/set',
  'POST /api/pin/clear',
]);

class LockedError extends Error {
  constructor() { super('Enter the shop PIN to do this.'); this.code = 'locked'; }
}

// ---------------------------------------------------------------- routes

const routes = {
  'GET /api/health': () => ({ ok: true, db: db.path(), version: 1 }),

  'GET /api/pin/status': () => ({ configured: L.hasPin(), unlocked: !locked() }),

  'POST /api/pin/unlock': async (_q, b) => {
    if (!L.hasPin()) return { unlocked: true };
    /* After a few wrong tries, answer slowly. Never lock the owner out: a shop
       that will not open its own till is worse than one a stranger prodded. */
    if (wrongTries >= 5) await new Promise(r => setTimeout(r, Math.min(2000 * (wrongTries - 4), 10_000)));
    if (!L.verifyPin(b.pin)) {
      wrongTries++;
      throw new L.ShopError(wrongTries >= 5
        ? 'That PIN is not right. After several wrong tries this gets slower.'
        : 'That PIN is not right.');
    }
    wrongTries = 0;
    unlockedUntil = Date.now() + UNLOCK_MINUTES * 60_000;
    return { unlocked: true, minutes: UNLOCK_MINUTES };
  },

  'POST /api/pin/lock': () => { unlockedUntil = 0; return { unlocked: false }; },
  'POST /api/pin/set': (_q, b) => L.setPin(b.pin),
  'POST /api/pin/clear': (_q, b) => { const r = L.clearPin(b.pin); unlockedUntil = 0; return r; },
  'GET /api/settings': () => L.publicSettings(),
  'POST /api/settings': async (_q, b) => {
    const s = L.settings();
    const f = (k, d = null) => b[k] ?? (s ? s[k] : d);
    if (!f('name') || !f('address1')) throw new L.ShopError('Enter the shop name and address.');
    if (s) {
      db.run(`update shop_settings set name=?, address1=?, address2=?, phone=?, gstin=?, dl_20b=?, dl_21b=?,
              pharmacist=?, bill_prefix=?, round_off=?, updated_at=datetime('now','localtime') where id=1`,
        f('name'), f('address1'), f('address2', ''), f('phone'), f('gstin'), f('dl_20b'), f('dl_21b'),
        f('pharmacist'), f('bill_prefix', 'SNM'), b.round_off === undefined ? s.round_off : (b.round_off ? 1 : 0));
    } else {
      db.run(`insert into shop_settings (id,name,address1,address2,phone,gstin,dl_20b,dl_21b,pharmacist,bill_prefix,round_off)
              values (1,?,?,?,?,?,?,?,?,?,?)`,
        f('name'), f('address1'), f('address2', ''), f('phone'), f('gstin'), f('dl_20b'), f('dl_21b'),
        f('pharmacist'), f('bill_prefix', 'SNM'), b.round_off === false ? 0 : 1);
    }
    db.audit('settings.save', 'shop', 1, null);
    return L.publicSettings();
  },

  // ---------------- catalogue
  'GET /api/search': q => L.searchProducts(q.get('q') || '', Number(q.get('limit') || 8)),
  'GET /api/products': q => db.all(`select * from v_stock ${q.get('all') ? '' : 'where is_active = 1'} order by name`),
  'GET /api/product': q => {
    const id = Number(q.get('id'));
    const p = L.productById(id);
    if (!p) throw new L.ShopError('No such medicine.');
    /* What the shop paid is withheld while locked — actually withheld, not
       merely hidden by the screen, because anything sent to the browser can be
       read there. Everything else about the medicine stays visible. */
    const batches = L.batchesOf(id).map(b => locked() ? { ...b, cost_paise: null } : b);
    return { product: p, batches, history: L.productHistory(id), units: L.stockOf(id),
             costsHidden: locked() };
  },
  'POST /api/product': (_q, b) => L.addProduct(b),
  'POST /api/product/update': (_q, b) => L.updateProduct(Number(b.id), b),
  'POST /api/product/archive': (_q, b) => L.archiveProduct(Number(b.id), b.archived !== false),
  'POST /api/product/delete': (_q, b) => L.removeProduct(Number(b.id)),
  'GET /api/codes': q => L.codesFor(Number(q.get('id'))),
  'POST /api/code/delete': (_q, b) => L.removeCode(Number(b.id)),
  'POST /api/supplier/delete': (_q, b) => L.removeSupplier(Number(b.id)),
  'POST /api/supplier/update': (_q, b) => L.updateSupplier(Number(b.id), b),
  'GET /api/deliveries': q => L.recentDeliveries(Number(q.get('limit') || 50)),
  'GET /api/delivery': q => L.deliveryById(Number(q.get('id'))),
  'GET /api/substitutes': q => L.substitutesFor(Number(q.get('id'))),
  'GET /api/by-code': q => {
    const code = q.get('code') || '';
    /* One of our own printed labels names a single batch, so it is answered
       exactly — the right expiry and the right price, not just the medicine. */
    const batch = L.batchByCode(code);
    if (batch) return { batch, product: L.productById(batch.product_id) };
    const row = db.get('select product_id from product_codes where code = ?', code);
    return row ? { product: L.productById(row.product_id), batch: null } : { product: null, batch: null };
  },

  // ---------------- printed labels
  /* Labels are asked for as a printable page at `/labels`, below — there is no
     second route handing back the same rows as data, because two ways to ask
     for the same thing drift apart. */

  // ---------------- selling
  'POST /api/quote': (_q, b) => L.quoteBill(b),
  'POST /api/bill': (_q, b) => L.createBill(b),
  'GET /api/bill': q => {
    const bill = q.get('no') ? L.findBill(q.get('no')) : L.billById(Number(q.get('id')));
    if (!bill) throw new L.ShopError('No such bill.');
    return bill;
  },
  'GET /api/bills': q => L.recentBills(Number(q.get('limit') || 25)),
  'POST /api/bill/cancel': (_q, b) => L.cancelBill(Number(b.id), b.reason),
  'POST /api/return': (_q, b) => L.createReturn(b),
  'POST /api/stockout': (_q, b) => L.logStockout(String(b.term || '').slice(0, 80), b.productId ?? null),

  // ---------------- buying and stock
  'GET /api/suppliers': () => db.all('select * from suppliers where is_active = 1 order by name'),
  'POST /api/supplier': (_q, b) => L.addSupplier(b),

  // ---------------- adding many medicines at once
  'POST /api/import/preview': (_q, b) => Import.preview(b.text || ''),
  'POST /api/import/save': (_q, b) => Import.save(b.text || '', { supplierId: b.supplierId || null }),
  'POST /api/delivery': (_q, b) => L.receiveDelivery(b),
  'POST /api/stock/adjust': (_q, b) => L.adjustStock(b),
  'POST /api/price': (_q, b) => L.setBatchPrice(b),

  // ---------------- reports
  'GET /api/reports/daily': q => L.dailyReport(q.get('date') || db.today()),
  'GET /api/reports/range': q => L.rangeReport(q.get('from'), q.get('to')),
  'GET /api/reports/payments': q => L.paymentReport(q.get('from'), q.get('to')),
  'GET /api/reports/inventory': q => L.inventoryReport({ includeArchived: !!q.get('all') }),
  'GET /api/reports/low-stock': () => L.lowStockReport(),
  'GET /api/reports/expiry': q => L.expiryReport(Number(q.get('days') || 180)),
  'GET /api/integrity': () => L.integrityCheck(),

  // ---------------- backups
  'GET /api/backups': () => ({ folder: db.backupDir(), backups: db.listBackups() }),
  'POST /api/backup': (_q, b) => db.backup(b.label || 'manual'),
  'POST /api/restore': (_q, b) => {
    const out = db.restore(String(b.file || ''));
    db.audit('db.restore', null, null, out);
    return out;
  },
};

const EXPORTS = {
  'sales': q => {
    const from = q.get('from'), to = q.get('to');
    const report = L.rangeReport(from, to);
    const bills = db.all(`select * from sales where business_date between ? and ? order by id`, from, to);
    const lines = db.all(`
      select s.bill_no, s.business_date, p.name, b.batch_no, b.expiry, si.qty, si.mrp_paise, si.gross_paise, si.gst_rate
        from sale_items si join sales s on s.id = si.sale_id
        join products p on p.id = si.product_id join batches b on b.id = si.batch_id
       where s.business_date between ? and ? order by s.id, si.id`, from, to);
    return [X.salesWorkbook(report, L.settings(), bills, lines), `sales-${from}-to-${to}.xlsx`];
  },
  'payments': q => {
    const from = q.get('from'), to = q.get('to');
    return [X.paymentWorkbook(L.paymentReport(from, to), L.settings()), `payments-${from}-to-${to}.xlsx`];
  },
  'inventory': () => [X.inventoryWorkbook(L.inventoryReport(), L.settings()), `stock-${db.today()}.xlsx`],
  'low-stock': () => [X.lowStockWorkbook(L.lowStockReport(), L.settings()), `low-stock-${db.today()}.xlsx`],
  'expiry': q => [X.expiryWorkbook(L.expiryReport(Number(q.get('days') || 180)), L.settings()), `expiry-${db.today()}.xlsx`],
};

// ---------------------------------------------------------------- server

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = join(PUBLIC, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC) || !existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('Not found');
  }
  const info = await stat(file);
  if (info.isDirectory()) { res.writeHead(404); return res.end(); }
  const data = await readFile(file);
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] || 'application/octet-stream',
    'content-length': data.length,
    'cache-control': 'no-cache',
  });
  res.end(data);
}

export function createApp() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${HOST}`);
    const key = `${req.method} ${url.pathname}`;
    try {
      const exportMatch = url.pathname.match(/^\/api\/export\/([\w-]+)\.xlsx$/);
      if (req.method === 'GET' && exportMatch) {
        const build = EXPORTS[exportMatch[1]];
        if (!build) throw new L.ShopError('No such report.');
        const [buf, name] = build(url.searchParams);
        return sheet(res, buf, name);
      }
      /* A blank sheet with the right headings, downloaded and filled in. */
      if (req.method === 'GET' && url.pathname === '/medicines-template.csv') {
        const text = Import.template();
        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="medicines-template.csv"',
          'content-length': Buffer.byteLength(text),
        });
        return res.end(text);
      }

      /* The sticker sheet is a page, not data: it opens in a tab and prints. */
      if (req.method === 'GET' && url.pathname === '/labels') {
        const rows = L.labelData({
          batchIds: (url.searchParams.get('ids') || '').split(',').filter(Boolean),
          purchaseId: url.searchParams.get('purchase') ? Number(url.searchParams.get('purchase')) : null,
        });
        const html = labelSheet(rows, {
          shopName: L.settings()?.name || 'Sri Nachiya Medicals',
          copies: Number(url.searchParams.get('copies') || 1),
        });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
        return res.end(html);
      }

      const handler = routes[key];
      if (handler) {
        /* The PIN is checked here, on the way in, so no route can be reached
           by asking for it directly. A check only in the browser is no check. */
        if (GUARDED.has(key) && locked()) throw new LockedError();
        const payload = req.method === 'POST' ? await body(req) : null;
        const out = await handler(url.searchParams, payload);
        keepAwake();                 // working keeps it unlocked; idling re-locks it
        return json(res, 200, out);
      }
      if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'No such action.' });
      if (req.method === 'GET') return serveStatic(res, url.pathname);
      json(res, 405, { error: 'Not allowed.' });
    } catch (err) {
      /* The database's own rules carry sentences written for the shopkeeper —
         "That batch has expired and cannot be sold." Those must reach the
         counter as themselves. Without this they arrived as "Something went
         wrong on this computer", which tells the owner nothing and looks like
         a broken app rather than a refused action. */
      const known = err instanceof L.ShopError || err instanceof LockedError || L.isRefusal(err);
      if (!known) console.error(`[${new Date().toISOString()}]`, key, err);
      json(res, known ? 400 : 500, {
        error: known ? L.plainMessage(err) : 'Something went wrong on this computer. Nothing was saved.',
        code: known ? (err.code || 'invalid') : 'server',
      });
    }
  });
}

/** A backup when the shop opens, and one every evening it stays open. */
function scheduleBackups() {
  let lastAuto = null;
  const tick = () => {
    const now = new Date();
    const stamp = db.today(now);
    if (now.getHours() >= 21 && lastAuto !== stamp) {
      try { db.backup('auto'); db.pruneBackups(30); lastAuto = stamp; console.log(`Backup taken for ${stamp}.`); }
      catch (e) { console.error('Backup failed:', e.message); }
    }
  };
  setInterval(tick, 10 * 60 * 1000).unref?.();
  tick();
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  db.open();
  const check = L.integrityCheck();
  if (!check.ok) console.error('WARNING: stock figures do not match the stock history. Run npm run check.');
  try { db.backup('start'); } catch (e) { console.error('Backup at start failed:', e.message); }
  scheduleBackups();

  const server = createApp();
  server.listen(PORT, HOST, () => {
    console.log(`\n  Sri Nachiya Medicals is running on this computer.`);
    console.log(`  Open:     http://localhost:${PORT}`);
    console.log(`  Database: ${db.path()}`);
    console.log(`  Backups:  ${db.backupDir()}`);
    console.log(`\n  No internet is needed. Leave this window open while the shop is working.\n`);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { console.log('\nClosing…'); try { db.backup('close'); } catch {} db.close(); process.exit(0); });
  }
}
