# Sales summaries: daily and monthly

What the owner of Sri Nachiya Medicals receives every evening and on the first
of every month, what each number means, and the order to build it in.

**Built so far**
- Phase 1, the three fixes: migration `0007_sales_summaries.sql`
- `daily_summary()` and `monthly_summary()` in the database, with 12 tests in
  `tests/db/summaries.test.sql` (run `npm run test:db`), including a check that
  the days of a month add up exactly to the month
- The **Sales** screen in the prototype, with **Day** and **Month** views

**Still to build:** the 9 PM phone notification, the monthly PDF and CA
spreadsheet, and the phone version of the Sales screen.

Two readers:
- **The owner**, who wants to know in ten seconds whether today was a good day,
  and once a month where the money went.
- **The shop's CA**, who needs the monthly GST figures in a form that drops
  straight into the return.

---

## First: three things that make today's numbers wrong

Found by reading the current reporting views. Fix these before any summary
goes out; a summary the owner learns not to trust is worse than none.

**1. Bills are dated by when they reached the server, not when they were sold.**
Every view uses `created_at`, which the server sets on arrival. A bill made
offline at 8:55 PM Monday that syncs at 10 AM Tuesday counts as Tuesday. The
totals go wrong exactly on the days the internet was down, which are the days
the owner is most likely to check them.

**2. Returns have no money record.** `sale_return` exists only as a stock
movement in the ledger. There is no table holding the refund amount, so net
sales cannot subtract returns.

**3. Margin is overstated by about 5 points.** The views compute
`line_total − cost`. `line_total` includes the GST the shop collects and pays
over to the government, while cost price (PTR) excludes GST. At 5% GST that
inflates margin by about 4.8% of sales: a shop shown 24% is really making about
19%. The correct figure is `taxable_value − cost`, and `sale_items` already
stores `taxable_value`. The price editor's margin column has the same error.

---

## What the owner gets

### Every evening, 9:00 PM: one message

Sent to the owner's phone. The figures below are an example of the format, not
real data.

```
Sri Nachiya Medicals · Tue 22 Sep

Sales       ₹28,450   ▲ 12% on last Tuesday
Margin      ₹5,470    19.2%
Bills       142       average ₹200
Cash ₹16,200 · UPI ₹11,050 · Credit ₹1,200

Returns     ₹310  (2 bills)
Discounts   ₹540

Needs attention
• Expiring in 30 days: ₹4,120 at cost
• Send back to distributors this week: ₹9,870  (Sakthi, Kovai)
• Asked for, not in stock: Azithral 500 ×3, Zincovit ×2, Dettol 500 ml

Top sellers: Glycomet GP 1, Pan 40, Dolo 650
Cash to hand over at close: ₹16,200
```

Why each line is there:

| Line | Exact rule | Why the owner cares |
|---|---|---|
| Sales | Sum of bill totals for the business day, cancelled bills excluded, minus refunds issued that day. GST-inclusive: what customers actually paid. | The headline. Compared with the **same weekday last week**, because a pharmacy's Sunday is nothing like its Wednesday. |
| Margin | `taxable_value − cost snapshot` for every line. Both exclude GST. | The number that pays the rent. Cost comes from the snapshot on the bill line, so a later price edit cannot rewrite it. |
| Bills, average | Count of non-cancelled bills; sales ÷ bills. | A falling average bill with steady footfall means customers buying less per visit. |
| Payment split | Cash, UPI, card, credit (khata). | Cash is the figure to count the drawer against. |
| Returns | Refunds issued today, with bill count. | Rising returns point to a counter or stock problem. |
| Discounts | Total discount given today. | Margin usually leaks through discounts, not theft. |
| Expiring in 30 days | Stock value at cost in batches expiring within 30 days. | Too late to return; push these now. |
| Send back this week | Value still inside each distributor's return window. | The line that recovers real money. |
| Asked for, not in stock | Today's stock-out log, most-asked first. | Demand the sales figures cannot see. |
| Top sellers | Top three by revenue today. | A quick sense check. |

**The message goes to the owner only.** It contains margin, which counter staff
are not allowed to see. No patient or customer name appears in it, ever.

**Late bills are restated, never slipped in silently.** If an offline bill for
Monday arrives on Tuesday, Tuesday's message opens with:

```
Monday restated: ₹28,450 → ₹29,120  (3 bills synced late)
```

### During the day: the owner's dashboard

The same numbers, live, on the phone app: today so far, an hourly sales strip
(shows when the counter needs a second person), and a tap through to any
figure's detail. The evening message is a summary of this screen, never a
different calculation.

### At closing: the day-end close at the counter

Two minutes before the shutter goes down:

1. The app shows the cash the drawer should hold.
2. Staff count it and type the actual amount.
3. Any difference is saved with the counter person's name and a note.

Small daily differences caught the same evening stay small. The evening message
reports the variance if there is one.

### On the 1st of every month, 9:00 AM: the monthly report

A PDF to the owner, and a spreadsheet for the CA.

**1. The month in one view**
Net sales, margin in ₹ and %, bills, average bill. Compared with last month and
with the same month last year, which matters in a pharmacy because fever, cold
and allergy lines move with the season.

**2. Day by day**
Daily sales across the month as a chart, the best and worst days, and the
weekday pattern.

**3. What sold**
Top 20 products by revenue and, separately, by margin; the two lists are rarely
the same. Sales mix by category. ABC classes recalculated, with anything that
changed class flagged.

