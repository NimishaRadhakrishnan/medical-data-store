-- Sri Nachiya Medicals
-- Migration 0007: correct sales figures, and the daily and monthly summaries
--
-- Three fixes first, because every summary depends on them:
--
--   1. BUSINESS DATE. Reports dated a bill by created_at, the moment it reached
--      the server. A bill made offline at 8:55 PM Monday that synced at 10 AM
--      Tuesday counted as Tuesday. Each bill now stores the day it was actually
--      sold, set once on insert.
--   2. RETURNS AS MONEY. A return existed only as stock coming back. Credit
--      notes now record the refund, so net sales can subtract it.
--   3. PROFIT WITHOUT GST. Margin was bill total minus cost. The bill total
--      includes GST that belongs to the government, while cost (from the
--      invoice) excludes it, so margin was overstated by about 5 points. Profit
--      is now taxable value minus cost.
--
-- Then two functions, daily_summary() and monthly_summary(), which are the only
-- place sales figures are calculated. The counter's Sales screen, the owner's
-- phone, the 9 PM notification and the MCP server all read these, so no two
-- screens can ever show two different totals.

-- ============================================================ 1. business date

alter table sales add column if not exists business_date    date;
alter table sales add column if not exists synced_at        timestamptz not null default now();
alter table sales add column if not exists date_from_server boolean not null default false;
-- Clinics and nursing homes sometimes buy with a GSTIN. Those bills are B2B and
-- are reported separately in GSTR-1, so the bill has to carry it.
alter table sales add column if not exists buyer_name  text;
alter table sales add column if not exists buyer_gstin text;

comment on column sales.business_date is
  'The IST date the bill was made at the counter. Every report groups by this, never by created_at.';
comment on column sales.date_from_server is
  'True when the counter clock was clearly wrong and the server time was used instead. Worth a look.';

create or replace function set_business_date() returns trigger as $$
declare
  v_server timestamptz := coalesce(new.created_at, now());
  v_client timestamptz := new.client_created_at;
begin
  -- Trust the counter's clock for when the sale happened — that is what makes
  -- an offline bill land on the right day — but only within sane bounds. A PC
  -- whose clock says next week, or last month, gets server time and a flag.
  if v_client is not null
     and v_client <= v_server + interval '5 minutes'
     and v_client >= v_server - interval '7 days' then
    new.business_date    := (v_client at time zone 'Asia/Kolkata')::date;
    new.date_from_server := false;
  else
    new.business_date    := (v_server at time zone 'Asia/Kolkata')::date;
    new.date_from_server := v_client is not null;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists sales_business_date on sales;
create trigger sales_business_date before insert on sales
  for each row execute function set_business_date();

-- Existing bills: bills are immutable, so the guard is lifted for this one
-- backfill inside the migration and put straight back.
alter table sales disable trigger sales_immutable;
update sales
   set business_date = (coalesce(client_created_at, created_at) at time zone 'Asia/Kolkata')::date
 where business_date is null;
alter table sales enable trigger sales_immutable;

alter table sales alter column business_date set not null;
create index if not exists sales_by_business_date on sales (shop_id, business_date);

-- ============================================================ 2. returns

create table if not exists sale_returns (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references shops(id) on delete cascade,
  sale_id       uuid not null references sales(id),
  return_no     text not null,                   -- credit note number, e.g. SNM-CN-000012
  business_date date not null default ((now() at time zone 'Asia/Kolkata')::date),
  refund_mode   payment_mode not null default 'cash',
  reason        text,
  created_at    timestamptz not null default now(),
  unique (shop_id, return_no)
);
create index if not exists sale_returns_by_date on sale_returns (shop_id, business_date);

create table if not exists sale_return_items (
  id             uuid primary key default gen_random_uuid(),
  return_id      uuid not null references sale_returns(id) on delete cascade,
  sale_item_id   uuid not null references sale_items(id),
  qty_base       integer not null check (qty_base > 0),
  refund_amount  numeric(12,2) not null check (refund_amount >= 0),  -- what the customer got back, GST included
  taxable_value  numeric(12,2) not null,
  gst_amount     numeric(12,2) not null
);
create index if not exists sale_return_items_by_line on sale_return_items (sale_item_id);

