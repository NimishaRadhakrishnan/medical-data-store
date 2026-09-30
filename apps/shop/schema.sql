-- Sri Nachiya Medicals — the shop's own database, on the shop's own computer.
--
-- SQLite, through Node's built-in driver, so the PC needs nothing installed but
-- Node itself: no server to run, no build tools, no internet, ever.
--
-- Carried over from the Postgres design, because these rules are what keep the
-- books honest:
--   * quantity lives on BATCHES, never on a medicine
--   * every quantity change is an append-only row in STOCK_LEDGER, and
--     batches.qty is its running total, maintained by trigger
--   * expired stock can never be sold
--   * a Schedule H1 line needs the doctor and patient recorded
--   * bills and credit notes are never edited, only cancelled or reversed
--
-- Money is INTEGER PAISE everywhere. SQLite has no decimal type, and floating
-- point rupees would drift by a paisa a day until the till stopped balancing.
-- Quantities are integers in the smallest unit sold (tablets, capsules, bottles).
-- Dates are TEXT 'YYYY-MM-DD' in the shop's own local time; timestamps are ISO.

pragma journal_mode = wal;        -- survives a power cut mid-write
pragma foreign_keys = on;
pragma synchronous = full;        -- a committed bill is on the disk platter

-- ------------------------------------------------------------ the shop

create table if not exists shop_settings (
  id              integer primary key check (id = 1),
  name            text not null,
  address1        text not null,
  address2        text not null,
  phone           text,
  gstin           text,           -- filled in at setup from the certificates
  dl_20b          text,
  dl_21b          text,
  pharmacist      text,
  state_code      text not null default '33',
  bill_prefix     text not null default 'SNM',
  round_off       integer not null default 1,     -- round the bill to whole rupees
  updated_at      text not null default (datetime('now', 'localtime'))
);

-- ------------------------------------------------------------ catalogue

create table if not exists products (
  id              integer primary key autoincrement,
  name            text not null,
  generic_name    text,
  composition_key text,                            -- same key = same medicine, for substitutes
  manufacturer    text,
  base_unit       text not null default 'tablet',  -- tablet | capsule | bottle | piece
  units_per_strip integer not null default 1 check (units_per_strip >= 1),
  strips_per_box  integer not null default 1 check (strips_per_box >= 1),
  hsn_code        text default '3004',
  gst_rate        integer not null default 5 check (gst_rate between 0 and 40),
  drug_schedule   text not null default 'OTC' check (drug_schedule in ('OTC','G','H','H1','X')),
  rack            text,
  reorder_packs   integer not null default 0,      -- warn below this many strips/bottles
  cold_storage    integer not null default 0,
  is_active       integer not null default 1,      -- archived instead of deleted
  archived_at     text,
  created_at      text not null default (datetime('now', 'localtime')),
  updated_at      text not null default (datetime('now', 'localtime'))
);
create index if not exists products_name on products (name);
create index if not exists products_active on products (is_active);

create table if not exists product_codes (
  id          integer primary key autoincrement,
  product_id  integer not null references products(id),
  code        text not null unique,                -- barcode or the GTIN from a QR code
  learned_at  text not null default (datetime('now', 'localtime'))
);

create table if not exists suppliers (
  id              integer primary key autoincrement,
  name            text not null unique,
  phone           text,
  gstin           text,
  lead_days       integer not null default 3,
  return_months   integer not null default 3,      -- how long before expiry they take stock back
  is_active       integer not null default 1
);

-- ------------------------------------------------------------ stock

create table if not exists batches (
  id            integer primary key autoincrement,
  product_id    integer not null references products(id),
  batch_no      text not null,
  expiry        text not null,                     -- 'YYYY-MM-DD', the last day of the printed month
  mrp_paise     integer not null check (mrp_paise > 0),      -- per strip / bottle
  cost_paise    integer not null check (cost_paise >= 0),    -- per strip / bottle, before GST
  qty           integer not null default 0,        -- base units; only the ledger moves this
  supplier_id   integer references suppliers(id),
  created_at    text not null default (datetime('now', 'localtime')),
  updated_at    text not null default (datetime('now', 'localtime')),
  unique (product_id, batch_no, expiry)
);
create index if not exists batches_fefo on batches (product_id, expiry);
create index if not exists batches_expiry on batches (expiry);

