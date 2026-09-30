# Sri Nachiya Medicals

Billing and stock for a retail pharmacy in Coimbatore, run by one person: the
owner bills, takes deliveries and sets prices himself.

**The shop runs with no internet at all.** The whole application lives on the
shop's computer — its own database file, its own local server, its own screens.
Start it with `apps/shop/start.bat`, open `http://localhost:8123`, and unplug
the network: billing, stock, printing, reports and Excel exports all keep
working.

    cd apps/shop && npm start          # then open http://localhost:8123

Read `docs/offline-setup.md` to put it on the shop's PC, and
`docs/one-person-shop.md` for how the screens were made for someone with no
computer training.

    apps/shop/                                  THE APPLICATION — runs offline on the shop's PC
      server.js  db.js  logic.js  xlsx.js       local server, SQLite, the shop's rules, Excel writer
      schema.sql                                tables, and the rules the database itself enforces
      public/                                   the screens: Bill, Add stock, Medicines, Reports, Settings
      start.bat / start.sh                      what the owner double-clicks
    apps/pos/index.html                         the earlier design prototype (demo data, no database)
    supabase/migrations/0001_schema.sql          tables
    supabase/migrations/0002_triggers_views.sql  ledger integrity, H1 block, analytics views
    supabase/migrations/0003_rls.sql             row level security, cost-price hiding
    supabase/migrations/0004_reporting_role.sql  read-only role + views for the MCP server
    supabase/migrations/0005_offline_sales.sql   accept offline sales, record discrepancies
    supabase/migrations/0006_owner_edits.sql     who may change prices and products; history
    supabase/migrations/0007_sales_summaries.sql correct sales figures; daily and monthly summaries
    lib/gs1.ts                                   GS1 barcode parser
    lib/pharmacy.ts                              quantity, GST, FEFO, reorder, ABC
    mcp/server.ts                                owner reporting MCP server (read-only)
    supabase/seed.sql                            20 SKUs + 60 days of sales for testing
    tests/app/*.test.js                          51 tests of the offline app (npm run test:app)
    tests/pharmacy.test.ts                       32 tests of the money and stock rules
    tests/db/summaries.test.sql                  12 tests of the optional cloud database
    docs/build-plan.md                           the full A-Z plan
    docs/implementation.md                       deploying into the actual shop
    docs/sales-summary-roadmap.md                daily and monthly sales summaries: what and in what order
    docs/one-person-shop.md                      what the owner does, never does, and what you set up once
    docs/offline-setup.md                        putting it on the shop's computer, backups, what-if

## Quick start

    npm install
    npm test                  # 32 tests, no database needed
    npm run pos               # counter prototype at http://localhost:5173

## The cloud half, which is now optional

`supabase/`, `mcp/` and `lib/` are the earlier cloud design: the same rules in
Postgres, plus a read-only server that let the owner ask Claude about the shop.
None of it is needed to run the shop, and nothing in `apps/shop` talks to it.
Keep it if the owner ever wants his figures on his phone; ignore it otherwise.

## Set up the cloud database (optional)

Create the Supabase project in **ap-south-1 (Mumbai)** — lowest latency from
Coimbatore, and it keeps health-adjacent personal data in India.

    supabase link --project-ref <ref>
    supabase db push          # migrations 0001-0007
    supabase db reset         # DEV ONLY: migrations + seed data

Then set a password for the read-only reporting role:

    alter role snm_reporting password '<generated>';

## The owner's MCP server

Lets the owner ask the shop questions from the Claude app instead of hunting
through a dashboard:

> What's expiring next month and what's it worth?
> Which items did people ask for that we didn't have this week?
> How did Sunday compare to last Sunday?
> What should I order from Sakthi Pharma?

Nine tools: `sales_summary`, `top_products`, `expiry_ladder`, `returnable_stock`,
`dead_stock`, `stock_on_hand`, `stockouts`, `reorder_suggestions`, `list_suppliers`.

    cp .env.example .env       # fill in the snm_reporting URL and shop id
    npm run mcp:smoke          # starts the server, lists the tools
    # then copy mcp/claude-desktop-config.example.json into your Claude config

### Why it is built the way it is

- **Read-only at three layers.** The role has `SELECT` on views only and
  `default_transaction_read_only`; the pool sets the session read-only again;
  and `mcp/db.ts` refuses to start if the connection username is anything but
  `snm_reporting`. An agent cannot write a stock ledger row.
- **No `run_sql` tool.** Free-form SQL is an injection surface wearing a helpful
  hat. Every tool takes typed parameters and runs a fixed, parameterised
  statement. The two enum arguments are validated by zod and mapped through a
  lookup, never interpolated.
- **No PII reachable.** No view exposes a customer name, phone, prescriber or
  patient. Bill-level rows are not granted to the role at all.
- **Owner device only.** This server holds credentials that can see cost price
  and margin, which is the point of it — so it must never be installed on the
  counter PC.

## The rules this code enforces

1. Quantity lives on batches, never on products. A pharmacy stocks the same
   medicine in several batches with different expiry dates and often different
   MRPs; a single stock integer cannot represent that, and the bill is legally
   required to print batch and expiry.
2. Every quantity change is an append-only `stock_ledger` row.
   `batches.qty_available` is a cached projection of it, maintained by trigger.
   `UPDATE` and `DELETE` on the ledger raise; corrections are compensating rows.
   `rebuild_batch_quantities()` recomputes balances from the ledger when they drift.
   This is also why offline sync has almost no conflicts: two terminals selling
   the last strip produce two rows, and the sum is still right.
3. MRP is tax-inclusive. GST is divided out, never added on top. Getting this
   backwards inflates every bill by the GST rate.
4. Expired stock is never sellable, and a Schedule H1 line cannot be saved
   without prescriber and patient details — the register must be kept three
   years. Both enforced in Postgres, not in the UI, because an offline PWA, a
   second counter terminal and an import script all have to obey them.

## Verified

Migrations and seed applied to a clean Postgres 16, and all nine MCP tools
called against the seeded data:

- ledger sum equals `qty_available` for every batch; `rebuild_batch_quantities`
  reports zero drift
- `UPDATE`/`DELETE` on `stock_ledger` and `UPDATE` on `sales` both raise
- a Schedule H1 line without prescriber and patient details is refused
- an online sale that would take stock negative is refused; the same sale
  arriving from the offline queue is accepted and logged in
  `stock_discrepancies` for the owner to resolve with a count
- logged in as counter staff: cannot change MRP, cost, GST or stock, and cannot
  see cost price; the pharmacist can change rack and reorder levels only; the
  owner changes prices through `set_batch_price()`, which needs a reason,
  refuses a cost above MRP, and records every change
- the `snm_reporting` role cannot write, and cannot read `customers`, `sales`
  or `batches.purchase_rate` at all

- a bill made offline at 8:55 PM counts on the day it was made, not the day it
  synced; a ₹50 return lowers that day's sales by exactly ₹50; profit leaves GST
  out; and the days of a month add up to the month to the paisa

Re-check any time with `npm test`, `npm run test:db` and `npm run mcp:smoke`.

## Next

Deploying into the shop: `docs/implementation.md`.
Week 3-4 of `docs/build-plan.md`: port `apps/pos/index.html` to React + Dexie
against this schema, then the offline sync engine in week 8.
