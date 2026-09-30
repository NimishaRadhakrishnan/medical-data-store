/**
 * The money and stock maths for Sri Nachiya Medicals.
 *
 * Every function here is pure so it can be tested to death. A rounding bug in a
 * POS is not a cosmetic problem: it shows up as a till that never balances.
 *
 * Rule followed throughout: money is handled in PAISE as integers wherever an
 * intermediate value could accumulate error, and only converted to rupees at
 * the boundary. Stock is always integer base units.
 */

// ============================================================ product shape

export interface Product {
  id: string;
  name: string;
  genericName?: string;
  compositionKey?: string;
  baseUnit: string;          // 'tablet' | 'ml' | 'piece'
  unitsPerStrip: number;     // 15 tablets in a strip
  stripsPerBox: number;      // 10 strips in a box
  gstRate: number;           // percent, e.g. 5
  drugSchedule: 'OTC' | 'G' | 'H' | 'H1' | 'X';
}

export interface Batch {
  id: string;
  productId: string;
  batchNo: string;
  expiryDate: Date;
  mrp: number;               // rupees, PER STRIP
  purchaseRate: number;      // rupees, PER STRIP
  qtyAvailable: number;      // base units
}

// ============================================================ quantity input

/**
 * Parse what the counter staff types into the quantity box.
 *
 *   "4"    -> 4 tablets          (bare number = base units)
 *   "2s"   -> 2 strips           -> 2 * unitsPerStrip
 *   "1b"   -> 1 box              -> 1 * stripsPerBox * unitsPerStrip
 *   "1.5s" -> half strips are real: people buy 7 of a 15-strip. Rounded to units.
 *
 * Customers buy four tablets, not a strip. Any pharmacy system that cannot sell
 * loose units is unusable on day one, which is why this function exists at all.
 */
export function parseQuantity(input: string, product: Product): number {
  const s = input.trim().toLowerCase();
  if (!s) throw new Error('Enter a quantity');

  const m = s.match(/^(\d+(?:\.\d+)?)\s*(s|str|strip|strips|b|box|boxes|t|tab|tabs)?$/);
  if (!m) throw new Error(`Cannot read quantity "${input}". Try 4, 2s or 1b.`);

  const n = Number(m[1]);
  const unit = m[2] ?? '';
  if (n <= 0) throw new Error('Quantity must be more than zero');

  let base: number;
  if (/^(s|str|strip|strips)$/.test(unit)) {
    base = n * product.unitsPerStrip;
  } else if (/^(b|box|boxes)$/.test(unit)) {
    base = n * product.stripsPerBox * product.unitsPerStrip;
  } else {
    base = n;
  }

  const rounded = Math.round(base);
  if (rounded <= 0) throw new Error('Quantity rounds to zero');
  return rounded;
}

/** Render base units back to something a human reads: 37 -> "2 strips + 7". */
export function formatQuantity(baseUnits: number, product: Product): string {
  const per = product.unitsPerStrip;
  if (per <= 1) return `${baseUnits}`;
  const strips = Math.floor(baseUnits / per);
  const loose = baseUnits % per;
  if (strips === 0) return `${loose}`;
  if (loose === 0) return `${strips} ${strips === 1 ? 'strip' : 'strips'}`;
  return `${strips} ${strips === 1 ? 'strip' : 'strips'} + ${loose}`;
}

// ============================================================ pricing

/**
 * Price of one base unit, in PAISE.
 *
 * MRP is printed per strip. Selling 4 tablets out of a 15-tablet strip at
 * ₹31.50 means 4 * 210 paise = ₹8.40. Doing this in rupees with floats gives
 * 8.400000000000002, and over a day of billing the till drifts.
 */
export function unitPricePaise(batch: Batch, product: Product): number {
  const mrpPaise = Math.round(batch.mrp * 100);
  if (product.unitsPerStrip <= 1) return mrpPaise;
  return mrpPaise / product.unitsPerStrip; // kept fractional; rounded once, at the line
}

export interface LineInput {
  product: Product;
  batch: Batch;
  qtyBase: number;
  discountPct?: number;
}

