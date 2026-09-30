#!/usr/bin/env node
/**
 * Hold a printed label in front of a real browser camera and check the right
 * medicine lands on the bill.
 *
 * The other tests check the pieces: `qr.js` draws the right squares,
 * `qr-reader.js` reads them back. This checks the whole chain the shop
 * actually uses — camera picture, reader, lookup, bill line — inside a real
 * browser, using a fake camera that plays a picture of one of the shop's own
 * labels.
 *
 * It deliberately runs in a browser WITHOUT `BarcodeDetector`, which is the
 * hard case: Safari and Firefox, where the bundled reader has to do the work.
 *
 * This is a developer check, not part of the shop's install. Neither Playwright
 * nor this file goes anywhere near the shop computer.
 *
 *     npm install -D playwright
 *     node tests/app/camera-check.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const APP = join(ROOT, 'apps', 'shop');
const PORT = 8231;

const { matrix } = await import(join(APP, 'qr.js'));
let chromium;
try { ({ chromium } = await import('playwright')); }
catch { die('Needs Playwright:  npm install -D playwright'); }

const work = mkdtempSync(join(tmpdir(), 'snm-cam-'));
let server, browser;

function die(msg) { console.error(msg); process.exit(1); }
const ok = msg => console.log(`  ok   ${msg}`);

/** A label, as a camera would see it: black on white paper, filling the frame. */
function labelVideo(code, file) {
  const W = 640, H = 480, FRAMES = 12;
  const m = matrix(code), n = m.length;
  const scale = Math.floor(Math.min(W, H) * 0.65 / n);
  const ox = Math.floor((W - n * scale) / 2), oy = Math.floor((H - n * scale) / 2);

  const Y = Buffer.alloc(W * H, 235);                       // paper
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (!m[y][x]) continue;
    for (let dy = 0; dy < scale; dy++) {
      const row = (oy + y * scale + dy) * W + ox + x * scale;
      Y.fill(16, row, row + scale);                          // ink
    }
  }
  const half = Buffer.alloc((W / 2) * (H / 2), 128);         // no colour
  const parts = [Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420mpeg2\n`)];
  for (let i = 0; i < FRAMES; i++) parts.push(Buffer.from('FRAME\n'), Y, half, half);
  writeFileSync(file, Buffer.concat(parts));
}

try {
  // ---- a shop with one medicine in stock
  process.env.SNM_DB = join(work, 'shop.db');
  process.env.SNM_BACKUPS = join(work, 'backups');
  const db = await import(join(APP, 'db.js'));
  const L = await import(join(APP, 'logic.js'));
  db.open();
  db.run(`insert into shop_settings (id, name, address1, address2)
          values (1, 'Sri Nachiya Medicals', 'Ettimadai Pirivu', 'Coimbatore 641112')`);
  db.run(`insert into suppliers (name) values ('Sakthi Pharma')`);
  const dolo = L.addProduct({ name: 'Dolo 650', unitsPerStrip: 15, gstRate: 5, reorderPacks: 20 });
  L.receiveDelivery({ supplierId: 1, lines: [{ productId: dolo.id, batchNo: 'B4471',
    expiry: db.today(new Date(Date.now() + 400 * 86400000)),
    packs: 40, mrpPaise: 3310, costPaise: 2540 }] });
  const batchId = db.get('select id from batches').id;
  const code = L.labelData({ batchIds: [batchId] })[0].code;
  db.close();

  const video = join(work, 'label.y4m');
  labelVideo(code, video);
  ok(`printed label ${code} and turned it into a camera picture`);

  // ---- the app, as the shop runs it
  server = spawn(process.execPath, [join(APP, 'server.js')], {
    env: { ...process.env, SNM_PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; ; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/api/health`); break; }
    catch { if (i > 40) die('the app did not start'); await new Promise(r => setTimeout(r, 100)); }
  }

  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
           `--use-file-for-fake-video-capture=${video}`],
  });
  const ctx = await browser.newContext({ permissions: ['camera'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });

  if (await page.evaluate(() => 'BarcodeDetector' in window))
    die('this browser reads codes by itself, so it does not test the hard case');
  ok('browser cannot read codes by itself — the bundled reader must do it');

  if (!await page.locator('#bCamBtn').isVisible())
    die('the camera button is hidden, so there is no way to scan without a scanner');
  ok('the camera button is offered anyway');

  // ---- scan
  await page.click('#bCamBtn');
  await page.waitForFunction(
    () => document.querySelectorAll('#billLines tr').length > 0,
    null, { timeout: 15000 }).catch(() => die('nothing reached the bill within 15s'));

  const text = await page.evaluate(() => document.getElementById('billLines').innerText);
  for (const want of ['Dolo 650', 'B4471'])
    if (!text.includes(want)) die(`the bill does not mention ${want}`);
  ok('the camera read the label and put the right medicine and batch on the bill');

  if (await page.evaluate(() => typeof window.jsQR) !== 'function')
    die('the bundled reader never loaded');
  ok('the reader came from this computer, not the internet');

  const real = errors.filter(e => !/favicon/i.test(e));
  if (real.length) die(`the page reported errors:\n  ${real.join('\n  ')}`);
  ok('no errors on the page');

  console.log('\nScanning works in a browser that has no reader of its own.');
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    // Let it finish the backup it writes on the way out, or the folder is
    // still being written to while we try to remove it.
    const stopped = new Promise(r => server.once('exit', r));
    server.kill();
    await Promise.race([stopped, new Promise(r => setTimeout(r, 3000))]);
  }
  try { rmSync(work, { recursive: true, force: true }); } catch { /* a temp folder; it can wait for the OS */ }
}
