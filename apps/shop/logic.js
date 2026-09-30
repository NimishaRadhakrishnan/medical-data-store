/**
 * What the shop actually does: sell, receive stock, correct prices, and count
 * what happened. Every figure below is worked out here, once, so no two screens
 * can disagree.
 *
 * Money is paise (integers). Quantity is base units (tablets, capsules,
 * bottles). MRP already includes GST, so GST is divided out of it and never
 * added on top — charging above the printed MRP is an offence.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

import { all, get, run, tx, audit, today } from './db.js';

// ---------------------------------------------------------------- money

/** What the customer pays for `qty` base units out of a pack priced `mrpPaise`. */
export const grossFor = (mrpPaise, unitsPerStrip, qty) =>
  Math.round(mrpPaise * qty / Math.max(unitsPerStrip, 1));

/** GST comes OUT of the MRP: taxable = gross ÷ (1 + rate). */
export function splitGst(grossPaise, gstRate) {
  const taxable = Math.round(grossPaise * 100 / (100 + gstRate));
  return { taxable, gst: grossPaise - taxable };
}

/** What that quantity cost the shop, from the invoice price, before GST. */
export const costFor = (costPaise, unitsPerStrip, qty) =>
  Math.round(costPaise * qty / Math.max(unitsPerStrip, 1));

/* Profit on one pack: GST comes out of the MRP first, because in India the MRP
   already includes it. Nothing is added on top of either side. */
export const profitPerPack = (mrpPaise, gstRate, costPaise) =>
  splitGst(mrpPaise, gstRate).taxable - costPaise;

// ---------------------------------------------------------------- catalogue

export const settings = () => get('select * from shop_settings where id = 1');

// ---------------------------------------------------------------- the PIN

/*
 * A four-digit PIN in front of the few actions that can do damage — cancelling
 * a bill, changing a price, deleting something, restoring a backup — and in
 * front of what the shop pays for its stock. Billing is never behind it.
 *
 * It is a guard against someone idly pressing things while the owner is in the
 * back of the shop. It is not protection against a person who has the
 * computer: the database file sits beside the app and can simply be read. The
 * things that actually protect the shop are the Windows password, where the
 * machine is placed, and the backup kept off the premises.
 */

const PIN_KEYLEN = 32;

/** Only the digits count, so a stray space cannot lock the owner out. */
const tidyPin = pin => String(pin ?? '').replace(/\D/g, '');

export const hasPin = () => {
  const s = settings();
  return !!(s?.pin_hash && s?.pin_salt);
};

export function setPin(pin) {
  const p = tidyPin(pin);
  if (p.length !== 4) throw new ShopError('The PIN must be four digits.');
  if (/^(\d)\1{3}$/.test(p)) throw new ShopError('Four the same is too easy to guess. Choose another.');
  if (p === '1234' || p === '0000') throw new ShopError('That PIN is too easy to guess. Choose another.');
  if (!settings()) throw new ShopError('Set the shop details first.');

  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(p, salt, PIN_KEYLEN).toString('hex');
  run('update shop_settings set pin_hash = ?, pin_salt = ? where id = 1', hash, salt);
  audit('pin.set', 'shop', 1, null);           // never the PIN itself, not even hashed
  return { ok: true };
}

/** Compared in constant time, so the answer cannot be guessed a digit at a time. */
export function verifyPin(pin) {
  const s = settings();
  if (!s?.pin_hash || !s?.pin_salt) return true;         // no PIN set: nothing is locked
  const p = tidyPin(pin);
  if (p.length !== 4) return false;
  const tried = scryptSync(p, s.pin_salt, PIN_KEYLEN);
  const stored = Buffer.from(s.pin_hash, 'hex');
  return stored.length === tried.length && timingSafeEqual(stored, tried);
}

export function clearPin(currentPin) {
  if (hasPin() && !verifyPin(currentPin)) throw new ShopError('That PIN is not right.');
  run('update shop_settings set pin_hash = null, pin_salt = null where id = 1');
  audit('pin.clear', 'shop', 1, null);
  return { ok: true };
}

/**
 * The shop's details as the screens may see them. The stored PIN never leaves
 * this computer's memory — not even as a hash — so it is stripped here rather
 * than relied upon to be ignored.
 */
export function publicSettings() {
  const s = settings();
  if (!s) return null;
  const { pin_hash, pin_salt, ...rest } = s;
  return { ...rest, hasPin: !!(pin_hash && pin_salt) };
}

export function searchProducts(term, limit = 8) {
  const t = `%${(term || '').trim().toLowerCase()}%`;
  return all(`
    select s.*, (select min(mrp_paise) from batches b
                  where b.product_id = s.product_id and b.qty > 0 and b.expiry >= ?4) as mrp_paise
      from v_stock s
     where s.is_active = 1
       and (lower(s.name) like ?1 or lower(coalesce(s.generic_name,'')) like ?1 or lower(coalesce(s.manufacturer,'')) like ?1)
     order by case when lower(s.name) like ?2 then 0 else 1 end, s.name
     limit ?3`, t, `${(term || '').trim().toLowerCase()}%`, limit, today());
}

export const productById = id => get('select * from products where id = ?', id);
export const batchesOf = id => all(
  `select b.*, s.name as supplier from batches b left join suppliers s on s.id = b.supplier_id
    where b.product_id = ? order by b.expiry`, id);

/** Same medicine and strength, in stock, for when something has run out. */
export const substitutesFor = id => all(`
  select s.* from v_stock s join products p on p.id = s.product_id
   where p.composition_key = (select composition_key from products where id = ?)
     and p.id <> ? and s.units > 0 and p.is_active = 1`, id, id);

// ---------------------------------------------------------------- selling

export class ShopError extends Error {
  constructor(message, code = 'invalid') { super(message); this.code = code; }
}

/*
 * Sensible ceilings for anything typed into the app.
 *
 * Not arbitrary tidiness: SQLite stores a 64-bit integer happily, but Node
 * cannot read one back above 2^53 and throws where nothing expects it. A slip
 * on the number pad — an extra row of zeros in "Free strips" — used to store a
 * quantity that could never be read again, and from that moment every screen
 * in the shop answered "something went wrong", including the one that is
 * supposed to diagnose trouble. The shop could only be recovered from a backup.
 *
 * So a quantity is capped at ten million units and a price at ten crore rupees.
 * Both are far beyond any real pharmacy and far below where the arithmetic
 * stops being exact.
 */
export const MAX_UNITS = 10_000_000;
export const MAX_PAISE = 10_000_000_00;

/*
 * The database refuses things too, and its refusals are written for the
 * shopkeeper. They arrive as ordinary errors, so they are recognised here and
 * passed on as themselves rather than being buried under "something went
 * wrong". Anything genuinely unexpected still gets the generic message, since
 * an internal fault is not something a counter can act on.
 */