-- Append-only. Every unit in the shop is explained by a row here.
create table if not exists stock_ledger (
  id          integer primary key autoincrement,
  product_id  integer not null references products(id),
  batch_id    integer not null references batches(id),
  delta       integer not null check (delta <> 0),   -- base units, signed
  reason      text not null check (reason in
                ('opening','purchase','sale','sale_return','purchase_return','expiry','damage','adjustment','cancel')),
  ref_type    text,
  ref_id      integer,
  note        text,
  created_at  text not null default (datetime('now', 'localtime'))
);
create index if not exists ledger_batch on stock_ledger (batch_id);
create index if not exists ledger_date on stock_ledger (created_at);

-- ------------------------------------------------------------ buying

create table if not exists purchases (
  id            integer primary key autoincrement,
  supplier_id   integer not null references suppliers(id),
  invoice_no    text,
  invoice_date  text,
  business_date text not null,
  -- The discount the whole invoice was given, in hundredths of a percent.
  discount_bp   integer not null default 0,
  total_paise   integer not null default 0,
  created_at    text not null default (datetime('now', 'localtime'))
);

create table if not exists purchase_items (
  id           integer primary key autoincrement,
  purchase_id  integer not null references purchases(id) on delete cascade,
  product_id   integer not null references products(id),
  batch_id     integer not null references batches(id),
  packs        integer not null check (packs > 0),
  free_packs   integer not null default 0,
  mrp_paise    integer not null,
  -- The distributor's "Trade Price", exactly as printed on the invoice.
  list_cost_paise integer,
  -- The invoice's "Dis %" column, in hundredths of a percent (4% -> 400), so
  -- the figures stay whole numbers.
  discount_bp  integer not null default 0,
  -- What the stock actually cost after that discount, before GST. This is the
  -- figure every margin is worked out from.
  cost_paise   integer not null,
  line_paise   integer not null
);

-- ------------------------------------------------------------ selling

create table if not exists sales (
  id             integer primary key autoincrement,
  bill_no        text not null unique,
  client_uuid    text unique,                 -- the till's own id: stops a double-click making two bills
  business_date  text not null,               -- 'YYYY-MM-DD' local, the day it was sold
  created_at     text not null default (datetime('now', 'localtime')),

  customer_name  text,
  customer_phone text,
  buyer_gstin    text,                        -- a clinic buying with a GSTIN makes this a B2B bill
  doctor_name    text,                        -- Schedule H1
  patient_name   text,
  patient_address text,

  taxable_paise  integer not null default 0,
  gst_paise      integer not null default 0,
  discount_paise integer not null default 0,
  round_paise    integer not null default 0,
  total_paise    integer not null default 0,

  pay_mode       text not null default 'cash' check (pay_mode in ('cash','upi','card','credit')),
  is_cancelled   integer not null default 0,
  cancelled_at   text,
  cancel_reason  text
);
create index if not exists sales_date on sales (business_date);

create table if not exists sale_items (
  id            integer primary key autoincrement,
  sale_id       integer not null references sales(id),
  product_id    integer not null references products(id),
  batch_id      integer not null references batches(id),
  qty           integer not null check (qty > 0),      -- base units
  -- Snapshots: a price change tomorrow can never rewrite this bill.
  mrp_paise     integer not null,
  cost_paise    integer not null,              -- per pack, as the batch stood
  -- What this quantity actually cost, worked out when the bill was made.
  -- Reports use this and never divide by the product's pack size again: that
  -- size can be corrected later, and a closed day must not change afterwards.
  cost_total_paise integer,
  gst_rate      integer not null,
  gross_paise   integer not null,
  taxable_paise integer not null,
  gst_paise     integer not null
);
create index if not exists sale_items_sale on sale_items (sale_id);
create index if not exists sale_items_product on sale_items (product_id);

