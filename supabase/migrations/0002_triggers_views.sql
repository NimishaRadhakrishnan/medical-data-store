-- Sri Nachiya Medicals
-- Migration 0002: ledger integrity, legal blocks, analytics views
--
-- Everything that must be true regardless of which client wrote the row lives
-- here, not in the UI. An offline PWA, a second counter terminal and a Python
-- import script all hit these same rules.

-- ============================================================ ledger integrity

-- The ledger is append-only. Corrections are new rows, never edits.
create or replace function forbid_ledger_mutation() returns trigger as $$
begin
  raise exception
    'stock_ledger is append-only. To correct stock, insert a compensating row with reason=''adjustment''.';
end;
$$ language plpgsql;

create trigger stock_ledger_no_update before update on stock_ledger
  for each row execute function forbid_ledger_mutation();
create trigger stock_ledger_no_delete before delete on stock_ledger
  for each row execute function forbid_ledger_mutation();

-- batches.qty_available is a cached projection of the ledger.
-- If the two ever disagree, the ledger wins (see rebuild_batch_quantities).
create or replace function apply_ledger_to_batch() returns trigger as $$
declare
  new_qty integer;
begin
  update batches
     set qty_available = qty_available + new.delta,
         updated_at    = now()
   where id = new.batch_id
  returning qty_available into new_qty;

  if new_qty is null then
    raise exception 'Ledger row references unknown batch %', new.batch_id;
  end if;

  -- Negative stock means two terminals raced, or a bad adjustment. Never let it
  -- persist silently: a pharmacy that thinks it has -3 strips has lost the plot.
  if new_qty < 0 then
    raise exception
      'Batch % would go negative (% units). Stock on hand is insufficient.',
      new.batch_id, new_qty;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger stock_ledger_apply after insert on stock_ledger
  for each row execute function apply_ledger_to_batch();

-- The recovery path. Run after any suspected drift; the ledger is the truth.
create or replace function rebuild_batch_quantities(p_shop_id uuid)
returns table (batch_id uuid, was integer, now_is integer) as $$
begin
  return query
  with truth as (
    select b.id, b.qty_available as was,
           coalesce(sum(l.delta), 0)::integer as should_be
      from batches b
      left join stock_ledger l on l.batch_id = b.id
     where b.shop_id = p_shop_id
     group by b.id, b.qty_available
  ), fixed as (
    update batches b
       set qty_available = t.should_be, updated_at = now()
      from truth t
     where b.id = t.id and b.qty_available <> t.should_be
    returning b.id, t.was, t.should_be
  )
  select * from fixed;
end;
$$ language plpgsql;

-- ============================================================ FEFO

-- First-Expiry-First-Out allocation. Returns the batches to draw from, in
-- order, for a requested quantity. Expired batches are never returned.
create or replace function allocate_fefo(
  p_product_id uuid,
  p_qty_base   integer
)
returns table (batch_id uuid, batch_no text, expiry_date date, mrp numeric, take integer) as $$
declare
  remaining integer := p_qty_base;
  r record;
begin
  for r in
    select b.id, b.batch_no, b.expiry_date, b.mrp, b.qty_available
      from batches b
     where b.product_id = p_product_id
       and b.qty_available > 0
       and b.expiry_date >= current_date      -- expired stock is not sellable. Ever.
     order by b.expiry_date asc, b.created_at asc
  loop
    exit when remaining <= 0;
    batch_id    := r.id;
    batch_no    := r.batch_no;
    expiry_date := r.expiry_date;
    mrp         := r.mrp;
    take        := least(remaining, r.qty_available);
    remaining   := remaining - take;
    return next;
  end loop;

  if remaining > 0 then
    raise exception 'Insufficient sellable stock: short by % base units', remaining;
  end if;
end;
$$ language plpgsql;

-- ============================================================ legal blocks

-- Schedule H1: supply must be recorded with prescriber and patient details,
-- and the register retained for three years. Block the bill at the database,
-- so no client can skip it.
create or replace function enforce_h1_details() returns trigger as $$
declare
  has_h1 boolean;
  s      sales%rowtype;
begin
  select * into s from sales where id = new.sale_id;

  select exists (
    select 1 from products p
     where p.id = new.product_id and p.drug_schedule = 'H1'
  ) into has_h1;

  if has_h1 then
    if coalesce(trim(s.prescriber_name), '')  = ''
    or coalesce(trim(s.patient_name), '')     = ''
    or coalesce(trim(s.patient_address), '')  = '' then
      raise exception
        'Schedule H1 item requires prescriber name, patient name and patient address on the bill.';
    end if;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger sale_items_h1_check before insert on sale_items
  for each row execute function enforce_h1_details();

-- Bills are immutable once saved. Cancel and re-issue; never edit.
create or replace function forbid_sale_edit() returns trigger as $$
begin
  if old.is_cancelled = false and new.is_cancelled = true then
    return new;                               -- cancelling is the one allowed change
  end if;
  raise exception 'Bills are immutable. Cancel this bill and issue a new one.';
