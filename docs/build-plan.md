# Sri Nachiya Medicals — Stock & Billing System
### A complete A-to-Z build plan: tools → data model → cloud → shop PC → owner mobile app → publishing

---

## A. What you are actually building

Three surfaces, one backend:

| Surface | Who | Where it runs | What it does |
|---|---|---|---|
| **Counter POS** | Shop staff / pharmacist | Shop PC (Chrome, installed as an app) | Billing, stock-in, returns. Must work with zero internet. |
| **Owner dashboard** | Shop owner | Phone | Sales, margin, expiry, dead stock, reorder. Read-mostly. |
| **Backend** | — | Cloud (Supabase, Mumbai) | Postgres, auth, sync, file storage, scheduled jobs |

One design sentence to hold onto for the whole project:

> **The counter must never stop billing, and every quantity in the system must be explainable by a row in the stock ledger.**

Everything below follows from those two constraints.

---

## B. What your three reference projects got right — and what to fix

I read all three. Honest assessment, because copying their mistakes will cost you weeks.

### `MedicalShopManager` (Java, single file)
**Keep:** the domain thinking. `msr` (minimum stock required), the low-stock warning on sale, expiry-dump awareness, per-category profit tracking (tablet / liquid / med / total). You already understood the *business* before you wrote code — that's the rare part.

**Fix:**
- `static` counters for inventory/investment/profit — these are class-level globals. Fine for a console demo, unusable for real data. All of this becomes SQL aggregates.
- No batch concept. `presentstock` is a single integer per product. **This is the fatal flaw for a pharmacy** (see section F).
- `sellProduct(int qty, int sellprice)` takes the selling price as an argument at sale time. In a real pharmacy the price is MRP printed on the pack and varies *per batch*. Price must come from the batch, not from the cashier.
- Profit computed as `qty * (sellprice - price)` at sale time — correct instinct, but it must be persisted per line item, not accumulated in a static field that dies when the process exits.

### `medicalStockTrackerr` (React + TS + Vite + Tailwind + Supabase + Chart.js)
**Keep:** this is your starting skeleton. The stack is right. `react-router-dom` route splitting by role (`ManufacturerRoutes` / `PurchaserRoutes` / `CustomerRoutes`), `lucide-react` icons, Chart.js for analytics, `@supabase/supabase-js` already in `package.json`, Tailwind configured. Reuse the shell, the routing pattern, the header/back-button components.

**Fix:**
- `mockData.ts` is 21 KB of hardcoded medicines and the `Medicine` interface has `stock: number` — same single-integer flaw. Replace with real tables.
- `QRCodeGenerator.tsx` hand-draws a QR on a `<canvas>`. That is not a real QR encoder — it will not scan. Use the `qrcode` npm package (or `qrcode-generator`, already in your deps) properly, and for *reading* use `@zxing/browser` or `html5-qrcode`.
- Supabase client is imported but there's no schema, no RLS, no auth. That's the actual work.
- The roles modelled (manufacturer/purchaser/customer) are a supply-chain demo. Your roles are owner / pharmacist / counter staff. Different app.

### `b2b` (Android Java + Firebase)
**Keep:** the README is the best spec of the three. Admin approval workflow, GST + discount on bills, PDF invoice, reorder suggestions, audit logs, order status tracking, MPAndroidChart, Room for local storage. The `auditLogs/` node shows you were already thinking about traceability.

**Fix / decide:**
- **Firebase Realtime Database vs Postgres.** RTDB is a JSON tree. Your reports — "gross margin by category last month", "batches expiring in 60 days with value at risk", "items with no sale in 90 days" — are joins and aggregates. Those are miserable in RTDB and trivial in SQL. **Choose Postgres.**
- Two codebases (Android Java + HTML/JS admin panel + Node/Express) is three things to maintain alone. Collapse to one.
- B2B supplier ordering is scope you do not need in v1. Your distributor is a phone call and a WhatsApp message. Build the *purchase entry*, not the *marketplace*.

### The single most important fix across all three
All three store stock as **one number per product**. A pharmacy cannot work this way. Paracetamol 500 in your shop right now is probably 3 different batches, 3 different expiry dates, and possibly 2 different MRPs. You must sell the oldest-expiring one first, your bill must legally print the batch and expiry, and your expiry report is meaningless without batches.

**Batch-level inventory is not a nice-to-have. It is the product.**

---

## C. The one architectural decision that matters: offline-first

A pharmacy counter cannot say "sorry, internet is down, no bill." Coimbatore broadband drops, the JioFiber router reboots, there's a power cut and the UPS gives you 15 minutes.

So: **writes go to the local device first, then sync.**

```
[Counter PC]                                    [Cloud]
Browser PWA
  ├── IndexedDB (Dexie)  ← read + write here     Supabase Postgres
  │     products, batches, stock_ledger,    ⇄     (source of truth for
  │     bills, outbox                              reporting + mobile)
  └── Service Worker (app shell cached)
```

- Every write = a row in local DB **plus** a row in `outbox`.
- A background sync loop drains `outbox` → Supabase when online.
- Pull loop fetches `WHERE updated_at > last_sync_at` per table.
- **The stock ledger is append-only, which kills the hardest conflict class.** Two devices both selling the last strip just produce two ledger rows; the sum is still correct and the negative balance shows up as an alert instead of silent data corruption.
- Bill numbers get a device prefix so they can never collide: `SNM-C1-000123`, `SNM-C2-000087`.

