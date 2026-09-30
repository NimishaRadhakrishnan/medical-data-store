/* Sri Nachiya Medicals — the counter screens.
   Everything here talks to the little server on this same computer. No other
   address is ever contacted, so the shop works with the internet unplugged. */

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const rs  = p => '₹' + (Math.round(p) / 100).toLocaleString('en-IN', { minimumFractionDigits:2, maximumFractionDigits:2 });
const rsR = p => '₹' + Math.round(Math.round(p) / 100).toLocaleString('en-IN');
const paise = v => Math.round(Number(v) * 100);
const todayStr = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const dmy = s => s ? s.split('-').reverse().join('-') : '';
const mmYYYY = s => s ? `${s.slice(5,7)}/${s.slice(0,4)}` : '';
const IRREGULAR = { batch:'batches', box:'boxes', medicine:'medicines', day:'days' };
const plural = (w, n) => n === 1 ? w : (IRREGULAR[w] || w + 's');

let toastTimer;
function toast(message, bad = false) {
  const t = $('toast');
  t.textContent = message; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, bad ? 6000 : 3500);
}

/** Every call goes to this computer. A failure here means the app is not running. */
async function api(path, body) {
  let res;
  try {
    res = await fetch(path, body === undefined ? {}
      : { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify(body) });
  } catch {
    $('healthDot').className = 'dot bad';
    $('healthText').textContent = 'App not running — restart it';
    throw new Error('The app is not running on this computer. Start it again from the desktop shortcut.');
  }
  const data = await res.json().catch(() => ({ error: 'The app sent something unreadable.' }));
  if (!res.ok) {
    /* The server refused because the shop is locked. Ask for the PIN once and
       try the very same thing again, so the owner never has to find a menu or
       repeat what he was doing. */
    if (data.code === 'locked' && await askForPin()) return api(path, body);
    const err = new Error(data.error || 'Something went wrong.');
    err.code = data.code;
    throw err;
  }
  return data;
}

const showMsg = (el, text, kind = 'bad') => { el.hidden = false; el.className = 'msg ' + kind; el.textContent = text; };
const hideMsg = el => { el.hidden = true; };

/**
 * A small dialog that gives back what was typed, or null if it was cancelled.
 *
 * `check` is optional: given the answers, it returns a sentence to show when
 * something is missing, and nothing when all is well. The dialog stays open
 * until it is happy, so a half-filled form cannot be saved by accident.
 */
function ask({ title, bodyHtml, okText = 'OK', check = null }) {
  return new Promise(resolve => {
    $('dlgTitle').textContent = title;
    $('dlgBody').innerHTML = bodyHtml;
    $('dlgOk').textContent = okText;
    const dlg = $('dlg'), ok = $('dlgOk');
    const read = () => {
      const out = {};
      dlg.querySelectorAll('[data-k]').forEach(el =>
        out[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value);
      return out;
    };

    const guard = e => {
      const problem = check?.(read());
      if (!problem) return;
      e.preventDefault();                       // keep the dialog open
      let note = dlg.querySelector('.dlg-problem');
      if (!note) {
        note = document.createElement('p');
        note.className = 'msg warn dlg-problem';
        $('dlgBody').appendChild(note);
      }
      note.textContent = problem;
    };
    if (check) ok.addEventListener('click', guard);

    dlg.returnValue = '';
    dlg.showModal();
    dlg.addEventListener('close', () => {
      if (check) ok.removeEventListener('click', guard);
      resolve(dlg.returnValue === 'ok' ? read() : null);
    }, { once:true });
  });
}

let SHOP = null;

/* The screens open light, because a bright shop counter is easier to read.
   The choice is remembered on this computer only. */
function applyTheme(mode) {
  document.documentElement.dataset.theme = mode;
  $('themeBtn').textContent = mode === 'light' ? 'Dark screen' : 'Light screen';
  try { localStorage.setItem('snm-theme', mode); } catch {}
}
let theme = 'light';
try { theme = localStorage.getItem('snm-theme') || 'light'; } catch {}
applyTheme(theme);
$('themeBtn').onclick = () => applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');

// ---------------------------------------------------------------- the PIN

/*
 * The PIN stands in front of the few actions that can do damage, and in front
 * of what the shop pays for its stock. Billing is never behind it.
 *
 * Nothing here decides whether something is allowed — the server does that.
 * This only asks for the PIN when the server says it needs one.
 */

let askingPin = null;         // one dialog at a time, however many calls are waiting

/** Ask for the PIN. True once the shop is unlocked, false if the owner gave up. */
function askForPin() {
  if (askingPin) return askingPin;                    // a second refusal joins the first dialog
  askingPin = (async () => {
    for (;;) {
      const out = await ask({ title:'Enter the shop PIN', okText:'Unlock', bodyHtml:`
        <div class="field"><label for="pinBox">PIN</label>
          <input data-k="pin" id="pinBox" inputmode="numeric" maxlength="4"
                 autocomplete="off" style="font-size:26px;letter-spacing:9px;text-align:center"></div>
        <p class="muted" style="margin:10px 0 0">Needed to change prices, correct stock, cancel a bill,
          delete anything, or see what stock cost. Billing never asks for it.</p>` });
      if (!out) return false;                          // cancelled: the action simply does not happen
      try { await rawApi('/api/pin/unlock', { pin: out.pin }); await refreshLock(); return true; }
      catch (e) { toast(e.message, true); }            // wrong PIN: ask again
    }
  })().finally(() => { askingPin = null; });
  return askingPin;
}

/** The plain call, used where a locked answer must not start another dialog. */
async function rawApi(path, body) {
  const res = await fetch(path, body === undefined ? {}
    : { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({ error: 'The app sent something unreadable.' }));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

async function refreshLock() {
  try {
    const s = await rawApi('/api/pin/status');
    $('lockBtn').hidden = !s.configured;
    $('lockBtn').textContent = s.unlocked ? 'Lock now' : 'Locked';
  } catch { /* the app is not running; the health dot already says so */ }
}

$('lockBtn').onclick = async () => {
  await rawApi('/api/pin/lock', {});          // a body, so this is a POST like the route expects
  await refreshLock();
  toast('Locked. The PIN will be asked for before anything is changed.');
  if (screen === 'meds' && medSelected) openMedicine(medSelected);
};

// ================================================================ screens

const SCREENS = { bill:'v-bill', stock:'v-stock', meds:'v-meds', reports:'v-reports', setup:'v-setup' };
let screen = 'bill';

function show(name) {
  screen = name;
  for (const [key, id] of Object.entries(SCREENS)) {
    $(id).hidden = key !== name;
    $('tab-' + key).setAttribute('aria-selected', String(key === name));
  }
  if (name === 'bill') { $('q').focus(); loadRecent(); }
  if (name === 'stock') loadStockScreen();
  if (name === 'meds') loadMedicines();
  if (name === 'reports') renderReport();
  if (name === 'setup') loadSettings();
  window.scrollTo(0, 0);
}
for (const key of Object.keys(SCREENS)) $('tab-' + key).onclick = () => show(key);

// ================================================================ new bill

let cart = [];            // { productId, name, baseUnit, unitsPerStrip, qty }
let quote = null;         // priced by the server, so the screen and the bill agree
let matches = [], highlight = 0, picked = null, pickUnit = 'strip';
let payMode = 'cash';
let billUuid = crypto.randomUUID();
let saving = false;

const unitsFor = (p, n, unit) => Math.round(
  unit === 'strip' ? n * p.units_per_strip : unit === 'box' ? n * p.units_per_strip * 10 : n);

let nextLineKey = 1;

/**
 * Put a medicine on the bill — the one way it is done, whether it was typed or
 * scanned.
 *
 * A scanned line names the exact strip in the customer's hand, so it stays a
 * line of its own and is never merged into a typed line of the same medicine.
 * Every line carries its own `key`, which is what the × removes; without it,
 * taking off a typed line also took off the scanned one beside it.
 */
function addLine({ productId, batchId = null, name, baseUnit, unitsPerStrip, qty }) {
  const existing = cart.find(c => c.productId === productId && (c.batchId ?? null) === batchId);
  if (existing) { existing.qty += qty; return existing; }
  const line = { key: nextLineKey++, productId, batchId, name, baseUnit, unitsPerStrip, qty };
  cart.push(line);
  return line;
}

/* One of the shop's own printed labels, e.g. SNM-B57-K. */
const OUR_LABEL = /^SNM-B\d+-[0-9A-Z]$/i;

/**
 * A scanned label goes straight onto the bill: the medicine and the exact
 * strip, so the printed expiry matches what is handed over. Nothing to click.
 */
async function sellScanned(code) {
  const found = await api(`/api/by-code?code=${encodeURIComponent(code.trim())}`);
  if (!found.batch) {
    showMsg($('billMsg'), 'That label is not in this computer. It may be from another shop, or the sticker is damaged — search by name instead.');
    return false;
  }
  const b = found.batch;
  if (b.qty <= 0) {
    showMsg($('billMsg'), `${b.name}, batch ${b.batch_no}, shows nothing left in stock. Check the shelf and correct the count in Medicines.`);
    return false;
  }
  const one = b.units_per_strip > 1 ? b.units_per_strip : 1;    // a whole strip by default
  addLine({ productId: b.product_id, batchId: b.id, name: b.name, baseUnit: b.base_unit,
            unitsPerStrip: b.units_per_strip, qty: one });
  $('q').value = ''; $('results').hidden = true;
  await refreshQuote();
  toast(`${b.name} — batch ${b.batch_no}, expires ${mmYYYY(b.expiry)}`);
  return true;
}

async function runSearch() {
  const term = $('q').value.trim();
  if (OUR_LABEL.test(term)) return void sellScanned(term);
  if (term.length < 2) { $('results').hidden = true; return; }
  matches = await api(`/api/search?q=${encodeURIComponent(term)}`);
  highlight = 0;
  renderResults(term);
}

function renderResults(term) {
  const box = $('results');
  if (!matches.length) {
    box.innerHTML = `<div class="res" style="display:block"><b>No medicine called “${esc(term)}”.</b>
      <div class="sub" style="margin:4px 0 10px">If a customer asked for it, note it down — it shows in your reports.</div>
      <button class="btn small" id="noteMiss">Note that a customer asked</button></div>`;
    box.hidden = false;
    $('noteMiss').onclick = async () => {
      await api('/api/stockout', { term }); $('results').hidden = true; $('q').value = '';
      toast(`Noted: a customer asked for ${term}`);
    };
    return;
  }
  box.innerHTML = matches.map((m, i) => {
    const out = m.units <= 0;
    const near = m.nearest_expiry && (new Date(m.nearest_expiry) - new Date()) / 86400000 <= 30;
    return `<div class="res" role="option" data-i="${i}" aria-selected="${i === highlight}">
      <div class="nm">${esc(m.name)}${m.drug_schedule === 'H1' ? '<span class="tag h1">Needs prescription</span>' : ''}
        ${out ? '<span class="tag out">Out of stock</span>' : near ? `<span class="tag near">Expires ${mmYYYY(m.nearest_expiry)}</span>` : ''}</div>
      <div class="sub">${esc(m.generic_name || '')}${m.rack ? ' · rack ' + esc(m.rack) : ''}</div>
      <div class="stk"><b>${out ? '—' : m.units + ' ' + plural(m.base_unit, m.units)}</b>${m.mrp_paise ? rs(m.mrp_paise) + ' / ' + (m.units_per_strip > 1 ? 'strip' : m.base_unit) : ''}</div>
    </div>`;
  }).join('');
  box.hidden = false;
  box.querySelectorAll('.res').forEach(el => el.onclick = () => choose(Number(el.dataset.i)));
}

async function choose(i) {
  const m = matches[i]; if (!m) return;
  $('results').hidden = true;
  if (m.units <= 0) return offerSubstitutes(m);
  picked = m;
  /* Always open on loose units. Customers ask for tablets far more often than
     whole strips, and it is the safer mistake: typing 2 meaning strips sells
     2 tablets, which is spotted at once, whereas the other way round sells a
     whole box by accident. */
  pickUnit = 'base';
  $('pickName').textContent = m.name;
  $('pickInfo').textContent = `${m.units} ${plural(m.base_unit, m.units)} in stock`;
  $('qtyNum').value = '1';
  renderUnitSeg();
  $('pick').hidden = false;
  $('qtyNum').focus(); $('qtyNum').select();
}

function renderUnitSeg() {
  const p = picked;
  const units = p.units_per_strip > 1
    ? [['base', p.base_unit[0].toUpperCase() + p.base_unit.slice(1) + 's'], ['strip', 'Strips'], ['box', 'Boxes (10)']]
    : [['base', p.base_unit[0].toUpperCase() + p.base_unit.slice(1) + 's']];
  $('unitSeg').innerHTML = units.map(([k, label]) => `<button data-u="${k}" aria-pressed="${k === pickUnit}">${label}</button>`).join('');
  $('unitSeg').querySelectorAll('button').forEach(b => b.onclick = () => { pickUnit = b.dataset.u; renderUnitSeg(); $('qtyNum').focus(); });
}

async function offerSubstitutes(m) {
  await api('/api/stockout', { term: m.name, productId: m.product_id });
  const alts = await api(`/api/substitutes?id=${m.product_id}`);
  showMsg($('billMsg'), '', 'ok');
  $('billMsg').innerHTML = `<div class="msg ok"><b>${esc(m.name)} is out of stock.</b>
    ${alts.length ? ' Same medicine and strength, in stock now:' : ' Nothing with the same composition is in stock. It has been noted for your next order.'}
    ${alts.map(a => `<div style="margin-top:8px"><button class="btn small" data-alt="${a.product_id}">${esc(a.name)} — ${a.units} ${esc(plural(a.base_unit, a.units))}</button></div>`).join('')}</div>`;
  $('billMsg').querySelectorAll('[data-alt]').forEach(b => b.onclick = async () => {
    matches = await api(`/api/search?q=${encodeURIComponent(b.textContent.split(' — ')[0])}`);
    $('billMsg').innerHTML = ''; choose(0);
  });
}

async function addToCart() {
  if (!picked) return;
  const n = Number($('qtyNum').value);
  if (!Number.isFinite(n) || n <= 0) return toast('Enter how many, for example 1 or 2', true);
  const qty = unitsFor(picked, n, pickUnit);
  addLine({ productId: picked.product_id, name: picked.name, baseUnit: picked.base_unit,
            unitsPerStrip: picked.units_per_strip, qty });
  picked = null; $('pick').hidden = true; $('q').value = ''; $('q').focus();
  await refreshQuote();
}

/** What goes to the server: the medicine, how many, and — only for a scanned
    label — the exact batch it must come out of. */
const cartItems = () => cart.map(c => c.batchId
  ? { key: c.key, productId: c.productId, qty: c.qty, batchId: c.batchId }
  : { key: c.key, productId: c.productId, qty: c.qty });

/** The server prices the basket, so the screen shows exactly what will be billed. */
async function refreshQuote() {
  $('billMsg').innerHTML = '';
  if (!cart.length) { quote = null; return renderBill(); }
  try {
    quote = await api('/api/quote', { items: cartItems() });
  } catch (e) {
    quote = null;
    showMsg($('billMsg'), e.message);
  }
  renderBill();
}

function renderBill() {
  const lines = quote?.lines ?? [];
  $('billEmpty').hidden = lines.length > 0;
  $('billCount').textContent = lines.length ? `${cart.length} ${plural('medicine', cart.length)}` : '';
  $('billLines').innerHTML = lines.map(l => {
    const daysLeft = Math.round((new Date(l.expiry) - new Date()) / 86400000);
    return `<tr class="${daysLeft <= 30 ? 'warnrow' : ''}">
      <td><div class="strong">${esc(l.name)}</div><div class="sub">${esc(l.generic || '')}</div></td>
      <td>${esc(l.batchNo)}<div class="sub">${mmYYYY(l.expiry)}${daysLeft <= 30 ? ` · ${daysLeft} days left` : ''}</div></td>
      <td class="num">${l.qty} ${esc(plural(l.baseUnit, l.qty))}</td>
      <td class="num">${rs(l.mrp_paise)}</td>
      <td class="num strong">${rs(l.gross_paise)}</td>
      <td class="num"><button class="x" data-rm="${l.key}" aria-label="Remove ${esc(l.name)}">×</button></td></tr>`;
  }).join('');
  $('billLines').querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => {
    // Remove only the line that was pressed, not every line of that medicine.
    cart = cart.filter(c => c.key !== Number(b.dataset.rm)); await refreshQuote();
  });

  $('tTaxable').textContent = rs(quote?.taxable ?? 0);
  $('tGst').textContent = rs(quote?.gst ?? 0);
  $('tRound').textContent = rs(quote ? quote.total - quote.net : 0);
  $('tTotal').textContent = rsR(quote?.total ?? 0);

  const needsRx = !!quote?.needsRx;
  $('rxBlock').hidden = !needsRx;
  const rxDone = !needsRx || ($('rxDoctor').value.trim() && $('rxPatient').value.trim() && $('rxAddress').value.trim());
  $('saveBill').disabled = !lines.length || !rxDone || saving;
  $('saveBill').textContent = saving ? 'Saving…' : (needsRx && !rxDone) ? 'Fill in the prescription record first' : 'Save and print bill';
}

async function saveBill() {
  if (saving || !cart.length) return;
  /* The Save button is disabled when a Schedule H1 line has no doctor and
     patient, but F9 calls this directly, so the same rule has to live here.
     The database refuses it either way; this is so the counter gets told what
     to do instead of an error. */
  if (quote?.needsRx && !($('rxDoctor').value.trim() && $('rxPatient').value.trim())) {
    showMsg($('billMsg'), 'This bill has a Schedule H1 medicine. Write the doctor and patient before saving.', 'warn');
    $('rxDoctor').focus();
    return;
  }
  saving = true; renderBill();
  try {
    const bill = await api('/api/bill', {
      items: cartItems(),
      payMode, clientUuid: billUuid,
      doctorName: $('rxDoctor').value || null,
      patientName: $('rxPatient').value || null,
      patientAddress: $('rxAddress').value || null,
    });
    printBill(bill);
    toast(bill.duplicate ? `That bill was already saved as ${bill.bill_no}.` : `Bill ${bill.bill_no} saved — ${rsR(bill.total_paise)}`);
    clearBill();
    loadRecent(); loadAlerts();
  } catch (e) {
    showMsg($('billMsg'), e.message);
    toast(e.message, true);
    await refreshQuote();
  } finally { saving = false; renderBill(); }
}

function clearBill() {
  cart = []; quote = null; picked = null; billUuid = crypto.randomUUID();
  $('pick').hidden = true; $('q').value = ''; $('billMsg').innerHTML = '';
  ['rxDoctor','rxPatient','rxAddress'].forEach(id => $(id).value = '');
  setPay('cash'); renderBill(); $('q').focus();
}

function setPay(mode) {
  payMode = mode;
  $('paySeg').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.pay === mode)));
}

