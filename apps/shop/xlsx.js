/**
 * Writes real .xlsx files with nothing but Node's own zlib.
 *
 * An .xlsx is a zip of XML parts. Writing those directly keeps the shop's
 * computer free of any installed package: copy the folder, run it, exports
 * work. The output is checked against a real spreadsheet reader in
 * tests/app/xlsx.test.js, because "it looks like a zip" is not the same as
 * "Excel opens it".
 */

import { deflateRawSync } from 'node:zlib';

// ---------------------------------------------------------------- zip

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Minimal zip writer: one entry per XML part, deflated. */
function zip(files) {
  const chunks = [], central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content, 'utf8');
    const deflated = deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(8, 8);            // deflate
    local.writeUInt16LE(0, 10);           // time
    local.writeUInt16LE(0x2100, 12);      // date (1996-01-01; spreadsheets ignore it)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, deflated);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 8); dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(0, 12); dir.writeUInt16LE(0x2100, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(deflated.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(0, 42 - 4);         // external attrs
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);

    offset += local.length + nameBuf.length + deflated.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}

// ---------------------------------------------------------------- sheet xml

const esc = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

const colName = n => {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
};

/**
 * A cell is one of:
 *   'text'                       plain text
 *   { n: 1234.5 }                a number
 *   { money: 1234.5 }            rupees, shown as 1,234.50
 *   { n|money, bold: true }      a heading or a total
 */
function cellXml(value, rowNum, colNum) {
  const ref = `${colName(colNum)}${rowNum}`;
  if (value === null || value === undefined || value === '') return `<c r="${ref}"/>`;
  if (typeof value === 'object') {
    const style = value.money ? (value.bold ? 4 : 3) : (value.bold ? 1 : 0);
    const num = value.money ?? value.n;
    if (typeof num === 'number' && Number.isFinite(num))
      return `<c r="${ref}" s="${style}"><v>${num}</v></c>`;
    return `<c r="${ref}" s="${value.bold ? 1 : 0}" t="inlineStr"><is><t xml:space="preserve">${esc(value.text ?? '')}</t></is></c>`;
  }
  if (typeof value === 'number' && Number.isFinite(value))
    return `<c r="${ref}"><v>${value}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

function sheetXml(rows, widths) {
  const cols = widths?.length
    ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const body = rows.map((row, r) =>
    `<row r="${r + 1}">${(row ?? []).map((c, i) => cellXml(c, r + 1, i + 1)).join('')}</row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${body}</sheetData></worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/**
 * Build a workbook.
 *   sheets: [{ name, rows: [[cell, ...], ...], widths?: [12, 30, ...] }]
 */
export function workbook(sheets) {
  const safe = sheets.map((s, i) => ({
    ...s,
    name: (s.name || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31),
  }));

  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${safe.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}
</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${safe.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${safe.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}
<Relationship Id="rId${safe.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`],
    ['xl/styles.xml', STYLES],
    ...safe.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows, s.widths)]),
  ];
  return zip(files);
}

// ---------------------------------------------------------------- the reports

const rupees = paise => ({ money: Math.round(paise) / 100 });
const bold = text => ({ text: String(text), bold: true });
const boldMoney = paise => ({ money: Math.round(paise) / 100, bold: true });

const header = (shop, title, subtitle) => [
  [bold(shop?.name || 'Sri Nachiya Medicals')],
  [shop ? `${shop.address1}, ${shop.address2}` : ''],
  [shop?.gstin ? `GSTIN ${shop.gstin}` : 'GSTIN not set'],
  [bold(title)],
  [subtitle],
  [],
];