-- A return must come from the bill it names, and cannot give back more than
-- was sold on that line, counting earlier returns.
create or replace function check_return_item() returns trigger as $$
declare
  v_sold     integer;
  v_returned integer;
  v_line_sale uuid;
  v_ret_sale  uuid;
begin
  select si.qty_base, si.sale_id into v_sold, v_line_sale
    from sale_items si where si.id = new.sale_item_id;
  select r.sale_id into v_ret_sale from sale_returns r where r.id = new.return_id;

  if v_line_sale is distinct from v_ret_sale then
    raise exception 'That medicine is not on the bill being returned.';
  end if;

  select coalesce(sum(qty_base), 0) into v_returned
    from sale_return_items where sale_item_id = new.sale_item_id;

  if v_returned + new.qty_base > v_sold then
    raise exception 'Only % of this line can still be returned (% sold, % already returned).',
      v_sold - v_returned, v_sold, v_returned;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists sale_return_items_check on sale_return_items;
create trigger sale_return_items_check before insert on sale_return_items
  for each row execute function check_return_item();

-- Credit notes are tax documents: like bills, never edited or deleted.
create or replace function forbid_document_edit() returns trigger as $$
begin
  raise exception 'Credit notes cannot be changed or deleted. Issue a new one instead.';
end;
$$ language plpgsql;

drop trigger if exists sale_returns_immutable on sale_returns;
create trigger sale_returns_immutable before update or delete on sale_returns
  for each row execute function forbid_document_edit();
drop trigger if exists sale_return_items_immutable on sale_return_items;
create trigger sale_return_items_immutable before update or delete on sale_return_items
  for each row execute function forbid_document_edit();

alter table sale_returns      enable row level security;
alter table sale_returns      force  row level security;
alter table sale_return_items enable row level security;
alter table sale_return_items force  row level security;

drop policy if exists sale_returns_read on sale_returns;
create policy sale_returns_read on sale_returns for select using (shop_id = current_shop_id());
drop policy if exists sale_returns_write on sale_returns;
create policy sale_returns_write on sale_returns for insert with check (shop_id = current_shop_id());
drop policy if exists sale_return_items_read on sale_return_items;
create policy sale_return_items_read on sale_return_items for select
  using (exists (select 1 from sale_returns r where r.id = return_id and r.shop_id = current_shop_id()));
drop policy if exists sale_return_items_write on sale_return_items;
create policy sale_return_items_write on sale_return_items for insert
  with check (exists (select 1 from sale_returns r where r.id = return_id and r.shop_id = current_shop_id()));

-- ============================================================ 3. one set of daily totals