This is also the thing that will make a senior engineer nod in an interview. Most student projects assume a perfect network.

---

## D. Final tech stack

| Layer | Pick | Why |
|---|---|---|
| Frontend | **React 18 + TypeScript + Vite + Tailwind** | You already have this working in `medicalStockTrackerr`. Don't restart. |
| UI kit | shadcn/ui + lucide-react | Fast, clean, no design debt |
| Local DB | **Dexie.js** (IndexedDB wrapper) | Offline store + outbox |
| PWA | `vite-plugin-pwa` (Workbox) | Installable on the shop PC *and* the owner's phone from one codebase |
| Backend | **Supabase** — Postgres + Auth + Realtime + Storage + Edge Functions + pg_cron | One service instead of five. Region: **ap-south-1 (Mumbai)** |
| Charts | Recharts (or Chart.js, already in your deps) | Owner dashboard |
| Barcode read | `@zxing/browser` (camera) + USB HID scanner (keyboard input) | See section G |
| Barcode write | `bwip-js` for GS1 DataMatrix / Code128 shelf labels | |
| PDF | `pdfmake` or `jspdf` | Invoices, GST reports, H1 register |
| ML service | **Python + FastAPI on Render/Fly.io free tier** | Invoice OCR + demand forecasting. Plays to your strength. |
| Hosting | Cloudflare Pages (free) | Auto-deploy on git push. Not Vercel's free tier: its Hobby plan is for non-commercial use only, and a shop's billing system is commercial. |
| Repo | GitHub, single monorepo | |

**Why not Flutter / React Native for the owner app?** Because the owner app is 6 read-only screens. A PWA with "Add to Home Screen" gets you there in a week instead of six, from the same codebase. If you later want a Play Store listing, wrap the same PWA in a TWA (section X). Don't write a second app.

---

## E. Shop-floor hardware (approximate Coimbatore prices)

| Item | Approx. cost | Notes |
|---|---|---|
| Shop PC (Windows 10/11, 8 GB RAM) | ₹0 if existing | Chrome/Edge is all you need |
| **2D barcode/QR imager scanner, USB** | ₹3,000 – ₹6,000 | **Buy the 2D, not the 1D.** Pharma QR codes and GS1 DataMatrix are 2D. A ₹1,200 laser 1D scanner cannot read them. |
| 80 mm thermal receipt printer (USB) | ₹3,500 – ₹6,000 | ESC/POS compatible (TVS RP 3160, Epson TM-T82, etc.) |
| UPS for PC + printer | ₹3,000 – ₹4,000 | Non-negotiable. Power cut mid-bill = corrupted state without it. |
| Thermal roll stock | ₹500 / month | |
| **Total one-time** | **≈ ₹10,000 – ₹16,000** | |

A USB scanner in HID mode behaves exactly like a keyboard — it "types" the barcode and presses Enter. That means **zero driver code**: just keep focus in a search box and listen for a fast burst of keystrokes ending in Enter. This is how every real POS works and it is far faster and more reliable than a webcam scan.

Use the webcam/phone camera path (`@zxing/browser`) only for the owner's phone and as a fallback.

---

## F. Data model — the core of the whole system

This is the part to get right before writing any UI.

### Tables

**`products`** — the catalogue (one row per sellable item, no quantities here)
```
id, name, generic_name, composition (normalized), strength,
manufacturer, pack_form (tablet|capsule|syrup|injection|cream|drops|device),
hsn_code, gst_rate, drug_schedule (OTC|H|H1|X|G),
base_unit (tablet|ml|piece), units_per_strip, strips_per_box,
is_refrigerated, rack_location, reorder_point, reorder_qty,
is_active, created_at, updated_at
```

**`product_barcodes`** — many codes per product. This table is what makes scanning work.
```
id, product_id, code, code_type (EAN13|CODE128|GS1_DM|QR), pack_level (base|strip|box)
```

**`batches`** — where quantity actually lives
```
id, product_id, batch_no, expiry_date, mfg_date,
mrp, purchase_rate (PTR), qty_available (base units),
supplier_id, grn_id, created_at
UNIQUE (product_id, batch_no, expiry_date)
```

**`stock_ledger`** — append-only, the audit spine
```
id, product_id, batch_id, delta (+/- base units),
reason (purchase|sale|sale_return|purchase_return|expiry_writeoff|damage|adjustment),
ref_type, ref_id, device_id, user_id, created_at
```
`batches.qty_available` is a **cached projection** of this ledger, maintained by a Postgres trigger. If they ever disagree, the ledger wins and you rebuild. This one table gives you: full traceability, painless sync, a real audit trail, and the ability to answer "where did those 40 strips go?" three months later.

**Other tables:** `suppliers` (with `lead_time_days`, `return_window_months`), `purchases` + `purchase_items` (GRN), `sales` + `sale_items`, `customers`, `credit_ledger`, `stockout_log`, `users`, `audit_log`, `settings`.

### Three modelling details that will bite you if you skip them

1. **Expiry is a month, not a date.** Packs print `MM/YYYY`. Store the *last day of that month* and always display `MM/YYYY`.

