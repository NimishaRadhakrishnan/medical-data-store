-- Sri Nachiya Medicals
-- Migration 0004: reporting role + views for the owner's MCP server
--
-- The MCP server lets the owner ask the shop questions in plain language from
-- his laptop. That convenience must not become a way to write to the shop's
-- books, so the server connects as a role that physically cannot:
--
--   * SELECT only, and only on the views below — never on the base tables
--   * no INSERT / UPDATE / DELETE anywhere, not even on stock_ledger
--   * no customer names, phone numbers or prescription data in any view
--   * a statement timeout, so a bad question cannot pin the database
--
-- Everything the agent can reach is aggregate or product-level. Bill-level rows
-- carrying patient details are simply not exposed.

-- ------------------------------------------------------------ the role

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'snm_reporting') then
    -- password is set out of band: ALTER ROLE snm_reporting PASSWORD '...';
    create role snm_reporting login noinherit;
  end if;
end $$;

revoke all on schema public from snm_reporting;
grant usage on schema public to snm_reporting;

-- Belt and braces: even if a future migration grants something by accident.
alter default privileges in schema public
  revoke insert, update, delete, truncate on tables from snm_reporting;

alter role snm_reporting set statement_timeout = '8s';
alter role snm_reporting set default_transaction_read_only = on;

-- ------------------------------------------------------------ reporting views

-- Stock on hand, product level. No supplier cost here — see v_rep_margin.
create or replace view v_rep_stock as
select
  p.shop_id,
  p.id                                   as product_id,
  p.name,
  p.generic_name,
  p.manufacturer,
  p.rack_location,
  p.drug_schedule::text                  as drug_schedule,
  p.units_per_strip,
  coalesce(sum(b.qty_available), 0)      as units_on_hand,
  round(coalesce(sum(b.qty_available), 0)::numeric / p.units_per_strip, 2) as strips_on_hand,
  min(b.expiry_date) filter (where b.qty_available > 0) as nearest_expiry,
  count(b.id) filter (where b.qty_available > 0)        as live_batches
from products p
left join batches b on b.product_id = p.id
where p.is_active
group by p.shop_id, p.id, p.name, p.generic_name, p.manufacturer,
         p.rack_location, p.drug_schedule, p.units_per_strip;

-- Daily revenue and true gross margin. purchase_rate is snapshotted on the sale
-- line, so the margin stays correct even after the distributor raises prices.
create or replace view v_rep_daily as
select
  s.shop_id,
  (s.created_at at time zone 'Asia/Kolkata')::date         as business_date,
  count(distinct s.id)                                     as bills,
  round(sum(si.line_total), 2)                             as revenue,
  round(sum(si.line_total
        - (si.qty_base::numeric / p.units_per_strip * si.purchase_rate)), 2) as gross_margin,
  round(sum(si.line_total) / nullif(count(distinct s.id), 0), 2)             as avg_bill_value
from sales s
join sale_items si on si.sale_id = s.id
join products   p  on p.id = si.product_id
where s.is_cancelled = false
group by 1, 2;

-- Product performance over a window. Used by the "what sells" question.
create or replace view v_rep_product_sales as
select
  s.shop_id,
  si.product_id,
  p.name,
  p.manufacturer,
  (s.created_at at time zone 'Asia/Kolkata')::date as business_date,
  sum(si.qty_base)                                  as units,
  round(sum(si.line_total), 2)                      as revenue,
  round(sum(si.line_total
        - (si.qty_base::numeric / p.units_per_strip * si.purchase_rate)), 2) as margin
from sales s
join sale_items si on si.sale_id = s.id
join products   p  on p.id = si.product_id
where s.is_cancelled = false
group by 1, 2, 3, 4, 5;

-- What customers asked for and we did not have. No customer identity attached.
create or replace view v_rep_stockouts as
select
  sl.shop_id,
  coalesce(p.name, sl.search_term) as asked_for,
  (p.id is null)                   as never_stocked,
  count(*)                         as times_asked,
  max(sl.created_at)               as last_asked
from stockout_log sl
left join products p on p.id = sl.product_id
group by sl.shop_id, coalesce(p.name, sl.search_term), (p.id is null);

-- Reorder suggestions. Mirrors computeReorder() in lib/pharmacy.ts, including
-- the critical detail: demand is divided by days the item was ACTUALLY in
-- stock, not by calendar days, so a past stock-out cannot depress the
-- suggestion and cause the same item to stock out again.
create or replace view v_rep_reorder as
with sold as (
  select si.product_id,
         (s.created_at at time zone 'Asia/Kolkata')::date as d,
         sum(si.qty_base) as qty
    from sale_items si
    join sales s on s.id = si.sale_id
   where s.is_cancelled = false
     and s.created_at >= now() - interval '28 days'
   group by 1, 2
),
stats as (
  select p.id as product_id,
         coalesce(sum(sold.qty), 0)                          as units_28d,
         greatest(count(sold.d), 1)                          as days_in_stock,
         coalesce(stddev_pop(sold.qty), 0)                   as sigma
    from products p
    left join sold on sold.product_id = p.id
   group by p.id
)
select
  p.shop_id,
  p.id                                   as product_id,
  p.name,
  sup.id                                 as supplier_id,
  sup.name                               as supplier_name,
  sup.lead_time_days,
  round(st.units_28d::numeric / st.days_in_stock, 2)         as avg_daily_demand,
  ceil(1.65 * st.sigma * sqrt(sup.lead_time_days))           as safety_stock,
  ceil(st.units_28d::numeric / st.days_in_stock * sup.lead_time_days
       + 1.65 * st.sigma * sqrt(sup.lead_time_days))         as reorder_point,
  coalesce(oh.units_on_hand, 0)                              as units_on_hand,
  greatest(0, ceil(
      st.units_28d::numeric / st.days_in_stock * (sup.lead_time_days + 7)
      + 1.65 * st.sigma * sqrt(sup.lead_time_days)
      - coalesce(oh.units_on_hand, 0)))                      as suggested_order_units
from products p
join stats st on st.product_id = p.id
left join lateral (
  select sum(b.qty_available) as units_on_hand,
         mode() within group (order by b.supplier_id) as supplier_id
    from batches b where b.product_id = p.id
) oh on true
left join suppliers sup on sup.id = oh.supplier_id
where p.is_active and sup.id is not null;

-- Suppliers, so a tool can resolve a name to an id.
--
-- This is a view rather than a column grant on the table itself. A direct grant
-- would be blocked anyway: every base table has RLS forced, and the policies
-- key off auth.uid(), which is null for a role that never logs in through
-- Supabase Auth — so the table would simply return nothing. Going through a
-- view also keeps the rule honest: this role reads views, never base tables.
create or replace view v_rep_suppliers as
select id, shop_id, name, phone, lead_time_days, return_window_months
  from suppliers
 where is_active;

-- ------------------------------------------------------------ grants
-- Explicit, view by view. Nothing is granted with a wildcard, so adding a table
-- later does not silently expose it to the agent.

grant select on
  v_rep_stock, v_rep_daily, v_rep_product_sales, v_rep_stockouts, v_rep_reorder,
  v_rep_suppliers,
  v_expiry_ladder, v_returnable_to_supplier, v_dead_stock
to snm_reporting;

comment on role snm_reporting is
  'Read-only role for the owner MCP server. Views only, no PII, no writes.';
