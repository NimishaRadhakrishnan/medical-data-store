-- Sri Nachiya Medicals — core schema
-- Migration 0001: tables
--
-- Design rules enforced here:
--   1. Quantity lives on BATCHES, never on PRODUCTS.
--   2. Every quantity change is a row in STOCK_LEDGER (append-only).
--   3. batches.qty_available is a cached projection of the ledger (see 0002).
--   4. All base-unit quantities are integers (tablets, ml, pieces) — never floats.
--   5. All money is NUMERIC(12,2). Never float.

create extension if not exists "pgcrypto";
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------- shops/users

create table shops (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  address         text not null,
  city            text not null default 'Coimbatore',
  state_code      text not null default '33',          -- TN, for CGST/SGST vs IGST
  gstin           text,
  dl_number_20b   text,                                -- retail drug licence
  dl_number_21b   text,
  pharmacist_name text,
  phone           text,
  created_at      timestamptz not null default now()
);

create type user_role as enum ('owner', 'pharmacist', 'counter_staff');

create table users (
  id          uuid primary key references auth.users(id) on delete cascade,
  shop_id     uuid not null references shops(id) on delete cascade,
  full_name   text not null,
  role        user_role not null default 'counter_staff',
  pin_hash    text,                                    -- 4-digit counter PIN (bcrypt)
  max_discount_pct numeric(5,2) not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);
create index on users (shop_id);

-- ---------------------------------------------------------------- catalogue

create type pack_form as enum
  ('tablet','capsule','syrup','injection','cream','ointment','gel','drops','inhaler','device','other');

-- Drug schedule drives legal controls at the billing screen.
create type drug_schedule as enum ('OTC','G','H','H1','X');