-- Everything below is built on this one view. Sales = what customers paid,
-- minus refunds. Profit = taxable value minus cost, with returned lines taken
-- back out at the cost they were sold at.
create or replace view v_day_totals as
with bills as (
  select s.shop_id, s.business_date,
         count(*)                                                        as bills,
         sum(s.total)                                                    as gross_sales,
         sum(s.discount)                                                 as discount,
         sum(case s.payment_mode when 'cash' then s.total
                                 when 'split' then s.cash_amount else 0 end) as cash,
         sum(case s.payment_mode when 'upi' then s.total
                                 when 'split' then s.upi_amount else 0 end)  as upi,
         sum(case when s.payment_mode = 'card'   then s.total else 0 end) as card,
         sum(case when s.payment_mode = 'credit' then s.total else 0 end) as credit,
         count(*) filter (where s.date_from_server)                      as clock_flagged
    from sales s
   where not s.is_cancelled
   group by 1, 2
),
lines as (
  select s.shop_id, s.business_date,
         sum(si.taxable_value)                                            as taxable,
         sum(si.gst_amount)                                               as gst,
         sum(si.qty_base::numeric / p.units_per_strip * si.purchase_rate) as cost
    from sales s
    join sale_items si on si.sale_id = s.id
    join products   p  on p.id = si.product_id
   where not s.is_cancelled
   group by 1, 2
),
rets as (
  select r.shop_id, r.business_date,
         count(distinct r.id)                                             as returns,
         sum(ri.refund_amount)                                            as refunds,
         sum(ri.taxable_value)                                            as taxable,
         sum(ri.gst_amount)                                               as gst,
         sum(ri.qty_base::numeric / p.units_per_strip * si.purchase_rate) as cost,
         sum(case when r.refund_mode = 'cash' then ri.refund_amount else 0 end) as cash_refunds
    from sale_returns r
    join sale_return_items ri on ri.return_id = r.id
    join sale_items si        on si.id = ri.sale_item_id
    join products p           on p.id = si.product_id
   group by 1, 2
),
days as (
  select shop_id, business_date from bills
  union
  select shop_id, business_date from rets
)
select
  d.shop_id,
  d.business_date,
  coalesce(b.bills, 0)                                        as bills,
  coalesce(b.gross_sales, 0)                                  as gross_sales,
  coalesce(r.returns, 0)                                      as returns,
  coalesce(r.refunds, 0)                                      as refunds,
  coalesce(b.gross_sales, 0) - coalesce(r.refunds, 0)         as net_sales,
  coalesce(l.taxable, 0) - coalesce(r.taxable, 0)             as taxable,
  coalesce(l.gst, 0) - coalesce(r.gst, 0)                     as gst,
  round(coalesce(l.cost, 0) - coalesce(r.cost, 0), 2)         as cost,
  round((coalesce(l.taxable, 0) - coalesce(r.taxable, 0))
      - (coalesce(l.cost, 0) - coalesce(r.cost, 0)), 2)       as profit,
  coalesce(b.discount, 0)                                     as discount,
  coalesce(b.cash, 0) - coalesce(r.cash_refunds, 0)           as cash,
  coalesce(b.upi, 0)                                          as upi,
  coalesce(b.card, 0)                                         as card,
  coalesce(b.credit, 0)                                       as credit,
  coalesce(b.clock_flagged, 0)                                as clock_flagged
from days d
left join bills b using (shop_id, business_date)
left join lines l using (shop_id, business_date)
left join rets  r using (shop_id, business_date);

-- This view crosses shops and reads cost, so nobody reads it directly: only
-- through the summary functions below, which check who is asking.
revoke all on v_day_totals from authenticated;

-- The older views now sit on top of it, keeping their column names so nothing
-- that reads them breaks. Profit and dates are now correct in all of them.
create or replace view v_daily_sales as
select shop_id, business_date, bills,
       net_sales as revenue,
       profit    as gross_margin,
       round(gross_sales / nullif(bills, 0), 2) as avg_bill_value
  from v_day_totals;

create or replace view v_rep_daily as
select shop_id, business_date, bills,
       net_sales as revenue,
       profit    as gross_margin,
       round(gross_sales / nullif(bills, 0), 2) as avg_bill_value
  from v_day_totals;

create or replace view v_rep_product_sales as
select
  s.shop_id,
  si.product_id,
  p.name,
  p.manufacturer,
  s.business_date,
  sum(si.qty_base)                                                               as units,
  round(sum(si.line_total), 2)                                                   as revenue,
  round(sum(si.taxable_value - si.qty_base::numeric / p.units_per_strip * si.purchase_rate), 2) as margin
from sales s
join sale_items si on si.sale_id = s.id
join products   p  on p.id = si.product_id
where not s.is_cancelled
group by 1, 2, 3, 4, 5;

-- ============================================================ who may read summaries

-- The owner, signed in through the app, for his own shop. Or the read-only
-- reporting role behind the owner's MCP server, and admin sessions.
create or replace function assert_can_report(p_shop uuid) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is not null then
    if not is_owner() or p_shop is distinct from current_shop_id() then
      raise exception 'Only the owner can see sales summaries.';
    end if;
  elsif session_user not in ('snm_reporting', 'postgres', 'supabase_admin') then
    raise exception 'Not allowed to read sales summaries.';
  end if;
end;
$$;

-- ============================================================ daily summary

