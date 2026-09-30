-- Sri Nachiya Medicals
-- Migration 0003: Row Level Security
--
-- Written before the UI, not after. Two payoffs:
--   1. A leaked anon key cannot read another shop's data.
--   2. Multi-shop later costs nothing — the isolation is already here.

-- Supabase creates the `authenticated` role for us. Create it if absent so
-- these migrations also apply to a plain Postgres — a local instance for
-- testing, or a self-hosted server later.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end $$;

-- ------------------------------------------------------------ helpers

create or replace function current_shop_id() returns uuid as $$
  select shop_id from users where id = auth.uid();
$$ language sql stable security definer;

create or replace function current_role_name() returns user_role as $$
  select role from users where id = auth.uid();
$$ language sql stable security definer;

create or replace function is_owner() returns boolean as $$
  select coalesce(current_role_name() = 'owner', false);
$$ language sql stable security definer;

create or replace function can_dispense() returns boolean as $$
  select coalesce(current_role_name() in ('owner','pharmacist','counter_staff'), false);
$$ language sql stable security definer;

-- ------------------------------------------------------------ enable RLS

do $$
declare t text;
begin
  foreach t in array array[
    'shops','users','products','product_barcodes','suppliers','batches',
    'stock_ledger','purchases','purchase_items','sales','sale_items',
    'customers','credit_ledger','stockout_log','audit_log','settings'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end $$;

-- ------------------------------------------------------------ shop isolation
-- Every table carrying shop_id gets the same read/write fence.

do $$
declare t text;
begin
  foreach t in array array[
    'products','product_barcodes','suppliers','batches','purchases',
    'sales','customers','credit_ledger','stockout_log','settings'
  ] loop
    execute format($f$
      create policy %1$s_read on %1$I for select
        using (shop_id = current_shop_id());
      create policy %1$s_write on %1$I for insert
        with check (shop_id = current_shop_id());
      create policy %1$s_update on %1$I for update
        using (shop_id = current_shop_id())
        with check (shop_id = current_shop_id());
    $f$, t);
  end loop;
end $$;

create policy shops_read on shops for select
  using (id = current_shop_id());
create policy shops_update on shops for update
  using (id = current_shop_id() and is_owner());

create policy users_read on users for select
  using (shop_id = current_shop_id());
create policy users_manage on users for all
  using (shop_id = current_shop_id() and is_owner())
  with check (shop_id = current_shop_id() and is_owner());

-- ------------------------------------------------------------ the ledger
-- Insert-only for everyone; the append-only triggers in 0002 handle the rest.
-- Nobody gets UPDATE or DELETE, not even the owner.

create policy ledger_read on stock_ledger for select
  using (shop_id = current_shop_id());
create policy ledger_insert on stock_ledger for insert
  with check (shop_id = current_shop_id() and can_dispense());

-- ------------------------------------------------------------ child tables
-- No shop_id column of their own; fence via the parent.

create policy sale_items_read on sale_items for select
  using (exists (select 1 from sales s
                  where s.id = sale_items.sale_id and s.shop_id = current_shop_id()));
create policy sale_items_insert on sale_items for insert
  with check (exists (select 1 from sales s
                       where s.id = sale_items.sale_id and s.shop_id = current_shop_id()));

create policy purchase_items_read on purchase_items for select
  using (exists (select 1 from purchases p
                  where p.id = purchase_items.purchase_id and p.shop_id = current_shop_id()));
create policy purchase_items_write on purchase_items for all
  using (exists (select 1 from purchases p
                  where p.id = purchase_items.purchase_id and p.shop_id = current_shop_id()))
  with check (exists (select 1 from purchases p
                       where p.id = purchase_items.purchase_id and p.shop_id = current_shop_id()));

create policy audit_read on audit_log for select
  using (shop_id = current_shop_id() and is_owner());
create policy audit_insert on audit_log for insert
  with check (shop_id = current_shop_id());

-- ------------------------------------------------------------ cost price
--
-- Counter staff bill customers. They have no business seeing what the shop paid
-- the distributor, or what the margin is. Postgres has no column-level RLS, so
-- the app reads batches through this view and never touches the table directly.

create or replace view v_batches_for_counter
with (security_invoker = true) as
select
  b.id, b.shop_id, b.product_id, b.batch_no, b.expiry_date,
  b.mrp, b.qty_available, b.supplier_id,
  case when is_owner() then b.purchase_rate else null end as purchase_rate
from batches b;

revoke all on batches from authenticated;
grant select (id, shop_id, product_id, batch_no, expiry_date, mrp, qty_available, supplier_id)
  on batches to authenticated;
grant insert, update on batches to authenticated;
grant select on v_batches_for_counter to authenticated;

-- Owner-only reporting views.
create or replace view v_margin_report
with (security_invoker = true) as
select * from v_daily_sales where is_owner();
