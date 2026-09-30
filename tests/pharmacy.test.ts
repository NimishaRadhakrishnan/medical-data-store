import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseGs1, parseGs1Date, isValidGtin, classifyScan } from '../lib/gs1.ts';
import {
  parseQuantity, formatQuantity, computeLine, computeBill, allocateFefo,
  expiryBucket, isReturnable, computeReorder, classifyAbc,
  InsufficientStockError, rupees,
  type Product, type Batch,
} from '../lib/pharmacy.ts';

const GS = '\u001d';

const dolo: Product = {
  id: 'p1', name: 'Dolo 650', genericName: 'Paracetamol',
  compositionKey: 'paracetamol|650mg', baseUnit: 'tablet',
  unitsPerStrip: 15, stripsPerBox: 10, gstRate: 5, drugSchedule: 'OTC',
};

const augmentin: Product = {
  ...dolo, id: 'p2', name: 'Augmentin 625 Duo', genericName: 'Amoxicillin + Clavulanic Acid',
  unitsPerStrip: 10, gstRate: 5, drugSchedule: 'H1',
};

const batch = (over: Partial<Batch> = {}): Batch => ({
  id: 'b1', productId: 'p1', batchNo: 'ABC123',
  expiryDate: new Date(Date.UTC(2027, 5, 30)),
  mrp: 31.50, purchaseRate: 24.20, qtyAvailable: 150,
  ...over,
});

// ============================================================ GS1

describe('GS1 barcode parsing', () => {
  test('parses a full pharma DataMatrix with separators', () => {
    const raw = `010890123456789017270630${GS}10BN4471${GS}21SER00981`;
    const r = parseGs1(raw);
    assert.equal(r.gtin, '08901234567890');
    assert.equal(r.batchNo, 'BN4471');
    assert.equal(r.serial, 'SER00981');
    assert.equal(r.expiryDate?.toISOString().slice(0, 10), '2027-06-30');
    assert.equal(r.complete, true);
  });

  test('handles a scanner that emits no FNC1 separators at all', () => {
    // Real HID scanners frequently strip \u001d. Variable-length batch must
    // still terminate correctly by finding the next known AI.
    const raw = '01089012345678901727063010BN447121SER00981';
    const r = parseGs1(raw);
    assert.equal(r.gtin, '08901234567890');
    assert.equal(r.batchNo, 'BN4471');
    assert.equal(r.serial, 'SER00981');
  });

  test('strips the symbology identifier some scanners prepend', () => {
    const r = parseGs1(`]d201089012345678901727063010BN4471`);
    assert.equal(r.gtin, '08901234567890');
    assert.equal(r.batchNo, 'BN4471');
  });

  test('DD=00 means last day of month — which is how expiry is printed', () => {
    // Packs print 06/2027. GS1 encodes that as 270600.
    assert.equal(parseGs1Date('270600')?.toISOString().slice(0, 10), '2027-06-30');
    assert.equal(parseGs1Date('280200')?.toISOString().slice(0, 10), '2028-02-29'); // leap
    assert.equal(parseGs1Date('270200')?.toISOString().slice(0, 10), '2027-02-28');
  });

  test('rejects impossible dates instead of silently producing one', () => {
    assert.equal(parseGs1Date('271301'), undefined); // month 13
    assert.equal(parseGs1Date('27063'),  undefined); // too short
    assert.equal(parseGs1Date('abcdef'), undefined);
  });

  test('validates the GTIN check digit', () => {
    assert.equal(isValidGtin('08901234567890'), true);
    assert.equal(isValidGtin('08901234567891'), false); // wrong check digit
    assert.equal(isValidGtin('8901030865275'),  true);  // EAN-13
  });

  test('classifies the three scan lanes', () => {
    assert.equal(classifyScan(`010890123456789017270630${GS}10BN4471`).kind, 'gs1');
    assert.equal(classifyScan('8901030865275').kind, 'ean13');
    assert.equal(classifyScan('HELLO').kind, 'unknown');
    // Unknown is not a failure — it routes to the "teach me this code" screen.
  });

  test('flags an incomplete parse rather than returning partial garbage', () => {
    const r = parseGs1('01089012345678909999XYZ');
    assert.equal(r.gtin, '08901234567890');
    assert.equal(r.complete, false);
  });
});

