/**
 * Fill an empty database with a believable month of trading, so the app can be
 * shown working without waiting for a real shop to generate history.
 *
 *   node demo-data.js            (refuses if the database already has bills)
 *   node demo-data.js --force    (wipes it and starts again)
 *
 * This is for demonstrations and training only. It never runs by itself, and it
 * refuses to touch a database that already has real sales in it.
 */

import { rmSync, existsSync } from 'node:fs';
import * as db from './db.js';
import * as L from './logic.js';

const force = process.argv.includes('--force');

if (force && existsSync(process.env.SNM_DB || '')) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync((process.env.SNM_DB) + suffix, { force: true }); } catch {}
  }
}

db.open();

const bills = db.get('select count(*) as n from sales').n;
if (bills > 0 && !force) {
  console.error(`\n  This database already has ${bills} bills in it.`);
  console.error('  Demo data is not added to a shop that is already trading.');
  console.error('  To start a fresh demo, point SNM_DB at a new file.\n');
  process.exit(1);
}

const day = n => db.today(new Date(Date.now() + n * 86400000));

if (!L.settings()) {
  db.run(`insert into shop_settings (id, name, address1, address2, phone, gstin, dl_20b, pharmacist)
          values (1, 'Sri Nachiya Medicals', '5/168, Palaghad Main Road',
                  'Ettimadai, Coimbatore, Tamil Nadu 641112', '', '33BDKPA2625M1ZP',
                  'CBE/6064/20/21', '')`);
}

for (const [name, phone] of [['Palepu Pharma Distributors', '8220047011'],
                             ['Sakthi Pharma', '9443011223'],
                             ['Kovai Agencies', '9843022114']]) {
  try { db.run('insert into suppliers (name, phone) values (?,?)', name, phone); } catch {}
}

// name, generic, maker, per strip, GST, schedule, MRP, trade price, packs
const CATALOGUE = [
  ['Dolo 650',        'Paracetamol 650mg',   'Micro Labs', 15, 5,  'OTC', 3310,  2540, 160],
  ['Pan 40',          'Pantoprazole 40mg',   'Alkem',      15, 5,  'H',   15000, 11000, 90],
  ['Azithral 500',    'Azithromycin 500mg',  'Alembic',     5, 5,  'H',   23719, 18072, 70],
  ['Shelcal 500',     'Calcium + D3',        'Torrent',    15, 12, 'OTC', 41600, 31695, 60],
  ['Telmikind 20',    'Telmisartan 20mg',    'Mankind',    10, 5,  'H',   2544,  1938,  120],
  ['Alprax 0.25',     'Alprazolam 0.25mg',   'Torrent',    15, 12, 'H1',  9800,  7400,  50],
  ['Ascoril LS Syrup','Ambroxol + Levo',     'Glenmark',    1, 5,  'OTC', 12800, 9650,  90],
  ['Thyronorm 100mcg','Thyroxine 100mcg',    'Abbott',    120, 5,  'H',   16991, 12946, 30],
];

const made = {};
for (const [name, generic, maker, per, gst, schedule, mrp, cost, packs] of CATALOGUE) {
  const p = L.addProduct({ name, genericName: generic, manufacturer: maker,
    unitsPerStrip: per, gstRate: gst, schedule, reorderPacks: 4, hsn: '3004' });
  made[name] = p;
  // Two deliveries apiece, a month apart, so there is price history and two batches.
  L.receiveDelivery({ supplierId: 1, invoiceNo: 'CB-26-134190', invoiceDate: day(-30), discountPct: 4,
    lines: [{ productId: p.id, batchNo: `A${p.id}241`, expiry: day(400),
              packs: Math.ceil(packs * 0.6), mrpPaise: mrp, costPaise: cost }] });
  L.receiveDelivery({ supplierId: 2, invoiceNo: 'SP-4821', invoiceDate: day(-8), discountPct: 6,
    lines: [{ productId: p.id, batchNo: `B${p.id}772`, expiry: day(180),
              packs: Math.floor(packs * 0.4) || 1, mrpPaise: mrp, costPaise: cost }] });
}

// A batch close to expiry, so the expiry report has something to show.
L.receiveDelivery({ supplierId: 3, invoiceNo: 'KA-118', invoiceDate: day(-20), discountPct: 4,
  lines: [{ productId: made['Dolo 650'].id, batchNo: 'SHORT-9', expiry: day(25),
            packs: 6, mrpPaise: 3310, costPaise: 2540 }] });

/* Four weeks of trading. The pattern is deliberately uneven — busier at the
   weekend, a quiet Monday — so the charts and averages look like a real shop
   rather than a straight line. */
const PAY = ['cash', 'cash', 'cash', 'upi', 'upi', 'card', 'credit'];
let seed = 20260924;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

let billNo = 0;
const dated = [];                    // which demo bill belongs to which day
for (let d = 28; d >= 0; d--) {
  const date = day(-d);
  const weekend = [0, 6].includes(new Date(date).getDay());
  const count = Math.round((weekend ? 9 : 6) + rand() * 5);

  for (let i = 0; i < count; i++) {
    const picks = [];
    const howMany = 1 + Math.floor(rand() * 3);
    for (let k = 0; k < howMany; k++) {
      const [name] = CATALOGUE[Math.floor(rand() * CATALOGUE.length)];
      const p = made[name];
      if (picks.some(x => x.productId === p.id)) continue;
      const strip = p.units_per_strip > 1;
      const qty = strip ? (rand() < 0.6 ? Math.ceil(rand() * 10) : p.units_per_strip) : 1;
      picks.push({ productId: p.id, qty });
    }
    if (!picks.length) continue;

    const needsRx = picks.some(x => db.get('select drug_schedule from products where id = ?', x.productId)
                                      .drug_schedule === 'H1');
    const uuid = `demo-${d}-${i}`;
    try {
      L.createBill({
        items: picks,
        payMode: PAY[Math.floor(rand() * PAY.length)],
        clientUuid: uuid,
        ...(needsRx ? { doctorName: 'Dr S Ramesh', patientName: 'Walk-in patient',
                        patientAddress: 'Ettimadai' } : {}),
      });
      dated.push([uuid, date]);
      billNo++;
    } catch { /* out of stock for that pick: a real shop has those days too */ }
  }
}

/* Every bill was written today, because the app has no way to backdate one —
   and it should not have: a bill carries the date it was actually made, and
   GST records depend on that. So the demo spreads them over the month here
   instead, lifting the immutability rule for a moment on this demo file alone.
   Nothing in the shop's own code can do this. */
db.handle().exec('drop trigger if exists sales_immutable');
for (const [uuid, date] of dated) {
  db.run('update sales set business_date = ? where client_uuid = ?', date, uuid);
}
db.close();
db.open();                           // schema.sql puts the rule straight back

const totals = db.get(`select count(*) as bills, coalesce(sum(total_paise),0) as taken from sales`);
console.log(`
  Demo data ready.

    ${totals.bills} bills over 29 days, ${(totals.taken / 100).toFixed(2)} taken
    ${CATALOGUE.length} medicines, 3 distributors, 17 batches
    one batch expiring in 25 days, so the expiry report has something to show

  Start the app and open http://localhost:8123
`);

db.close();