export interface LineTotals {
  grossPaise: number;
  discountPaise: number;
  /** net = gross - discount. This is MRP-inclusive: GST is already inside it. */
  netPaise: number;
  taxablePaise: number;
  gstPaise: number;
  cgstPaise: number;
  sgstPaise: number;
}

/**
 * MRP in India is tax-INCLUSIVE. You cannot add GST on top of MRP — you must
 * back it out. taxable = net / (1 + rate/100). Getting this backwards inflates
 * every bill by the GST rate and is the single commonest bug in student POS
 * projects.
 */
export function computeLine(line: LineInput): LineTotals {
  const { product, batch, qtyBase } = line;
  const discountPct = line.discountPct ?? 0;
  if (discountPct < 0 || discountPct > 100) throw new Error('Discount must be 0-100%');

  const gross = Math.round(unitPricePaise(batch, product) * qtyBase);
  const discount = Math.round((gross * discountPct) / 100);
  const net = gross - discount;

  const taxable = Math.round((net * 100) / (100 + product.gstRate));
  const gst = net - taxable;

  // Intra-state (both parties in Tamil Nadu) splits GST into CGST + SGST.
  // An odd paisa goes to CGST by convention.
  const sgst = Math.floor(gst / 2);
  const cgst = gst - sgst;

  return {
    grossPaise: gross,
    discountPaise: discount,
    netPaise: net,
    taxablePaise: taxable,
    gstPaise: gst,
    cgstPaise: cgst,
    sgstPaise: sgst,
  };
}

export interface BillTotals {
  subtotalPaise: number;
  discountPaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  roundOffPaise: number;
  payablePaise: number;
  gstByRate: Record<string, { taxablePaise: number; gstPaise: number }>;
}

/** Sum the lines, then round the final payable to the nearest rupee. */
export function computeBill(lines: LineInput[]): BillTotals {
  const totals: BillTotals = {
    subtotalPaise: 0, discountPaise: 0, taxablePaise: 0,
    cgstPaise: 0, sgstPaise: 0, roundOffPaise: 0, payablePaise: 0,
    gstByRate: {},
  };

  for (const line of lines) {
    const t = computeLine(line);
    totals.subtotalPaise += t.grossPaise;
    totals.discountPaise += t.discountPaise;
    totals.taxablePaise  += t.taxablePaise;
    totals.cgstPaise     += t.cgstPaise;
    totals.sgstPaise     += t.sgstPaise;

    // HSN-wise GST summary is a legal requirement on the invoice.
    const key = line.product.gstRate.toFixed(2);
    const bucket = totals.gstByRate[key] ?? { taxablePaise: 0, gstPaise: 0 };
    bucket.taxablePaise += t.taxablePaise;
    bucket.gstPaise     += t.gstPaise;
    totals.gstByRate[key] = bucket;
  }

  const net = totals.subtotalPaise - totals.discountPaise;
  const payable = Math.round(net / 100) * 100;   // nearest rupee
  totals.roundOffPaise = payable - net;
  totals.payablePaise = payable;
  return totals;
}

export const rupees = (paise: number): string =>
  (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ============================================================ FEFO

export interface Allocation {
  batch: Batch;
  take: number;
}

export class InsufficientStockError extends Error {
  shortBy: number;
  constructor(shortBy: number) {
    super(`Insufficient sellable stock: short by ${shortBy} units`);
    this.name = 'InsufficientStockError';
    this.shortBy = shortBy;
  }
}

/**
 * First-Expiry-First-Out. Always sell the batch that dies soonest.
 *
 * Expired batches are excluded unconditionally. Not a warning, not an override:
 * a pharmacy that can sell expired stock by clicking through a dialog will,
 * eventually, sell expired stock.
 */
export function allocateFefo(batches: Batch[], qtyBase: number, asOf = new Date()): Allocation[] {
  if (qtyBase <= 0) throw new Error('Quantity must be more than zero');

  const sellable = batches
    .filter(b => b.qtyAvailable > 0 && b.expiryDate >= startOfDay(asOf))
    .sort((a, b) => a.expiryDate.getTime() - b.expiryDate.getTime());

  const out: Allocation[] = [];
  let remaining = qtyBase;

  for (const batch of sellable) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, batch.qtyAvailable);
    out.push({ batch, take });
    remaining -= take;
  }

  if (remaining > 0) throw new InsufficientStockError(remaining);
  return out;
}