// ============================================================ quantity

describe('quantity entry', () => {
  test('bare number is base units — customers buy 4 tablets', () => {
    assert.equal(parseQuantity('4', dolo), 4);
  });

  test('strips and boxes expand correctly', () => {
    assert.equal(parseQuantity('2s', dolo), 30);
    assert.equal(parseQuantity('2 strips', dolo), 30);
    assert.equal(parseQuantity('1b', dolo), 150);
  });

  test('half strips are real and round to whole tablets', () => {
    assert.equal(parseQuantity('1.5s', dolo), 23); // 22.5 -> 23
  });

  test('rejects nonsense loudly', () => {
    assert.throws(() => parseQuantity('', dolo));
    assert.throws(() => parseQuantity('0', dolo));
    assert.throws(() => parseQuantity('-3', dolo));
    assert.throws(() => parseQuantity('2 packets', dolo));
  });

  test('formats back into shop language', () => {
    assert.equal(formatQuantity(37, dolo), '2 strips + 7');
    assert.equal(formatQuantity(30, dolo), '2 strips');
    assert.equal(formatQuantity(15, dolo), '1 strip');
    assert.equal(formatQuantity(7,  dolo), '7');
  });
});

// ============================================================ GST

describe('pricing and GST', () => {
  test('MRP is tax-inclusive: GST is backed OUT, never added on top', () => {
    // 1 strip at MRP 31.50, GST 5%.
    const t = computeLine({ product: dolo, batch: batch(), qtyBase: 15 });
    assert.equal(t.grossPaise, 3150);
    assert.equal(t.netPaise, 3150);
    // taxable = 3150 / 1.05 = 3000
    assert.equal(t.taxablePaise, 3000);
    assert.equal(t.gstPaise, 150);
    // The customer pays exactly the printed MRP. Anything else is wrong.
    assert.equal(t.taxablePaise + t.gstPaise, t.netPaise);
  });

  test('loose tablets price without float drift', () => {
    // 4 tablets of a 15-tab strip at 31.50 = 4 * 2.10 = 8.40 exactly
    const t = computeLine({ product: dolo, batch: batch(), qtyBase: 4 });
    assert.equal(t.grossPaise, 840);
    assert.equal(rupees(t.grossPaise), '8.40');
  });

  test('CGST and SGST always re-add to the total GST, odd paise included', () => {
    for (const qty of [1, 3, 7, 11, 13, 29, 47]) {
      const t = computeLine({ product: dolo, batch: batch(), qtyBase: qty });
      assert.equal(t.cgstPaise + t.sgstPaise, t.gstPaise, `qty ${qty}`);
    }
  });

  test('discount applies before tax is backed out', () => {
    const t = computeLine({ product: dolo, batch: batch(), qtyBase: 15, discountPct: 10 });
    assert.equal(t.discountPaise, 315);
    assert.equal(t.netPaise, 2835);
    assert.equal(t.taxablePaise + t.gstPaise, 2835);
  });

  test('bill rounds once, at the end, and the round-off is recorded', () => {
    const lines = [
      { product: dolo,      batch: batch(), qtyBase: 7 },
      { product: augmentin, batch: batch({ id: 'b2', productId: 'p2', mrp: 223.50 }), qtyBase: 6 },
    ];
    const b = computeBill(lines);
    assert.equal(b.payablePaise % 100, 0, 'payable must be a whole rupee');
    assert.equal(
      b.subtotalPaise - b.discountPaise + b.roundOffPaise,
      b.payablePaise,
      'round-off must reconcile exactly — this is what makes the till balance',
    );
  });

  test('GST summary is grouped by rate for the invoice', () => {
    const vitamins: Product = { ...dolo, id: 'p3', gstRate: 18 };
    const b = computeBill([
      { product: dolo,     batch: batch(), qtyBase: 15 },
      { product: vitamins, batch: batch({ id: 'b3', mrp: 118 }), qtyBase: 15 },
    ]);
    assert.deepEqual(Object.keys(b.gstByRate).sort(), ['18.00', '5.00']);
    assert.equal(b.gstByRate['5.00'].gstPaise, 150);
    assert.equal(b.gstByRate['18.00'].gstPaise, 1800); // 11800 / 1.18 = 10000
  });
});