create table products (
  id              uuid primary key default gen_random_uuid(),
  shop_id         uuid not null references shops(id) on delete cascade,

  name            text not null,                       -- brand name, e.g. 'Dolo 650'
  generic_name    text,                                -- 'Paracetamol'
  composition_key text,                                -- normalised, for substitute search
  strength        text,                                -- '650 mg'
  manufacturer    text,

  pack_form       pack_form not null default 'tablet',
  base_unit       text not null default 'tablet',      -- smallest sellable unit
  units_per_strip integer not null default 1 check (units_per_strip > 0),
  strips_per_box  integer not null default 1 check (strips_per_box  > 0),

  hsn_code        text,
  gst_rate        numeric(5,2) not null default 5.00,  -- DATA, not a constant. Rates change.
  drug_schedule   drug_schedule not null default 'OTC',

  is_refrigerated boolean not null default false,
  rack_location   text,

  reorder_point   integer not null default 0,          -- base units; refreshed by the reorder job
  reorder_qty     integer not null default 0,

  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index on products (shop_id, is_active);
create index on products (shop_id, composition_key);
-- fast type-ahead on the billing screen
create index products_name_trgm on products using gin (name gin_trgm_ops);

-- One product can carry many codes: EAN-13 on the strip, GS1 DataMatrix on the box.
create table product_barcodes (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references shops(id) on delete cascade,
  product_id  uuid not null references products(id) on delete cascade,
  code        text not null,
  code_type   text not null default 'EAN13',           -- EAN13 | CODE128 | GS1_DM | QR
  pack_level  text not null default 'strip',           -- base | strip | box
  learned_by  uuid references users(id),               -- who taught the system this code
  created_at  timestamptz not null default now(),
  unique (shop_id, code, pack_level)
);
create index on product_barcodes (shop_id, code);

-- ---------------------------------------------------------------- suppliers

create table suppliers (
  id                   uuid primary key default gen_random_uuid(),
  shop_id              uuid not null references shops(id) on delete cascade,
  name                 text not null,
  gstin                text,
  dl_number            text,
  phone                text,
  lead_time_days       integer not null default 3,     -- feeds the reorder point
  return_window_months integer not null default 3,     -- expiry returns accepted before this
  is_active            boolean not null default true,
  created_at           timestamptz not null default now()
);
create index on suppliers (shop_id);

-- ---------------------------------------------------------------- batches

create table batches (
  id             uuid primary key default gen_random_uuid(),
  shop_id        uuid not null references shops(id) on delete cascade,
  product_id     uuid not null references products(id) on delete cascade,

  batch_no       text not null,
  -- Packs print MM/YYYY. Store the LAST DAY of that month; always display MM/YYYY.
  expiry_date    date not null,
  mfg_date       date,

  mrp            numeric(12,2) not null check (mrp >= 0),          -- per STRIP (or per pack)
  purchase_rate  numeric(12,2) not null default 0,                 -- PTR, per strip. Staff must not see this.

  qty_available  integer not null default 0,           -- CACHED projection of stock_ledger
  supplier_id    uuid references suppliers(id),

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (product_id, batch_no, expiry_date)
);
create index on batches (shop_id, product_id, expiry_date);
-- the FEFO lookup: nearest expiry with stock
create index batches_fefo on batches (product_id, expiry_date) where qty_available > 0;
-- the expiry ladder report
create index batches_expiry on batches (shop_id, expiry_date) where qty_available > 0;

-- ---------------------------------------------------------------- the ledger

create type ledger_reason as enum (
  'purchase', 'sale', 'sale_return', 'purchase_return',
  'expiry_writeoff', 'damage', 'adjustment', 'opening_stock'
);

-- APPEND-ONLY. Never UPDATE, never DELETE. This is the audit spine and the
-- reason offline sync has almost no conflicts: two devices selling the last
-- strip produce two rows, and the sum is still correct.
create table stock_ledger (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references shops(id) on delete cascade,
  product_id  uuid not null references products(id),
  batch_id    uuid not null references batches(id),

  delta       integer not null check (delta <> 0),     -- base units, signed
  reason      ledger_reason not null,

  ref_type    text,                                     -- 'sale' | 'purchase' | ...
  ref_id      uuid,
  note        text,

  device_id   text,
  user_id     uuid references users(id),
  created_at  timestamptz not null default now(),
  client_created_at timestamptz                         -- display only; never trust shop clocks
);
create index on stock_ledger (shop_id, created_at desc);
create index on stock_ledger (batch_id);
create index on stock_ledger (product_id, created_at desc);

-- ---------------------------------------------------------------- purchases

create table purchases (
  id             uuid primary key default gen_random_uuid(),
  shop_id        uuid not null references shops(id) on delete cascade,
  supplier_id    uuid not null references suppliers(id),
  invoice_no     text not null,
  invoice_date   date not null,
  source         text not null default 'manual',       -- manual | scan | ocr
  invoice_image  text,                                  -- storage path
  ocr_confidence numeric(5,2),
  subtotal       numeric(12,2) not null default 0,
  gst_amount     numeric(12,2) not null default 0,
  total          numeric(12,2) not null default 0,
  status         text not null default 'draft',        -- draft | confirmed
  confirmed_by   uuid references users(id),
  confirmed_at   timestamptz,
  created_at     timestamptz not null default now(),
  unique (shop_id, supplier_id, invoice_no)
);
create index on purchases (shop_id, invoice_date desc);

create table purchase_items (
  id            uuid primary key default gen_random_uuid(),
  purchase_id   uuid not null references purchases(id) on delete cascade,
  product_id    uuid not null references products(id),
  batch_id      uuid references batches(id),
  batch_no      text not null,
  expiry_date   date not null,
  qty_strips    integer not null check (qty_strips > 0),
  free_strips   integer not null default 0,            -- the scheme quantity; affects real cost
  purchase_rate numeric(12,2) not null,
  mrp           numeric(12,2) not null,
  gst_rate      numeric(5,2) not null,
  line_total    numeric(12,2) not null
);
create index on purchase_items (purchase_id);

-- ---------------------------------------------------------------- sales

create type payment_mode as enum ('cash','upi','card','credit','split');

create table sales (
  id             uuid primary key default gen_random_uuid(),   -- client-generated; makes push idempotent
  shop_id        uuid not null references shops(id) on delete cascade,
  bill_no        text not null,                        -- device-prefixed: SNM-C1-000123
  device_id      text not null,
  customer_id    uuid,
  user_id        uuid references users(id),

  -- Schedule H1 requires these. Enforced in 0002.
  prescriber_name    text,
  prescriber_address text,
  patient_name       text,
  patient_address    text,
  rx_image           text,

  subtotal       numeric(12,2) not null default 0,
  discount       numeric(12,2) not null default 0,
  cgst           numeric(12,2) not null default 0,
  sgst           numeric(12,2) not null default 0,
  round_off      numeric(12,2) not null default 0,
  total          numeric(12,2) not null default 0,

  payment_mode   payment_mode not null default 'cash',
  cash_amount    numeric(12,2) not null default 0,
  upi_amount     numeric(12,2) not null default 0,

  is_cancelled   boolean not null default false,       -- bills are immutable; cancel, never edit
  created_at     timestamptz not null default now(),
  client_created_at timestamptz,
  unique (shop_id, bill_no)
);
create index on sales (shop_id, created_at desc);
create index on sales (customer_id);

create table sale_items (
  id            uuid primary key default gen_random_uuid(),
  sale_id       uuid not null references sales(id) on delete cascade,
  product_id    uuid not null references products(id),
  batch_id      uuid not null references batches(id),

  qty_base      integer not null check (qty_base > 0), -- base units (tablets), always
  mrp           numeric(12,2) not null,                -- per strip, snapshot at sale time
  unit_price    numeric(12,2) not null,                -- per base unit
  purchase_rate numeric(12,2) not null,                -- snapshot: lets margin survive price changes
  discount_pct  numeric(5,2) not null default 0,
  gst_rate      numeric(5,2) not null,
  taxable_value numeric(12,2) not null,
  gst_amount    numeric(12,2) not null,
  line_total    numeric(12,2) not null
);
create index on sale_items (sale_id);
create index on sale_items (product_id);
create index on sale_items (batch_id);

-- ---------------------------------------------------------------- customers

create table customers (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references shops(id) on delete cascade,
  name         text not null,
  phone        text,
  address      text,
  -- DPDP Act 2023: purchase history is health-adjacent. Opt-in, not default.
  consent_marketing boolean not null default false,
  consent_at   timestamptz,
  is_chronic   boolean not null default false,         -- drives refill reminders
  is_anonymised boolean not null default false,        -- erasure keeps the financial rows
  created_at   timestamptz not null default now()
);
create index on customers (shop_id, phone);

create table credit_ledger (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references shops(id) on delete cascade,
  customer_id uuid not null references customers(id),
  sale_id     uuid references sales(id),
  amount      numeric(12,2) not null,                  -- +ve = owed to shop, -ve = payment
  note        text,
  created_at  timestamptz not null default now()
);
create index on credit_ledger (shop_id, customer_id);

-- ---------------------------------------------------------------- the stock-out log
--
-- The single best reorder signal there is, and almost no commercial pharmacy
-- software captures it: what customers asked for and we did not have.

create table stockout_log (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references shops(id) on delete cascade,
  search_term  text not null,
  product_id   uuid references products(id),           -- null = we don't even stock it
  user_id      uuid references users(id),
  created_at   timestamptz not null default now()
);
create index on stockout_log (shop_id, created_at desc);

-- ---------------------------------------------------------------- audit

create table audit_log (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references shops(id) on delete cascade,
  user_id     uuid references users(id),
  action      text not null,
  entity      text,
  entity_id   uuid,
  detail      jsonb,
  device_id   text,
  created_at  timestamptz not null default now()
);
create index on audit_log (shop_id, created_at desc);

create table settings (
  shop_id    uuid primary key references shops(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
