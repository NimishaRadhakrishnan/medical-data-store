# Putting this into Sri Nachiya Medicals

A runbook for taking the code from this repo to a shop that runs on it daily.
`docs/build-plan.md` is the full 14-week plan; this is the deployment half —
what to buy, what to set up, what order to do it in, and how to hand over
without breaking a working business.

The single rule underneath all of it:

> **Never let the shop's ability to bill a customer depend on something you are
> still testing.** Run in parallel with paper until the numbers match for two
> straight weeks.

---

## Phase 0 — Before you write or deploy anything (1 day)

Spend a day behind the counter with a notebook. This day is worth more than a
month of coding, and skipping it is how these projects die.

**Measure:**
- Time 20 real bills with a stopwatch. Write down the actual seconds. That is
  the number you have to beat, and you cannot beat a number you never measured.
- Time one goods-receipt: distributor delivery arrives, how long until it is
  recorded?
- Count how many customers ask for something not in stock, in one day.

**Photograph:**
- 30 medicine packs, front and back — you need to see which actually carry a
  scannable barcode or QR code. Most will not.
- 20 distributor invoices from the file. These become your OCR test set.
- The current bill book, the purchase register, the H1 register if one exists.

**Ask, and write down the answers:**

| Question | Why it matters |
|---|---|
| Do you use any software now — Marg, EasySol, Vasu, anything? | If yes, ask for a CSV/Excel export. Saves two weeks of opening-stock entry. |
| Which distributors, and how many days from order to delivery? | This is `suppliers.lead_time_days`, and it drives every reorder suggestion. |
| How many months before expiry will each distributor still take returns? | `return_window_months`. This one field is what turns write-offs into credit notes. |
| Do you sell loose tablets? | Yes, always. Confirms `base_unit` design. |
| Who works the counter, and are they comfortable with a keyboard? | Decides how much you simplify the billing screen. |
| What annoys you most about how things work now? | Build that first. |

**Get in writing:** shop name, address, GSTIN, both drug licence numbers
(20B and 21B), and the registered pharmacist's name. All of it prints on every
bill and all of it is legally required.

---

## Phase 1 — Hardware (₹10,000–16,000, one week lead time)

Order early; the scanner is the item most likely to be wrong.

| Item | Budget | Notes |
|---|---|---|
| Shop PC | ₹0 if one exists | Windows 10/11, 8 GB RAM, Chrome or Edge. That is the whole requirement. |
| **2D barcode/QR imager, USB** | ₹3,000–6,000 | **Must be 2D.** Pharma QR and GS1 DataMatrix are two-dimensional; a ₹1,200 laser 1D scanner physically cannot read them. Check the box says "2D imager" or "area imager". |
| 80 mm thermal printer, USB | ₹3,500–6,000 | ESC/POS compatible — TVS RP 3160, Epson TM-T82. |
| **UPS** | ₹3,000–4,000 | Non-negotiable. A power cut mid-bill with no UPS is how you lose data and trust in the same second. |
| Thermal rolls | ₹500/month | 79–80 mm width. |

**Scanner setup:** plug it in and open Notepad. Scan any pack. If the code
appears as text and the cursor moves to a new line, it is in HID keyboard mode
and you need no driver at all. That is what the code expects. If nothing
appears, scan the "USB HID Keyboard" configuration barcode from the scanner's
manual.

---

## Phase 2 — Cloud setup (half a day)

### 2.0 What runs where, and what it costs

| Piece | Where | Cost |
|---|---|---|
| Database, logins, sync API | Supabase **Pro**, region **ap-south-1 (Mumbai)** | about $25/month |
| Counter app + owner dashboard | Cloudflare Pages, free tier | ₹0 |
| Domain, e.g. `srinachiyamedicals.in` | Porkbun (about $5/yr) or an Indian registrar (about ₹800–900/yr) | under ₹900/year |
| Owner's MCP server | His laptop, via Claude desktop | ₹0 |
| Invoice-OCR service (later, week 11) | Small Python host — Render, Railway or Fly.io | ₹0–600/month |

No server in the shop, and no VPS to patch. The counter runs in the browser and
keeps its own copy of the data.