-- ------------------------------------------------------------ returns (credit notes)

create table if not exists sale_returns (
  id            integer primary key autoincrement,
  return_no     text not null unique,
  sale_id       integer not null references sales(id),
  business_date text not null,
  refund_mode   text not null default 'cash' check (refund_mode in ('cash','upi','card','credit')),
  reason        text,
  created_at    text not null default (datetime('now', 'localtime'))
);
create index if not exists returns_date on sale_returns (business_date);

create table if not exists sale_return_items (
  id            integer primary key autoincrement,
  return_id     integer not null references sale_returns(id) on delete cascade,
  sale_item_id  integer not null references sale_items(id),
  qty           integer not null check (qty > 0),
  refund_paise  integer not null check (refund_paise >= 0),
  taxable_paise integer not null,
  gst_paise     integer not null
);

-- ------------------------------------------------------------ history

create table if not exists price_changes (
  id            integer primary key autoincrement,
  batch_id      integer not null references batches(id),
  product_id    integer not null references products(id),
  old_mrp_paise integer not null, new_mrp_paise integer not null,
  old_cost_paise integer not null, new_cost_paise integer not null,
  reason        text not null,
  created_at    text not null default (datetime('now', 'localtime'))
);

create table if not exists audit_log (
  id          integer primary key autoincrement,
  action      text not null,
  entity      text,
  entity_id   integer,
  detail      text,                            -- JSON
  created_at  text not null default (datetime('now', 'localtime'))
);
create index if not exists audit_date on audit_log (created_at);

create table if not exists stockout_log (
  id          integer primary key autoincrement,
  search_term text not null,
  product_id  integer references products(id),
  created_at  text not null default (datetime('now', 'localtime'))
);
create index if not exists stockout_date on stockout_log (created_at);

-- ============================================================ integrity

-- The ledger is append-only: corrections are new rows, never edits.
create trigger if not exists ledger_no_update before update on stock_ledger begin
  select raise(abort, 'Stock history cannot be changed. Record a stock adjustment instead.');
end;
create trigger if not exists ledger_no_delete before delete on stock_ledger begin
  select raise(abort, 'Stock history cannot be deleted. Record a stock adjustment instead.');
end;

-- Stock can never go below zero...
create trigger if not exists ledger_no_negative before insert on stock_ledger
when (select qty from batches where id = new.batch_id) + new.delta < 0
begin
  select raise(abort, 'Not enough stock in that batch.');
end;

-- ...and batches.qty is simply the running total of the ledger.
create trigger if not exists ledger_apply after insert on stock_ledger begin
  update batches
     set qty = qty + new.delta,
         updated_at = datetime('now', 'localtime')
   where id = new.batch_id;
end;

-- A new batch starts empty; stock arrives as a 'purchase' or 'opening' row.
create trigger if not exists batches_start_empty before insert on batches
when new.qty <> 0
begin
  select raise(abort, 'A new batch starts at zero. Add the quantity as a purchase.');
end;

-- Expired stock is never sold. Not a warning, a refusal.
--
-- The comparison is against the bill's own business_date, not against
-- date('now'). SQLite reads 'localtime' from the operating system while the app
-- reads it from its own settings, and the two can be a day apart for hours at a
-- time. When that happened, a batch that expired yesterday was still sellable
-- to SQLite. One clock now decides, and it is the app's.
create trigger if not exists sale_items_not_expired before insert on sale_items
when (select expiry from batches where id = new.batch_id)
     < (select business_date from sales where id = new.sale_id)
begin
  select raise(abort, 'That batch has expired and cannot be sold.');
end;