const startOfDay = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export const daysUntil = (expiry: Date, asOf = new Date()): number =>
  Math.floor((startOfDay(expiry).getTime() - startOfDay(asOf).getTime()) / 86_400_000);

export type ExpiryBucket = 'expired' | '0-30' | '31-90' | '91-180' | 'beyond';

export function expiryBucket(expiry: Date, asOf = new Date()): ExpiryBucket {
  const d = daysUntil(expiry, asOf);
  if (d < 0) return 'expired';
  if (d <= 30) return '0-30';
  if (d <= 90) return '31-90';
  if (d <= 180) return '91-180';
  return 'beyond';
}

/**
 * Can this batch still go back to the distributor?
 *
 * This is the feature that puts money back in the owner's pocket. Most shops
 * notice expiry at 45 days, by which point returns are refused and the stock is
 * a write-off. Catching it at 120 days turns the same stock into a credit note.
 */
export function isReturnable(
  expiry: Date,
  supplierReturnWindowMonths: number,
  asOf = new Date(),
): boolean {
  const cutoff = new Date(startOfDay(asOf));
  cutoff.setUTCMonth(cutoff.getUTCMonth() + supplierReturnWindowMonths);
  return startOfDay(expiry) > cutoff;
}

// ============================================================ reorder point

export interface DemandStats {
  /** Units sold in the window, counting only days the item was ACTUALLY in stock. */
  unitsSold: number;
  daysInStock: number;
  sigmaDaily: number;
  leadTimeDays: number;
  /** How often the owner places an order with this distributor. */
  reviewPeriodDays?: number;
}

export interface ReorderResult {
  avgDailyDemand: number;
  safetyStock: number;
  reorderPoint: number;
  suggestedOrderQty: number;
}

/** z for a 95% service level. Stocking out of a BP tablet is not a small failure. */
const Z_95 = 1.65;

/**
 * ROP = avg daily demand x lead time + safety stock.
 *
 * The important subtlety is daysInStock, NOT calendar days. If the item was out
 * of stock for 6 of the last 28 days, dividing by 28 understates demand, the
 * reorder point comes out too low, and the item stocks out again — forever.
 * Dividing by days-in-stock breaks that loop.
 */
export function computeReorder(stats: DemandStats, onHand: number): ReorderResult {
  const days = Math.max(stats.daysInStock, 1);
  const avgDaily = stats.unitsSold / days;

  const safety = Z_95 * stats.sigmaDaily * Math.sqrt(Math.max(stats.leadTimeDays, 0));
  const rop = avgDaily * stats.leadTimeDays + safety;

  const review = stats.reviewPeriodDays ?? 7;
  const target = rop + avgDaily * review;
  const order = Math.max(0, Math.ceil(target - onHand));

  return {
    avgDailyDemand: round2(avgDaily),
    safetyStock: Math.ceil(safety),
    reorderPoint: Math.ceil(rop),
    suggestedOrderQty: order,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * ABC by revenue contribution. A = top 70%, B = next 20%, C = the tail.
 * Drives rack layout: A-class items belong within arm's reach of the counter.
 */
export function classifyAbc<T extends { productId: string; revenue: number }>(
  rows: T[],
): Array<T & { abc: 'A' | 'B' | 'C' }> {
  const sorted = [...rows].sort((a, b) => b.revenue - a.revenue);
  const total = sorted.reduce((s, r) => s + r.revenue, 0);
  if (total <= 0) return sorted.map(r => ({ ...r, abc: 'C' as const }));

  let cumulative = 0;
  return sorted.map(r => {
    cumulative += r.revenue;
    const share = cumulative / total;
    const abc = share <= 0.7 ? 'A' : share <= 0.9 ? 'B' : 'C';
    return { ...r, abc };
  });
}