2. **Loose tablet sales.** Customers buy 4 tablets, not a strip of 15. So `base_unit = tablet`, and `units_per_strip` / `strips_per_box` are conversion factors. All stock math happens in base units; the UI lets staff type `2s` (2 strips) or `4` (4 tablets). Per-tablet price = `mrp / units_per_strip`, rounded per your rounding rule. Almost every student project misses this and it makes the system useless on day one.

3. **MRP varies by batch.** Never store price on `products`. Price comes from `batches`.

---

## G. Stock-in: what the QR code can and can't actually do

You asked: *"if QR code is there in the bulk stock purchase then the items should be automatically updated."* Here's the honest reality, then the design that works.

### The regulatory picture (verified, current)

India's on-pack QR framework is **Schedule H2** of the Drugs Rules, 1945. <cite index="7-3">It was introduced by notification G.S.R. 823(E) dated 17 November 2022, amending Rule 96, and took effect on 1 August 2023, covering the 300 formulations listed in Schedule H2</cite>. <cite index="6-1">The code must carry the unique product identification code, brand name, generic name, manufacturer name and address, batch number, manufacturing date, manufacturing licence number, and expiry date</cite>.

<cite index="3-1">On 22 June 2026 the Ministry of Health and Family Welfare published G.S.R. 506(E), the Drugs (Seventh Amendment) Rules 2026, expanding Schedule H2 from that static list of 300 brands to entire therapeutic classes — the original list is retained as Table 1 and a new Table 2 adds category-wide coverage</cite>. <cite index="5-1">The new categories are all vaccines, all antimicrobials, all narcotic and psychotropic drugs, and all anticancer drugs; the requirement takes effect 1 July 2027 for three categories and 1 July 2028 for antimicrobials</cite>.

**What this means for you:** a growing but still partial share of packs on your shelf carry a machine-readable code, and the timelines run into 2027–28. Most general medicines still do not. **You cannot build a system that only works by scanning.**

### The design: three ingest lanes into one review screen

```
Lane 1: SCAN THE CARTON  ─┐
Lane 2: OCR THE INVOICE  ─┼──▶  [GRN DRAFT SCREEN]  ──▶  confirm  ──▶  stock_ledger
Lane 3: TYPE IT MANUALLY ─┘     editable, side-by-side with the paper invoice
```

**Lane 1 — Scan.** Scanner fires a string. You classify it:
- **GS1-128 / GS1 DataMatrix** → parse Application Identifiers: `(01)` GTIN, `(17)` expiry YYMMDD, `(10)` batch, `(21)` serial. Write a small `parseGS1()` function — this is ~60 lines and it is the genuinely impressive bit of the feature. You get product + batch + expiry from one scan.
- **Plain EAN-13** → look up `product_barcodes`. You get the product; batch/expiry still need typing.
- **Unknown code** → show a **"Teach me this code"** screen: staff picks the product once, you insert into `product_barcodes`. **Every unknown scan trains the system.** After ~3 weeks of normal purchasing, a large share of what the shop actually stocks is mapped. Ship this on day one; it's what makes scanning get better instead of staying broken.

**Lane 2 — OCR the distributor invoice.** This is the real "bulk auto-update" and it is section H.

**Lane 3 — Manual**, with aggressive autocomplete and a "repeat last purchase of this item" button.

### Non-negotiable rule
**Nothing enters stock without a human pressing Confirm.** A scan or an OCR result creates a *draft GRN*, never a committed stock movement. Mis-scanned expiry dates in a pharmacy are a safety problem, not a bug.

---

## H. The invoice OCR lane — your differentiator

When a distributor delivery arrives, it comes with a printed invoice listing 30–60 lines: product, pack, batch, expiry, qty, free qty, rate, MRP, GST. Typing that is 25 minutes per delivery. This is the single biggest time sink in a pharmacy's day, and it's where your ML background shows.

**Pipeline:**
1. Staff photographs the invoice (phone) or scans it → uploaded to Supabase Storage.
2. Python FastAPI service on Render/Fly.io picks it up.
3. **Extraction:** a vision LLM (Claude / Gemini) with a strict JSON schema prompt handles messy layouts far better than template-based OCR, and distributor invoice formats vary wildly. Fall back to PaddleOCR + layout heuristics for the ones you see repeatedly.
4. **Matching:** fuzzy-match each extracted line against your `products` table (RapidFuzz on normalized name + pack size, boosted by manufacturer match). Below a confidence threshold → "new product?" prompt.
5. Return a draft GRN. Staff reviews side-by-side with the paper, fixes 2–3 lines, presses Confirm.

**Target:** 25 minutes → under 3 minutes.

Measure this. "Reduced goods-receipt time by 88% on 40-line distributor invoices" is a resume line with a number attached, which is worth ten feature bullets.

**Cost control:** one invoice ≈ one vision API call ≈ a few rupees. At 2 deliveries/day that's under ₹200/month. Cache by invoice hash so re-processing is free.

---

## I. The billing screen — where the project lives or dies

If billing is slower than the paper bill book, the shop will stop using your app in week two. Nothing else matters if this screen is slow.

**Target: under 30 seconds for a 5-item bill, hands never leaving the keyboard.**