const REFUSALS = [
  /cannot be sold/i, /cannot be changed/i, /cannot be deleted/i, /Not enough stock/i,
  /needs the doctor and patient/i, /More is being returned/i, /has expired/i,
];

export function isRefusal(err) {
  const m = String(err?.message ?? '');
  if (REFUSALS.some(re => re.test(m))) return true;
  // A uniqueness clash is a duplicate the owner can fix, not a fault.
  return /UNIQUE constraint failed/i.test(m);
}

export function plainMessage(err) {
  const m = String(err?.message ?? '');
  if (err instanceof ShopError) return m;
  if (/UNIQUE constraint failed: suppliers\.name/i.test(m))
    return 'A distributor with that name is already in the list.';
  if (/UNIQUE constraint failed: products/i.test(m))
    return 'A medicine with that name is already in the list.';
  if (/UNIQUE constraint failed/i.test(m))
    return 'That has already been entered.';
  // A trigger's own sentence, with SQLite's prefix taken off.
  return m.replace(/^.*?(?:constraint failed|abort at \d+ in \[[^\]]*\]):?\s*/is, '').trim() || m;
}

/** A whole number within reach, or a plain sentence saying what is wrong. */
export function whole(value, what, { min = 0, max = MAX_UNITS } = {}) {
  const n = Number(value);
  if (value === '' || value === null || value === undefined || !Number.isFinite(n))
    throw new ShopError(`${what} must be a number.`);
  if (!Number.isInteger(n)) throw new ShopError(`${what} must be a whole number.`);
  if (n < min) throw new ShopError(`${what} cannot be less than ${min}.`);
  if (n > max) throw new ShopError(`${what} looks wrong — ${n.toLocaleString('en-IN')} is too large. Check the figure.`);
  return n;
}

/** The same, for money in paise. */
export const money = (value, what, opts = {}) => whole(value, what, { max: MAX_PAISE, ...opts });

/**
 * First expiry, first out. Expired batches are never included — the database
 * refuses them too, but the counter should never be offered one.
 */
export function allocate(productId, qty, preferBatchId = null) {
  const batches = all(
    `select * from batches where product_id = ? and qty > 0 and expiry >= ?
      order by expiry, id`, productId, today());

  /* When the counter scans one of the shop's own labels, the strip in the
     customer's hand is a known batch. Sell that one first, so the expiry
     printed on the bill is the expiry actually being handed over. Anything
     left over still comes off the oldest stock, and an expired batch is no
     more sellable for having been scanned. */
  if (preferBatchId) {
    const i = batches.findIndex(b => b.id === Number(preferBatchId));
    if (i > 0) batches.unshift(batches.splice(i, 1)[0]);
  }

  const out = [];
  let left = qty;
  for (const b of batches) {
    if (left <= 0) break;
    const take = Math.min(left, b.qty);
    out.push({ batch: b, take });
    left -= take;
  }
  if (left > 0) {
    const p = productById(productId);
    throw new ShopError(`Only ${stockOf(productId)} ${p.base_unit}s of ${p.name} left in stock.`, 'short');
  }
  return out;
}

export const stockOf = productId =>
  get('select coalesce(sum(qty), 0) as n from batches where product_id = ?', productId).n;

function nextNumber(table, column, prefix) {
  const row = get(`select ${column} as v from ${table} order by id desc limit 1`);
  const n = row ? Number(String(row.v).split('-').pop()) + 1 : 1;
  return `${prefix}-${String(n).padStart(6, '0')}`;
}

function priceLines(items) {
  const lines = [];
  for (const item of items) {
    const p = productById(item.productId);
    if (!p) throw new ShopError('That medicine is not in the list any more.');
    const qty = Number(item.qty);
    if (!Number.isInteger(qty) || qty <= 0) throw new ShopError(`Enter how many ${p.base_unit}s of ${p.name}.`);
    // First expiry first: one line per batch the quantity comes out of.
    for (const { batch, take } of allocate(p.id, qty, item.batchId ?? null)) {
      const gross = grossFor(batch.mrp_paise, p.units_per_strip, take);
      const { taxable, gst } = splitGst(gross, p.gst_rate);
      /* `key` says which line of the screen's bill this came from. One entry
         can become several lines when the quantity spans batches, so without
         it the screen cannot tell which line to take off when the × is
         pressed. It is passed straight back, never used to price anything. */
      lines.push({ p, batch, qty: take, gross, taxable, gst, key: item.key ?? null,
                   cost: costFor(batch.cost_paise, p.units_per_strip, take) });
    }
  }
  return lines;
}

function billTotals(lines, discountPaise) {
  const gross = lines.reduce((s, l) => s + l.gross, 0);
  const discount = Math.max(0, Math.min(money(discountPaise ?? 0, 'The discount'), gross));
  const net = gross - discount;
  const cfg = settings();
  const total = cfg?.round_off ? Math.round(net / 100) * 100 : net;

  /* A discount reduces the tax with it: GST is charged on what the customer
     actually pays. Summing the lines' own tax would leave the printed bill
     saying taxable + GST is more than the total, and would overstate the GST
     owed on the return. Each line is reduced in proportion and the tax split
     out of the reduced figure. */
  let taxable = 0, gst = 0;
  for (const l of lines) {
    const after = discount ? Math.round(l.gross * net / gross) : l.gross;
    const split = splitGst(after, l.p.gst_rate);
    taxable += split.taxable;
    gst += split.gst;
  }
  return { gross, discount, net, total, taxable, gst };
}

/**
 * Price a basket without saving anything, so the counter screen shows the
 * same figures the bill will carry — worked out by the same code, against the
 * same batches.
 */
export function quoteBill({ items = [], discountPaise = 0 }) {
  const lines = priceLines(items);
  const t = billTotals(lines, discountPaise);
  return {
    lines: lines.map(l => ({
      key: l.key,
      productId: l.p.id, name: l.p.name, generic: l.p.generic_name, schedule: l.p.drug_schedule,
      baseUnit: l.p.base_unit, unitsPerStrip: l.p.units_per_strip,
      batchId: l.batch.id, batchNo: l.batch.batch_no, expiry: l.batch.expiry,
      qty: l.qty, mrp_paise: l.batch.mrp_paise, gross_paise: l.gross, gst_rate: l.p.gst_rate,
    })),
    ...t,
    needsRx: lines.some(l => l.p.drug_schedule === 'H1'),
  };
}

/**
 * Save a bill: the whole thing in one transaction — the bill, its lines and
 * every stock movement land together or not at all.
 *
 * `clientUuid` is the till's own id for this bill. If the same one arrives
 * twice — a double click, or a retry after a hiccup — the bill already saved
 * is returned instead of a second one being written.
 */