create or replace function daily_summary(p_shop uuid, p_date date)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  d  v_day_totals%rowtype;
  lw v_day_totals%rowtype;
begin
  perform assert_can_report(p_shop);

  select * into d  from v_day_totals where shop_id = p_shop and business_date = p_date;
  select * into lw from v_day_totals where shop_id = p_shop and business_date = p_date - 7;

  return jsonb_build_object(
    'date',            p_date,
    'sales',           coalesce(d.net_sales, 0),
    'bills',           coalesce(d.bills, 0),
    'average_bill',    round(coalesce(d.gross_sales, 0) / nullif(d.bills, 0), 2),
    'profit',          coalesce(d.profit, 0),
    'profit_pct',      round(d.profit * 100 / nullif(d.taxable, 0), 1),
    'gst_collected',   coalesce(d.gst, 0),
    'returns',         coalesce(d.returns, 0),
    'refunds',         coalesce(d.refunds, 0),
    'discount',        coalesce(d.discount, 0),
    'payments',        jsonb_build_object('cash',   coalesce(d.cash, 0),
                                          'upi',    coalesce(d.upi, 0),
                                          'card',   coalesce(d.card, 0),
                                          'credit', coalesce(d.credit, 0)),
    -- A pharmacy's Sunday is nothing like its Wednesday: compare like with like.
    'same_day_last_week', coalesce(lw.net_sales, 0),
    'change_pct',      round((coalesce(d.net_sales, 0) - lw.net_sales) * 100 / nullif(lw.net_sales, 0), 1),
    'top_sellers', coalesce((
        select jsonb_agg(jsonb_build_object('name', name, 'sales', sales) order by sales desc)
          from (select p.name, round(sum(si.line_total), 2) as sales
                  from sales s
                  join sale_items si on si.sale_id = s.id
                  join products p    on p.id = si.product_id
                 where s.shop_id = p_shop and s.business_date = p_date and not s.is_cancelled
                 group by p.name
                 order by 2 desc
                 limit 5) t), '[]'::jsonb),
    -- Bills made offline that arrived on a later day. If this is above zero
    -- after the evening notification went out, the day has been restated.
    'late_bills', (select count(*) from sales s
                    where s.shop_id = p_shop and s.business_date = p_date and not s.is_cancelled
                      and (s.synced_at at time zone 'Asia/Kolkata')::date > s.business_date),
    'clock_flagged',   coalesce(d.clock_flagged, 0),
    'asked_not_in_stock', coalesce((
        select jsonb_agg(jsonb_build_object('item', item, 'times', times) order by times desc)
          from (select coalesce(p.name, sl.search_term) as item, count(*) as times
                  from stockout_log sl
                  left join products p on p.id = sl.product_id
                 where sl.shop_id = p_shop
                   and (sl.created_at at time zone 'Asia/Kolkata')::date = p_date
                 group by 1) t), '[]'::jsonb),
    'expiring_30_days_at_cost', (
        select coalesce(round(sum(b.qty_available::numeric / p.units_per_strip * b.purchase_rate), 2), 0)
          from batches b join products p on p.id = b.product_id
         where b.shop_id = p_shop and b.qty_available > 0
           and b.expiry_date between p_date and p_date + 30),
    'returnable_to_distributors', (
        select coalesce(sum(recoverable_value), 0)
          from v_returnable_to_supplier where shop_id = p_shop)
  );
end;
$$;

-- ============================================================ monthly summary

create or replace function monthly_summary(p_shop uuid, p_month date)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  m_start date := date_trunc('month', p_month)::date;
  m_end   date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  cur  record;
  prev record;
  same record;
  ly   record;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  -- Part-way through the current month, how many days have passed.
  v_days_so_far int := case when v_today between m_start and m_end then v_today - m_start + 1 end;