async function loadRecent() {
  const bills = await api('/api/bills?limit=8');
  $('recentBills').innerHTML = bills.map(b => `<tr>
    <td><button class="linkbtn" data-bill="${b.id}">${esc(b.bill_no)}</button>
        <div class="sub">${(b.created_at || '').slice(11, 16)}${b.is_cancelled ? ' · cancelled' : ''}</div></td>
    <td class="num">${rsR(b.total_paise)}<div class="sub">${esc(b.pay_mode)}</div></td></tr>`).join('')
    || '<tr><td class="muted">No bills yet today.</td></tr>';
  $('recentBills').querySelectorAll('[data-bill]').forEach(b => b.onclick = () => openBill(Number(b.dataset.bill)));
}

async function openBill(id) {
  const bill = await api(`/api/bill?id=${id}`);
  const rows = bill.items.map(i => `<tr><td>${esc(i.name)}<div class="sub">${esc(i.batch_no)} · ${mmYYYY(i.expiry)}</div></td>
      <td class="num">${i.qty}</td><td class="num">${rs(i.gross_paise)}</td>
      <td class="num"><input data-k="ret_${i.id}" inputmode="numeric" value="0" style="width:70px;padding:6px;border:1px solid var(--line);border-radius:4px"></td></tr>`).join('');
  const out = await ask({
    title: `Bill ${bill.bill_no}${bill.is_cancelled ? ' (cancelled)' : ''}`,
    okText: bill.is_cancelled ? 'Close' : 'Take these back',
    bodyHtml: `<p class="muted">${dmy(bill.business_date)} · ${esc(bill.pay_mode)} · ${rsR(bill.total_paise)}</p>
      <div class="tablewrap"><table><thead><tr><th>Medicine</th><th class="num">Sold</th><th class="num">Amount</th><th class="num">Return</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
      ${bill.is_cancelled ? '' : `<div class="field" style="margin-top:12px"><label>Or cancel the whole bill — say why</label>
        <input data-k="cancelReason" placeholder="e.g. billed twice by mistake"></div>`}`,
  });
  if (!out || bill.is_cancelled) return;

  if (out.cancelReason && out.cancelReason.trim().length >= 3) {
    try { await api('/api/bill/cancel', { id, reason: out.cancelReason });
      toast(`Bill ${bill.bill_no} cancelled, stock put back.`);
      loadRecent(); loadAlerts(); afterBillChanged(); }
    catch (e) { toast(e.message, true); }
    return;
  }
  const items = bill.items.map(i => ({ saleItemId: i.id, qty: Number(out['ret_' + i.id] || 0) }))
                          .filter(i => i.qty > 0);
  if (!items.length) return;
  try {
    const r = await api('/api/return', { saleId: id, items, refundMode: bill.pay_mode });
    toast(`Credit note ${r.return_no} — refund ${rs(r.refund_paise)}. Stock is back on the shelf.`);
    loadRecent(); loadAlerts(); afterBillChanged();
  } catch (e) { toast(e.message, true); }
}

/* Cancelling a bill or taking a return can be started from the Day report,
   which then sits behind the dialog showing figures that have just changed.
   Redraw it, or the owner counts the day's takings from a stale screen. */
function afterBillChanged() {
  if (screen === 'reports') renderReport();
}

// ---------------------------------------------------------------- printing

function billHtml(bill) {
  const W = 40, pad = (s, n) => String(s).padEnd(n).slice(0, n), rp = (s, n) => String(s).padStart(n).slice(-n);
  const L = [];
  L.push(`<div class="center"><b>${esc(SHOP?.name || 'Sri Nachiya Medicals')}</b></div>`);
  L.push(`<div class="center">${esc(SHOP?.address1 || '')}</div>`);
  L.push(`<div class="center">${esc(SHOP?.address2 || '')}</div>`);
  if (SHOP?.phone) L.push(`<div class="center">Ph ${esc(SHOP.phone)}</div>`);
  L.push(`<div class="center">GSTIN ${esc(SHOP?.gstin || '__________')}</div>`);
  /* Many Tamil Nadu retail licences are issued as one reference covering both
     Form 20 and Form 21 — "CBE/6064/20/21". Print what is filled in, once. */
  const licences = [...new Set([SHOP?.dl_20b, SHOP?.dl_21b].map(s => String(s || '').trim()).filter(Boolean))];
  L.push(`<div class="center">DL ${esc(licences.join(' / ') || '____')}</div>`);
  L.push('<div class="line"></div>');
  L.push(`<div>${pad(bill.bill_no, 20)}${rp(dmy(bill.business_date), 20)}</div>`);
  L.push(`<div>${rp((bill.created_at || '').slice(11, 16), 40)}</div>`);
  if (bill.doctor_name) L.push(`<div>Dr: ${esc(bill.doctor_name)} · Pt: ${esc(bill.patient_name || '')}</div>`);
  L.push('<div class="line"></div>');
  for (const i of bill.items) {
    L.push(`<div>${esc(pad(i.name, W))}</div>`);
    L.push(`<div>  ${esc(pad(i.batch_no + ' ' + mmYYYY(i.expiry), 17))}${rp(i.qty, 6)}${rp((i.mrp_paise/100).toFixed(2), 8)}${rp((i.gross_paise/100).toFixed(2), 9)}</div>`);
  }
  L.push('<div class="line"></div>');
  L.push(`<div>${pad('Before GST', 26)}${rp((bill.taxable_paise/100).toFixed(2), 14)}</div>`);
  L.push(`<div>${pad('CGST + SGST', 26)}${rp((bill.gst_paise/100).toFixed(2), 14)}</div>`);
  if (bill.round_paise) L.push(`<div>${pad('Round off', 26)}${rp((bill.round_paise/100).toFixed(2), 14)}</div>`);
  L.push(`<div><b>${pad('TOTAL', 26)}${rp((bill.total_paise/100).toFixed(2), 14)}</b></div>`);
  L.push(`<div>${pad('Paid by', 26)}${rp(bill.pay_mode, 14)}</div>`);
  L.push('<div class="line"></div>');
  L.push('<div class="center">Thank you. Keep this bill for returns.</div>');
  if (SHOP?.pharmacist) L.push(`<div class="center">Pharmacist: ${esc(SHOP.pharmacist)}</div>`);
  return `<div class="bill80">${L.join('')}</div>`;
}