/** Sales over a range: a summary, then a row per day, then the detail. */
export function salesWorkbook(report, shop, bills = [], billLines = []) {
  const summary = [
    ...header(shop, 'Sales report', `${report.from} to ${report.to}`),
    [bold('Sales (after returns)'), rupees(report.sales_paise)],
    [bold('Bills'), { n: report.bills }],
    [bold('Average bill'), rupees(report.average_bill_paise)],
    [bold('Before GST'), rupees(report.taxable_paise)],
    [bold('GST collected'), rupees(report.gst_paise)],
    [bold('Cost of what was sold'), rupees(report.cost_paise)],
    [bold('You made'), boldMoney(report.profit_paise)],
    [bold('Returns refunded'), rupees(report.refund_paise)],
    [bold('Discount given'), rupees(report.discount_paise)],
    [],
    [bold('Cash'), rupees(report.cash_paise)],
    [bold('UPI'), rupees(report.upi_paise)],
    [bold('Card'), rupees(report.card_paise)],
    [bold('Credit'), rupees(report.credit_paise)],
    [],
    [bold('GST rate'), bold('Before GST'), bold('CGST'), bold('SGST')],
    ...report.gst_by_rate.map(r => [`${r.rate}%`, rupees(r.taxable_paise),
      rupees(Math.round(r.gst_paise / 2)), rupees(r.gst_paise - Math.round(r.gst_paise / 2))]),
  ];

  const daily = [
    [bold('Date'), bold('Bills'), bold('Sales'), bold('Returns'), bold('Before GST'), bold('GST'), bold('You made')],
    ...report.days.map(d => [d.business_date, { n: d.bills }, rupees(d.sales_paise), rupees(d.refund_paise),
      rupees(d.taxable_paise), rupees(d.gst_paise), rupees(d.profit_paise)]),
    [bold('Total'), { n: report.bills, bold: true }, boldMoney(report.sales_paise), boldMoney(report.refund_paise),
     boldMoney(report.taxable_paise), boldMoney(report.gst_paise), boldMoney(report.profit_paise)],
  ];

  const medicines = [
    [bold('Medicine'), bold('Units sold'), bold('Sales'), bold('You made')],
    ...report.top_by_sales.map(r => [r.name, { n: r.units }, rupees(r.sales_paise), rupees(r.profit_paise)]),
  ];

  const sheets = [
    { name: 'Summary', rows: summary, widths: [28, 16, 14, 14] },
    { name: 'Day by day', rows: daily, widths: [14, 9, 14, 12, 14, 12, 14] },
    { name: 'Medicines', rows: medicines, widths: [32, 12, 14, 14] },
  ];

  if (bills.length) {
    sheets.push({ name: 'Bills', widths: [16, 12, 10, 12, 14, 12],
      rows: [[bold('Bill no'), bold('Date'), bold('Time'), bold('Paid by'), bold('Total'), bold('Cancelled')],
        ...bills.map(b => [b.bill_no, b.business_date, (b.created_at || '').slice(11, 16), b.pay_mode,
                           rupees(b.total_paise), b.is_cancelled ? 'Yes' : ''])] });
  }
  if (billLines.length) {
    sheets.push({ name: 'Bill lines', widths: [16, 12, 30, 14, 12, 10, 12, 12, 10],
      rows: [[bold('Bill no'), bold('Date'), bold('Medicine'), bold('Batch'), bold('Expiry'),
              bold('Qty'), bold('MRP'), bold('Amount'), bold('GST %')],
        ...billLines.map(l => [l.bill_no, l.business_date, l.name, l.batch_no, l.expiry,
          { n: l.qty }, rupees(l.mrp_paise), rupees(l.gross_paise), { n: l.gst_rate }])] });
  }
  return workbook(sheets);
}

export function inventoryWorkbook(report, shop) {
  return workbook([
    { name: 'Stock on hand', widths: [32, 24, 18, 10, 12, 12, 14, 14],
      rows: [
        ...header(shop, 'Stock on hand', `As on ${report.generated}`),
        [bold('Medicine'), bold('Generic'), bold('Company'), bold('Rack'), bold('Packs'), bold('Units'),
         bold('Value at cost'), bold('Nearest expiry')],
        ...report.rows.map(r => [r.name, r.generic_name || '', r.manufacturer || '', r.rack || '',
          { n: r.packs }, { n: r.units }, rupees(r.stock_value_paise), r.nearest_expiry || '']),
        [bold('Total'), '', '', '', '', '', boldMoney(report.total_value_paise), ''],
      ] },
  ]);
}

export function lowStockWorkbook(report, shop) {
  return workbook([
    { name: 'Low stock', widths: [32, 12, 14, 12, 28],
      rows: [
        ...header(shop, 'Low stock', `As on ${report.generated}`),
        [bold('Medicine'), bold('Packs left'), bold('Remind below'), bold('Rack'), bold('Distributor')],
        ...report.rows.map(r => [r.name, { n: r.packs }, { n: r.reorder_packs }, r.rack || '', r.suppliers || '']),
      ] },
  ]);
}

export function expiryWorkbook(report, shop) {
  const rows = bucket => (report.buckets[bucket]?.rows ?? []).map(r =>
    [r.name, r.batch_no, r.expiry, { n: r.days_left }, { n: r.qty }, rupees(r.value_paise), r.supplier || '']);
  const head = [bold('Medicine'), bold('Batch'), bold('Expiry'), bold('Days left'), bold('Units'),
                bold('Value at cost'), bold('Distributor')];
  return workbook([
    { name: 'Expiry', widths: [30, 14, 12, 11, 10, 14, 24],
      rows: [
        ...header(shop, 'Expiry report', `As on ${report.generated}`),
        [bold('Already expired')], head, ...rows('expired'), [],
        [bold('Expiring within 30 days')], head, ...rows('0-30'), [],
        [bold('31 to 90 days')], head, ...rows('31-90'), [],
        [bold('91 to 180 days')], head, ...rows('91-180'),
      ] },
    { name: 'Send back to distributor', widths: [24, 30, 14, 12, 10, 14],
      rows: [[bold('Distributor'), bold('Medicine'), bold('Batch'), bold('Expiry'), bold('Units'), bold('Value at cost')],
        ...report.returnable.rows.map(r => [r.supplier || '', r.name, r.batch_no, r.expiry, { n: r.qty }, rupees(r.value_paise)]),
        [bold('Total'), '', '', '', '', boldMoney(report.returnable.value_paise)]] },
  ]);
}

export function paymentWorkbook(report, shop) {
  return workbook([
    { name: 'Payments', widths: [16, 10, 16, 16, 16, 10],
      rows: [
        ...header(shop, 'Payment-wise sales', `${report.from} to ${report.to}`),
        [bold('Paid by'), bold('Bills'), bold('Taken'), bold('Refunded'), bold('Net'), bold('Share %')],
        ...report.modes.map(m => [m.pay_mode, { n: m.bills }, rupees(m.total_paise),
          rupees(m.refund_paise), rupees(m.net_paise), { n: m.share_pct }]),
        [bold('Total'), '', boldMoney(report.total_paise), '', '', ''],
      ] },
  ]);
}