export function createBill(input) {
  const { items = [], payMode = 'cash', clientUuid = null, discountPaise = 0 } = input;

  if (clientUuid) {
    const existing = get('select * from sales where client_uuid = ?', clientUuid);
    if (existing) return { ...billById(existing.id), duplicate: true };
  }
  if (!items.length) throw new ShopError('Add at least one medicine to the bill.');
  if (!['cash', 'upi', 'card', 'credit'].includes(payMode)) throw new ShopError('Choose how the customer paid.');

  return tx(() => {
    // Everything is priced first, so nothing is written if anything is wrong.
    const lines = priceLines(items);
    const { discount, total, taxable, gst, net } = billTotals(lines, discountPaise);

    const billNo = nextNumber('sales', 'bill_no', settings()?.bill_prefix || 'SNM');
    const sale = run(`insert into sales
      (bill_no, client_uuid, business_date, customer_name, customer_phone, buyer_gstin,
       doctor_name, patient_name, patient_address,
       taxable_paise, gst_paise, discount_paise, round_paise, total_paise, pay_mode)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      billNo, clientUuid, today(), input.customerName ?? null, input.customerPhone ?? null,
      input.buyerGstin ?? null, input.doctorName ?? null, input.patientName ?? null, input.patientAddress ?? null,
      taxable, gst, discount, total - net, total, payMode);
    const saleId = Number(sale.lastInsertRowid);

    for (const l of lines) {
      run(`insert into sale_items
        (sale_id, product_id, batch_id, qty, mrp_paise, cost_paise, cost_total_paise,
         gst_rate, gross_paise, taxable_paise, gst_paise)
        values (?,?,?,?,?,?,?,?,?,?,?)`,
        saleId, l.p.id, l.batch.id, l.qty, l.batch.mrp_paise, l.batch.cost_paise, l.cost, l.p.gst_rate,
        l.gross, l.taxable, l.gst);
      // The stock only moves here, through the ledger.
      run(`insert into stock_ledger (product_id, batch_id, delta, reason, ref_type, ref_id)
           values (?,?,?,'sale','sale',?)`, l.p.id, l.batch.id, -l.qty, saleId);
    }
    audit('bill.create', 'sale', saleId, { billNo, total, lines: lines.length });
    return billById(saleId);
  });
}

export function billById(id) {
  const sale = get('select * from sales where id = ?', id);
  if (!sale) return null;
  const items = all(`
    select si.*, p.name, p.generic_name, p.base_unit, p.units_per_strip, p.drug_schedule,
           b.batch_no, b.expiry
      from sale_items si join products p on p.id = si.product_id join batches b on b.id = si.batch_id
     where si.sale_id = ? order by si.id`, id);
  const returns = all(`
    select r.*, (select sum(refund_paise) from sale_return_items where return_id = r.id) as refund_paise
      from sale_returns r where r.sale_id = ? order by r.id`, id);
  return { ...sale, items, returns };
}

export const findBill = billNo => {
  const s = get('select id from sales where bill_no = ?', billNo);
  return s ? billById(s.id) : null;
};

export const recentBills = (limit = 25) => all(
  `select id, bill_no, business_date, created_at, total_paise, pay_mode, is_cancelled
     from sales order by id desc limit ?`, limit);

/** Cancelling puts every unit back, through the ledger, and leaves the bill on record. */
export function cancelBill(id, reason) {
  return tx(() => {
    const sale = get('select * from sales where id = ?', id);
    if (!sale) throw new ShopError('No such bill.');
    if (sale.is_cancelled) throw new ShopError('That bill is already cancelled.');
    if (get('select count(*) as n from sale_returns where sale_id = ?', id).n)
      throw new ShopError('This bill has a return against it, so it cannot be cancelled.');
    if (!reason || reason.trim().length < 3) throw new ShopError('Say why the bill is being cancelled.');

    for (const l of all('select * from sale_items where sale_id = ?', id)) {
      run(`insert into stock_ledger (product_id, batch_id, delta, reason, ref_type, ref_id, note)
           values (?,?,?,'cancel','sale',?,?)`, l.product_id, l.batch_id, l.qty, id, reason);
    }
    run(`update sales set is_cancelled = 1, cancelled_at = datetime('now','localtime'), cancel_reason = ?
          where id = ?`, reason.trim(), id);
    audit('bill.cancel', 'sale', id, { reason });
    return billById(id);
  });
}

/** A customer brings something back: a credit note, and the stock returns. */
export function createReturn({ saleId, items = [], refundMode = 'cash', reason = '' }) {
  if (!items.length) throw new ShopError('Choose what is being returned.');
  return tx(() => {
    const sale = get('select * from sales where id = ?', saleId);
    if (!sale) throw new ShopError('No such bill.');
    if (sale.is_cancelled) throw new ShopError('That bill was cancelled.');

    const returnNo = nextNumber('sale_returns', 'return_no', `${settings()?.bill_prefix || 'SNM'}-CN`);
    const ret = run(`insert into sale_returns (return_no, sale_id, business_date, refund_mode, reason)
                     values (?,?,?,?,?)`, returnNo, saleId, today(), refundMode, reason || null);
    const returnId = Number(ret.lastInsertRowid);

    /* The bill's gross is before the round-off, but the customer handed over
       the rounded total. Refunding the gross would give back up to 50 paise
       more than was taken on every fully returned bill, and the credit note
       would not match the invoice. Refunds are worked out from what was
       actually paid. */
    const billed = sale.taxable_paise + sale.gst_paise;      // after any discount, before rounding
    const paidRatio = billed > 0 ? sale.total_paise / billed : 1;

    let refundTotal = 0;
    for (const item of items) {
      const line = get('select * from sale_items where id = ? and sale_id = ?', item.saleItemId, saleId);
      if (!line) throw new ShopError('That medicine is not on this bill.');
      const qty = whole(item.qty, 'The quantity coming back', { min: 1 });

      const already = get(`select coalesce(sum(qty), 0) as n from sale_return_items where sale_item_id = ?`,
                          line.id).n;
      if (already + qty > line.qty) {
        const left = line.qty - already;
        throw new ShopError(left > 0
          ? `Only ${left} of that line can still be returned — ${already} already came back.`
          : 'That line has already been returned in full.');
      }

      const refund = Math.round(line.gross_paise * qty / line.qty * paidRatio);
      const { taxable, gst } = splitGst(refund, line.gst_rate);
      run(`insert into sale_return_items (return_id, sale_item_id, qty, refund_paise, taxable_paise, gst_paise)
           values (?,?,?,?,?,?)`, returnId, line.id, qty, refund, taxable, gst);
      run(`insert into stock_ledger (product_id, batch_id, delta, reason, ref_type, ref_id)
           values (?,?,?,'sale_return','return',?)`, line.product_id, line.batch_id, qty, returnId);
      refundTotal += refund;
    }
    audit('return.create', 'sale_return', returnId, { returnNo, refundTotal });
    return { id: returnId, return_no: returnNo, refund_paise: refundTotal };
  });
}

export function logStockout(term, productId = null) {
  run('insert into stockout_log (search_term, product_id) values (?, ?)', term, productId);
  return { ok: true };
}

// ---------------------------------------------------------------- buying stock

/**
 * Is this name already taken? Compared the way a person would read it, not the
 * way a computer does: spacing and capitals are ignored, so "dolo 650" and
 * "Dolo  650" are the same medicine.
 */
/** The shop's own date, for the importer's expiry checks. */
export const todayForImport = () => today();

/** A name as it should be stored: no stray spaces at the ends or in the middle. */
export const tidyName = name => String(name ?? '').trim().replace(/\s+/g, ' ');

export const productNamed = (name, exceptId = null) =>
  get(`select * from products
        where lower(trim(name)) = lower(?) and id is not ?
        order by is_active desc, id limit 1`, tidyName(name).toLowerCase(), exceptId);

export function addProduct(p) {
  if (!p.name || !p.name.trim()) throw new ShopError('Enter the medicine name.');
  /* Two medicines with one name is the quiet kind of mistake: the stock splits
     in half, the counter shows the same name twice, and the reminder to
     reorder never comes because neither half looks low. Refuse it here, and
     say where the first one is. */
  const clash = productNamed(p.name);
  if (clash) {
    throw new ShopError(clash.is_active
      ? `${clash.name} is already in the list. Add the new delivery to it instead of adding the medicine again.`
      : `${clash.name} is in the list but archived. Open Medicines, find it, and bring it back rather than adding a second one.`);
  }
  const units = whole(p.unitsPerStrip ?? 1, 'Units per strip', { min: 1, max: 100_000 });
  const r = run(`insert into products
      (name, generic_name, composition_key, manufacturer, base_unit, units_per_strip, strips_per_box,
       hsn_code, gst_rate, drug_schedule, rack, reorder_packs, cold_storage)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    tidyName(p.name), p.genericName ?? null, p.compositionKey ?? null, p.manufacturer ?? null,
    p.baseUnit ?? 'tablet', units, Number(p.stripsPerBox ?? 1), p.hsn ?? '3004',
    whole(p.gstRate ?? 5, 'GST %', { max: 100 }), p.schedule ?? 'OTC', p.rack ?? null,
    whole(p.reorderPacks ?? 0, 'The reminder level'), p.coldStorage ? 1 : 0);
  audit('product.add', 'product', Number(r.lastInsertRowid), { name: p.name });
  return productById(Number(r.lastInsertRowid));
}

const PRODUCT_FIELDS = {
  name: 'name', genericName: 'generic_name', compositionKey: 'composition_key',
  manufacturer: 'manufacturer', hsn: 'hsn_code', gstRate: 'gst_rate', schedule: 'drug_schedule',
  rack: 'rack', reorderPacks: 'reorder_packs', coldStorage: 'cold_storage',
  unitsPerStrip: 'units_per_strip', stripsPerBox: 'strips_per_box', baseUnit: 'base_unit',
};

export function updateProduct(id, patch) {
  const before = productById(id);
  if (!before) throw new ShopError('No such medicine.');
  const sets = [], args = [], changes = {};
  for (const [key, column] of Object.entries(PRODUCT_FIELDS)) {
    if (patch[key] === undefined) continue;
    let value = patch[key];
    if (['gstRate', 'reorderPacks', 'unitsPerStrip', 'stripsPerBox'].includes(key)) value = Number(value);
    if (key === 'coldStorage') value = value ? 1 : 0;
    if (key === 'name') {
      value = tidyName(value);
      if (!value) throw new ShopError('The name cannot be empty.');
      // Renaming onto another medicine's name would split the stock just as
      // surely as adding a duplicate.
      const clash = productNamed(value, id);
      if (clash) throw new ShopError(`${clash.name} is already in the list. Two medicines cannot share a name.`);
    }
    if (value === before[column]) continue;
    sets.push(`${column} = ?`); args.push(value);
    changes[key] = { from: before[column], to: value };
  }
  if (!sets.length) return { product: before, changed: {} };
  run(`update products set ${sets.join(', ')}, updated_at = datetime('now','localtime') where id = ?`, ...args, id);
  audit('product.update', 'product', id, changes);
  return { product: productById(id), changed: changes };
}

/** Archive, never delete: old bills point at the medicine. */
export function archiveProduct(id, archived = true) {
  const p = productById(id);
  if (!p) throw new ShopError('No such medicine.');
  if (archived && stockOf(id) > 0)
    throw new ShopError('This medicine still has stock. Sell it, or write it off, before archiving.');
  run(`update products set is_active = ?, archived_at = case when ? then datetime('now','localtime') end
        where id = ?`, archived ? 0 : 1, archived ? 1 : 0, id);
  audit(archived ? 'product.archive' : 'product.restore', 'product', id, null);
  return productById(id);
}

/**
 * A delivery from the distributor. Each line becomes (or joins) a batch, and
 * the stock arrives through the ledger.
 *
 * Free packs lower what each pack really cost, so the profit figures stay true.
 */
/**
 * A discount as a whole number of hundredths of a percent: 4 -> 400, 8.5 -> 850.
 * Kept this way so no discount is ever stored as a rounded-off fraction.
 */
export function discountBp(pct) {
  const n = Number(pct ?? 0);
  if (!Number.isFinite(n) || n < 0 || n >= 100)
    throw new ShopError('The discount must be between 0 and 99%.');
  return Math.round(n * 100);
}

export function receiveDelivery({ supplierId, invoiceNo = null, invoiceDate = null,
                                  discountPct = 0, lines = [] }) {
  if (!supplierId) throw new ShopError('Choose the distributor.');
  if (!lines.length) throw new ShopError('Add at least one medicine to the delivery.');
  const invoiceBp = discountBp(discountPct);

  /* The same invoice entered twice doubles the stock and the money owed, and
     there is no way to reverse a delivery. A bill is protected by the till's
     own id; a delivery is protected by the invoice number, which the
     distributor has already made unique. Entering it again is refused rather
     than quietly accepted — the owner can check the Deliveries report and see
     the one already there. */
  if (invoiceNo && String(invoiceNo).trim()) {
    const seen = get(`select p.id, p.business_date, s.name as supplier from purchases p
                       left join suppliers s on s.id = p.supplier_id
                      where lower(trim(p.invoice_no)) = lower(?) and p.supplier_id = ?`,
                     String(invoiceNo).trim().toLowerCase(), supplierId);
    if (seen) throw new ShopError(
      `Invoice ${String(invoiceNo).trim()} from ${seen.supplier || 'this distributor'} was already entered on ` +
      `${seen.business_date}. Check Reports → Deliveries before entering it again.`);
  }

  return tx(() => {
    const purchase = run(`insert into purchases (supplier_id, invoice_no, invoice_date, business_date, discount_bp)
                          values (?,?,?,?,?)`, supplierId, invoiceNo, invoiceDate, today(), invoiceBp);
    const purchaseId = Number(purchase.lastInsertRowid);
    let total = 0;

    for (const line of lines) {
      const p = productById(line.productId);
      if (!p) throw new ShopError('That medicine is not in the list.');
      /* Archived medicines are hidden from the counter and from the stock
         reports, so stock received against one becomes real stock nobody can
         find or sell. Refuse it and say how to fix it. */
      if (!p.is_active) throw new ShopError(
        `${p.name} is archived, so stock cannot be added to it. Open Medicines, bring it back, then save this delivery.`);
      const packs = whole(line.packs, `The number of ${p.name} packs`, { min: 1 });
      const free = whole(line.freePacks ?? 0, `Free packs of ${p.name}`);
      const mrp = money(line.mrpPaise, `The MRP of ${p.name}`, { min: 1 });
      // The stock this line creates must also stay within reach.
      whole((packs + free) * p.units_per_strip, `The quantity of ${p.name}`, { min: 1 });
      /* `costPaise` is the Trade Price as printed. The invoice then takes its
         "Dis %" off that, and it is the discounted figure the shop actually
         pays — so that, not the printed one, is what every margin must be
         worked out from. A line may carry its own discount; otherwise it takes
         the invoice's. */
      const listCost = money(line.costPaise, `The trade price of ${p.name}`);
      const lineBp = line.discountPct === undefined || line.discountPct === null || line.discountPct === ''
        ? invoiceBp : discountBp(line.discountPct);
      const cost = Math.round(listCost * (10000 - lineBp) / 10000);
      /* The discount is taken off the line's whole value and rounded once,
         which is how the distributor works it out. Discounting each pack and
         then multiplying rounds a second time and drifts a few paise away from
         the total printed on the invoice. */
      const linePaise = Math.round(listCost * packs * (10000 - lineBp) / 10000);
      money(linePaise, `The value of the ${p.name} line`);
      if (cost > mrp) throw new ShopError(
        `${p.name}: cost ₹${(cost / 100).toFixed(2)} is more than the MRP ₹${(mrp / 100).toFixed(2)}. Check the invoice.`);
      if (!line.batchNo || !String(line.batchNo).trim()) throw new ShopError(`Enter the batch number for ${p.name}.`);
      if (!line.expiry || !/^\d{4}-\d{2}-\d{2}$/.test(line.expiry)) throw new ShopError(`Enter the expiry for ${p.name}.`);
      if (line.expiry < today()) throw new ShopError(
        `${p.name} batch ${line.batchNo} has already expired. Do not take it into stock.`);

      // What each pack on the shelf really cost: what was paid for the line,
      // shared across every pack that arrived — the free ones included.
      const realCost = Math.round(linePaise / (packs + free));
      const batchNo = String(line.batchNo).trim().toUpperCase();
      let batch = get('select * from batches where product_id = ? and batch_no = ? and expiry = ?',
                      p.id, batchNo, line.expiry);
      if (!batch) {
        const r = run(`insert into batches (product_id, batch_no, expiry, mrp_paise, cost_paise, supplier_id)
                       values (?,?,?,?,?,?)`, p.id, batchNo, line.expiry, mrp, realCost, supplierId);
        batch = get('select * from batches where id = ?', Number(r.lastInsertRowid));
      } else if (batch.mrp_paise !== mrp || batch.cost_paise !== realCost) {
        // Same batch arriving again at a different price: keep the newest, and
        // keep the old one in the price history.
        run(`insert into price_changes (batch_id, product_id, old_mrp_paise, new_mrp_paise,
             old_cost_paise, new_cost_paise, reason) values (?,?,?,?,?,?,?)`,
            batch.id, p.id, batch.mrp_paise, mrp, batch.cost_paise, realCost, 'New delivery of the same batch');
        run('update batches set mrp_paise = ?, cost_paise = ? where id = ?', mrp, realCost, batch.id);
      }

      const units = (packs + free) * p.units_per_strip;
      run(`insert into stock_ledger (product_id, batch_id, delta, reason, ref_type, ref_id)
           values (?,?,?,'purchase','purchase',?)`, p.id, batch.id, units, purchaseId);
      run(`insert into purchase_items (purchase_id, product_id, batch_id, packs, free_packs,
             mrp_paise, list_cost_paise, discount_bp, cost_paise, line_paise)
           values (?,?,?,?,?,?,?,?,?,?)`,
          purchaseId, p.id, batch.id, packs, free, mrp, listCost, lineBp, cost, linePaise);
      total += linePaise;

      if (line.code) {
        try { run('insert into product_codes (product_id, code) values (?, ?)', p.id, String(line.code)); } catch {}
      }
    }
    run('update purchases set total_paise = ? where id = ?', total, purchaseId);
    audit('delivery.receive', 'purchase', purchaseId, { lines: lines.length, total });
    return { id: purchaseId, total_paise: total, lines: lines.length };
  });
}

/** A counted difference, damage, or expiry write-off. Always with a reason. */
export function adjustStock({ batchId, delta, reason = 'adjustment', note }) {
  const d = Number(delta);
  if (!Number.isInteger(d) || d === 0) throw new ShopError('Enter how many units to add or remove.');
  if (!note || note.trim().length < 3) throw new ShopError('Say why the stock is being changed.');
  if (!['adjustment', 'damage', 'expiry', 'purchase_return'].includes(reason)) throw new ShopError('Unknown reason.');
  const batch = get('select * from batches where id = ?', batchId);
  if (!batch) throw new ShopError('No such batch.');

  return tx(() => {
    run(`insert into stock_ledger (product_id, batch_id, delta, reason, note) values (?,?,?,?,?)`,
        batch.product_id, batchId, d, reason, note.trim());
    audit('stock.adjust', 'batch', batchId, { delta: d, reason, note });
    return get('select * from batches where id = ?', batchId);
  });
}

/** Correct a price that was typed wrongly, or an MRP the company revised. */
export function setBatchPrice({ batchId, mrpPaise, costPaise, reason }) {
  const b = get('select * from batches where id = ?', batchId);
  if (!b) throw new ShopError('No such batch.');
  if (!reason || reason.trim().length < 3) throw new ShopError('Choose why the price is changing.');
  const mrp = mrpPaise == null ? b.mrp_paise : Number(mrpPaise);
  const cost = costPaise == null ? b.cost_paise : Number(costPaise);
  if (!(mrp > 0)) throw new ShopError('MRP must be more than zero.');
  if (!(cost >= 0)) throw new ShopError('Cost cannot be negative.');
  if (cost > mrp) throw new ShopError(
    `Cost ₹${(cost / 100).toFixed(2)} is more than the MRP ₹${(mrp / 100).toFixed(2)} — every sale would lose money.`);
  if (mrp === b.mrp_paise && cost === b.cost_paise) return b;

  return tx(() => {
    run(`insert into price_changes (batch_id, product_id, old_mrp_paise, new_mrp_paise,
         old_cost_paise, new_cost_paise, reason) values (?,?,?,?,?,?,?)`,
        batchId, b.product_id, b.mrp_paise, mrp, b.cost_paise, cost, reason.trim());
    run(`update batches set mrp_paise = ?, cost_paise = ?, updated_at = datetime('now','localtime') where id = ?`,
        mrp, cost, batchId);
    audit('price.change', 'batch', batchId, { mrp, cost, reason });
    return get('select * from batches where id = ?', batchId);
  });
}

// ------------------------------------------------------- removing things

/*
 * What can be deleted, and what cannot.
 *
 * Anything the owner typed by mistake should be removable, or the list slowly
 * fills with rubbish nobody dares touch. But nothing that a saved bill or the
 * stock history depends on may go, because those have to keep making sense for
 * years — the GST records for six, the Schedule H1 register for three.
 *
 * So the rule is: delete it outright if nothing points at it, and otherwise
 * take it off the lists while keeping the record itself.
 */

/**
 * Add a distributor. The name is checked here rather than left to the
 * database, so typing one that already exists says so plainly instead of
 * arriving at the counter as "something went wrong".
 */
export function addSupplier(s = {}) {
  const name = tidyName(s.name);
  if (!name) throw new ShopError('Enter the distributor name.');
  const clash = get('select name, is_active from suppliers where lower(trim(name)) = lower(?)',
                    name.toLowerCase());
  if (clash) {
    throw new ShopError(clash.is_active
      ? `${clash.name} is already in the list.`
      : `${clash.name} is already there but was removed from the list. Bring it back instead of adding it twice.`);
  }
  const r = run('insert into suppliers (name, phone, gstin, lead_days, return_months) values (?,?,?,?,?)',
    name, s.phone ?? null, s.gstin ?? null,
    whole(s.leadDays ?? 3, 'Days to deliver', { max: 365 }),
    whole(s.returnMonths ?? 3, 'Return months', { max: 60 }));
  audit('supplier.add', 'supplier', Number(r.lastInsertRowid), { name });
  return get('select * from suppliers where id = ?', Number(r.lastInsertRowid));
}

/** Correct a distributor's details — a wrong phone number, a changed name. */
export function updateSupplier(id, patch = {}) {
  const s = get('select * from suppliers where id = ?', id);
  if (!s) throw new ShopError('No such distributor.');

  const fields = { name: 'name', phone: 'phone', gstin: 'gstin',
                   leadDays: 'lead_days', returnMonths: 'return_months' };
  const sets = [], args = [], changes = {};
  for (const [key, column] of Object.entries(fields)) {
    if (patch[key] === undefined) continue;
    let value = patch[key];
    if (key === 'name') {
      value = tidyName(value);
      if (!value) throw new ShopError('The distributor needs a name.');
      const clash = get(`select name from suppliers where lower(trim(name)) = lower(?) and id is not ?`,
                        value.toLowerCase(), id);
      if (clash) throw new ShopError(`${clash.name} is already in the list.`);
    }
    if (key === 'leadDays' || key === 'returnMonths') {
      value = Number(value);
      if (!Number.isInteger(value) || value < 0) throw new ShopError('Days and months must be whole numbers.');
    }
    if (value === s[column]) continue;
    sets.push(`${column} = ?`); args.push(value);
    changes[key] = { from: s[column], to: value };
  }
  if (!sets.length) return { supplier: s, changed: {} };

  run(`update suppliers set ${sets.join(', ')} where id = ?`, ...args, id);
  audit('supplier.update', 'supplier', id, changes);
  return { supplier: get('select * from suppliers where id = ?', id), changed: changes };
}

/** Deliveries already received, newest first — what arrived and what it cost. */
export const recentDeliveries = (limit = 50) => all(`
  select p.*, s.name as supplier,
         (select count(*) from purchase_items where purchase_id = p.id) as lines
    from purchases p left join suppliers s on s.id = p.supplier_id
   order by p.id desc limit ?`, limit);

/** One delivery in full, for checking against the paper invoice. */
export function deliveryById(id) {
  const purchase = get(`select p.*, s.name as supplier from purchases p
                         left join suppliers s on s.id = p.supplier_id where p.id = ?`, id);
  if (!purchase) throw new ShopError('No such delivery.');
  const items = all(`
    select pi.*, pr.name, pr.base_unit, pr.units_per_strip, b.batch_no, b.expiry
      from purchase_items pi
      join products pr on pr.id = pi.product_id
      join batches b on b.id = pi.batch_id
     where pi.purchase_id = ? order by pi.id`, id);
  return { purchase, items };
}

/** Distributors: gone if never used, hidden from the list if they were. */
export function removeSupplier(id) {
  const s = get('select * from suppliers where id = ?', id);
  if (!s) throw new ShopError('No such distributor.');

  const deliveries = get('select count(*) as n from purchases where supplier_id = ?', id).n;
  const stock = get('select count(*) as n from batches where supplier_id = ?', id).n;

  if (deliveries || stock) {
    run('update suppliers set is_active = 0 where id = ?', id);
    audit('supplier.hide', 'supplier', id, { name: s.name, deliveries });
    return { name: s.name, deleted: false,
      message: `${s.name} has ${deliveries} ${deliveries === 1 ? 'delivery' : 'deliveries'} on record, so the name is kept for those. It will not appear when adding stock any more.` };
  }
  run('delete from suppliers where id = ?', id);
  audit('supplier.delete', 'supplier', id, { name: s.name });
  return { name: s.name, deleted: true, message: `${s.name} removed.` };
}

/** Medicines: gone only if never stocked and never sold. Otherwise archive. */
export function removeProduct(id) {
  const p = productById(id);
  if (!p) throw new ShopError('No such medicine.');

  const batches = get('select count(*) as n from batches where product_id = ?', id).n;
  const sold = get('select count(*) as n from sale_items where product_id = ?', id).n;

  if (batches || sold) throw new ShopError(
    `${p.name} cannot be deleted: it has ${batches ? 'stock' : 'sales'} on record, and the bills that mention it must keep making sense. ` +
    `Use "Archive this medicine" instead — it disappears from the counter and the history stays.`);

  run('delete from product_codes where product_id = ?', id);
  /* The app writes a stockout row itself whenever a customer asks for
     something that has run out, and that row pointed back at the medicine —
     so a name typed by mistake could never be removed. The note of what was
     asked for is worth keeping; the link to a deleted medicine is not. */
  run('update stockout_log set product_id = null where product_id = ?', id);
  run('delete from products where id = ?', id);
  audit('product.delete', 'product', id, { name: p.name });
  return { name: p.name, deleted: true, message: `${p.name} removed.` };
}

/** Codes linked to a medicine, so a wrong one can be seen and taken off. */
export const codesFor = id =>
  all('select id, code, learned_at from product_codes where product_id = ? order by id', id);

/**
 * Unlink a scanned code from a medicine. This happens when a code was learned
 * against the wrong one — without this the mistake is permanent and every scan
 * of that pack puts the wrong medicine on the bill.
 */
export function removeCode(codeId) {
  const row = get('select * from product_codes where id = ?', codeId);
  if (!row) throw new ShopError('No such code.');
  run('delete from product_codes where id = ?', codeId);
  audit('code.unlink', 'product', row.product_id, { code: row.code });
  return { code: row.code, message: `Code ${row.code} unlinked. The next scan will ask which medicine it belongs to.` };
}

export const productHistory = id => ({
  prices: all(`select pc.*, b.batch_no from price_changes pc join batches b on b.id = pc.batch_id
                where pc.product_id = ? order by pc.id desc limit 50`, id),
  details: all(`select * from audit_log where entity = 'product' and entity_id = ? order by id desc limit 50`, id),
  stock: all(`select l.*, b.batch_no from stock_ledger l join batches b on b.id = l.batch_id
               where l.product_id = ? order by l.id desc limit 100`, id),
});

// ---------------------------------------------------------------- QR labels

/* The shop has no barcode scanner, and most packs that arrive have either no
   printed code or a plain one carrying no batch. So the app prints its own
   sticker for each batch instead. The sticker names one batch and nothing else:
   scanning it is a lookup, not a guess, so the expiry on the bill is always the
   expiry of the strip in the customer's hand.

   The code is short on purpose. Every character is in the QR "alphanumeric"
   set, which keeps the code to the smallest size — 21 squares across, still
   readable when printed at 15mm on a cheap inkjet. */

const CHECK_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** A check character, so a damaged or misread code is refused, never silently
    treated as a different batch. Weighted, so swapped digits fail too. */
function checkChar(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) sum += Number(digits[i]) * (i % 2 ? 3 : 7);
  return CHECK_CHARS[sum % 36];
}

/** The text printed inside one batch's QR code. */
export const batchCode = batchId => {
  const digits = String(Number(batchId));
  return `SNM-B${digits}-${checkChar(digits)}`;
};

/** The batch a scanned code refers to, or null if it is not one of ours. */
export function batchByCode(code) {
  const m = /^SNM-B(\d+)-([0-9A-Z])$/.exec(String(code || '').trim().toUpperCase());
  if (!m) return null;
  if (checkChar(m[1]) !== m[2]) return null;              // misread; better nothing than the wrong batch
  return get(`select b.*, p.name, p.units_per_strip, p.base_unit, p.drug_schedule
                from batches b join products p on p.id = b.product_id where b.id = ?`, Number(m[1])) ?? null;
}

/** Everything a sticker prints, for the batches asked for. */
export function labelData({ batchIds = [], purchaseId = null } = {}) {
  let ids = batchIds.map(Number).filter(Number.isInteger);
  if (purchaseId) {
    ids = all('select distinct batch_id as id from purchase_items where purchase_id = ?', Number(purchaseId))
      .map(r => r.id);
  }
  if (!ids.length) return [];
  const marks = ids.map(() => '?').join(',');
  const rows = all(`select b.id, b.batch_no, b.expiry, b.mrp_paise, b.qty,
                           p.name, p.units_per_strip, p.base_unit, p.drug_schedule
                      from batches b join products p on p.id = b.product_id
                     where b.id in (${marks}) order by p.name, b.expiry`, ...ids);
  return rows.map(r => ({ ...r, code: batchCode(r.id) }));
}

// ---------------------------------------------------------------- reports

const emptyDay = date => ({
  business_date: date, bills: 0, gross_paise: 0, refund_paise: 0, sales_paise: 0, taxable_paise: 0,
  gst_paise: 0, cost_paise: 0, profit_paise: 0, discount_paise: 0, returns: 0,
  cash_paise: 0, upi_paise: 0, card_paise: 0, credit_paise: 0,
});

export const dayRow = date => get('select * from v_day where business_date = ?', date) ?? emptyDay(date);

/** One day: the same figures the evening summary sends. */
export function dailyReport(date = today()) {
  const d = dayRow(date);
  const prev = new Date(date); prev.setDate(prev.getDate() - 7);
  const lastWeek = dayRow(today(prev));
  return {
    date,
    ...d,
    average_bill_paise: d.bills ? Math.round(d.gross_paise / d.bills) : 0,
    profit_pct: d.taxable_paise > 0 ? +(d.profit_paise * 100 / d.taxable_paise).toFixed(1) : null,
    same_day_last_week_paise: lastWeek.sales_paise,
    top_sellers: all(`
      select p.name, sum(si.gross_paise) as sales_paise, sum(si.qty) as units
        from sale_items si join sales s on s.id = si.sale_id join products p on p.id = si.product_id
       where s.business_date = ? and s.is_cancelled = 0
       group by p.id order by sales_paise desc limit 5`, date),
    bills_list: all(`select id, bill_no, created_at, total_paise, pay_mode, is_cancelled
                       from sales where business_date = ? order by id`, date),
    asked_not_in_stock: all(`
      select coalesce(p.name, sl.search_term) as item, count(*) as times
        from stockout_log sl left join products p on p.id = sl.product_id
       where date(sl.created_at) = ? group by item order by times desc`, date),
  };
}

/** Any stretch of days: the custom range report. */
export function rangeReport(from, to) {
  if (!from || !to || from > to) throw new ShopError('Choose a start date and an end date.');
  const days = all('select * from v_day where business_date between ? and ? order by business_date', from, to);
  const sum = key => days.reduce((s, d) => s + d[key], 0);
  const bills = sum('bills');
  return {
    from, to, days,
    bills,
    sales_paise: sum('sales_paise'), gross_paise: sum('gross_paise'), refund_paise: sum('refund_paise'),
    taxable_paise: sum('taxable_paise'), gst_paise: sum('gst_paise'), cost_paise: sum('cost_paise'),
    profit_paise: sum('profit_paise'), discount_paise: sum('discount_paise'), returns: sum('returns'),
    cash_paise: sum('cash_paise'), upi_paise: sum('upi_paise'), card_paise: sum('card_paise'), credit_paise: sum('credit_paise'),
    average_bill_paise: bills ? Math.round(sum('gross_paise') / bills) : 0,
    profit_pct: sum('taxable_paise') > 0 ? +(sum('profit_paise') * 100 / sum('taxable_paise')).toFixed(1) : null,
    open_days: days.filter(d => d.bills > 0).length,
    best_day: days.slice().sort((a, b) => b.sales_paise - a.sales_paise)[0] ?? null,
    top_by_sales: all(`
      select p.name, sum(si.gross_paise) as sales_paise, sum(si.qty) as units,
             sum(si.taxable_paise - coalesce(si.cost_total_paise, si.qty * si.cost_paise / p.units_per_strip)) as profit_paise
        from sale_items si join sales s on s.id = si.sale_id join products p on p.id = si.product_id
       where s.business_date between ? and ? and s.is_cancelled = 0
       group by p.id order by sales_paise desc limit 20`, from, to),
    top_by_profit: all(`
      select p.name, sum(si.gross_paise) as sales_paise,
             sum(si.taxable_paise - coalesce(si.cost_total_paise, si.qty * si.cost_paise / p.units_per_strip)) as profit_paise
        from sale_items si join sales s on s.id = si.sale_id join products p on p.id = si.product_id
       where s.business_date between ? and ? and s.is_cancelled = 0
       group by p.id order by profit_paise desc limit 20`, from, to),
    gst_by_rate: all(`
      select si.gst_rate as rate, sum(si.taxable_paise) as taxable_paise, sum(si.gst_paise) as gst_paise
        from sale_items si join sales s on s.id = si.sale_id
       where s.business_date between ? and ? and s.is_cancelled = 0
       group by si.gst_rate order by si.gst_rate`, from, to),
    hsn_summary: all(`
      select case when s.buyer_gstin is not null and trim(s.buyer_gstin) <> '' then 'B2B' else 'B2C' end as kind,
             coalesce(p.hsn_code, '3004') as hsn, si.gst_rate as rate,
             sum(si.qty) as units, sum(si.taxable_paise) as taxable_paise, sum(si.gst_paise) as gst_paise
        from sale_items si join sales s on s.id = si.sale_id join products p on p.id = si.product_id
       where s.business_date between ? and ? and s.is_cancelled = 0
       group by kind, hsn, rate order by kind, hsn, rate`, from, to),
    documents: get(`
      select min(bill_no) as first_bill, max(bill_no) as last_bill, count(*) as issued,
             sum(is_cancelled) as cancelled
        from sales where business_date between ? and ?`, from, to),
    credit_notes: get(`select count(*) as n, coalesce(sum(
        (select sum(refund_paise) from sale_return_items where return_id = r.id)), 0) as refund_paise
        from sale_returns r where r.business_date between ? and ?`, from, to),
  };
}

/** How customers paid, over a range. */
export function paymentReport(from, to) {
  const rows = all(`
    select pay_mode, count(*) as bills, sum(total_paise) as total_paise
      from sales where business_date between ? and ? and is_cancelled = 0
     group by pay_mode order by total_paise desc`, from, to);
  const refunds = all(`
    select refund_mode as pay_mode, count(*) as returns,
           (select coalesce(sum(refund_paise), 0) from sale_return_items where return_id = r.id) as refund_paise
      from sale_returns r where r.business_date between ? and ? group by r.id`, from, to);
  const byMode = {};
  for (const r of refunds) byMode[r.pay_mode] = (byMode[r.pay_mode] || 0) + r.refund_paise;
  const total = rows.reduce((s, r) => s + r.total_paise, 0);
  return {
    from, to, total_paise: total,
    modes: rows.map(r => ({ ...r, refund_paise: byMode[r.pay_mode] || 0,
                            net_paise: r.total_paise - (byMode[r.pay_mode] || 0),
                            share_pct: total ? +(r.total_paise * 100 / total).toFixed(1) : 0 })),
  };
}

/** Everything on the shelves, and what it is worth. */
export function inventoryReport({ includeArchived = false } = {}) {
  const rows = all(`select * from v_stock ${includeArchived ? '' : 'where is_active = 1'} order by name`);
  return {
    generated: today(),
    total_value_paise: rows.reduce((s, r) => s + r.stock_value_paise, 0),
    lines: rows.length,
    in_stock: rows.filter(r => r.units > 0).length,
    rows,
  };
}

/** What has run low, judged against the reminder level set for each medicine. */
export function lowStockReport() {
  const rows = all(`
    select s.*, (select group_concat(name, ', ') from (
                   select distinct sup.name from batches b2
                     join suppliers sup on sup.id = b2.supplier_id
                    where b2.product_id = s.product_id)) as suppliers
      from v_stock s
     where s.is_active = 1 and s.reorder_packs > 0 and s.packs <= s.reorder_packs
     order by (s.packs * 1.0 / s.reorder_packs), s.name`);
  return { generated: today(), count: rows.length, rows };
}

/** Expiry, in the buckets that decide what to do about it. */
export function expiryReport(days = 180) {
  /* How many days are left is worked out here rather than in the view, from
     the app's own date. Asking SQLite for today risks a different answer. */
  const asOf = today();
  const daysLeft = expiry =>
    Math.round((Date.parse(`${expiry}T00:00:00`) - Date.parse(`${asOf}T00:00:00`)) / 86400000);

  const withDays = r => ({ ...r, days_left: daysLeft(r.expiry) });
  const everything = all('select * from v_expiry order by expiry').map(withDays);

  const rows = everything.filter(r => r.days_left <= days);
  const bucket = r => r.days_left < 0 ? 'expired'
    : r.days_left <= 30 ? '0-30' : r.days_left <= 90 ? '31-90' : '91-180';
  const buckets = { expired: [], '0-30': [], '31-90': [], '91-180': [] };
  for (const r of rows) (buckets[bucket(r)] ??= []).push(r);
  // Still far enough from expiry that the distributor will take it back.
  const returnable = everything
    .filter(r => r.days_left > (r.return_months ?? 0) * 30 && r.days_left <= (r.return_months ?? 0) * 30 + 60)
    .sort((a, b) => String(a.supplier ?? '').localeCompare(String(b.supplier ?? '')) || a.expiry.localeCompare(b.expiry));
  return {
    generated: asOf,
    buckets: Object.fromEntries(Object.entries(buckets).map(([k, v]) =>
      [k, { count: v.length, value_paise: v.reduce((s, r) => s + r.value_paise, 0), rows: v }])),
    returnable: { count: returnable.length,
                  value_paise: returnable.reduce((s, r) => s + r.value_paise, 0), rows: returnable },
  };
}

/** Proof that the ledger still explains every batch balance. */
export function integrityCheck() {
  const drift = all(`
    select b.id, b.batch_no, b.qty, coalesce((select sum(delta) from stock_ledger where batch_id = b.id), 0) as ledger
      from batches b
     where b.qty <> coalesce((select sum(delta) from stock_ledger where batch_id = b.id), 0)`);
  const negative = all('select id, batch_no, qty from batches where qty < 0');
  /* Two medicines sharing a name split their stock between them, so neither
     looks low and neither shows the true count. */
  /* Names are tidied before they are stored, so this should never find
     anything. It compares with runs of spaces squeezed out all the same, so
     that data arriving some other way — an import, a hand-edited file — cannot
     hide a duplicate behind a double space. */
  const squeeze = `lower(trim(replace(replace(replace(name,'  ',' '),'  ',' '),'  ',' ')))`;
  const duplicates = all(`
    select group_concat(id) as ids, min(name) as name, count(*) as n
      from products group by ${squeeze} having count(*) > 1`);
  return {
    ok: drift.length === 0 && negative.length === 0 && duplicates.length === 0,
    drift, negative, duplicates,
  };
}