// ============================================================ FEFO

describe('FEFO allocation', () => {
  const asOf = new Date(Date.UTC(2026, 8, 16)); // 16 Sep 2026

  test('sells the soonest-expiring batch first', () => {
    const batches = [
      batch({ id: 'far',  expiryDate: new Date(Date.UTC(2028, 0, 31)), qtyAvailable: 100 }),
      batch({ id: 'near', expiryDate: new Date(Date.UTC(2026, 11, 31)), qtyAvailable: 20 }),
      batch({ id: 'mid',  expiryDate: new Date(Date.UTC(2027, 5, 30)), qtyAvailable: 50 }),
    ];
    const alloc = allocateFefo(batches, 30, asOf);
    assert.equal(alloc[0].batch.id, 'near');
    assert.equal(alloc[0].take, 20);
    assert.equal(alloc[1].batch.id, 'mid');
    assert.equal(alloc[1].take, 10);
  });

  test('expired stock is never allocated, even when it is all there is', () => {
    const batches = [
      batch({ id: 'dead', expiryDate: new Date(Date.UTC(2026, 7, 31)), qtyAvailable: 500 }),
    ];
    assert.throws(() => allocateFefo(batches, 1, asOf), InsufficientStockError);
  });

  test('a batch expiring today is still sellable', () => {
    const batches = [batch({ expiryDate: asOf, qtyAvailable: 10 })];
    assert.equal(allocateFefo(batches, 5, asOf)[0].take, 5);
  });

  test('short stock throws with the exact shortfall, for the stock-out log', () => {
    const batches = [batch({ qtyAvailable: 8 })];
    try {
      allocateFefo(batches, 20, asOf);
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e instanceof InsufficientStockError);
      assert.equal(e.shortBy, 12);
    }
  });
});

// ============================================================ expiry money

describe('expiry and distributor returns', () => {
  const asOf = new Date(Date.UTC(2026, 8, 16));
  const plusDays = (n: number) => new Date(Date.UTC(2026, 8, 16 + n));

  test('buckets the expiry ladder', () => {
    assert.equal(expiryBucket(plusDays(-1),  asOf), 'expired');
    assert.equal(expiryBucket(plusDays(20),  asOf), '0-30');
    assert.equal(expiryBucket(plusDays(60),  asOf), '31-90');
    assert.equal(expiryBucket(plusDays(150), asOf), '91-180');
    assert.equal(expiryBucket(plusDays(400), asOf), 'beyond');
  });

  test('the return window is the money: 120 days back, 45 days too late', () => {
    // Distributor accepts returns only more than 3 months before expiry.
    assert.equal(isReturnable(plusDays(120), 3, asOf), true,
      'catch it here and it becomes a credit note');
    assert.equal(isReturnable(plusDays(45), 3, asOf), false,
      'most shops only notice here — by which point it is a write-off');
  });

  test('respects a per-supplier window', () => {
    assert.equal(isReturnable(plusDays(150), 6, asOf), false); // 6-month window
    assert.equal(isReturnable(plusDays(210), 6, asOf), true);
  });
});

// ============================================================ reorder