**4. Where money leaked**
- Discounts by staff member
- Returns
- Expiry write-offs in ₹: the number this whole system exists to shrink
- Stock-outs: count and the most-asked missing items
- Stock differences from offline sales (`stock_discrepancies`)

**5. Stock health**
Stock value at cost on the first and last day of the month, worked out from
the ledger as of each date. Dead stock in ₹. Days of inventory on hand.

**6. Purchases**
Total by distributor, and every product whose cost price went up this month.

**7. Credit (khata)**
Outstanding at month end, by age: under 30 days, 30–60, over 60.

**8. For the CA: the GST pack**
- Taxable value, CGST and SGST by rate (0%, 5%, 12%, 18%)
- HSN summary for GSTR-1 Table 12, split into its B2B and B2C tabs. The split
  applies from 2025. For a business with turnover up to ₹5 crore, B2B needs
  4-digit HSN; the B2C tab is optional under a CBIC clarification of June 2025.
  Generate both anyway, since it costs nothing, and let the CA decide.
- Credit notes issued (returns)
- Documents issued for Table 13: first and last bill number per counter, and
  cancelled bills

Deliver as Excel for the CA and PDF for the owner. The shop files monthly or
quarterly depending on its scheme; the pack works for either.

**9. Schedule H1 register for the month**
A PDF of every H1 supply: date, patient, prescriber, drug, quantity. It is
legally required, kept three years, and only the owner can open it.

---

## Build order

Each phase ends with something the owner can use, and a check that proves the
numbers.

### Phase 1: make the numbers right (3–4 days)

1. **Store the business date on every bill.**
   New column `sales.business_date`, set once when the bill is saved:
   - Use the IST date of when the bill was actually made on the counter
     (`client_created_at`).
   - Fall back to server time when the counter's clock is clearly wrong: more
     than 5 minutes in the future, or more than 7 days in the past. Flag those
     bills for the owner to look at.
   - Add `synced_at`, so late bills can be found and restated.

   Stored rather than recomputed, so every report agrees, and indexed, because
   every report filters on it.
2. **Record returns as money.**
   New tables `sale_returns` and `sale_return_items`: a credit note linked to
   the original bill, with its own number series. The `sale_return` ledger rows
   point at it.
3. **Compute margin on taxable value.**
   Fix `v_daily_sales`, `v_rep_daily`, `v_rep_product_sales` and the price
   editor to use `taxable_value − cost`.
4. **Allow a buyer's GSTIN on a bill**, for clinics and nursing homes that buy
   with one. Without it, Table 12's B2B tab cannot be produced.

**Done when these tests pass:**
- A bill made offline at 8:55 PM Monday and synced Tuesday counts on Monday.
- A return lowers that day's net sales by exactly the refund.
- Margin equals taxable value minus cost, line by line.
- The daily summaries for a month add up exactly to the monthly summary.

### Phase 2: the evening message (3 days)

- One database function, `daily_summary(shop, date)`, returning every figure
  above. The message, the dashboard and the owner's MCP server all call it. No
  screen does its own sums, which is what stops two screens showing two totals.
- The day-end close screen at the counter.
- The message itself: a Telegram bot, which is free and about 20 lines. Supabase
  `pg_cron` fires it at **15:30 UTC, which is 9:00 PM IST**; the cron schedule
  runs in UTC. WhatsApp only if the owner insists, since it needs approved
  templates and is charged per conversation.
- The restatement line for late bills.
- Point the existing `sales_summary` MCP tool at `daily_summary`.

**Done when:** during the parallel run, the paper bill book's total and the
message's total match every evening.

### Phase 3: the owner's dashboard (4–5 days)

Today (live), the last 30 days, and this month, on the phone app, each figure
opening to its detail. The hourly strip and the 30-day trend chart. Owner login
only.

**Done when:** the owner checks the day from the dashboard instead of phoning
the shop.

### Phase 4: the monthly report (5 days)

- `monthly_summary(shop, month)`, built on the same daily figures.
- Stock value as of any date, from the ledger.
- PDF for the owner and Excel for the CA, sent on the 1st at 03:30 UTC (9:00 AM
  IST).
- The GST pack and the H1 register.
- A `monthly_summary` MCP tool, so the owner can ask "how did August compare
  with July?"

**Done when:** the CA files one month's GSTR-1 from the GST pack without
correcting it.

### Phase 5: noticing things (after 3 months of real data)

- Alerts when something is off:
  - sales more than 25% below the average of the last four same weekdays
  - one staff member's discounts climbing
  - a product's margin dropping because its cost price rose
- Demand forecasts (build plan, section N).
- A written explanation of the month. The owner asks Claude "why was August
  down?" and it answers from the MCP tools: which products, which days, which
  customers moved.

### Timeline

| Week | Phase | The owner sees |
|---|---|---|
| 1 | Correct numbers | Nothing new; every figure after this is right |
| 2 | Evening message | A 9 PM message, checked against paper every night |
| 3 | Dashboard | Today's sales on his phone, live |
| 4–5 | Monthly report | The first monthly PDF, and a GST pack for the CA |
| after 3 months | Alerts, forecasts | A message only when something needs him |

---

## Rules that keep the numbers trustworthy

- **One calculation.** Every surface reads `daily_summary` or `monthly_summary`.
- **Days and months are in IST**, by business date.
- **Sales include GST; margin excludes it.** Every figure says which.
- **Cancelled bills are left out, and listed separately**, so nothing
  disappears.
- **Days add up to the month**, and a test proves it.
- **Late bills restate the day they belong to**, and say so.
- **Cost and margin go to the owner only.** No customer or patient name appears
  in any summary; the H1 register is the one place those details live.
