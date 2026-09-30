/**
 * The sticker sheet.
 *
 * One sticker per batch: the medicine, the batch number, the expiry, the MRP,
 * and a QR code holding nothing but that batch's own short code. The owner
 * sticks it on the box as the delivery is put away. From then on, one look
 * through the webcam puts the right strip — the right expiry, the right price —
 * onto the bill.
 *
 * Plain A4. It prints on 65×36mm sticker sheets if the shop buys them, and on
 * ordinary paper to be cut with scissors if it does not.
 */

import { svg } from './qr.js';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
const rupees = paise => '₹' + (paise / 100).toFixed(2);
const monthYear = iso => {
  const [y, m] = String(iso).split('-');
  return `${m}/${y}`;
};

/** One sticker. */
function label(row, shopName) {
  const unit = row.units_per_strip > 1 ? 'strip' : (row.base_unit || 'unit');
  return `<div class="label">
    <div class="text">
      <div class="shop">${esc(shopName)}</div>
      <div class="name">${esc(row.name)}${row.drug_schedule ? ` <span class="sch">${esc(row.drug_schedule)}</span>` : ''}</div>
      <div class="line">Batch <b>${esc(row.batch_no)}</b></div>
      <div class="line">Expiry <b>${monthYear(row.expiry)}</b></div>
      <div class="mrp">${rupees(row.mrp_paise)} <span class="per">per ${esc(unit)}</span></div>
    </div>
    <div class="qr">${svg(row.code, { size: 20, quiet: 2 })}<div class="code">${esc(row.code)}</div></div>
  </div>`;
}

/**
 * The whole printable page. `copies` repeats every sticker, for a shop that
 * wants one on each strip rather than one on the box.
 */
export function labelSheet(rows, { shopName = 'Sri Nachiya Medicals', copies = 1 } = {}) {
  const n = Math.min(Math.max(1, Number(copies) || 1), 50);
  const stickers = rows.flatMap(row => Array.from({ length: n }, () => label(row, shopName)));

  const body = stickers.length
    ? stickers.join('')
    : `<p class="empty">Nothing to print. Choose at least one batch.</p>`;

  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stock labels — ${esc(shopName)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 10mm; background: #eef1ee;
         font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #101a12; }
  .bar { max-width: 210mm; margin: 0 auto 8mm; display: flex; gap: 12px; align-items: center;
         background: #0d4a2b; color: #fff; padding: 12px 16px; border-radius: 10px; }
  .bar h1 { font-size: 17px; margin: 0; flex: 1; font-weight: 700; }
  .bar button { font: inherit; font-weight: 700; padding: 9px 18px; border-radius: 8px;
                border: 0; background: #fff; color: #0d4a2b; cursor: pointer; }
  .bar .hint { font-size: 13px; opacity: .85; }

  .sheet { max-width: 210mm; margin: 0 auto; background: #fff; padding: 8mm;
           display: grid; grid-template-columns: repeat(3, 1fr); gap: 3mm;
           border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,.15); }

  .label { height: 36mm; border: 1px dashed #b9c4bb; border-radius: 2mm; padding: 2.5mm;
           display: flex; gap: 2mm; align-items: stretch; overflow: hidden; background: #fff; }
  .text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .shop { font-size: 6.5pt; color: #5b6b5f; letter-spacing: .02em; }
  .name { font-size: 9.5pt; font-weight: 700; line-height: 1.15; margin: .4mm 0 1mm;
          overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .sch { font-size: 6pt; font-weight: 700; color: #9a1c1c; border: 1px solid #9a1c1c;
         border-radius: 2px; padding: 0 1px; vertical-align: 1px; }
  .line { font-size: 7.5pt; line-height: 1.35; color: #24352a; }
  .mrp { margin-top: auto; font-size: 11pt; font-weight: 700; }
  .per { font-size: 6.5pt; font-weight: 400; color: #5b6b5f; }
  .qr { width: 21mm; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .qr svg { width: 20mm; height: 20mm; display: block; }
  .code { font-size: 5.5pt; color: #5b6b5f; margin-top: .6mm; letter-spacing: .02em; }
  .empty { text-align: center; color: #5b6b5f; grid-column: 1 / -1; padding: 20mm 0; }

  @media print {
    @page { size: A4; margin: 8mm; }
    body { background: #fff; padding: 0; }
    .bar { display: none; }
    .sheet { max-width: none; margin: 0; padding: 0; box-shadow: none; border-radius: 0; gap: 0; }
    .label { border: 1px dashed #ccc; border-radius: 0; break-inside: avoid; }
  }
</style>
</head>
<body>
  <div class="bar">
    <h1>${stickers.length} label${stickers.length === 1 ? '' : 's'} ready</h1>
    <span class="hint">Stick one on each box as you put the delivery away.</span>
    <button onclick="window.print()">Print</button>
  </div>
  <div class="sheet">${body}</div>
</body>
</html>`;
}