function printBill(bill) {
  $('print-area').innerHTML = billHtml(bill);
  window.print();
}

function printReport(title, meta, innerHtml) {
  $('print-area').innerHTML = `<div class="a4"><h1>${esc(SHOP?.name || 'Sri Nachiya Medicals')}</h1>
    <div class="meta">${esc(SHOP?.address1 || '')}, ${esc(SHOP?.address2 || '')}${SHOP?.gstin ? ' · GSTIN ' + esc(SHOP.gstin) : ''}<br>
    <b>${esc(title)}</b> — ${esc(meta)}</div>${innerHtml}</div>`;
  window.print();
}

// ================================================================ add stock

let delivery = [], scannedCode = null, productsCache = [];

/**
 * What one pack really cost, after the invoice's discount and after free packs
 * are shared in. This is the figure every profit in the app is worked out
 * from, so it is worked out here exactly as `receiveDelivery` does it in
 * logic.js — discount off the whole line, rounded once, then divided over
 * every pack that arrived. Two slightly different formulas would put one
 * number on the screen and a different one in the database.
 */
function realCostPerPack(listCostPaise, packs, freePacks = 0, discountPct = 0) {
  const bp = Math.round((Number(discountPct) || 0) * 100);
  const linePaise = Math.round(Number(listCostPaise) * packs * (10000 - bp) / 10000);
  return Math.round(linePaise / (packs + (Number(freePacks) || 0)));
}

async function loadStockScreen() {
  const [suppliers, products] = await Promise.all([api('/api/suppliers'), api('/api/products')]);
  productsCache = products;
  const keep = $('dSupplier').value;
  $('dSupplier').innerHTML = '<option value="">Choose…</option>' +
    suppliers.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  $('dSupplier').value = keep;
  $('medList').innerHTML = products.map(p => `<option value="${esc(p.name)}">`).join('');
  if (!$('dExpM').options.length) {
    $('dExpM').innerHTML = '<option value="">Month</option>' +
      Array.from({ length:12 }, (_, i) => `<option value="${String(i+1).padStart(2,'0')}">${String(i+1).padStart(2,'0')}</option>`).join('');
    const y = new Date().getFullYear();
    $('dExpY').innerHTML = '<option value="">Year</option>' + Array.from({ length:7 }, (_, i) => `<option>${y + i}</option>`).join('');
  }
  renderDelivery();
}

/** Reads the GS1 code printed on a pharma carton: product, expiry, batch. */
function parseGs1(raw) {
  const s = raw.replace(/^\]\w\d/, '').replace(/^\u001d/, '');
  const fixed = { '01':14, '11':6, '17':6 }, out = {};
  let i = 0;
  while (i < s.length) {
    const ai = s.slice(i, i + 2); i += 2;
    if (fixed[ai]) { out[ai] = s.slice(i, i + fixed[ai]); i += fixed[ai]; if (s[i] === '\u001d') i++; }
    else if (ai === '10' || ai === '21') { const e = s.indexOf('\u001d', i); out[ai] = s.slice(i, e < 0 ? s.length : e); i = e < 0 ? s.length : e + 1; }
    else break;
  }
  return out;
}

/* Reading a code out of the camera picture, two ways.

   Chrome and Edge can do it themselves, and will read the striped barcode
   printed on a pack as well as a QR code. Safari and Firefox cannot, so the
   shop's own labels are read by qr-reader.js, which is kept beside this file
   and loaded only when it is actually needed. That is the reason the shop's
   labels are QR squares and not stripes: a QR code can be read by any camera
   in any browser, with nothing bought and nothing installed. */
let camStream = null, camWhere = 'stock';

let readerLoading = null;
function loadQrReader() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  if (!readerLoading) {
    readerLoading = new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = '/qr-reader.js';
      s.onload = () => window.jsQR ? ok(window.jsQR) : fail(new Error('no reader'));
      s.onerror = () => fail(new Error('no reader'));
      document.head.appendChild(s);
    }).catch(e => { readerLoading = null; throw e; });
  }
  return readerLoading;
}

/** Something with `.read(video)` that gives back the code it saw, or null. */
async function makeReader() {
  try {
    const detector = new window.BarcodeDetector({
      formats: ['qr_code', 'data_matrix', 'ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e'] });
    // Prove it works before relying on it; some browsers have the name but not the ability.
    await detector.detect(document.createElement('canvas'));
    return { read: async v => (await detector.detect(v))[0]?.rawValue || null, kind: 'any code' };
  } catch {
    const jsQR = await loadQrReader();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return {
      kind: 'QR only',
      read: v => {
        const vw = v.videoWidth, vh = v.videoHeight;
        if (!vw || !vh) return null;
        // A smaller picture is read many times faster and is still ample for a
        // label held up to the camera.
        const k = Math.min(1, 960 / Math.max(vw, vh));
        const w = Math.round(vw * k), h = Math.round(vh * k);
        canvas.width = w; canvas.height = h;
        ctx.drawImage(v, 0, 0, w, h);
        return jsQR(ctx.getImageData(0, 0, w, h).data, w, h,
          { inversionAttempts: 'dontInvert' })?.data || null;
      },
    };
  }
}

/* The camera serves both screens: at the counter it puts a strip on the bill,
   and at the back it fills in a delivery. Same reader, different landing. */
const CAM = {
  stock: { panel: 'camPanel', video: 'camView', msg: 'dScanMsg', keepOpen: false, take: handleScan },
  bill:  { panel: 'bCamPanel', video: 'bCamView', msg: 'billMsg', keepOpen: true,  take: sellScanned },
};

async function startCamera(where = 'stock') {
  stopCamera();
  camWhere = where;
  const ui = CAM[where];
  try {
    const reader = await makeReader();
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 } } });
    const video = $(ui.video);
    video.srcObject = camStream;
    await video.play();
    $(ui.panel).hidden = false;

    /* The same sticker sits in front of the lens for a second or two after it
       is read, so ignore a repeat until something else comes along. */
    let last = '', lastAt = 0;
    const look = async () => {
      if (!camStream || camWhere !== where) return;
      try {
        const code = await reader.read(video);
        if (code && !(code === last && Date.now() - lastAt < 2500)) {
          last = code; lastAt = Date.now();
          if (!ui.keepOpen) stopCamera();               // one shot when filling a form
          await ui.take(code);                          // a queue keeps scanning
        }
      } catch {}
      if (camStream) setTimeout(look, 350);
    };
    look();
  } catch {
    stopCamera();
    showMsg($(ui.msg), 'The camera could not be opened. Allow the camera for this page, or type the details instead.', 'warn');
  }
}

function stopCamera() {
  camStream?.getTracks().forEach(t => t.stop());
  camStream = null;
  for (const ui of Object.values(CAM)) { const p = $(ui.panel); if (p) p.hidden = true; }
}

async function handleScan(code) {
  const raw = code.trim(); if (!raw) return;
  const box = $('dScanMsg');

  /* One of our own stickers: the medicine, batch and expiry are all known, so
     only the quantity and prices are left to type. */
  if (OUR_LABEL.test(raw)) {
    const found = await api(`/api/by-code?code=${encodeURIComponent(raw)}`);
    $('dScan').value = '';
    if (!found.batch) return showMsg(box, 'That label is not in this computer. Type the details below instead.', 'warn');
    const b = found.batch;
    $('dMed').value = b.name; onMedicineChosen();
    $('dBatch').value = b.batch_no;
    $('dExpY').value = b.expiry.slice(0, 4);
    $('dExpM').value = b.expiry.slice(5, 7);
    $('dMrp').value = (b.mrp_paise / 100).toFixed(2);
    showMsg(box, `${b.name}, batch ${b.batch_no}, expires ${mmYYYY(b.expiry)}. Now enter how many arrived.`, 'ok');
    $('dPacks').focus();
    return;
  }

  let key = raw, batch = null, exp = null;
  if (!/^\d{8,14}$/.test(raw)) { const g = parseGs1(raw); key = g['01'] || raw; batch = g['10'] || null; exp = g['17'] || null; }
  else if (raw.length === 13) key = '0' + raw;

  const found = await api(`/api/by-code?code=${encodeURIComponent(key)}`);
  if (found.product) {
    $('dMed').value = found.product.name; onMedicineChosen();
    if (batch) $('dBatch').value = batch;
    if (exp) { $('dExpY').value = String(2000 + Number(exp.slice(0,2))); $('dExpM').value = exp.slice(2,4); }
    showMsg(box, `Filled from the box: ${found.product.name}${batch ? ', batch ' + batch : ''}. Now enter how many arrived.`, 'ok');
    $('dPacks').focus();
  } else {
    scannedCode = key;
    showMsg(box, 'This code is not linked to a medicine yet. Choose the medicine below and it will be remembered next time.', 'warn');
    $('dMed').focus();
  }
  $('dScan').value = '';
}

function currentDeliveryProduct() {
  const name = $('dMed').value.trim().toLowerCase();
  return productsCache.find(p => p.name.toLowerCase() === name);
}

function onMedicineChosen() {
  const p = currentDeliveryProduct();
  const word = p ? (p.units_per_strip > 1 ? 'strip' : p.base_unit) : 'strip';
  $('dPacksLabel').textContent = `${word[0].toUpperCase() + word.slice(1)}s received`;
  $('dMrpLabel').textContent = `MRP per ${word} (₹)`;
  // Named after the invoice's own column, so the eye can go straight across.
  $('dCostLabel').textContent = `Trade price per ${word} (₹)`;
}

async function addDeliveryLine() {
  const box = $('dMsg');
  const p = currentDeliveryProduct();
  if (!p) return showMsg(box, 'Choose the medicine from the list, or add it as a new medicine.');
  const batchNo = $('dBatch').value.trim().toUpperCase();
  const y = $('dExpY').value, m = $('dExpM').value;
  const packs = Number($('dPacks').value), free = Number($('dFree').value || 0);
  const mrp = paise($('dMrp').value), cost = paise($('dCost').value);

  if (!batchNo) return showMsg(box, 'Enter the batch number printed on the box.');
  if (!y || !m) return showMsg(box, 'Choose the expiry month and year from the box.');
  const expiry = todayStr(new Date(Number(y), Number(m), 0));
  if (expiry < todayStr()) return showMsg(box, 'This stock has already expired. Do not take it in — send it back with the delivery.');
  if (!Number.isInteger(packs) || packs <= 0) return showMsg(box, 'Enter how many packs arrived.');
  if (!Number.isFinite(mrp) || mrp <= 0) return showMsg(box, 'Enter the MRP printed on the pack.');
  if (!Number.isFinite(cost) || cost <= 0) return showMsg(box, 'Enter the cost from the invoice.');
  if (cost > mrp) return showMsg(box, `Cost ${rs(cost)} is more than the MRP ${rs(mrp)}. Check the invoice.`);

  delivery.push({ productId: p.product_id, name: p.name, batchNo, expiry, packs, freePacks: free,
                  mrpPaise: mrp, costPaise: cost, code: scannedCode, word: p.units_per_strip > 1 ? 'strip' : p.base_unit });
  scannedCode = null;

  const notes = [`Added ${p.name}.`];
  const months = Math.round((new Date(expiry) - new Date()) / 86400000 / 30);
  if (months < 6) notes.push(`Short expiry: about ${months} ${plural('month', months)} left. Keep it only if the distributor will take it back.`);
  if (free) notes.push(`With ${free} free, each pack really cost ` +
    `${rs(realCostPerPack(cost, packs, free, Number($('dDisc')?.value || 0)))}.`);
  showMsg(box, notes.join(' '), notes.length > 1 ? 'warn' : 'ok');

  ['dMed','dBatch','dPacks','dMrp','dCost'].forEach(id => $(id).value = '');
  $('dFree').value = '0';
  renderDelivery(); $('dScan').focus();
}