-- Schedule H1: the doctor and patient must be on the bill.
create trigger if not exists sale_items_h1 before insert on sale_items
when (select drug_schedule from products where id = new.product_id) = 'H1'
 and (select coalesce(trim(doctor_name), '') = ''
          or coalesce(trim(patient_name), '') = ''
          or coalesce(trim(patient_address), '') = '' from sales where id = new.sale_id)
begin
  select raise(abort, 'This medicine needs the doctor and patient written on the bill.');
end;

-- Bills are never edited. Cancelling is the one allowed change.
create trigger if not exists sales_immutable before update on sales
when not (old.is_cancelled = 0 and new.is_cancelled = 1
          and old.total_paise = new.total_paise and old.bill_no = new.bill_no)
begin
  select raise(abort, 'A bill cannot be changed. Cancel it and make a new one.');
end;
create trigger if not exists sales_no_delete before delete on sales begin
  select raise(abort, 'A bill cannot be deleted. Cancel it instead.');
end;
create trigger if not exists sale_items_no_change before update on sale_items begin
  select raise(abort, 'A bill cannot be changed. Cancel it and make a new one.');
end;

-- Credit notes are tax documents too.
create trigger if not exists returns_immutable before update on sale_returns begin
  select raise(abort, 'A credit note cannot be changed.');
end;
create trigger if not exists returns_no_delete before delete on sale_returns begin
  select raise(abort, 'A credit note cannot be deleted.');
end;

-- Never give back more than was sold on that line.
create trigger if not exists return_qty_check before insert on sale_return_items
when new.qty + coalesce((select sum(qty) from sale_return_items
                          where sale_item_id = new.sale_item_id), 0)
     > (select qty from sale_items where id = new.sale_item_id)
begin
  select raise(abort, 'More is being returned than was sold on that line.');
end;

-- Stock is counted in tablets, so the strip size cannot change under it.
create trigger if not exists product_pack_locked before update of units_per_strip on products
when new.units_per_strip <> old.units_per_strip
 and (select coalesce(sum(qty), 0) from batches where product_id = old.id) <> 0
begin
  select raise(abort, 'This medicine has stock on hand, so the strip size cannot change yet.');
end;

-- A medicine that has ever been sold or bought is archived, never deleted:
-- old bills point at it.
create trigger if not exists product_no_delete_with_history before delete on products
when exists (select 1 from sale_items where product_id = old.id)
  or exists (select 1 from stock_ledger where product_id = old.id)
begin
  select raise(abort, 'This medicine appears on past bills, so it can only be archived.');
end;

-- ============================================================ views

-- Stock on hand, per medicine.
create view if not exists v_stock as
select p.id as product_id, p.name, p.generic_name, p.manufacturer, p.rack,
       p.base_unit, p.units_per_strip, p.gst_rate, p.drug_schedule, p.reorder_packs, p.is_active,
       coalesce(sum(b.qty), 0) as units,
       coalesce(sum(b.qty), 0) / p.units_per_strip as packs,
       coalesce(sum(b.qty * b.cost_paise / p.units_per_strip), 0) as stock_value_paise,
       min(case when b.qty > 0 then b.expiry end) as nearest_expiry,
       count(case when b.qty > 0 then 1 end) as live_batches
  from products p
  left join batches b on b.product_id = p.id
 group by p.id;