Design rules:
- **One search box, always focused.** Type 3 letters → ranked results (prefix match on brand name, then generic, then composition). Arrow keys + Enter to select. Scanner input also lands here.
- **Quantity immediately after, inline.** `4` = 4 tablets, `2s` = 2 strips, `1b` = 1 box.
- **Batch auto-picked by FEFO** (First-Expiry-First-Out) — nearest expiry that has stock. Show it, allow override with one keypress.
- **Keyboard shortcuts everywhere:** F2 new bill, F4 discount, F9 save & print, Esc cancel line.
- **Hard blocks, not soft warnings:**
  - Expired batch → cannot be added. Ever.
  - Expiring within 30 days → amber confirmation prompt.
  - Schedule H1 item → cannot save the bill without prescriber name, patient name/address, and an optional Rx photo (legally required — section P).
  - Selling more than available → blocked, with a "record as stock-out" option.
- **Out of stock → show substitutes** with the same composition and strength, marked clearly as *suggestions for the pharmacist to approve*. Never auto-substitute. This recovers sales that currently walk out the door.
- **Payment:** cash / UPI / card / credit (khata). UPI QR shown on screen.
- **Round-off** to the nearest rupee, stored as its own field.

**Every failed search gets logged to `stockout_log`.** A button labelled "Not available" next to empty results. This becomes the single best reorder signal you will have, and almost no commercial pharmacy software captures it.

Then: bill saves → ledger rows written → print → new bill, cursor back in the search box.

---

## J. Stock-out and returns

- **Sale** → for each line, one negative `stock_ledger` row against the specific `batch_id`. Trigger decrements `batches.qty_available`.
- **Sale return** (customer brings it back) → positive row, `reason = sale_return`, linked to the original bill. Only within N days, configurable. Batch must match the original.
- **Purchase return** (near-expiry sent back to distributor) → negative row, `reason = purchase_return`, plus a credit-note record against the supplier.
- **Expiry write-off** → negative row, `reason = expiry_writeoff`. Monthly job flags batches past expiry and asks the owner to confirm the write-off. Confirmed write-offs feed the "money lost to expiry" metric.
- **Physical stock-take** → a count screen; the difference posts as `reason = adjustment` with a mandatory note. Never silently overwrite a quantity.

---

## K. Analytics 1 — the owner's daily screen

Open the app, understand the day in 10 seconds. Six numbers at the top, nothing else above the fold:

1. **Today's sales ₹** (vs. same weekday last week, % change)
2. **Gross margin ₹ and %** — `Σ (selling − purchase_rate) × qty`. This is the number owners actually care about and almost no small pharmacy knows daily.
3. **Bills count + average bill value**
4. **Cash vs UPI vs credit split** — cash figure doubles as the day-end till reconciliation target
5. **⚠ Value at risk** — ₹ of stock expiring in 90 days
6. **⚠ Stock-outs today** — count of items customers asked for and you didn't have

Below: 30-day sales sparkline, top 10 movers by value, hourly sales heatmap (tells them when to staff the counter).

Push a **daily 9 PM summary** — one message, six numbers. For a single shop, a **Telegram bot is free and takes 20 lines of Python**; WhatsApp Business API requires template approval and per-conversation billing. Start with Telegram.

---

## L. Analytics 2 — expiry and dead stock (this is where you save them real money)

This module alone justifies the whole project.

**Expiry ladder**, with rupee value at each level:

| Window | Value at risk | Action |
|---|---|---|
| Already expired | ₹ | Write off, quarantine physically |
| 0–30 days | ₹ | Too late to return — push discount / bundle |
| 31–90 days | ₹ | Discount, watch |
| 91–180 days | ₹ | **← return window: act now** |

**The return-window alert is the killer feature.** Most distributors accept returns only if the item is more than ~3–6 months from expiry (store the actual window per supplier in `suppliers.return_window_months`). Every pharmacy loses money by noticing expiry at 45 days, when returns are no longer accepted.

So: a weekly job produces a **"Return to distributor this week"** list, grouped by supplier, with quantities, batch numbers and total value. One tap → PDF → WhatsApp to the distributor.

**Dead stock report:** items with zero sales in 90 days and stock on hand, sorted by rupees locked up. Add a "why" column (new product / seasonal / substitute available / overstocked once). Owners are usually shocked by this number.

**Near-expiry markdown suggestions:** for 31–90 day items with no return path, suggest a discount that still clears above cost. Better to recover 70% than write off 100%.

---

## M. Analytics 3 — the reorder engine

Don't just alert on "below minimum." Compute a real reorder point:

```
avg_daily_demand  = 28-day sales ÷ 28   (excluding stock-out days — important)
safety_stock      = z × σ_daily × √lead_time_days     (z = 1.65 for ~95% service)
reorder_point     = avg_daily_demand × lead_time_days + safety_stock
order_qty         = max(reorder_point + review_period×demand − on_hand, min_pack)
```

Excluding stock-out days matters: if you were out of stock for 6 days, your measured demand is artificially low, and a naive system under-orders forever. This is a genuinely sophisticated detail that separates your project from every other student inventory app.

Output: a **suggested purchase order per distributor**, editable, exportable as PDF, sendable on WhatsApp in one tap. Fold in `stockout_log` — items people asked for that you never stocked appear as "consider stocking."

**ABC–XYZ classification**, recomputed weekly:
- ABC by revenue contribution (A = top 70%, B = next 20%, C = last 10%)
- XYZ by demand variability (X = steady, Y = variable, Z = erratic)
- **AX items** = tight control, never go out of stock, keep at the front rack.
- **CZ items** = stop stocking, order on demand.