function renderDelivery() {
  $('dEmpty').hidden = delivery.length > 0;
  const disc = Number($('dDisc')?.value || 0);

  $('dLines').innerHTML = delivery.map((d, i) => {
    const real = realCostPerPack(d.costPaise, d.packs, d.freePacks, disc);
    const notes = [];
    if (disc > 0) notes.push(`${rs(d.costPaise)} less ${disc}%`);
    if (d.freePacks) notes.push(`shared over ${d.packs + d.freePacks} packs`);
    return `<tr>
      <td class="strong">${esc(d.name)}</td>
      <td>${esc(d.batchNo)}<div class="sub">${mmYYYY(d.expiry)}</div></td>
      <td class="num">${d.packs} ${esc(plural(d.word, d.packs))}${d.freePacks ? `<div class="sub">+ ${d.freePacks} free</div>` : ''}</td>
      <td class="num">${rs(d.mrpPaise)}</td>
      <td class="num">${rs(real)}${notes.length ? `<div class="sub">${esc(notes.join(', '))}</div>` : ''}</td>
      <td class="num"><button class="x" data-rm="${i}" aria-label="Remove">×</button></td></tr>`;
  }).join('');
  $('dLines').querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { delivery.splice(Number(b.dataset.rm), 1); renderDelivery(); });
  $('dSave').disabled = !delivery.length;
  $('dSave').textContent = delivery.length
    ? `Save delivery and add ${delivery.length} ${plural('medicine', delivery.length)} to stock`
    : 'Save delivery and add to stock';
}

async function saveDelivery() {
  const supplierId = Number($('dSupplier').value);
  if (!supplierId) { toast('Choose the distributor at the top first', true); return $('dSupplier').focus(); }
  $('dSave').disabled = true;
  try {
    const out = await api('/api/delivery', { supplierId, invoiceNo: $('dInvoice').value || null,
      discountPct: Number($('dDisc').value || 0), lines: delivery });
    toast(`Stock added: ${out.lines} ${plural('medicine', out.lines)}, invoice total ${rs(out.total_paise)}`);
    delivery = []; $('dInvoice').value = ''; hideMsg($('dScanMsg'));
    /* The moment to print stickers is now, with the boxes still on the counter. */
    $('dMsg').innerHTML = `<div class="msg ok"><b>Stock added.</b>
      Print a label for each box before you put them away — then the camera can
      read them at the counter.
      <div class="row" style="margin-top:10px;align-items:flex-end">
        <div class="field" style="max-width:130px"><label for="lblCopies">Labels per box</label>
          <input id="lblCopies" inputmode="numeric" value="1"></div>
        <button class="btn primary small" id="lblPrint">Print labels</button>
        <button class="btn small" id="lblSkip">Not now</button>
      </div></div>`;
    $('lblPrint').onclick = () => {
      const copies = Math.min(Math.max(1, Number($('lblCopies').value) || 1), 50);
      window.open(`/labels?purchase=${out.id}&copies=${copies}`, '_blank');
    };
    $('lblSkip').onclick = () => hideMsg($('dMsg'));
    await loadStockScreen(); loadAlerts();
  } catch (e) { toast(e.message, true); showMsg($('dMsg'), e.message); }
  finally { renderDelivery(); }
}

async function addNewMedicine() {
  const out = await ask({ title:'New medicine', okText:'Add medicine', bodyHtml:`
    <div class="formgrid">
      <div class="field span2"><label>Name</label><input data-k="name" placeholder="e.g. Dolo 650"></div>
      <div class="field span2"><label>Generic name</label><input data-k="genericName"></div>
      <div class="field span2"><label>Company</label><input data-k="manufacturer"></div>
      <div class="field"><label>Sold as</label><select data-k="baseUnit"><option>tablet</option><option>capsule</option><option>bottle</option><option>piece</option></select></div>
      <div class="field"><label>Per strip</label><input data-k="unitsPerStrip" inputmode="numeric" value="1"></div>
      <div class="field"><label>GST %</label><select data-k="gstRate"><option>5</option><option>0</option><option>12</option><option>18</option></select></div>
      <div class="field"><label>Schedule</label><select data-k="schedule">
        <option value="">Choose…</option>
        <option value="OTC">OTC — sold without a prescription</option>
        <option value="G">G — with a pharmacist</option>
        <option value="H">H — prescription only</option>
        <option value="H1">H1 — prescription, and the register</option>
        <option value="X">X — prescription, kept locked</option>
      </select></div>
      <div class="field"><label>Rack</label><input data-k="rack"></div>
      <div class="field"><label>Remind below (packs)</label><input data-k="reorderPacks" inputmode="numeric" value="0"></div>
    </div>
    <p class="muted" style="margin:10px 0 0">The schedule is on the pack, near the price. It decides
      whether the counter asks for the doctor's name, so it is worth getting right.</p>`,
    /* No default here on purpose. OTC is the least careful answer, and a
       medicine left on it by accident would be sold without the prescription
       details the law wants — so the choice has to be made, not inherited. */
    check: o => {
      if (!o.name?.trim()) return 'The medicine needs a name.';
      if (!o.schedule) return 'Choose the schedule. It is printed on the pack, near the price.';
      return null;
    } });
  if (!out) return;
  try {
    const p = await api('/api/product', out);
    await loadStockScreen();
    $('dMed').value = p.name; onMedicineChosen();
    toast(`${p.name} added. Now enter the batch and price.`);
  } catch (e) { toast(e.message, true); }
}

async function addNewSupplier() {
  const out = await ask({ title:'New distributor', okText:'Add distributor', bodyHtml:`
    <div class="formgrid">
      <div class="field span2"><label>Name</label><input data-k="name"></div>
      <div class="field span2"><label>Phone</label><input data-k="phone"></div>
      <div class="field"><label>Days to deliver</label><input data-k="leadDays" inputmode="numeric" value="3"></div>
      <div class="field"><label>Takes returns until (months before expiry)</label><input data-k="returnMonths" inputmode="numeric" value="3"></div>
    </div>` });
  if (!out) return;
  try { const s = await api('/api/supplier', out); await loadStockScreen(); $('dSupplier').value = s.id; toast(`${s.name} added.`); }
  catch (e) { toast(e.message, true); }
}

/** Correct a distributor's details — a mistyped name or a changed phone. */
async function editSupplier() {
  const id = Number($('dSupplier').value);
  if (!id) return toast('Choose the distributor to edit first', true);
  const s = (await api('/api/suppliers')).find(x => x.id === id);
  if (!s) return toast('That distributor is no longer in the list', true);

  const out = await ask({ title:`Edit ${s.name}`, okText:'Save',
    bodyHtml:`<div class="formgrid">
      <div class="field span2"><label>Name</label><input data-k="name" value="${esc(s.name)}"></div>
      <div class="field span2"><label>Phone</label><input data-k="phone" value="${esc(s.phone || '')}"></div>
      <div class="field"><label>Days to deliver</label><input data-k="leadDays" inputmode="numeric" value="${s.lead_days}"></div>
      <div class="field"><label>Takes returns until (months before expiry)</label>
        <input data-k="returnMonths" inputmode="numeric" value="${s.return_months}"></div>
    </div>`,
    check: o => o.name?.trim() ? null : 'The distributor needs a name.' });
  if (!out) return;

  try { const r = await api('/api/supplier/update', { id, ...out });
    await loadStockScreen(); $('dSupplier').value = id;
    toast(Object.keys(r.changed).length ? `${r.supplier.name} saved.` : 'Nothing changed.');
  } catch (e) { toast(e.message, true); }
}

/**
 * Take a distributor off the list. One that never delivered anything is
 * removed outright; one that did keeps its name, because the deliveries on
 * record have to go on saying who they came from.
 */
async function removeSupplier() {
  const id = Number($('dSupplier').value);
  if (!id) return toast('Choose the distributor to remove first', true);
  const name = $('dSupplier').selectedOptions[0]?.textContent || 'this distributor';

  const out = await ask({ title:`Remove ${name}?`, okText:'Remove',
    bodyHtml:`<p>${esc(name)} will no longer appear when adding stock.</p>
      <p class="muted">If they have delivered before, the name is kept on those deliveries — only the list changes.</p>` });
  if (!out) return;

  try { const r = await api('/api/supplier/delete', { id });
    await loadStockScreen(); $('dSupplier').value = ''; toast(r.message);
  } catch (e) { toast(e.message, true); }
}

// ------------------------------------------------- adding many at once

/*
 * A shop opening its books has hundreds of medicines on the shelves. One
 * dialog per medicine would take days, so the list is pasted straight out of
 * Excel or chosen as a file.
 *
 * The owner always sees what will happen before anything is written, with the
 * line number of every row that cannot be used — a list of four hundred always
 * has a few odd ones, and hunting for them afterwards is miserable.
 */

let bulkPreviewed = '';          // the exact text that was checked

function showBulk(open) {
  $('bulkPanel').hidden = !open;
  if (open) { loadBulkSuppliers(); $('bulkText').focus(); }
}

async function loadBulkSuppliers() {
  const list = await api('/api/suppliers');
  $('bulkSupplier').innerHTML = '<option value="">Not needed</option>' +
    list.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
}

$('bulkBtn').onclick = () => showBulk($('bulkPanel').hidden);
$('bulkClose').onclick = () => showBulk(false);

$('bulkFile').onchange = async e => {
  const file = e.target.files?.[0];
  if (!file) return;
  $('bulkText').value = await file.text();
  $('bulkResult').innerHTML = '';
  toast(`${file.name} loaded. Press "Check the list".`);
};

$('bulkCheck').onclick = async () => {
  const text = $('bulkText').value;
  if (!text.trim()) return toast('Paste the rows first, or choose a file', true);

  try {
    const { rows, counts, hint } = await api('/api/import/preview', { text });
    bulkPreviewed = text;
    if (!rows.length) { $('bulkResult').innerHTML = '<div class="msg warn">Nothing was found in that.</div>'; return; }

    const withStock = rows.filter(r => r.action === 'add' && r.opening).length;
    const problems = rows.filter(r => r.action === 'problem');

    $('bulkResult').innerHTML = `
      <div class="msg ${counts.problem ? 'warn' : 'ok'}">
        <b>${counts.add} ${plural('medicine', counts.add)} will be added.</b>
        ${counts.skip ? ` ${counts.skip} already in the list, so ${counts.skip === 1 ? 'it' : 'they'} will be left alone.` : ''}
        ${counts.problem ? ` ${counts.problem} ${plural('row', counts.problem)} cannot be used — see below.` : ''}
        ${withStock ? ` ${withStock} ${plural('medicine', withStock)} also ${withStock === 1 ? 'brings' : 'bring'} opening stock.` : ''}
      </div>
      ${hint ? `<div class="msg warn" style="margin-top:10px">${esc(hint)}</div>` : ''}
      ${problems.length ? `<div class="block" style="margin-top:12px">
        <div class="block-head"><h3>Rows that cannot be used</h3>
          <p>Fix these in your sheet and paste again. Everything else can be saved now.</p></div>
        <div class="tablewrap"><table>
          <thead><tr><th class="num">Line</th><th>Medicine</th><th>What is wrong</th></tr></thead>
          <tbody>${problems.map(p => `<tr>
            <td class="num">${p.line}</td><td>${esc(p.name || '—')}</td><td>${esc(p.why)}</td></tr>`).join('')}
          </tbody></table></div></div>` : ''}
      ${counts.add ? `<div class="row" style="margin-top:12px">
        <button class="btn primary" id="bulkSave">Add ${counts.add} ${plural('medicine', counts.add)}</button>
        ${withStock && !$('bulkSupplier').value
          ? '<span class="muted">Choose the distributor above first — the sheet has opening stock in it.</span>' : ''}
      </div>` : ''}`;

    if ($('bulkSave')) $('bulkSave').onclick = saveBulk;
  } catch (e) { $('bulkResult').innerHTML = `<div class="msg bad">${esc(e.message)}</div>`; }
};

async function saveBulk() {
  /* Save exactly what was checked. If the box has been edited since, the list
     on screen is no longer what would be written. */
  if ($('bulkText').value !== bulkPreviewed) {
    return toast('The list changed since it was checked. Press "Check the list" again.', true);
  }
  const button = $('bulkSave');
  const wording = button.textContent;
  button.disabled = true;
  button.textContent = 'Adding them…';
  $('bulkResult').insertAdjacentHTML('beforeend',
    '<p class="muted" id="bulkBusy" style="margin:10px 0 0">Adding the medicines. This takes a few seconds for a long list — leave the screen as it is.</p>');
  try {
    const out = await api('/api/import/save', {
      text: bulkPreviewed, supplierId: Number($('bulkSupplier').value) || null });

    $('bulkResult').innerHTML = `<div class="msg ${out.failed.length ? 'warn' : 'ok'}">
      <b>${out.added} ${plural('medicine', out.added)} added.</b>
      ${out.stocked ? ` ${out.stocked} also went onto the shelf with opening stock.` : ''}
      ${out.failed.length ? `<div style="margin-top:8px">${out.failed.length} could not be added:
        ${out.failed.map(f => `<div class="sub">Line ${f.line}, ${esc(f.name)}: ${esc(f.why)}</div>`).join('')}</div>` : ''}
      </div>`;
    $('bulkText').value = ''; bulkPreviewed = '';
    loadMedicines();
    if (out.stocked) loadAlerts();
  } catch (e) {
    button.disabled = false;
    button.textContent = wording;
    $('bulkBusy')?.remove();
    $('bulkResult').innerHTML = `<div class="msg bad">${esc(e.message)}</div>`;
  }
}