-- One day's takings. Sales are what customers paid less refunds; profit leaves
-- GST out on both sides, because the GST collected is the government's and the
-- cost from the invoice is before GST.
create view if not exists v_day as
select d.business_date,
       coalesce(s.bills, 0)        as bills,
       coalesce(s.gross, 0)        as gross_paise,
       coalesce(r.refunds, 0)      as refund_paise,
       coalesce(s.gross, 0) - coalesce(r.refunds, 0)        as sales_paise,
       coalesce(s.taxable, 0) - coalesce(r.taxable, 0)      as taxable_paise,
       coalesce(s.gst, 0) - coalesce(r.gst, 0)              as gst_paise,
       coalesce(s.cost, 0) - coalesce(r.cost, 0)            as cost_paise,
       (coalesce(s.taxable, 0) - coalesce(r.taxable, 0))
         - (coalesce(s.cost, 0) - coalesce(r.cost, 0))      as profit_paise,
       coalesce(s.discount, 0)     as discount_paise,
       coalesce(r.returns, 0)      as returns,
       -- A refund comes off the way it was given back. Only cash used to be
       -- netted, so a UPI or card refund left the four figures adding up to
       -- more than the day's takings.
       coalesce(s.cash, 0)   - coalesce(r.cash, 0)     as cash_paise,
       coalesce(s.upi, 0)    - coalesce(r.upi, 0)      as upi_paise,
       coalesce(s.card, 0)   - coalesce(r.card, 0)     as card_paise,
       coalesce(s.credit, 0) - coalesce(r.credit, 0)   as credit_paise
  from (select business_date from sales where is_cancelled = 0
        union select business_date from sale_returns) d
  left join (
    select s.business_date,
           count(distinct s.id) as bills,
           sum(s.total_paise) as gross,
           sum(s.discount_paise) as discount,
           sum(case when s.pay_mode = 'cash'   then s.total_paise else 0 end) as cash,
           sum(case when s.pay_mode = 'upi'    then s.total_paise else 0 end) as upi,
           sum(case when s.pay_mode = 'card'   then s.total_paise else 0 end) as card,
           sum(case when s.pay_mode = 'credit' then s.total_paise else 0 end) as credit,
           (select coalesce(sum(si.taxable_paise), 0) from sale_items si
              join sales s2 on s2.id = si.sale_id
             where s2.business_date = s.business_date and s2.is_cancelled = 0) as taxable,
           (select coalesce(sum(si.gst_paise), 0) from sale_items si
              join sales s2 on s2.id = si.sale_id
             where s2.business_date = s.business_date and s2.is_cancelled = 0) as gst,
           (select coalesce(sum(coalesce(si.cost_total_paise, si.qty * si.cost_paise / p.units_per_strip)), 0) from sale_items si
              join sales s2 on s2.id = si.sale_id join products p on p.id = si.product_id
             where s2.business_date = s.business_date and s2.is_cancelled = 0) as cost
      from sales s where s.is_cancelled = 0 group by s.business_date) s on s.business_date = d.business_date
  left join (
    select r.business_date,
           count(distinct r.id) as returns,
           sum(ri.refund_paise) as refunds,
           sum(ri.taxable_paise) as taxable,
           sum(ri.gst_paise) as gst,
           sum(ri.qty * coalesce(si.cost_total_paise * 1.0 / si.qty, si.cost_paise * 1.0 / p.units_per_strip)) as cost,
           sum(case when r.refund_mode = 'cash'   then ri.refund_paise else 0 end) as cash,
           sum(case when r.refund_mode = 'upi'    then ri.refund_paise else 0 end) as upi,
           sum(case when r.refund_mode = 'card'   then ri.refund_paise else 0 end) as card,
           sum(case when r.refund_mode = 'credit' then ri.refund_paise else 0 end) as credit
      from sale_returns r
      join sale_return_items ri on ri.return_id = r.id
      join sale_items si on si.id = ri.sale_item_id
      join products p on p.id = si.product_id
     group by r.business_date) r on r.business_date = d.business_date;

-- Batches near their end, with what they cost.
create view if not exists v_expiry as
select b.id as batch_id, b.batch_no, b.expiry, b.qty, b.mrp_paise, b.cost_paise,
       p.id as product_id, p.name, p.units_per_strip, p.rack,
       s.name as supplier, s.return_months,
       -- days_left is deliberately not worked out here: it would need SQLite's
       -- idea of today, which can differ from the app's. The caller passes the
       -- date in and does the subtraction.
       b.qty * b.cost_paise / p.units_per_strip as value_paise
  from batches b
  join products p on p.id = b.product_id
  left join suppliers s on s.id = b.supplier_id
 where b.qty > 0;