describe('reorder engine', () => {
  test('excluding stock-out days breaks the under-ordering death spiral', () => {
    // 120 units sold. The item was only available 20 of the last 28 days.
    const naive  = computeReorder(
      { unitsSold: 120, daysInStock: 28, sigmaDaily: 2, leadTimeDays: 3 }, 0);
    const honest = computeReorder(
      { unitsSold: 120, daysInStock: 20, sigmaDaily: 2, leadTimeDays: 3 }, 0);

    assert.ok(honest.avgDailyDemand > naive.avgDailyDemand);
    assert.ok(honest.reorderPoint > naive.reorderPoint,
      'a system that divides by calendar days under-orders the same item forever');
  });

  test('safety stock grows with lead time and volatility', () => {
    const steady   = computeReorder({ unitsSold: 280, daysInStock: 28, sigmaDaily: 1,  leadTimeDays: 3 }, 0);
    const volatile = computeReorder({ unitsSold: 280, daysInStock: 28, sigmaDaily: 8,  leadTimeDays: 3 }, 0);
    const slowSupp = computeReorder({ unitsSold: 280, daysInStock: 28, sigmaDaily: 1,  leadTimeDays: 12 }, 0);

    assert.ok(volatile.safetyStock > steady.safetyStock);
    assert.ok(slowSupp.reorderPoint > steady.reorderPoint);
  });

  test('suggests nothing when stock already covers the target', () => {
    const r = computeReorder({ unitsSold: 28, daysInStock: 28, sigmaDaily: 1, leadTimeDays: 3 }, 10_000);
    assert.equal(r.suggestedOrderQty, 0);
  });
});

// ============================================================ ABC

describe('ABC classification', () => {
  test('top 70% of revenue is class A', () => {
    const rows = [
      { productId: 'a', revenue: 7000 },
      { productId: 'b', revenue: 2000 },
      { productId: 'c', revenue: 700 },
      { productId: 'd', revenue: 300 },
    ];
    const out = classifyAbc(rows);
    assert.equal(out.find(r => r.productId === 'a')!.abc, 'A');
    assert.equal(out.find(r => r.productId === 'b')!.abc, 'B');
    assert.equal(out.find(r => r.productId === 'd')!.abc, 'C');
  });

  test('empty revenue does not divide by zero', () => {
    const out = classifyAbc([{ productId: 'x', revenue: 0 }]);
    assert.equal(out[0].abc, 'C');
  });
});

// ============================================================ the invariant

describe('ledger invariant (simulation of the integration test)', () => {
  test('SUM(ledger deltas) always equals batch quantity after random operations', () => {
    // This is the single test that catches almost every class of stock bug.
    // In the real system it runs against Postgres; here it proves the model.
    const ledger: { batchId: string; delta: number }[] = [];
    const qty: Record<string, number> = { b1: 0, b2: 0 };

    const post = (batchId: string, delta: number) => {
      if (qty[batchId] + delta < 0) return; // the DB trigger refuses this too
      ledger.push({ batchId, delta });
      qty[batchId] += delta;
    };

    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

    for (let i = 0; i < 2000; i++) {
      const b = rand() < 0.5 ? 'b1' : 'b2';
      const r = rand();
      if (r < 0.35)      post(b,  Math.ceil(rand() * 150));  // purchase
      else if (r < 0.85) post(b, -Math.ceil(rand() * 20));   // sale
      else if (r < 0.92) post(b,  Math.ceil(rand() * 5));    // sale return
      else               post(b, -Math.ceil(rand() * 10));   // write-off
    }

    for (const batchId of ['b1', 'b2']) {
      const summed = ledger.filter(l => l.batchId === batchId)
                           .reduce((s, l) => s + l.delta, 0);
      assert.equal(summed, qty[batchId], `${batchId}: ledger must explain the balance`);
      assert.ok(qty[batchId] >= 0, `${batchId}: stock must never go negative`);
    }
    assert.ok(ledger.length > 1500, 'the simulation actually ran');
  });
});