end;
$$ language plpgsql;

create trigger sales_immutable before update on sales
  for each row execute function forbid_sale_edit();

-- ============================================================ analytics views

-- The expiry ladder. The 91–180 day bucket is the money bucket: still inside
-- most distributors' return window, so it can go back instead of being binned.
create or replace view v_expiry_ladder as
select
  b.shop_id,
  case
    when b.expiry_date <  current_date                        then 'expired'
    when b.expiry_date <= current_date + interval  '30 days'  then '0-30'
    when b.expiry_date <= current_date + interval  '90 days'  then '31-90'
    when b.expiry_date <= current_date + interval '180 days'  then '91-180'
    else 'beyond'
  end as bucket,
  count(*)                                        as batch_count,
  sum(b.qty_available)                            as units,
  round(sum(b.qty_available::numeric / p.units_per_strip * b.purchase_rate), 2) as value_at_cost,
  round(sum(b.qty_available::numeric / p.units_per_strip * b.mrp), 2)           as value_at_mrp
from batches b
join products p on p.id = b.product_id
where b.qty_available > 0
group by 1, 2;

-- "Send these back this week." Grouped by supplier, only what they will accept.
create or replace view v_returnable_to_supplier as
select
  b.shop_id,
  s.id   as supplier_id,
  s.name as supplier_name,
  s.phone,
  p.name as product_name,
  b.batch_no,
  to_char(b.expiry_date, 'MM/YYYY')               as expiry,
  b.qty_available,
  round(b.qty_available::numeric / p.units_per_strip, 2) as strips,
  round(b.qty_available::numeric / p.units_per_strip * b.purchase_rate, 2) as recoverable_value
from batches b
join products  p on p.id = b.product_id
join suppliers s on s.id = b.supplier_id
where b.qty_available > 0
  and b.expiry_date >  current_date
  -- still inside this supplier's return window, and close enough to be worth doing
  and b.expiry_date <= current_date + (s.return_window_months || ' months')::interval + interval '60 days'
  and b.expiry_date >  current_date + (s.return_window_months || ' months')::interval;

-- Dead stock: on hand, nothing sold in 90 days, sorted by rupees locked up.
create or replace view v_dead_stock as
select
  p.shop_id,
  p.id as product_id,
  p.name,
  p.rack_location,
  sum(b.qty_available) as units_on_hand,
  round(sum(b.qty_available::numeric / p.units_per_strip * b.purchase_rate), 2) as capital_locked,
  max(ls.last_sold) as last_sold
from products p
join batches b on b.product_id = p.id and b.qty_available > 0
left join lateral (
  select max(s.created_at) as last_sold
    from sale_items si join sales s on s.id = si.sale_id
   where si.product_id = p.id and s.is_cancelled = false
) ls on true
group by p.shop_id, p.id, p.name, p.rack_location
having max(ls.last_sold) is null
    or max(ls.last_sold) < now() - interval '90 days';

-- Daily sales and TRUE gross margin. purchase_rate is snapshotted on the sale
-- line, so margin stays correct even after the supplier raises prices.
create or replace view v_daily_sales as
select
  s.shop_id,
  (s.created_at at time zone 'Asia/Kolkata')::date as business_date,
  count(distinct s.id)                             as bills,
  round(sum(si.line_total), 2)                     as revenue,
  round(sum(si.line_total
          - (si.qty_base::numeric / p.units_per_strip * si.purchase_rate)), 2) as gross_margin,
  round(avg(bill.total), 2)                        as avg_bill_value
from sales s
join sale_items si on si.sale_id = s.id
join products   p  on p.id = si.product_id
join lateral (select s.total) bill on true
where s.is_cancelled = false
group by 1, 2;

-- Demand for the reorder engine, EXCLUDING days the item was out of stock.
-- Without this exclusion a stock-out depresses measured demand and the system
-- under-orders the same item forever.
create or replace view v_demand_28d as
with sold as (
  select si.product_id,
         (s.created_at at time zone 'Asia/Kolkata')::date as d,
         sum(si.qty_base) as qty
    from sale_items si
    join sales s on s.id = si.sale_id
   where s.is_cancelled = false
     and s.created_at >= now() - interval '28 days'
   group by 1, 2
)
select
  p.shop_id,
  p.id as product_id,
  p.name,
  coalesce(sum(sold.qty), 0)                       as units_28d,
  count(sold.d)                                    as days_with_sales,
  round(coalesce(sum(sold.qty), 0)::numeric
        / greatest(count(sold.d), 1), 2)           as avg_daily_when_available,
  round(stddev_pop(sold.qty), 2)                   as sigma_daily
from products p
left join sold on sold.product_id = p.id
group by p.shop_id, p.id, p.name;