A "rack reorganization" report that says *these 40 items are 60% of your sales, put them within arm's reach of the counter* is the kind of insight that makes an owner tell other owners about you.

---

## N. Analytics 4 — demand forecasting (your ML angle)

Do this **last**, and only after you have 3+ months of real sales data. Forecasting on fake data is a portfolio liability, not an asset.

**Phase 1 (baseline):** 7-day and 28-day moving average, day-of-week factor. Ships in an afternoon.

**Phase 2 (real model):** weekly demand per SKU, for **A-class items only** (~100–200 SKUs, not all 5,000).
- Features: lagged sales (1/2/4/8 weeks), day-of-week, month, festival calendar (Pongal, Diwali, local temple festivals), Tamil Nadu monsoon season flags, recent trend slope, stock-out mask.
- Models: ETS / Prophet for seasonal items, LightGBM with the above features for the pooled cross-SKU model.
- Runs as a weekly batch job in your FastAPI service, writes forecasts back to a `forecasts` table.

**Discipline: you must beat the moving-average baseline on WAPE, out of sample, or you don't ship it.** Report both. Being able to say "the LightGBM model beat the naive baseline by 18% WAPE on 140 A-class SKUs over 12 held-out weeks" is a *real* ML result. Saying "we used AI for demand prediction" with no baseline is not.

**Seasonal wins specific to your shop:** fever/cold spikes with the northeast monsoon (Oct–Dec), allergy season, exam-season antacids, festival-week dips. A forecast that tells the owner to stock up on antipyretics two weeks before the monsoon peak is immediately, obviously valuable.

---

## O. Extra features worth building (ranked by value-per-hour)

1. **Chronic refill reminders.** Flag diabetes/BP/thyroid/cardiac items. If a customer bought a 30-day supply 27 days ago, they need a refill. Owner-approved list → one-tap message. This is recurring revenue and the highest-ROI feature on this list.
2. **Customer credit ledger (khata).** Every shop runs informal credit on paper. Digitize it: outstanding per customer, ageing buckets, payment reminders. Owners love this more than any chart.
3. **Substitute / generic finder.** Composition-indexed search. Converts stock-outs into sales, supports legitimate generic substitution. *Suggestion only, pharmacist decides.*
4. **Rx photo capture.** Snap the prescription, attach to the bill. Mandatory for H1. Solves disputes and inspections.
5. **Doctor-wise analytics.** Which local doctors drive your prescriptions, which molecules they favour. Informs what to stock.
6. **Staff-wise discount tracking.** Margin leakage is usually discounts, not theft. Shows discount given per staff member.
7. **Day-close cash reconciliation.** Expected cash vs counted cash, variance logged. Two minutes at closing, prevents slow leaks.
8. **Shelf label printing.** Rack location + barcode + MRP. Makes physical stock-taking 3× faster.
9. **Multi-device counter.** Second billing terminal during rush hours — works free because of the append-only ledger and device-prefixed bill numbers.
10. **Purchase price variance alert.** Flags when a distributor quietly raises the PTR on a repeat item.

### What NOT to build in v1
Supplier marketplace/B2B ordering. Online customer ordering. Delivery tracking. Loyalty points. Multi-shop. Payment gateway. Home delivery. All of it is a distraction from *billing fast and never losing money to expiry.*

---

## P. Compliance and legal — do not skip this

This is a regulated business. Getting this right is also what makes the project look professional rather than academic.

**On every bill (legally required):**
shop name and address · Drug Licence numbers (20/21 or 20B/21B) · GSTIN · bill number and date · product name · **batch number** · **expiry** · quantity · MRP · rate · HSN code · GST split (CGST/SGST) · total in words · pharmacist name.

**Schedule H1 register.** Certain antibiotics, anti-TB drugs and psychotropics require a separate register recording the date of supply, patient name and address, prescriber name and address, drug name and quantity — **retained for three years**. Auto-generate this from H1-flagged bills and make it exportable as PDF. This is a legal obligation the shop currently fulfils on paper badly, and automating it is a genuine selling point.

**Schedule X / narcotics:** stricter registers and storage. **Exclude from v1 scope** unless the shop actually stocks them — get it wrong and it's a licensing problem, not a bug.

**GST.** <cite index="32-1">Under the 56th GST Council rationalisation effective 22 September 2025, GST on 36 specified life-saving drugs was reduced to nil, and all other medicines now attract a concessional 5% rate unless specifically exempted; medical devices and instruments were also rationalised to 5%</cite>. <cite index="29-1">Vitamins, supplements and OTC products remain at 18%</cite>. <cite index="29-1">Medicines fall under HSN Chapter 30 — 3004 for medicaments, 3002 for vaccines, 3003 for ayurvedic and homeopathic products</cite>.

> **Store `gst_rate` and `hsn_code` as per-product data fields, never as constants in code.** Rates change; the September 2025 reform is proof.

**E-invoicing:** <cite index="12-1">mandatory only for taxpayers with aggregate annual turnover above ₹5 crore, and only for B2B supplies</cite>. A retail pharmacy selling to walk-in customers is B2C and almost certainly below the threshold — **you do not need IRP integration**. Build the GSTR-1 summary and HSN-wise summary reports instead, and let their CA file.