// ================================================================ medicines

let medSelected = null;

async function loadMedicines() {
  const term = $('mSearch').value.trim().toLowerCase();
  const products = await api('/api/products?all=1');
  const rows = products.filter(p => !term || p.name.toLowerCase().includes(term) ||
    (p.generic_name || '').toLowerCase().includes(term));
  $('mList').innerHTML = rows.map(p => `<tr><td>
      <button class="linkbtn" data-p="${p.product_id}" style="text-decoration:none;color:inherit;font-weight:600">${esc(p.name)}</button>
      <div class="sub">${esc(p.generic_name || '')}${p.is_active ? '' : ' · archived'}</div></td>
      <td class="num">${p.units} ${esc(plural(p.base_unit, p.units))}</td></tr>`).join('')
    || '<tr><td class="muted">Nothing matches.</td></tr>';
  $('mList').querySelectorAll('[data-p]').forEach(b => b.onclick = () => openMedicine(Number(b.dataset.p)));
  if (medSelected) openMedicine(medSelected);
}

async function openMedicine(id) {
  medSelected = id;
  const { product: p, batches, history, units, costsHidden } = await api(`/api/product?id=${id}`);
  const word = p.units_per_strip > 1 ? 'strip' : p.base_unit;
  const codes = await api(`/api/codes?id=${id}`);
  /* Deleting is only offered when nothing points at this medicine. Once a
     batch or a bill mentions it, archiving is the only way out. */
  const neverUsed = batches.length === 0 && history.stock.length === 0;

  const batchRows = batches.map(b => {
    /* While the shop is locked the server sends no cost at all, so there is
       nothing here to uncover — the columns simply have nothing to show. */
    let costCell = '<td class="num muted">—</td>', profitCell = '<td class="num muted">—</td>';
    if (!costsHidden) {
      // MRP already has GST inside it, so tax comes out of the selling side
      // before the cost is taken off. Both sides tax-free, once.
      const taxable = Math.round(b.mrp_paise * 100 / (100 + p.gst_rate));
      const profit = taxable - b.cost_paise;
      costCell = `<td class="num">${rs(b.cost_paise)}</td>`;
      profitCell = `<td class="num">${rs(profit)}<div class="sub">${taxable > 0 ? (profit * 100 / taxable).toFixed(1) : '0'}%</div></td>`;
    }
    return `<tr>
      <td class="strong">${esc(b.batch_no)}</td><td>${mmYYYY(b.expiry)}</td>
      <td class="num">${b.qty} ${esc(plural(p.base_unit, b.qty))}</td>
      <td class="num">${rs(b.mrp_paise)}</td>${costCell}${profitCell}
      <td class="num"><button class="btn small" data-price="${b.id}">Change price</button>
        <button class="btn small" data-adjust="${b.id}">Adjust stock</button>
        <button class="btn small" data-label="${b.id}">Label</button></td></tr>`;
  }).join('') || `<tr><td colspan="7" class="muted">No batches yet. Your next delivery creates one.</td></tr>`;

  const hist = [
    ...history.prices.map(h => ({ at:h.created_at, what:`Batch ${h.batch_no}: ` +
      [h.old_mrp_paise !== h.new_mrp_paise ? `MRP ${rs(h.old_mrp_paise)} → ${rs(h.new_mrp_paise)}` : null,
       h.old_cost_paise !== h.new_cost_paise ? `cost ${rs(h.old_cost_paise)} → ${rs(h.new_cost_paise)}` : null]
      .filter(Boolean).join(', '), why:h.reason })),
    /* Two different shapes are kept in this log: an edit records {from, to}
       for each field it changed, while adding a medicine records the plain
       value. Each is shown as itself — a value that is not a change must not
       be printed as "undefined → undefined". */
    ...history.details.map(h => {
      const d = JSON.parse(h.detail || '{}');
      const isChange = v => v && typeof v === 'object' && ('from' in v || 'to' in v);
      const show = v => v === null || v === undefined || v === '' ? '(blank)' : String(v);
      const what = h.action === 'product.add'
        ? `Medicine added${d.name ? `: ${d.name}` : ''}`
        : Object.entries(d)
            .map(([k, v]) => isChange(v) ? `${k}: ${show(v.from)} → ${show(v.to)}` : `${k}: ${show(v)}`)
            .join('; ');
      return { at:h.created_at, what: what || h.action, why:'' };
    }),
    ...history.stock.filter(s => s.reason !== 'sale').map(s => ({ at:s.created_at,
      what:`${s.delta > 0 ? '+' : ''}${s.delta} ${plural(p.base_unit, Math.abs(s.delta))} (${s.reason}) batch ${s.batch_no}`, why:s.note || '' })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 25);

  $('mDetail').innerHTML = `
    <h2 style="font-size:23px">${esc(p.name)}</h2>
    <p class="muted" style="margin:2px 0 14px">${esc(p.generic_name || '')} · ${esc(p.manufacturer || '')} · ${units} ${esc(plural(p.base_unit, units))} in stock</p>

    <div class="block"><div class="block-head"><h3>Batches and prices</h3>
      ${costsHidden
        ? '<p>Cost and profit are hidden. <button class="btn small" id="showCosts">Unlock to see cost and profit</button></p>'
        : '<p>Each delivery keeps its own price. Use “Change price” only to fix a mistake or a revised MRP.</p>'}</div>
      <div class="tablewrap"><table><thead><tr><th>Batch</th><th>Expiry</th><th class="num">In stock</th>
        <th class="num">MRP / ${esc(word)}</th><th class="num">Cost / ${esc(word)}</th><th class="num">You make</th><th></th></tr></thead>
        <tbody>${batchRows}</tbody></table></div></div>

    <div class="block"><div class="block-head"><h3>Details</h3><p>Bills already made keep their old values.</p></div>
      <div class="block-body"><div class="formgrid">
        <div class="field span2"><label for="pName">Name</label><input id="pName" value="${esc(p.name)}"></div>
        <div class="field span2"><label for="pGeneric">Generic name</label><input id="pGeneric" value="${esc(p.generic_name || '')}"></div>
        <div class="field span2"><label for="pMfr">Company</label><input id="pMfr" value="${esc(p.manufacturer || '')}"></div>
        <div class="field"><label for="pGst">GST</label><select id="pGst">${[0,5,12,18].map(r => `<option ${r === p.gst_rate ? 'selected' : ''}>${r}</option>`).join('')}</select></div>
        <div class="field"><label for="pSched">Schedule</label><select id="pSched">${['OTC','G','H','H1','X'].map(s => `<option ${s === p.drug_schedule ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
        <div class="field"><label for="pRack">Rack</label><input id="pRack" value="${esc(p.rack || '')}"></div>
        <div class="field"><label for="pReorder">Remind below (packs)</label><input id="pReorder" inputmode="numeric" value="${p.reorder_packs}"></div>
        <div class="field"><label for="pUnits">${esc(p.base_unit)}s per strip</label><input id="pUnits" inputmode="numeric" value="${p.units_per_strip}" ${units > 0 ? 'disabled' : ''}>
          ${units > 0 ? '<div class="hint">Locked while there is stock, because stock is counted in ' + esc(plural(p.base_unit, 2)) + '.</div>' : ''}</div>
        <div class="field"><label for="pHsn">HSN code</label><input id="pHsn" value="${esc(p.hsn_code || '')}"></div>
      </div>
      <div class="row" style="margin-top:14px;justify-content:space-between">
        <div class="row">
          <button class="btn ${p.is_active ? 'danger' : ''}" id="pArchive">${p.is_active ? 'Archive this medicine' : 'Bring back from archive'}</button>
          ${neverUsed ? '<button class="btn danger" id="pDelete">Delete</button>' : ''}
        </div>
        <button class="btn primary" id="pSave">Save details</button></div>
      ${neverUsed
        ? '<p class="muted" style="margin:10px 0 0">Nothing has ever been stocked or sold under this name, so it can be deleted completely.</p>'
        : '<p class="muted" style="margin:10px 0 0">This medicine has stock or sales on record, so it cannot be deleted — old bills must keep making sense. Archiving takes it off the counter and keeps the history.</p>'}
      </div></div>

    <div class="block"><div class="block-head"><h3>Scanned codes</h3>
        <p>Codes learned from packs. Remove one if it was linked to the wrong medicine.</p></div>
      <div class="tablewrap"><table><tbody>${codes.map(c => `<tr>
        <td><span class="strong">${esc(c.code)}</span><div class="sub">learned ${esc(c.learned_at)}</div></td>
        <td class="num"><button class="x" data-code="${c.id}" aria-label="Unlink ${esc(c.code)}">×</button></td></tr>`).join('')
        || '<tr><td class="muted">None yet. Scanning an unknown pack links one.</td></tr>'}</tbody></table></div></div>

    <div class="block"><div class="block-head"><h3>History</h3></div>
      <div class="tablewrap"><table><tbody>${hist.map(h => `<tr><td class="sub" style="width:150px">${esc(h.at)}</td>
        <td>${esc(h.what)}${h.why ? `<div class="sub">${esc(h.why)}</div>` : ''}</td></tr>`).join('')
        || '<tr><td class="muted">Nothing yet.</td></tr>'}</tbody></table></div></div>`;

  $('mDetail').querySelectorAll('[data-price]').forEach(b => b.onclick = () => changePrice(Number(b.dataset.price), p, batches));
  $('mDetail').querySelectorAll('[data-adjust]').forEach(b => b.onclick = () => adjustStock(Number(b.dataset.adjust), p, batches));
  $('mDetail').querySelectorAll('[data-label]').forEach(b => b.onclick = () => reprintLabel(Number(b.dataset.label)));
  $('pSave').onclick = async () => {
    try {
      const out = await api('/api/product/update', { id, name:$('pName').value, genericName:$('pGeneric').value,
        manufacturer:$('pMfr').value, gstRate:$('pGst').value, schedule:$('pSched').value, rack:$('pRack').value,
        reorderPacks:$('pReorder').value, hsn:$('pHsn').value,
        ...(units > 0 ? {} : { unitsPerStrip:$('pUnits').value }) });
      toast(Object.keys(out.changed).length ? 'Details saved.' : 'Nothing changed.');
      openMedicine(id); loadMedicines();
    } catch (e) { toast(e.message, true); }
  };
  $('pArchive').onclick = async () => {
    try { await api('/api/product/archive', { id, archived: !!p.is_active });
      toast(p.is_active ? `${p.name} archived. Old bills keep it.` : `${p.name} is back in the list.`);
      openMedicine(id); loadMedicines();
    } catch (e) { toast(e.message, true); }
  };

  if ($('showCosts')) $('showCosts').onclick = async () => {
    if (await askForPin()) openMedicine(id);     // reload: the server now sends the figures
  };

  $('mDetail').querySelectorAll('[data-code]').forEach(b => b.onclick = async () => {
    try { const out = await api('/api/code/delete', { id: Number(b.dataset.code) });
      toast(out.message); openMedicine(id);
    } catch (e) { toast(e.message, true); }
  });

  if ($('pDelete')) $('pDelete').onclick = async () => {
    const out = await ask({ title:`Delete ${p.name}?`, okText:'Delete',
      bodyHtml:`<p>This removes the medicine completely. Nothing has been stocked or sold
        under it, so no bill or stock record is affected.</p>
        <p class="muted">If you only want it off the counter, use Archive instead.</p>` });
    if (!out) return;
    try { const r = await api('/api/product/delete', { id });
      toast(r.message); medSelected = null; $('mDetail').innerHTML = ''; loadMedicines();
    } catch (e) { toast(e.message, true); }
  };
}

/** Print more stickers for one batch — a torn label, or a box split up. */
async function reprintLabel(batchId) {
  const out = await ask({ title:'Print labels', okText:'Print', bodyHtml:`
    <div class="field"><label>How many labels?</label><input data-k="copies" inputmode="numeric" value="1"></div>
    <p class="muted" style="margin:10px 0 0;font-size:14px">One is enough for the box. Print one per strip only if
      you want to scan each strip separately at the counter.</p>` });
  if (!out) return;
  const copies = Math.min(Math.max(1, Number(out.copies) || 1), 50);
  window.open(`/labels?ids=${batchId}&copies=${copies}`, '_blank');
}

async function changePrice(batchId, p, batches) {
  const b = batches.find(x => x.id === batchId);
  const out = await ask({ title:`Change price — batch ${b.batch_no}`, okText:'Save new price', bodyHtml:`
    <div class="formgrid">
      <div class="field"><label>MRP per pack (₹)</label><input data-k="mrp" inputmode="decimal" value="${(b.mrp_paise/100).toFixed(2)}"></div>
      <div class="field"><label>Cost per pack (₹)</label><input data-k="cost" inputmode="decimal" value="${(b.cost_paise/100).toFixed(2)}"></div>
      <div class="field span2"><label>Why?</label><select data-k="reason">
        <option>Mistake when adding stock</option><option>Company changed the MRP</option><option>Distributor changed the price</option></select></div>
    </div>
    <p class="muted" style="margin:10px 0 0;font-size:14px">Bills already made keep the old price.</p>` });
  if (!out) return;
  try {
    await api('/api/price', { batchId, mrpPaise: paise(out.mrp), costPaise: paise(out.cost), reason: out.reason });
    toast('New price saved.'); openMedicine(p.id);
  } catch (e) { toast(e.message, true); }
}

async function adjustStock(batchId, p, batches) {
  const b = batches.find(x => x.id === batchId);
  const out = await ask({ title:`Adjust stock — batch ${b.batch_no}`, okText:'Save the change', bodyHtml:`
    <p class="muted">There are now <b>${b.qty} ${esc(plural(p.base_unit, b.qty))}</b> of batch ${esc(b.batch_no)}.</p>
    <div class="formgrid">
      <div class="field"><label>Counted / change by</label><input data-k="delta" inputmode="numeric" placeholder="e.g. -15 or 30"></div>
      <div class="field"><label>Reason</label><select data-k="reason">
        <option value="adjustment">Counted, different from the app</option>
        <option value="damage">Damaged</option><option value="expiry">Expired — writing it off</option>
        <option value="purchase_return">Sent back to the distributor</option></select></div>
      <div class="field span2"><label>Note</label><input data-k="note" placeholder="e.g. counted on shelf B-4"></div>
    </div>` });
  if (!out) return;
  try {
    await api('/api/stock/adjust', { batchId, delta: Number(out.delta), reason: out.reason, note: out.note });
    toast('Stock updated and written into the history.'); openMedicine(p.id); loadAlerts();
  } catch (e) { toast(e.message, true); }
}

// ================================================================ reports

let reportKind = 'day';
const state = { date: todayStr(), from: todayStr(new Date(Date.now() - 29 * 86400000)), to: todayStr(), days: 180 };

document.querySelectorAll('.subtab').forEach(b => b.onclick = () => {
  reportKind = b.dataset.report;
  document.querySelectorAll('.subtab').forEach(x => x.setAttribute('aria-selected', String(x === b)));
  renderReport();
});

const dateField = (label, key) =>
  `<div class="field"><label for="f_${key}">${label}</label><input type="date" id="f_${key}" value="${state[key]}"></div>`;

function controls(html, onApply) {
  $('reportControls').innerHTML = html;
  $('reportControls').querySelectorAll('input,select').forEach(el => el.onchange = () => {
    const key = el.id.replace('f_', '');
    state[key] = el.value;
    onApply();
  });
}

async function renderReport() {
  const body = $('reportBody');
  body.innerHTML = '<p class="muted">Loading…</p>';
  try {
    if (reportKind === 'day') return reportDay();
    if (reportKind === 'range') return reportRange();
    if (reportKind === 'payments') return reportPayments();
    if (reportKind === 'inventory') return reportInventory();
    if (reportKind === 'low') return reportLowStock();
    if (reportKind === 'expiry') return reportExpiry();
    if (reportKind === 'deliveries') return reportDeliveries();
  } catch (e) { body.innerHTML = `<div class="msg bad">${esc(e.message)}</div>`; }
}

const tile = (k, v, s, lead) => `<div class="tile${lead ? ' lead' : ''}"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s || ''}</div></div>`;
const exportBtn = (href, label = 'Download as Excel') => `<a class="btn small" href="${href}" download>${label}</a>`;

async function reportDay() {
  const r = await api(`/api/reports/daily?date=${state.date}`);
  controls(`${dateField('Day', 'date')}
    <button class="btn small" id="printBtn" style="align-self:flex-end">Print</button>
    <span style="align-self:flex-end">${exportBtn(`/api/export/sales.xlsx?from=${state.date}&to=${state.date}`)}</span>`, renderReport);

  const change = r.same_day_last_week_paise
    ? `${r.sales_paise >= r.same_day_last_week_paise ? '▲' : '▼'} ${Math.abs(Math.round((r.sales_paise - r.same_day_last_week_paise) * 100 / r.same_day_last_week_paise))}% on the same day last week`
    : 'No sales that day last week';
  const billRows = r.bills_list.map(b => `<tr class="${b.is_cancelled ? 'warnrow' : ''}">
    <td><button class="linkbtn" data-bill="${b.id}">${esc(b.bill_no)}</button></td>
    <td>${(b.created_at || '').slice(11,16)}</td><td>${esc(b.pay_mode)}</td>
    <td class="num">${rs(b.total_paise)}</td><td>${b.is_cancelled ? 'Cancelled' : ''}</td></tr>`).join('');

  $('reportBody').innerHTML = `
    <div class="tiles">
      ${tile('Sales', rsR(r.sales_paise), change, true)}
      ${tile('You made', rsR(r.profit_paise), r.profit_pct != null ? r.profit_pct + '% after GST and cost' : '')}
      ${tile('Bills', r.bills, 'average ' + rsR(r.average_bill_paise))}
      ${tile('Cash', rsR(r.cash_paise), `UPI ${rsR(r.upi_paise)} · Card ${rsR(r.card_paise)} · Credit ${rsR(r.credit_paise)}`)}
    </div>
    <div class="grid2">
      <div class="block"><div class="block-head"><h3>Bills on ${dmy(r.date)}</h3></div>
        <div class="tablewrap"><table><thead><tr><th>Bill</th><th>Time</th><th>Paid by</th><th class="num">Total</th><th></th></tr></thead>
          <tbody>${billRows || '<tr><td colspan="5" class="muted">No bills.</td></tr>'}</tbody></table></div></div>
      <div>
        <div class="block"><div class="block-head"><h3>Best sellers</h3></div>
          <div class="tablewrap"><table><tbody>${r.top_sellers.map(t => `<tr><td>${esc(t.name)}</td><td class="num">${rsR(t.sales_paise)}</td></tr>`).join('') || '<tr><td class="muted">Nothing sold.</td></tr>'}</tbody></table></div></div>
        <div class="block"><div class="block-head"><h3>Also today</h3></div>
          <div class="tablewrap"><table><tbody>
            <tr><td>Returns</td><td class="num">${r.returns ? r.returns + ' · ' + rs(r.refund_paise) : 'None'}</td></tr>
            <tr><td>GST collected</td><td class="num">${rs(r.gst_paise)}</td></tr>
            <tr><td>Asked for, not in stock</td><td class="num">${r.asked_not_in_stock.map(a => esc(a.item) + ' ×' + a.times).join(', ') || 'None'}</td></tr>
          </tbody></table></div></div>
      </div>
    </div>`;
  $('reportBody').querySelectorAll('[data-bill]').forEach(b => b.onclick = () => openBill(Number(b.dataset.bill)));
  $('printBtn').onclick = () => printReport('Daily sales', dmy(r.date),
    `<p>Sales ${rs(r.sales_paise)} · Bills ${r.bills} · You made ${rs(r.profit_paise)} · Cash ${rs(r.cash_paise)} · UPI ${rs(r.upi_paise)}</p>
     <table><thead><tr><th>Bill</th><th>Time</th><th>Paid by</th><th>Total</th></tr></thead><tbody>
     ${r.bills_list.map(b => `<tr><td>${esc(b.bill_no)}</td><td>${(b.created_at||'').slice(11,16)}</td><td>${esc(b.pay_mode)}</td><td>${rs(b.total_paise)}</td></tr>`).join('')}
     </tbody></table>`);
}

async function reportRange() {
  const r = await api(`/api/reports/range?from=${state.from}&to=${state.to}`);
  controls(`${dateField('From', 'from')}${dateField('To', 'to')}
    <button class="btn small" id="printBtn" style="align-self:flex-end">Print</button>
    <span style="align-self:flex-end">${exportBtn(`/api/export/sales.xlsx?from=${state.from}&to=${state.to}`)}</span>`, renderReport);

  const gstRows = r.gst_by_rate.map(g => {
    const cgst = Math.round(g.gst_paise / 2);
    return `<tr><td>${g.rate}%</td><td class="num">${rs(g.taxable_paise)}</td><td class="num">${rs(cgst)}</td>
      <td class="num">${rs(g.gst_paise - cgst)}</td><td class="num">${rs(g.taxable_paise + g.gst_paise)}</td></tr>`;
  }).join('');

  $('reportBody').innerHTML = `
    <div class="tiles">
      ${tile('Sales', rsR(r.sales_paise), `${dmy(r.from)} to ${dmy(r.to)}`, true)}
      ${tile('You made', rsR(r.profit_paise), r.profit_pct != null ? r.profit_pct + '% after GST and cost' : '')}
      ${tile('Bills', r.bills.toLocaleString('en-IN'), `average ${rsR(r.average_bill_paise)} · ${r.open_days} ${plural('day', r.open_days)} open`)}
      ${tile('Best day', r.best_day ? rsR(r.best_day.sales_paise) : '—', r.best_day ? dmy(r.best_day.business_date) : '')}
    </div>
    <div class="block"><div class="block-head"><h3>Sales each day</h3></div><div class="chartwrap" id="chart"></div></div>
    <div class="grid2" style="margin-top:14px">
      <div class="block"><div class="block-head"><h3>Sold the most</h3></div>
        <div class="tablewrap"><table><thead><tr><th>Medicine</th><th class="num">Units</th><th class="num">Sales</th><th class="num">You made</th></tr></thead>
          <tbody>${r.top_by_sales.map(t => `<tr><td>${esc(t.name)}</td><td class="num">${t.units}</td><td class="num">${rsR(t.sales_paise)}</td><td class="num">${rsR(t.profit_paise)}</td></tr>`).join('')
            || '<tr><td colspan="4" class="muted">No sales in these dates.</td></tr>'}</tbody></table></div></div>
      <div>
        <div class="block"><div class="block-head"><h3>Money in and out</h3></div>
          <div class="tablewrap"><table><tbody>
            <tr><td>Cash</td><td class="num">${rs(r.cash_paise)}</td></tr>
            <tr><td>UPI</td><td class="num">${rs(r.upi_paise)}</td></tr>
            <tr><td>Card</td><td class="num">${rs(r.card_paise)}</td></tr>
            <tr><td>Credit</td><td class="num">${rs(r.credit_paise)}</td></tr>
            <tr><td>Returns refunded (${r.returns})</td><td class="num">${rs(r.refund_paise)}</td></tr>
            <tr class="total"><td>GST collected</td><td class="num">${rs(r.gst_paise)}</td></tr>
          </tbody></table></div></div>
        <div class="block"><div class="block-head"><h3>For your CA</h3><p>GST on sales. Bills ${esc(r.documents.first_bill || '—')} to ${esc(r.documents.last_bill || '—')}, ${r.documents.issued} issued, ${r.documents.cancelled || 0} cancelled, ${r.credit_notes.n} credit notes.</p></div>
          <div class="tablewrap"><table><thead><tr><th>Rate</th><th class="num">Before GST</th><th class="num">CGST</th><th class="num">SGST</th><th class="num">Total</th></tr></thead>
            <tbody>${gstRows || '<tr><td colspan="5" class="muted">No sales.</td></tr>'}</tbody></table></div></div>
      </div>
    </div>`;
  drawChart(r.days);
  $('printBtn').onclick = () => printReport('Sales report', `${dmy(r.from)} to ${dmy(r.to)}`,
    `<p>Sales ${rs(r.sales_paise)} · Bills ${r.bills} · You made ${rs(r.profit_paise)}</p>
     <table><thead><tr><th>Date</th><th>Bills</th><th>Sales</th><th>You made</th></tr></thead><tbody>
     ${r.days.map(d => `<tr><td>${dmy(d.business_date)}</td><td>${d.bills}</td><td>${rs(d.sales_paise)}</td><td>${rs(d.profit_paise)}</td></tr>`).join('')}
     </tbody></table>`);
}

/** One series, one colour, bars from zero, figures on hover. */
function drawChart(days) {
  const box = $('chart'); if (!box) return;
  if (!days.length) { box.innerHTML = '<p class="muted">No sales in these dates.</p>'; return; }
  const W = Math.max(320, box.clientWidth - 24), H = 240;
  const m = { l:70, r:10, t:20, b:30 }, pw = W - m.l - m.r, ph = H - m.t - m.b;
  const maxR = Math.max(1, ...days.map(d => d.sales_paise / 100));
  const raw = maxR / 4, pow = 10 ** Math.floor(Math.log10(raw)), f = raw / pow;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
  const top = Math.ceil(maxR / step) * step;
  const y = v => m.t + ph - v / top * ph;
  const slot = pw / days.length, bw = Math.min(Math.max(2, slot - 2), 64);

  let grid = '', bars = '', hits = '', labels = '';
  for (let v = 0; v <= top + 1e-9; v += step)
    grid += `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>
             <text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">₹${Math.round(v).toLocaleString('en-IN')}</text>`;
  days.forEach((d, i) => {
    const x = m.l + i * slot + (slot - bw) / 2, v = d.sales_paise / 100;
    if (i === 0 || (i + 1) % 5 === 0) labels += `<text x="${x + bw/2}" y="${H - 9}" text-anchor="middle">${d.business_date.slice(8)}</text>`;
    if (v <= 0) return;
    const yt = y(v), h = m.t + ph - yt, r = Math.min(4, bw / 2, h);
    bars += `<path class="bar" id="b${i}" d="M${x},${m.t+ph} V${yt+r} Q${x},${yt} ${x+r},${yt} H${x+bw-r} Q${x+bw},${yt} ${x+bw},${yt+r} V${m.t+ph} Z"/>`;
    hits += `<rect class="hit" x="${m.l + i*slot}" y="${m.t}" width="${slot}" height="${ph}" tabindex="0" data-i="${i}"
              aria-label="${dmy(d.business_date)}: sales ${rsR(d.sales_paise)}, ${d.bills} bills"/>`;
  });
  box.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Sales each day">
    ${grid}${bars}<line class="baseline" x1="${m.l}" x2="${W-m.r}" y1="${m.t+ph}" y2="${m.t+ph}"/>${labels}${hits}</svg>
    <div class="tip" id="tip" hidden></div>`;
  const tip = $('tip');
  box.querySelectorAll('.hit').forEach(h => {
    const showTip = () => {
      const d = days[Number(h.dataset.i)];
      box.querySelectorAll('.bar.on').forEach(b => b.classList.remove('on'));
      $('b' + h.dataset.i)?.classList.add('on');
      tip.innerHTML = `<b>${dmy(d.business_date)}</b><div>Sales ${rs(d.sales_paise)}</div>
        <div>Bills ${d.bills}</div><div>You made ${rs(d.profit_paise)}</div>`;
      tip.hidden = false;
      tip.style.left = Math.min(Math.max(8, m.l + Number(h.dataset.i) * slot - tip.offsetWidth / 2), W - tip.offsetWidth) + 'px';
      tip.style.top = '6px';
    };
    h.addEventListener('mouseenter', showTip); h.addEventListener('focus', showTip);
    h.addEventListener('mouseleave', () => tip.hidden = true); h.addEventListener('blur', () => tip.hidden = true);
  });
}

async function reportPayments() {
  const r = await api(`/api/reports/payments?from=${state.from}&to=${state.to}`);
  controls(`${dateField('From', 'from')}${dateField('To', 'to')}
    <button class="btn small" id="printBtn" style="align-self:flex-end">Print</button>
    <span style="align-self:flex-end">${exportBtn(`/api/export/payments.xlsx?from=${state.from}&to=${state.to}`)}</span>`, renderReport);
  const rows = r.modes.map(m => `<tr><td class="strong">${esc(m.pay_mode)}</td><td class="num">${m.bills}</td>
    <td class="num">${rs(m.total_paise)}</td><td class="num">${rs(m.refund_paise)}</td>
    <td class="num strong">${rs(m.net_paise)}</td><td class="num">${m.share_pct}%</td></tr>`).join('');
  $('reportBody').innerHTML = `<div class="block">
    <div class="block-head"><h3>How customers paid</h3><p>${dmy(r.from)} to ${dmy(r.to)}</p></div>
    <div class="tablewrap"><table><thead><tr><th>Paid by</th><th class="num">Bills</th><th class="num">Taken</th>
      <th class="num">Refunded</th><th class="num">Net</th><th class="num">Share</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="muted">No bills in these dates.</td></tr>'}
      <tr class="total"><td>Total</td><td></td><td class="num">${rs(r.total_paise)}</td><td></td><td></td><td></td></tr></tbody></table></div></div>`;
  $('printBtn').onclick = () => printReport('Payment-wise sales', `${dmy(r.from)} to ${dmy(r.to)}`,
    `<table><thead><tr><th>Paid by</th><th>Bills</th><th>Taken</th><th>Net</th></tr></thead><tbody>
     ${r.modes.map(m => `<tr><td>${esc(m.pay_mode)}</td><td>${m.bills}</td><td>${rs(m.total_paise)}</td><td>${rs(m.net_paise)}</td></tr>`).join('')}</tbody></table>`);
}

async function reportInventory() {
  const r = await api('/api/reports/inventory');
  controls(`<button class="btn small" id="printBtn">Print</button>${exportBtn('/api/export/inventory.xlsx')}`, renderReport);
  const rows = r.rows.map(p => `<tr class="${p.units <= 0 ? 'warnrow' : ''}">
    <td class="strong">${esc(p.name)}<div class="sub">${esc(p.generic_name || '')}</div></td>
    <td>${esc(p.rack || '')}</td><td class="num">${p.packs}</td><td class="num">${p.units}</td>
    <td class="num">${rs(p.stock_value_paise)}</td><td>${p.nearest_expiry ? mmYYYY(p.nearest_expiry) : ''}</td></tr>`).join('');
  $('reportBody').innerHTML = `
    <div class="tiles">
      ${tile('Stock value', rsR(r.total_value_paise), 'at what you paid', true)}
      ${tile('Medicines', r.lines, `${r.in_stock} with stock`)}
      ${tile('As on', dmy(r.generated), '')}
    </div>
    <div class="block"><div class="tablewrap"><table>
      <thead><tr><th>Medicine</th><th>Rack</th><th class="num">Packs</th><th class="num">Units</th><th class="num">Value at cost</th><th>Nearest expiry</th></tr></thead>
      <tbody>${rows}</tbody></table></div></div>`;
  $('printBtn').onclick = () => printReport('Stock on hand', `As on ${dmy(r.generated)} · value ${rs(r.total_value_paise)}`,
    `<table><thead><tr><th>Medicine</th><th>Rack</th><th>Packs</th><th>Units</th><th>Value</th></tr></thead><tbody>
     ${r.rows.map(p => `<tr><td>${esc(p.name)}</td><td>${esc(p.rack||'')}</td><td>${p.packs}</td><td>${p.units}</td><td>${rs(p.stock_value_paise)}</td></tr>`).join('')}</tbody></table>`);
}

async function reportLowStock() {
  const r = await api('/api/reports/low-stock');
  controls(`<button class="btn small" id="printBtn">Print</button>${exportBtn('/api/export/low-stock.xlsx')}`, renderReport);
  $('reportBody').innerHTML = `<div class="block">
    <div class="block-head"><h3>Running low</h3><p>${r.count} ${plural('medicine', r.count)} at or below the reminder level you set.</p></div>
    <div class="tablewrap"><table><thead><tr><th>Medicine</th><th class="num">Packs left</th><th class="num">Remind below</th><th>Rack</th><th>Distributor</th></tr></thead>
      <tbody>${r.rows.map(p => `<tr><td class="strong">${esc(p.name)}</td><td class="num">${p.packs}</td>
        <td class="num">${p.reorder_packs}</td><td>${esc(p.rack || '')}</td><td>${esc(p.suppliers || '')}</td></tr>`).join('')
        || '<tr><td colspan="5" class="muted">Nothing is low. Set a reminder level on a medicine to see it here.</td></tr>'}</tbody></table></div></div>`;
  $('printBtn').onclick = () => printReport('Low stock', `As on ${dmy(r.generated)}`,
    `<table><thead><tr><th>Medicine</th><th>Packs left</th><th>Remind below</th><th>Distributor</th></tr></thead><tbody>
     ${r.rows.map(p => `<tr><td>${esc(p.name)}</td><td>${p.packs}</td><td>${p.reorder_packs}</td><td>${esc(p.suppliers||'')}</td></tr>`).join('')}</tbody></table>`);
}

/**
 * Deliveries already received. Until now a delivery could be entered but never
 * looked at again, so there was no way to check what a distributor actually
 * sent last month, or what a past invoice came to.
 */
async function reportDeliveries() {
  const rows = await api('/api/deliveries?limit=100');
  controls('<button class="btn small" id="printBtn" style="align-self:flex-end">Print</button>');

  $('reportBody').innerHTML = `
    <div class="block"><div class="block-head"><h3>Deliveries received</h3>
      <p>Newest first. Click one to see every medicine on it.</p></div>
      <div class="tablewrap"><table>
        <thead><tr><th>Date</th><th>Distributor</th><th>Invoice</th>
          <th class="num">Medicines</th><th class="num">Paid (before GST)</th></tr></thead>
        <tbody>${rows.map(d => `<tr class="clickable" data-del="${d.id}">
          <td>${esc(d.invoice_date || d.business_date)}</td>
          <td class="strong">${esc(d.supplier || '—')}</td>
          <td>${esc(d.invoice_no || '—')}${d.discount_bp ? `<div class="sub">less ${d.discount_bp / 100}%</div>` : ''}</td>
          <td class="num">${d.lines}</td>
          <td class="num strong">${rs(d.total_paise)}</td></tr>`).join('')
          || '<tr><td colspan="5" class="muted">No deliveries entered yet.</td></tr>'}</tbody>
      </table></div></div>
    <div id="delDetail"></div>`;

  $('reportBody').querySelectorAll('[data-del]').forEach(t => t.onclick = () => showDelivery(Number(t.dataset.del)));
  if ($('printBtn')) $('printBtn').onclick = () => window.print();
}

async function showDelivery(id) {
  const { purchase, items } = await api(`/api/delivery?id=${id}`);
  $('delDetail').innerHTML = `
    <div class="block"><div class="block-head">
      <h3>${esc(purchase.supplier || 'Delivery')} · ${esc(purchase.invoice_no || purchase.business_date)}</h3>
      <p>Received ${esc(purchase.business_date)}${purchase.discount_bp ? ` · discount ${purchase.discount_bp / 100}%` : ''}</p></div>
      <div class="tablewrap"><table>
        <thead><tr><th>Medicine</th><th>Batch · Expiry</th><th class="num">Received</th>
          <th class="num">MRP</th><th class="num">Paid each</th><th class="num">Line</th></tr></thead>
        <tbody>${items.map(i => `<tr>
          <td class="strong">${esc(i.name)}</td>
          <td>${esc(i.batch_no)}<div class="sub">${mmYYYY(i.expiry)}</div></td>
          <td class="num">${i.packs}${i.free_packs ? `<div class="sub">+ ${i.free_packs} free</div>` : ''}</td>
          <td class="num">${rs(i.mrp_paise)}</td>
          <td class="num">${rs(i.cost_paise)}${i.list_cost_paise && i.list_cost_paise !== i.cost_paise
            ? `<div class="sub">from ${rs(i.list_cost_paise)}</div>` : ''}</td>
          <td class="num strong">${rs(i.line_paise)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="5" class="num strong">Total before GST</td>
          <td class="num strong">${rs(purchase.total_paise)}</td></tr></tfoot>
      </table></div></div>`;
  $('delDetail').scrollIntoView({ behavior:'smooth', block:'nearest' });
}

async function reportExpiry() {
  const r = await api(`/api/reports/expiry?days=${state.days}`);
  controls(`<div class="field"><label for="f_days">Show expiry within</label>
      <select id="f_days">${[30,90,180,365].map(d => `<option value="${d}" ${d == state.days ? 'selected' : ''}>${d} days</option>`).join('')}</select></div>
    <button class="btn small" id="printBtn" style="align-self:flex-end">Print</button>
    <span style="align-self:flex-end">${exportBtn(`/api/export/expiry.xlsx?days=${state.days}`)}</span>`, renderReport);

  const section = (title, b, note) => `<div class="block"><div class="block-head"><h3>${title}</h3>
      <p>${b.count} ${plural('batch', b.count)} · ${rs(b.value_paise)} at cost${note ? ' · ' + note : ''}</p></div>
    <div class="tablewrap"><table><thead><tr><th>Medicine</th><th>Batch</th><th>Expiry</th><th class="num">Days left</th><th class="num">Units</th><th class="num">Value</th><th>Distributor</th></tr></thead>
      <tbody>${b.rows.map(x => `<tr><td class="strong">${esc(x.name)}</td><td>${esc(x.batch_no)}</td><td>${mmYYYY(x.expiry)}</td>
        <td class="num">${x.days_left}</td><td class="num">${x.qty}</td><td class="num">${rs(x.value_paise)}</td><td>${esc(x.supplier || '')}</td></tr>`).join('')
        || '<tr><td colspan="7" class="muted">Nothing here.</td></tr>'}</tbody></table></div></div>`;

  const b = r.buckets;
  $('reportBody').innerHTML = `
    <div class="tiles">
      ${tile('Already expired', rsR(b.expired.value_paise), `${b.expired.count} ${plural('batch', b.expired.count)} — write these off`)}
      ${tile('Within 30 days', rsR(b['0-30'].value_paise), 'sell these first', true)}
      ${tile('31 to 90 days', rsR(b['31-90'].value_paise), '')}
      ${tile('Can go back', rsR(r.returnable.value_paise), 'the distributor still accepts these')}
    </div>
    ${section('Send back to the distributor', r.returnable, 'still inside their return window')}
    ${section('Already expired', b.expired)}
    ${section('Expiring within 30 days', b['0-30'])}
    ${section('31 to 90 days', b['31-90'])}
    ${section('91 to 180 days', b['91-180'])}`;
  $('printBtn').onclick = () => printReport('Expiry report', `As on ${dmy(r.generated)}`,
    `<h3>Send back to the distributor</h3><table><thead><tr><th>Distributor</th><th>Medicine</th><th>Batch</th><th>Expiry</th><th>Units</th><th>Value</th></tr></thead><tbody>
     ${r.returnable.rows.map(x => `<tr><td>${esc(x.supplier||'')}</td><td>${esc(x.name)}</td><td>${esc(x.batch_no)}</td><td>${mmYYYY(x.expiry)}</td><td>${x.qty}</td><td>${rs(x.value_paise)}</td></tr>`).join('')}</tbody></table>`);
}

// ================================================================ settings

async function loadSettings() {
  const s = await api('/api/settings');
  SHOP = s;
  if (s) {
    $('sName').value = s.name || ''; $('sPhone').value = s.phone || '';
    $('sAddr1').value = s.address1 || ''; $('sAddr2').value = s.address2 || '';
    $('sGstin').value = s.gstin || ''; $('sDl20').value = s.dl_20b || ''; $('sDl21').value = s.dl_21b || '';
    $('sPharm').value = s.pharmacist || ''; $('sPrefix').value = s.bill_prefix || 'SNM';
  }
  const { folder, backups } = await api('/api/backups');
  $('backupFolder').textContent = `Saved in ${folder}`;
  $('backupList').innerHTML = backups.slice(0, 12).map(b => `<tr><td>${esc(b.file)}</td>
    <td class="num">${Math.round(b.size / 1024)} KB</td>
    <td class="num"><button class="btn small danger" data-restore="${esc(b.file)}">Restore this</button></td></tr>`).join('')
    || '<tr><td class="muted">No backups yet.</td></tr>';
  $('backupList').querySelectorAll('[data-restore]').forEach(b => b.onclick = async () => {
    const out = await ask({ title:'Restore this backup?', okText:'Yes, restore',
      bodyHtml:`<p>Everything entered since <b>${esc(b.dataset.restore)}</b> will be replaced by that copy.</p>
        <p class="muted">Today's database is kept beside it, so this can be undone.</p>
        <div class="field"><label>Type RESTORE to confirm</label><input data-k="confirm"></div>` });
    if (!out || out.confirm !== 'RESTORE') return;
    try { await api('/api/restore', { file: b.dataset.restore }); toast('Restored. Check today’s bills.'); loadSettings(); loadAlerts(); }
    catch (e) { toast(e.message, true); }
  });
}

// ================================================================ alerts + boot

async function loadAlerts() {
  try {
    const [expiry, low] = await Promise.all([api('/api/reports/expiry?days=30'), api('/api/reports/low-stock')]);
    const bits = [];
    const soon = expiry.buckets['0-30'], expired = expiry.buckets.expired;
    if (expired.count) bits.push(`<span><b>${expired.count}</b> expired ${plural('batch', expired.count)} to write off (${rsR(expired.value_paise)})</span>`);
    if (soon.count) bits.push(`<span>Expiring within 30 days: <b>${rsR(soon.value_paise)}</b></span>`);
    if (expiry.returnable.count) bits.push(`<span>Can go back to distributors: <b>${rsR(expiry.returnable.value_paise)}</b></span>`);
    if (low.count) bits.push(`<span><b>${low.count}</b> running low</span>`);
    $('alerts').innerHTML = bits.join('') + (bits.length ? `<button class="linkbtn" id="toReports">Open reports</button>` : '');
    $('alerts').hidden = !bits.length;
    if (bits.length) $('toReports').onclick = () => { show('reports'); };
  } catch { $('alerts').hidden = true; }
}

async function firstRun() {
  const out = await ask({ title:'Welcome — set up the shop', okText:'Save and start', bodyHtml:`
    <p class="muted">These print on every bill. You can change them later in Settings.</p>
    <div class="formgrid">
      <div class="field span2"><label>Shop name</label><input data-k="name" value="Sri Nachiya Medicals"></div>
      <div class="field span2"><label>Phone</label><input data-k="phone"></div>
      <div class="field span2"><label>Address line 1</label><input data-k="address1" value="5/168, Palaghad Main Road"></div>
      <div class="field span2"><label>Address line 2</label><input data-k="address2" value="Ettimadai, Coimbatore, Tamil Nadu 641112"></div>
      <div class="field span2"><label>GSTIN</label><input data-k="gstin" value="33BDKPA2625M1ZP"></div>
      <div class="field"><label>Drug licence (Form 20)</label><input data-k="dl_20b" value="CBE/6064/20/21"></div>
      <div class="field"><label>Drug licence (Form 21)</label><input data-k="dl_21b"></div>
      <div class="field span2"><label>Pharmacist</label><input data-k="pharmacist"></div>
    </div>
      <div class="field span2"><label>PIN <span class="muted">(optional, 4 digits)</span></label>
        <input data-k="pin" inputmode="numeric" maxlength="4" autocomplete="off"></div>
    </div>
    <p class="muted" style="margin:10px 0 0">The PIN is asked for before prices, stock corrections,
      cancelling a bill or deleting anything — never for billing. Leave it empty to skip it.</p>
    <div class="formgrid" style="margin-top:0">
    <p class="muted" style="margin:10px 0 0">Forms 20 and 21 are the retail licences a medical shop holds.
      If yours is one number covering both, leave the second box empty — the bill prints it once.
      Check these against the certificates before the first bill.</p>` });
  if (!out) return;
  SHOP = await api('/api/settings', out);
  $('shopName').textContent = SHOP.name;

  /* The PIN is set after the shop details, because setting one needs a shop to
     attach it to. A rejected PIN must not lose the details just saved. */
  if (String(out.pin || '').trim()) {
    try { await rawApi('/api/pin/set', { pin: out.pin }); await refreshLock(); }
    catch (e) { toast(`Shop details saved. The PIN was not set: ${e.message}`, true); }
  }
  toast('Saved. Add your distributors and stock next.');
  show('stock');
}

// ---------------------------------------------------------------- wiring

let searchTimer;
$('q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 120); });
$('q').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); highlight = Math.min(highlight + 1, matches.length - 1); renderResults($('q').value); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); highlight = Math.max(highlight - 1, 0); renderResults($('q').value); }
  else if (e.key === 'Enter') { e.preventDefault(); if (matches.length) choose(highlight); }
  else if (e.key === 'Escape') { $('results').hidden = true; $('pick').hidden = true; picked = null; }
});
$('qtyNum').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addToCart(); } });
$('addBtn').onclick = addToCart;
$('pickCancel').onclick = () => { $('pick').hidden = true; picked = null; $('q').focus(); };
$('paySeg').querySelectorAll('button').forEach(b => b.onclick = () => setPay(b.dataset.pay));
$('saveBill').onclick = saveBill;
$('clearBill').onclick = clearBill;
['rxDoctor','rxPatient','rxAddress'].forEach(id => $(id).addEventListener('input', renderBill));
document.addEventListener('keydown', e => { if (screen === 'bill' && e.key === 'F9') { e.preventDefault(); saveBill(); } });