**Not Vercel's free tier:** its Hobby plan is restricted to non-commercial use,
and a shop's billing system is commercial. Cloudflare Pages has no such clause
and gives unlimited bandwidth for a static app.

**Cloudflare Registrar cannot register `.in` domains**, so buy the domain
elsewhere; you can still point its DNS at Cloudflare for free.

**Choose the domain before go-live and never change it.** The installed counter
app, its service worker and all of its offline data belong to that exact
address. Move to a new domain later and the installed app and any unsynced
bills are left behind on the old one.

**The MCP server runs on the owner's laptop.** It talks to Claude over stdio,
so it lives on that machine. Asking the shop questions from his phone means
hosting it as a remote HTTP MCP server with proper sign-in — a separate piece of
work, and only worth doing once he is actually using it on the laptop.


### 2.1 Create the Supabase project

Region: **ap-south-1 (Mumbai)**. Lowest latency from Coimbatore, and it keeps
health-adjacent personal data inside India, which matters under the DPDP Act.

Start on the Free plan for development. **Move to Pro before go-live** — free
projects pause after a week of inactivity, and a paused project means the shop
cannot bill. At roughly ₹2,200/month, make the argument in the owner's terms:
it costs less than one month of the expiry write-offs this system prevents.

### 2.2 Apply the schema

```bash
npm install
supabase link --project-ref <your-ref>
supabase db push          # applies migrations 0001 through 0007
```

Load the sample data **into a dev project only**, never the shop's real one:

```bash
supabase db reset         # migrations + supabase/seed.sql
```

The seed gives you 20 real SKUs, 22 batches across every expiry bucket, 60 days
of sales, and logged stock-outs — enough that every report returns something you
can sanity-check before real money is involved.

### 2.3 Verify the safety rails yourself

Do not take the README's word for it. Run these against the dev project:

```sql
-- The ledger must explain every balance. Must return zero rows.
select * from rebuild_batch_quantities('<shop-id>');

-- The ledger is append-only. Both of these must ERROR.
update stock_ledger set delta = 999 where id = (select id from stock_ledger limit 1);
delete from stock_ledger where id = (select id from stock_ledger limit 1);

-- Bills are immutable. Must ERROR.
update sales set total = 1 where id = (select id from sales limit 1);
```

If any of those succeed, stop and find out why before going further.

### 2.4 Create the reporting password

Migration 0004 creates the read-only role deliberately without a password, so
no credential ever lands in git.

```sql
alter role snm_reporting password '<generate a long random one>';
```

---

## Phase 3 — Opening stock (the biggest adoption risk)

Three thousand SKUs typed by hand is two weeks of misery and the most common
point of failure. Use all three strategies together.

**1. Import, if anything exists.** If they run Marg or EasySol, export to CSV
and write a one-off import script. Two weeks saved in an afternoon. Always ask.

**2. Progressive onboarding — the main strategy.** Do not enter everything up
front. Enter the **top 300 fast movers** only. Everything else gets created the
first time it is purchased or sold, through a quick-add modal with four fields.
After three or four weeks the catalogue is effectively complete and nobody ever
had a data-entry marathon.

**3. One weekend stock-take, for A-class items only.** Two helpers, printed
count sheets, rack by rack. Only where accuracy actually matters.

For every item entered, the three fields people skip and then regret:
`units_per_strip` (loose sales break without it), `gst_rate` (5% for most
medicines, 18% for vitamins and supplements — it is data, not a constant), and
the supplier's `return_window_months`.

**Enter opening stock as ledger rows with `reason = 'opening_stock'`**, never by
writing `qty_available` directly. `supabase/seed.sql` shows the pattern. If you
set the column directly, the ledger no longer explains the balance and you have
broken the one invariant the whole design rests on.

---

## Phase 4 — Install on the shop PC (2 hours)

1. Deploy the POS to Cloudflare Pages (free tier, auto-deploy on push) on the shop's own domain. Not Vercel's free tier — its Hobby plan is non-commercial only. Settle the domain before this step: the installed app and its offline data belong to that exact address.
2. On the shop PC, open the site in Chrome → **⋮ → Cast, save and share →
   Install page as app**. It gets a desktop icon and its own window with no
   address bar. It looks like installed software and updates itself on every
   deploy.