**DPDP Act 2023.** Customer name, phone and purchase history is personal data, and medicine purchase history is health-adjacent — treat it as sensitive.
- Phone number optional, asked for with a stated purpose.
- No marketing messages without explicit opt-in.
- "Delete customer" must **anonymize** the customer record while retaining the financial rows (you can't delete tax records). Replace name/phone, keep bill totals.
- Keep data in India — this is why the Supabase region choice matters.

**Retention:** keep financial records 8 years, H1 register 3 years.

**Safety line to hold:** the app suggests, the pharmacist decides. No clinical advice, no dosage guidance, no automatic substitution, no dispensing workflow that bypasses the registered pharmacist.

---

## Q. Cloud and storage — where the data lives

### Recommendation: Supabase, Mumbai region

| | Free | Pro |
|---|---|---|
| Cost | $0 | <cite index="27-1">$25/mo, includes 100,000 MAUs, 8 GB database, 250 GB egress, 100 GB storage, 2M Edge Function invocations</cite> |
| Backups | none | <cite index="24-1">daily, 7-day retention</cite> |
| **Catch** | <cite index="20-1">500 MB database, 2 projects, and free projects auto-pause after one week of inactivity</cite> | — |

> ⚠️ **Build on Free. Go live on Pro.** A free project that auto-pauses would take the shop's billing down. ~₹2,200/month is trivial against the ₹40,000+ of expiry write-offs this system will prevent in a year — make exactly that argument to the owner.

**Region: ap-south-1 (Mumbai)** — lowest latency from Coimbatore, and it keeps Indian health-adjacent personal data in India.

**What goes where:**
- **Postgres** — everything transactional. Products, batches, ledger, bills, customers.
- **Supabase Storage** — Rx photos, distributor invoice scans, generated PDFs. Compress images to ~200 KB before upload; at 10 Rx/day that's ~700 MB/year.
- **IndexedDB on the shop PC** — full local mirror of products/batches/recent bills + the outbox.

**Size math:** 5,000 SKUs, 200 bills/day × 5 lines = ~1,000 sale rows/day ≈ 365K rows/year, plus ledger. That's a few hundred MB per year. The 8 GB Pro database comfortably covers 5+ years.

**Backup strategy (3-2-1):**
1. Supabase daily automated backup (cloud)
2. Nightly `pg_dump` via a GitHub Actions cron → gzip + encrypt → Cloudflare R2 or Google Drive (second cloud, different provider)
3. The shop PC's IndexedDB mirror + a weekly CSV export to a USB drive the owner keeps (offline copy)

**Then actually test a restore.** Once, before go-live, and write down how long it took. An untested backup is not a backup.

**Alternative (only if cost is a hard blocker):** self-host Postgres on a ₹400–800/month VPS (Hetzner / DigitalOcean / Oracle Cloud Free). You then own backups, TLS certs, OS patching and uptime. For one shop, not worth it. Revisit if you sell to 10 shops.

---

## R. Security and access control

**Roles:** `owner` (everything + reports + cost prices), `pharmacist` (billing, stock, H1 entries), `counter_staff` (billing only, **cannot see purchase rates or margins**, cannot delete bills, discount capped).

**Implementation:**
- Supabase Auth with email/password for owner and pharmacist.
- **4-digit PIN for quick counter switching** — the PC is logged in as the shop; staff punch a PIN per session. Nobody types an email address at a busy counter.
- **Row Level Security on every single table.** `shop_id = auth.jwt() ->> 'shop_id'`. Write the policies before the UI, not after. This is also what makes the system multi-shop-ready later at zero cost.
- **Cost prices (`purchase_rate`) hidden from `counter_staff` via a column-level policy or a restricted view.** Owners care about this a lot.
- Bills are immutable once saved. Corrections happen via a credit note, never an edit. Every override, discount above threshold, and manual stock adjustment writes to `audit_log` with user + device + timestamp.
- Secrets in environment variables, never in the repo. Rotate the Supabase anon key if it ever leaks; never ship the service-role key to the browser.

---

## S. Printing

**Phase 1 (start here):** browser printing with a dedicated print stylesheet.
```css
@page { size: 72mm auto; margin: 0; }
```
Set the thermal printer as the Windows default, enable Chrome's silent-print flag or accept one Ctrl+P. Zero extra software. Good enough to launch.

**Phase 2 (if print reliability or a cash drawer becomes an issue):** a tiny **local print agent** — Python + FastAPI + `python-escpos`, packaged with PyInstaller, running on the shop PC as a service, listening on `localhost:9100`. The PWA POSTs the bill JSON; the agent emits raw ESC/POS bytes and kicks the cash drawer. Rock solid, uses your Python strength, and 200 lines of code.

**Bill layout** for 80 mm: shop name and address, DL numbers, GSTIN, bill no + date/time, line items with batch and expiry, GST summary by rate, total in words, a "keep this bill for returns" footer, and a UPI QR.

Also print **A5 GST invoices** (PDF via `pdfmake`) for customers who need them for insurance or reimbursement.

---

## T. Sync design (the details that make it work)

**Outbox table** (local): `id, table_name, op (insert|update), payload, created_at, synced_at, attempts, last_error`.

**Push loop:** every 15 s when online, drain the outbox in creation order, batched. On success set `synced_at`. On failure increment `attempts` with exponential backoff; after 5 failures surface a visible banner — *never* fail silently.

**Pull loop:** every 60 s, `SELECT * FROM <table> WHERE updated_at > $last_sync` per table, upsert into Dexie. Supabase Realtime can push product/price changes instantly.

**Conflict rules:**
- `stock_ledger` — append-only, no conflicts possible by construction.
- `products` / `batches` metadata — last-write-wins by server `updated_at`.
- `sales` — client-generated UUID primary key + device-prefixed bill number. Idempotent upsert means a retried push can never double-insert a bill.

**Clock skew:** never trust the shop PC's clock for ordering. Server sets `created_at` via `now()` on insert; the local copy keeps a `client_created_at` for display only.

**Visible sync status in the UI:** a small pill — green "Synced", amber "3 pending", red "Offline 2h". The staff must be able to see it, and the owner must be able to tell you about it on the phone.

---

## U. Repo structure

```
sri-nachiya-medicals/
├── apps/
│   ├── pos/                  # React PWA — counter + owner dashboard (one app, role-routed)
│   │   ├── src/
│   │   │   ├── features/     # billing/ stock/ purchases/ analytics/ settings/
│   │   │   ├── db/           # dexie schema, outbox, sync engine
│   │   │   ├── lib/          # gs1-parser.ts, units.ts, gst.ts, fefo.ts, print/
│   │   │   └── components/
│   │   └── vite.config.ts    # vite-plugin-pwa
│   └── ml-service/           # Python FastAPI — invoice OCR + forecasting
│       ├── app/ocr/ app/forecast/
│       └── Dockerfile
├── supabase/
│   ├── migrations/           # versioned SQL — schema, triggers, RLS policies
│   ├── functions/            # edge functions: daily-summary, expiry-alert
│   └── seed.sql
├── docs/
│   ├── architecture.md  data-model.md  compliance.md  runbook.md
│   └── diagrams/
└── README.md
```

Keep it one repo. Migrations versioned in SQL from day one — never click-edit the schema in the Supabase dashboard.

---

## V. Build roadmap — 14 weeks

Sized for a student working alongside coursework. Each week ends with something demonstrable.

| Week | Deliverable |
|---|---|
| **1** | **Go to the shop.** Two half-days behind the counter. Time 20 real bills with a stopwatch. Photograph 30 packs, 20 distributor invoices, the bill book, the current register. Write down the 5 things that annoy them most. *Do not write code this week.* |
| **2** | Supabase project (Mumbai). Full schema as SQL migrations. RLS policies. Ledger trigger. Seed 300 real SKUs from their shelf. |
| **3–4** | **Billing screen.** Search, quantity parsing, FEFO batch pick, GST, discount, save. Keyboard-only. Hit the 30-second target. |
| **5** | Thermal print + bill numbering + sale returns + day-close reconciliation. |
| **6** | Stock-in: manual GRN, supplier master, batch entry, purchase returns. |
| **7** | Barcode: HID scanner input, GS1 AI parser, `product_barcodes` + the "teach me this code" flow. |
| **8** | **Offline layer.** Dexie mirror, outbox, sync engine, conflict rules, sync status UI. Test by pulling the network cable mid-bill. |
| **9** | Analytics: expiry ladder, return-window list, dead stock, reorder engine, ABC-XYZ. |
| **10** | Owner mobile dashboard (PWA) + Telegram daily summary bot. |
| **11** | Invoice OCR service (FastAPI + vision model + fuzzy matching + review screen). |
| **12** | **Pilot.** System runs in parallel with the paper bill book for 2 full weeks. Every evening, reconcile. Log every complaint. |
| **13** | Fix everything from the pilot. Schedule H1 register, GST reports, PDF invoices, backup + restore test. |
| **14** | Cutover. Training. Printed one-page cheat sheet. Play Store TWA submission. Documentation. |

Weeks 3–4 and week 12 are the ones that matter. Don't compress them.

---

## W. Testing and the pilot

**Automated:**
- Unit tests for the money and stock math — GST computation, per-tablet pricing, FEFO selection, GS1 parsing, reorder point. These are pure functions; test them hard. Rounding bugs in a POS are unforgivable.
- An integration test that runs 1,000 random operations (sales, returns, purchases, adjustments) and asserts **`SUM(stock_ledger.delta) == batches.qty_available` for every batch**. This single invariant test catches almost every category of bug you can have.
- Offline test: queue 50 bills offline, reconnect, assert exactly 50 bills server-side and no duplicates.

**Manual, in the shop:**
- Print 20 bills on the actual printer. Check alignment, the batch/expiry columns, the GST split.
- Cut power mid-bill. Confirm no corruption.
- Have the *slowest* staff member bill 10 customers unassisted. If they can't, redesign the screen, don't retrain the person.

**Pilot rule:** two weeks parallel with paper, reconcile the day-end total every single night. When the two match for 14 consecutive days, cut over. Keep the bill book for another month as a rollback.

---

## X. Deployment and publishing

**Frontend:** Cloudflare Pages, free tier, auto-deploy on push to `main`. (Not Vercel's free Hobby tier — it is restricted to non-commercial use.) Custom domain `srinachiyamedicals.in` (~₹450–900/year). Fix the domain **before** go-live: the installed app and its offline data are tied to the exact address, so changing domain later strands both.

**Shop PC:** open the site in Chrome/Edge → **Install app** → desktop icon, own window, no address bar. It looks and behaves like installed software, and it updates itself on every deploy with no reinstall. Pin it to the taskbar and set it to launch on boot.

**Owner's phone:**
1. **Now:** Safari/Chrome → *Add to Home Screen*. Full-screen icon, works offline, push notifications supported on Android and on iOS 16.4+ for installed PWAs. This is enough.
2. **Later, for the Play Store:** wrap the same PWA as a **TWA (Trusted Web Activity)** using PWABuilder or Bubblewrap. No second codebase.
   - Play Console: **$25 one-time** (~₹2,200).
   - ⚠️ Check current Play requirements before you start — personal developer accounts have been subject to a **closed-testing requirement (12 testers for 14 continuous days)** before production release. Budget an extra 3 weeks if so.
   - You'll need: a privacy policy URL, a data-safety declaration (you collect personal data — declare it honestly), icons, screenshots, and a Digital Asset Links file on your domain.
3. **iOS App Store:** $99/year and a review process for what is essentially a dashboard. **Skip it.** The home-screen PWA is fine.

**Alerts:** Telegram bot (free, instant, 20 lines) for the daily summary and expiry warnings. Web Push for in-app alerts. Only move to WhatsApp Business API if the owner insists — it needs template approval and per-conversation billing.

**Monitoring:** Sentry (free tier) for frontend errors, an uptime check on the Supabase health endpoint, and a weekly automated email to yourself with sync-failure counts and outbox depth. You want to know the system is unhappy before the shop calls you.

---

## Y. Onboarding the shop — the part everyone underestimates

**Opening stock entry is the single biggest adoption risk.** Three thousand SKUs typed by hand is two weeks of work and it is where these projects die.

Three strategies, use all three:
1. **Import if possible.** Ask whether they currently use Marg, EasySol, or similar. Most export to CSV or Excel. One import script saves two weeks. Ask this in week 1.
2. **Progressive onboarding.** Don't enter everything up front. Start with the top ~300 fast movers. Everything else gets created the first time it's purchased or sold — a "quick add" modal with 4 fields. After 3–4 weeks the catalogue is effectively complete and nobody had a data-entry marathon.
3. **One weekend stock-take.** Two helpers, printed count sheets, rack by rack. Do this only for the A-class items where accuracy matters.

**Training:** one hour, hands-on at the counter, not a slide deck. Produce a **laminated one-page cheat sheet** of keyboard shortcuts and tape it to the monitor. Record a 5-minute phone video of the billing flow in Tamil.

**Support:** a WhatsApp group with you and the owner for the first month. Expect calls. This is also where your best feature ideas will come from.

**Rollback plan:** keep the paper bill book for 30 days after cutover. Nobody will need it, but its presence is what lets an anxious owner say yes.

---

## Z. How to make it genuinely impressive

The technical work above is what makes it *good*. This section is what makes it *stand out*.

**1. Actually deploy it.** A working system in a real shop, processing real money, is worth more than any five course projects. In Chennai and Bangalore interviews, "I shipped software that a business depends on daily" is a category most freshers cannot claim.

**2. Instrument it, then quote numbers.** Capture baselines in week 1, results after 3 months:
- Average billing time: _before_ → _after_
- Goods-receipt time per distributor invoice: 25 min → under 3 min
- Expiry write-off value: before → after (this is the headline number)
- Stock-outs per week on A-class items: before → after
- Value recovered via in-window distributor returns: ₹_____

> *"Deployed an offline-first POS and inventory system at a retail pharmacy. Cut goods-receipt time 88% with a vision-LLM invoice parser, and reduced expiry write-offs by ₹X over 3 months through batch-level FEFO tracking and return-window alerting."*

That is a resume line with numbers in it. Very few applicants have one.

**3. Build a public demo.** A separate Supabase project seeded with realistic fake data and a `demo@` login. Put the URL at the top of the README. Recruiters will not clone your repo, but they will click a link.

**4. A README people actually read.** Architecture diagram, animated GIF of the billing flow, the data model, the offline-sync design, the compliance section, a "what I'd do differently" section. The compliance and offline-sync sections will signal seniority more than any amount of code.

**5. Write it up.** A LinkedIn post with a 60-second screen recording, and a blog post on the offline-first sync design — that one is genuinely interesting and under-written about. Tag it with the numbers from point 2.

**6. Possible paper.** *"Offline-first, batch-level inventory management with demand forecasting for small Indian retail pharmacies"* — a solid workshop or national-conference paper with a real deployment, real data, and a proper WAPE comparison against baselines. (Keep your Q1 ambitions on the KG-RAG dissertation; this is your applied/industry portfolio piece, and it's stronger as that.)

**7. Then productize, carefully.** Once it has run clean at Sri Nachiya for 3 months, two or three more shops at ₹500–1,000/month each covers your infrastructure with margin. The multi-shop path costs almost nothing extra because RLS was built in from day one. But do not chase this before the first shop is stable — a second unhappy customer is worse than no second customer.

---

### The four things that decide whether this succeeds

1. **Batch-level inventory**, not a single stock number.
2. **Billing under 30 seconds**, keyboard-only.
3. **Works with the internet unplugged.**
4. **The expiry return-window alert**, because it puts money back in the owner's pocket and that is what makes them keep using it.

Get those four right and the rest is finishing work.

---

### Immediate next step

Before anything else: **spend a day at the counter with a notebook.** Time the bills, photograph the invoices, ask what they hate about their current process, and find out whether any existing software has a CSV export.

Everything above is a strong default. That one day is what turns it into *their* system.