$('dScan').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); handleScan($('dScan').value); } });
// A USB scanner types the code and presses Enter by itself, so nothing else is needed.
/* Every browser with a camera can read the shop's own QR labels, so the button
   is offered wherever there is a camera at all — no scanner needed. */
if (navigator.mediaDevices?.getUserMedia) {
  $('camBtn').hidden = false; $('camBtn').onclick = () => startCamera('stock');
  $('bCamBtn').hidden = false; $('bCamBtn').onclick = () => startCamera('bill');
}
$('camStop').onclick = stopCamera;
$('bCamStop').onclick = stopCamera;
// Retyping the discount must redraw the costs at once, or the owner is
// looking at figures from the old one.
$('dDisc').addEventListener('input', renderDelivery);
$('dMed').addEventListener('change', onMedicineChosen);
$('dAdd').onclick = addDeliveryLine;
$('dSave').onclick = saveDelivery;
$('newMedicine').onclick = addNewMedicine;
$('newSupplier').onclick = addNewSupplier;
$('editSupplier').onclick = editSupplier;
$('delSupplier').onclick = removeSupplier;

let medTimer;
$('mSearch').addEventListener('input', () => { clearTimeout(medTimer); medTimer = setTimeout(loadMedicines, 150); });

$('saveSettings').onclick = async () => {
  try {
    SHOP = await api('/api/settings', {
      name:$('sName').value, phone:$('sPhone').value, address1:$('sAddr1').value, address2:$('sAddr2').value,
      gstin:$('sGstin').value, dl_20b:$('sDl20').value, dl_21b:$('sDl21').value,
      pharmacist:$('sPharm').value, bill_prefix:$('sPrefix').value || 'SNM',
    });
    $('shopName').textContent = SHOP.name;
    $('setupMsg').textContent = 'Saved.';
    toast('Shop details saved. They print on the next bill.');
  } catch (e) { toast(e.message, true); }
};
$('backupNow').onclick = async () => {
  try { const b = await api('/api/backup', { label:'manual' }); toast(`Backup saved (${Math.round(b.size/1024)} KB).`); loadSettings(); }
  catch (e) { toast(e.message, true); }
};
$('checkDb').onclick = async () => {
  const r = await api('/api/integrity');
  /* Say which thing is wrong. Reporting a drift count when the trouble is
     something else sends the owner looking in the wrong place. */
  const problems = [];
  if (r.drift?.length)
    problems.push(`${r.drift.length} ${plural('batch', r.drift.length)} do not match the stock history`);
  if (r.negative?.length)
    problems.push(`${r.negative.length} ${plural('batch', r.negative.length)} show less than nothing in stock`);
  if (r.duplicates?.length)
    problems.push(`${r.duplicates.length} ${plural('medicine', r.duplicates.length)} appear twice in the list ` +
      `(${r.duplicates.map(d => d.name).join(', ')}), so their stock is split`);

  showMsg($('integrityMsg'), r.ok
    ? 'Everything adds up: the stock figures match the stock history exactly.'
    : `${problems.join('. ')}. Call for help before billing more.`,
    r.ok ? 'ok' : 'bad');
};

(async function boot() {
  try {
    await api('/api/health');
    SHOP = await api('/api/settings');
    if (!SHOP) { await firstRun(); }
    else $('shopName').textContent = SHOP.name;
    renderBill(); loadRecent(); loadAlerts();
    $('q').focus();
  } catch (e) {
    document.body.insertAdjacentHTML('afterbegin',
      `<div class="msg bad" style="margin:18px">${esc(e.message)}</div>`);
  }
})();