3. Pin it to the taskbar; set it to launch on boot.
4. Set the thermal printer as the Windows default and print 20 test bills.
   Check the batch and expiry columns line up and the GST split is right.
5. Create the counter users with 4-digit PINs. Nobody types an email address at
   a busy counter.

**Roles matter here.** Counter staff get `counter_staff`, which cannot see
`purchase_rate` or margin — that is revoked at the database grant level, not
hidden in the UI. Only the owner gets `owner`.

---

## Phase 5 — The owner's phone (30 minutes)

**Dashboard:** open the site in Chrome or Safari → *Add to Home Screen*.
Full-screen icon, works offline, supports push. That is enough; skip the app
stores for now.

**The MCP server** lets him ask the shop questions in plain language instead of
hunting through a dashboard:

> *What's expiring next month and what's it worth?*
> *Which items did people ask for that we didn't have this week?*
> *How did Sunday compare to last Sunday?*
> *What should I order from Sakthi Pharma?*

Install it on **his** machine, never the counter PC — it holds credentials that
can see cost price and margin.

```bash
cp .env.example .env     # fill in the snm_reporting URL and the shop id
npm run mcp:smoke        # calls all 9 tools and prints the output
```

Then copy the block from `mcp/claude-desktop-config.example.json` into the
Claude desktop config and restart Claude.

Check the smoke-test output against the dashboard before trusting it. If
`expiry_ladder` and the dashboard disagree, find out why now.

---

## Phase 6 — The parallel run (2 weeks, do not shorten this)

The system runs **alongside the paper bill book**. Both get every sale.

**Every single evening:**
1. Total the paper bills for the day.
2. Run `sales_summary` for the same date.
3. They must match to the rupee. If they do not, find out why *that night* —
   a discrepancy you postpone is a discrepancy you will never explain.
4. Write down every complaint from the counter staff. Those complaints are your
   real bug list.

**Cut over only when the totals have matched for 14 consecutive days.**

Then keep the paper bill book for another 30 days. Nobody will need it, but its
presence on the counter is what lets an anxious owner say yes.

**Rollback plan, written down before you start:** if the system fails, staff go
back to paper immediately, and you reconcile afterwards from the ledger. Say
this out loud to the owner on day one. It is the difference between a partner
and a liability.

---

## Phase 7 — Training and handover

- **One hour, hands-on at the counter.** Not a slide deck.
- **Laminate a one-page cheat sheet** of keyboard shortcuts and tape it to the
  monitor: `F2` new bill, `F9` save and print, `2s` = two strips, `Esc` clear.
- **Record a 5-minute phone video in Tamil** of the billing flow. Staff will
  rewatch it; they will not reread a manual.
- **WhatsApp group** with you and the owner for the first month. Expect calls.
  This is also where your best feature ideas will come from.

**Teach three things explicitly, because they are the ones that cause support
calls:**
1. The sync pill. Green means synced, amber means pending, red means offline.
   Offline is fine — billing continues — but tell them what it means.
2. Expired stock cannot be sold and this is deliberate, not a bug.
3. H1 items need the doctor's and patient's details, and that is the law, not
   the software being difficult.

---

## Changing prices and product details

Teach the owner this in the handover hour; it is the question he will ask first.

**A new price from the distributor needs no edit.** Each delivery is entered as
a new batch with its own MRP and cost. FEFO sells the older stock at its old
price first, then moves on to the new batch. This is how the shop stays legal:
the MRP charged always matches the pack in the customer's hand.

**Editing is for corrections**: a typo at goods receipt, or a manufacturer's
announced MRP revision on stock already on the shelf. The owner opens
**Products & prices**, picks the product, and presses **Change price** on the
batch. He must give a reason. The screen refuses a cost above MRP, and warns on a
jump of more than 25%, which is usually a typo.

**Selling below MRP is a discount at the counter**, not a price edit. Charging
above the printed MRP is an offence, so the MRP field is never a pricing lever.

**Who can change what** is enforced by the database, not only the screen:

| | Owner | Pharmacist | Counter staff |
|---|---|---|---|
| MRP and cost price (`set_batch_price`) | Yes, with a reason | No | No |
| See cost price and margin | Yes | No | No |
| Name, GST rate, HSN, schedule, pack size | Yes | No | No |
| Rack, reorder level, fridge storage | Yes | Yes | No |
| Stock quantity | Only through the ledger: purchase, sale, return, count | same | same |

Three things that surprise people:
- **Old bills never change.** Every bill line stores the MRP, cost and GST rate
  it was sold at. Changing GST from 5% to 12% today leaves yesterday's invoices
  and yesterday's margin exactly as they were.
- **Pack size is locked while stock exists**, because stock is counted in
  tablets. Changing 15 per strip to 10 would silently turn 300 tablets into a
  different number of strips. Sell or count the stock to zero first, or create
  a new product for the new pack.
- **Products are discontinued, never deleted.** Bills and the ledger point at
  them.

Every change lands in the product's **History** with who, when and why. Only the
owner sees it, because it contains cost prices.

---

## Phase 8 — Backups (do this before go-live, not after)

Three copies, two media, one off-site:

1. Supabase daily automated backup (Pro plan, 7-day retention).
2. A nightly `pg_dump` via GitHub Actions cron → gzip → encrypt → Cloudflare R2
   or Google Drive. A second provider, so one account problem is not fatal.
3. A weekly CSV export to a USB drive the owner keeps in the shop.

**Then restore one.** Actually do it, into a scratch project, and write down how
long it took. An untested backup is not a backup — it is a hope.

---

## Ongoing — the weekly rhythm

| When | What | How |
|---|---|---|
| Daily, 9 PM | Six-number summary to the owner | Telegram bot — free, 20 lines of Python. WhatsApp Business API needs template approval and per-conversation billing; start with Telegram. |
| Weekly | **Return-to-distributor list** | `returnable_stock` → PDF → WhatsApp to each supplier. This is the report that recovers real money. |
| Weekly | Reorder suggestions | `reorder_suggestions`, filtered by supplier, one purchase order each. |
| Monthly | Expiry write-offs | Confirm and post, so the "money lost to expiry" figure stays honest. |
| Monthly | GSTR-1 and HSN summary | Hand to their CA. You do **not** need IRP e-invoicing — that applies above ₹5 crore turnover and only to B2B. |
| Quarterly | ABC-XYZ and a rack reorganisation | "These 40 items are 60% of your sales, put them within arm's reach." |

---

## Measure the before and after

Capture the Phase 0 baselines and re-measure at 3 months. These numbers are
what turn a college project into something you can put a figure against:

- Average billing time: _____ → _____
- Goods-receipt time per invoice: _____ → _____
- **Expiry write-off value per month: _____ → _____** (the headline)
- Stock-outs per week on A-class items: _____ → _____
- Value recovered through in-window distributor returns: ₹_____

---

## What will actually go wrong

Plan for these; they are not hypotheticals.

| Problem | What to do |
|---|---|
| Scanner reads nothing on most packs | Expected. Schedule H2 covers a growing but partial share of packs, with category-wide deadlines in July 2027 and 2028. The "teach me this code" flow is the answer — every unknown scan trains the system. |
| Staff quietly go back to paper | Billing is too slow. Watch them for an hour; do not ask them to try harder. Fix the screen. |
| Day-end totals do not match | Almost always round-off or a discount entered differently. Check `round_off` first. |
| Internet drops for hours | Billing continues offline. Watch the pending count; if it climbs past a few hundred, investigate before it becomes a sync storm. |
| Owner wants "just one more feature" mid-pilot | Write it down, do not build it. Finish the parallel run first. |
| Two counters double-sell the last strip | The ledger handles it — two rows, correct sum. The second sale fails cleanly with an insufficient-stock error rather than corrupting anything. |

---

## The order that matters

If you only get four things right, get these:

1. **Batch-level inventory**, never a single stock number per product.
2. **Billing under 30 seconds**, keyboard only.
3. **Works with the internet unplugged.**
4. **The return-window alert**, because it puts money back in the owner's pocket
   and that is what makes them keep using it.

Everything else is finishing work.