begin
  perform assert_can_report(p_shop);

  -- Comparing 22 days with last month's full 31 would always look like a bad
  -- month, so a month still in progress is also compared with the same days
  -- of last month.
  select coalesce(sum(net_sales), 0) sales into same
    from v_day_totals where shop_id = p_shop
     and business_date between (m_start - interval '1 month')::date
                           and least((m_start - interval '1 month')::date + coalesce(v_days_so_far, 31) - 1, m_start - 1);

  select coalesce(sum(net_sales), 0) sales, coalesce(sum(bills), 0) bills,
         coalesce(sum(gross_sales), 0) gross_sales, coalesce(sum(profit), 0) profit,
         coalesce(sum(taxable), 0) taxable, coalesce(sum(gst), 0) gst,
         coalesce(sum(returns), 0) returns, coalesce(sum(refunds), 0) refunds,
         coalesce(sum(discount), 0) discount,
         coalesce(sum(cash), 0) cash, coalesce(sum(upi), 0) upi,
         coalesce(sum(card), 0) card, coalesce(sum(credit), 0) credit,
         count(*) filter (where bills > 0) open_days
    into cur
    from v_day_totals where shop_id = p_shop and business_date between m_start and m_end;

  select coalesce(sum(net_sales), 0) sales, coalesce(sum(profit), 0) profit into prev
    from v_day_totals where shop_id = p_shop
     and business_date between (m_start - interval '1 month')::date and m_start - 1;

  select coalesce(sum(net_sales), 0) sales, coalesce(sum(profit), 0) profit into ly
    from v_day_totals where shop_id = p_shop
     and business_date between (m_start - interval '1 year')::date
                           and (m_start - interval '1 year' + interval '1 month - 1 day')::date;

  return jsonb_build_object(
    'month',          to_char(m_start, 'YYYY-MM'),
    'sales',          cur.sales,
    'bills',          cur.bills,
    'average_bill',   round(cur.gross_sales / nullif(cur.bills, 0), 2),
    'profit',         cur.profit,
    'profit_pct',     round(cur.profit * 100 / nullif(cur.taxable, 0), 1),
    'gst_collected',  cur.gst,
    'returns',        cur.returns,
    'refunds',        cur.refunds,
    'discount',       cur.discount,
    'open_days',      cur.open_days,
    'payments',       jsonb_build_object('cash', cur.cash, 'upi', cur.upi, 'card', cur.card, 'credit', cur.credit),
    'days_so_far',    v_days_so_far,
    'last_month_same_days', case when v_days_so_far is not null then jsonb_build_object(
                        'days', v_days_so_far, 'sales', same.sales,
                        'change_pct', round((cur.sales - same.sales) * 100 / nullif(same.sales, 0), 1)) end,
    'last_month',     jsonb_build_object('sales', prev.sales, 'profit', prev.profit,
                        'change_pct', round((cur.sales - prev.sales) * 100 / nullif(prev.sales, 0), 1)),
    'same_month_last_year', jsonb_build_object('sales', ly.sales, 'profit', ly.profit,
                        'change_pct', round((cur.sales - ly.sales) * 100 / nullif(ly.sales, 0), 1)),

    -- Every day of the month, including days with no sales, for the chart.
    'by_day', (
      select jsonb_agg(jsonb_build_object(
               'date', g.d::date, 'sales', coalesce(t.net_sales, 0),
               'bills', coalesce(t.bills, 0), 'profit', coalesce(t.profit, 0)) order by g.d)
        from generate_series(m_start, m_end, interval '1 day') g(d)
        left join v_day_totals t on t.shop_id = p_shop and t.business_date = g.d::date),

    -- Average sales on each weekday, over the days the shop was open.
    'by_weekday', (
      select jsonb_agg(jsonb_build_object('weekday', trim(to_char(wd_date, 'Day')),
                                          'average_sales', avg_sales) order by wd)
        from (select extract(isodow from business_date) wd, min(business_date) wd_date,
                     round(avg(net_sales), 2) avg_sales
                from v_day_totals
               where shop_id = p_shop and business_date between m_start and m_end and bills > 0
               group by 1) w),

    'best_day',  (select jsonb_build_object('date', business_date, 'sales', net_sales)
                    from v_day_totals where shop_id = p_shop and business_date between m_start and m_end and bills > 0
                   order by net_sales desc limit 1),
    'worst_day', (select jsonb_build_object('date', business_date, 'sales', net_sales)
                    from v_day_totals where shop_id = p_shop and business_date between m_start and m_end and bills > 0
                   order by net_sales asc limit 1),

    'top_by_sales', coalesce((
      select jsonb_agg(jsonb_build_object('name', name, 'sales', sales, 'profit', profit) order by sales desc)
        from (select p.name, round(sum(si.line_total), 2) sales,
                     round(sum(si.taxable_value - si.qty_base::numeric / p.units_per_strip * si.purchase_rate), 2) profit
                from sales s join sale_items si on si.sale_id = s.id join products p on p.id = si.product_id
               where s.shop_id = p_shop and s.business_date between m_start and m_end and not s.is_cancelled
               group by p.name order by 2 desc limit 20) t), '[]'::jsonb),
    'top_by_profit', coalesce((
      select jsonb_agg(jsonb_build_object('name', name, 'sales', sales, 'profit', profit) order by profit desc)
        from (select p.name, round(sum(si.line_total), 2) sales,
                     round(sum(si.taxable_value - si.qty_base::numeric / p.units_per_strip * si.purchase_rate), 2) profit
                from sales s join sale_items si on si.sale_id = s.id join products p on p.id = si.product_id
               where s.shop_id = p_shop and s.business_date between m_start and m_end and not s.is_cancelled
               group by p.name order by 3 desc limit 20) t), '[]'::jsonb),

    -- ---------------------------------------------------- for the CA
    -- GST on sales by rate. Intra-state, so split equally into CGST and SGST.
    'gst_by_rate', coalesce((
      select jsonb_agg(jsonb_build_object('rate', rate, 'taxable', taxable,
                                          'cgst', round(gst / 2, 2), 'sgst', gst - round(gst / 2, 2)) order by rate)
        from (select si.gst_rate rate, sum(si.taxable_value) taxable, sum(si.gst_amount) gst
                from sales s join sale_items si on si.sale_id = s.id
               where s.shop_id = p_shop and s.business_date between m_start and m_end and not s.is_cancelled
               group by 1) t), '[]'::jsonb),
    -- GSTR-1 Table 12 has separate B2B and B2C tabs: a bill with a buyer
    -- GSTIN is B2B, everything else B2C. Quantity is in the unit sold.
    'hsn_summary', coalesce((
      select jsonb_agg(jsonb_build_object('type', kind, 'hsn', hsn, 'rate', rate, 'quantity', qty,
                                          'taxable', taxable, 'tax', gst) order by kind, hsn, rate)
        from (select case when s.buyer_gstin is not null then 'B2B' else 'B2C' end kind,
                     coalesce(p.hsn_code, '3004') hsn, si.gst_rate rate,
                     sum(si.qty_base) qty, sum(si.taxable_value) taxable, sum(si.gst_amount) gst
                from sales s join sale_items si on si.sale_id = s.id join products p on p.id = si.product_id
               where s.shop_id = p_shop and s.business_date between m_start and m_end and not s.is_cancelled
               group by 1, 2, 3) t), '[]'::jsonb),
    -- GSTR-1 Table 13: the range of document numbers issued, and cancellations.
    'documents', jsonb_build_object(
      'bills_first',     (select min(bill_no) from sales where shop_id = p_shop and business_date between m_start and m_end),
      'bills_last',      (select max(bill_no) from sales where shop_id = p_shop and business_date between m_start and m_end),
      'bills_issued',    (select count(*)    from sales where shop_id = p_shop and business_date between m_start and m_end),
      'bills_cancelled', (select count(*)    from sales where shop_id = p_shop and business_date between m_start and m_end and is_cancelled),
      'credit_notes',    (select count(*)    from sale_returns where shop_id = p_shop and business_date between m_start and m_end))
  );
end;
$$;

revoke all on function assert_can_report(uuid)     from public;
revoke all on function daily_summary(uuid, date)   from public;
revoke all on function monthly_summary(uuid, date) from public;
grant execute on function daily_summary(uuid, date)   to authenticated, snm_reporting;
grant execute on function monthly_summary(uuid, date) to authenticated, snm_reporting;
