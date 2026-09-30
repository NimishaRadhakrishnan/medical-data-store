-- Sri Nachiya Medicals
-- Migration 0006: how prices and products get changed, and by whom
--
-- Fixes four holes found by testing 0001-0005 as real logged-in users:
--   1. counter staff could UPDATE a batch's MRP or cost price
--   2. counter staff could set batches.qty_available directly, skipping the
--      ledger — breaking the one rule the whole design rests on
--   3. counter staff could change a product's GST rate, schedule or pack size
--   4. v_batches_for_counter failed for everyone, the owner included, because a
--      security_invoker view needs column privileges the role no longer had
--
-- The rules after this migration:
--
--   Stock   changes only through stock_ledger. Nobody updates it directly.
--   Price   (MRP, cost) changes only through set_batch_price(): owner only,
--           a reason is required, and every change is kept in price_changes.
--   Product details: owner can change anything; the pharmacist can change
--           rack, reorder levels and storage; counter staff can change nothing.
--           Pack size is locked while stock is on hand. Every change is written
--           to audit_log with its old and new value.
--
-- Old bills never change. sale_items keeps its own copy of MRP, cost and GST
-- rate from the moment of sale, so editing a product today cannot rewrite
-- yesterday's invoice or yesterday's margin.

-- ============================================================ stock

-- The app may create batches (goods receipt) but never edit them directly.
revoke update on batches from authenticated;

-- The ledger trigger still has to move qty_available, so it now runs with its
-- owner's rights rather than the caller's.
alter function apply_ledger_to_batch() security definer set search_path = public, pg_temp;

-- A new batch starts empty. Stock arrives as a 'purchase' or 'opening_stock'
-- ledger row, so the ledger explains every unit from the first one.
create or replace function batches_start_empty() returns trigger as $$
begin
  if new.qty_available <> 0 then
    raise exception
      'A new batch starts at zero stock. Add the quantity as a purchase or opening_stock ledger row.';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists batches_start_empty on batches;
create trigger batches_start_empty before insert on batches
  for each row execute function batches_start_empty();

-- ============================================================ price

create table if not exists price_changes (
  id                 uuid primary key default gen_random_uuid(),
  shop_id            uuid not null references shops(id) on delete cascade,
  batch_id           uuid not null references batches(id),
  product_id         uuid not null references products(id),
  old_mrp            numeric(12,2) not null,
  new_mrp            numeric(12,2) not null,
  old_purchase_rate  numeric(12,2) not null,
  new_purchase_rate  numeric(12,2) not null,
  reason             text not null,
  changed_by         uuid references users(id),
  changed_at         timestamptz not null default now()
);
create index if not exists price_changes_by_product
  on price_changes (product_id, changed_at desc);

alter table price_changes enable row level security;
alter table price_changes force row level security;

-- Cost price is in here, so only the owner reads it. Nobody inserts directly:
-- rows come only from set_batch_price().
drop policy if exists price_changes_owner_read on price_changes;
create policy price_changes_owner_read on price_changes for select
  using (shop_id = current_shop_id() and is_owner());
revoke insert, update, delete on price_changes from authenticated;

/**
 * The one way to change a batch's MRP or cost price.
 *
 * Normal price rises need no edit at all: the next delivery arrives as a new
 * batch with its own MRP and cost, and FEFO sells the old stock at the old
 * price first. This function is for corrections — a typo at goods receipt, or
 * a manufacturer-announced MRP revision on stock already on the shelf.
 *
 * MRP must match what is printed on the pack. Charging above the printed MRP is
 * an offence; to sell cheaper, give a discount at the counter instead.
 *
 * Pass NULL for a value you are not changing.
 */
create or replace function set_batch_price(
  p_batch_id       uuid,
  p_mrp            numeric,
  p_purchase_rate  numeric,
  p_reason         text
) returns table (batch_id uuid, mrp numeric, purchase_rate numeric)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  b         batches%rowtype;
  v_mrp     numeric;
  v_cost    numeric;
begin
  if not is_owner() then
    raise exception 'Only the owner can change prices.';
  end if;

  select * into b from batches where id = p_batch_id for update;
  if not found or b.shop_id is distinct from current_shop_id() then
    raise exception 'Batch not found.';
  end if;

  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Give a reason for the change, e.g. "typo at goods receipt".';
  end if;

  v_mrp  := coalesce(p_mrp, b.mrp);
  v_cost := coalesce(p_purchase_rate, b.purchase_rate);

  if v_mrp <= 0 then
    raise exception 'MRP must be more than zero.';
  end if;
  if v_cost < 0 then
    raise exception 'Cost price cannot be negative.';
  end if;
  if v_cost > v_mrp then
    raise exception
      'Cost ₹% is above MRP ₹%. Every sale at MRP would lose money — check for a typo.',
      v_cost, v_mrp;
  end if;

  if v_mrp = b.mrp and v_cost = b.purchase_rate then
    return query select b.id, b.mrp, b.purchase_rate;   -- nothing to change
    return;
  end if;

  insert into price_changes (shop_id, batch_id, product_id,
                             old_mrp, new_mrp, old_purchase_rate, new_purchase_rate,
                             reason, changed_by)
  values (b.shop_id, b.id, b.product_id,
          b.mrp, v_mrp, b.purchase_rate, v_cost,
          trim(p_reason), auth.uid());

  update batches
     set mrp = v_mrp, purchase_rate = v_cost, updated_at = now()
   where id = b.id;

  return query select b.id, v_mrp, v_cost;
end;
$$;

revoke all on function set_batch_price(uuid, numeric, numeric, text) from public;
grant execute on function set_batch_price(uuid, numeric, numeric, text) to authenticated;

-- ============================================================ reading batches

-- Replaces the broken security_invoker version from 0003. This view runs with
-- its owner's rights, so it must fence the shop itself — which it does — and it
-- shows cost price to the owner only.
drop view if exists v_batches_for_counter;
create view v_batches_for_counter as
select
  b.id, b.shop_id, b.product_id, b.batch_no, b.expiry_date,
  b.mrp, b.qty_available, b.supplier_id,
  case when is_owner() then b.purchase_rate end as purchase_rate,
  b.updated_at
from batches b
where b.shop_id = current_shop_id();

grant select on v_batches_for_counter to authenticated;

-- ============================================================ products

-- Columns grouped by who may change them.
--   pharmacist + owner : rack_location, reorder_point, reorder_qty, is_refrigerated
--   owner only         : everything else — name, composition, manufacturer,
--                        GST rate, HSN, drug schedule, pack size, active flag
create or replace function guard_product_update() returns trigger
language plpgsql as $$
declare
  v_role   user_role;
  v_stock  boolean;
  v_diff   jsonb;
begin
  new.updated_at := now();

  -- Migrations, imports and the service role are not app users; the role rules
  -- apply to people logged in through the app.
  if current_user = 'authenticated' then
    v_role := current_role_name();

    if v_role is null or v_role = 'counter_staff' then
      raise exception 'Counter staff cannot edit products. Ask the owner or pharmacist.';
    end if;

    if v_role = 'pharmacist' and
       (new.name, new.generic_name, new.composition_key, new.strength, new.manufacturer,
        new.pack_form, new.base_unit, new.units_per_strip, new.strips_per_box,
        new.hsn_code, new.gst_rate, new.drug_schedule, new.is_active)
       is distinct from
       (old.name, old.generic_name, old.composition_key, old.strength, old.manufacturer,
        old.pack_form, old.base_unit, old.units_per_strip, old.strips_per_box,
        old.hsn_code, old.gst_rate, old.drug_schedule, old.is_active)
    then
      raise exception
        'Only the owner can change a product''s name, GST, schedule or pack size. You can change rack and reorder levels.';
    end if;
  end if;

  -- Stock is counted in base units (tablets, ml). Changing the pack size while
  -- stock exists would silently change what that count means — 300 tablets
  -- would become 300 of something else. Applies to everyone, admins included.
  if (new.units_per_strip, new.strips_per_box, new.base_unit)
     is distinct from (old.units_per_strip, old.strips_per_box, old.base_unit)
  then
    select exists (select 1 from batches
                    where product_id = new.id and qty_available <> 0)
      into v_stock;
    if v_stock then
      raise exception
        'This product has stock on hand. Pack size can only change once its stock is zero — or create a new product for the new pack.';
    end if;
  end if;

  if new.gst_rate < 0 or new.gst_rate > 40 then
    raise exception 'GST rate % is not a valid rate.', new.gst_rate;
  end if;

  -- Record exactly what changed.
  select jsonb_object_agg(o.key, jsonb_build_object('from', o.value, 'to', n.value))
    into v_diff
    from jsonb_each(to_jsonb(old)) o
    join jsonb_each(to_jsonb(new)) n on n.key = o.key
   where o.value is distinct from n.value
     and o.key <> 'updated_at';

  if v_diff is not null then
    insert into audit_log (shop_id, user_id, action, entity, entity_id, detail)
    values (new.shop_id, auth.uid(), 'product.update', 'product', new.id, v_diff);
  end if;

  return new;
end;
$$;

drop trigger if exists products_guard_update on products;
create trigger products_guard_update before update on products
  for each row execute function guard_product_update();

-- Products are discontinued, never deleted: bills and the ledger point at them.
revoke delete on products from authenticated;

-- ============================================================ history for the owner

-- One timeline per product: price corrections and detail edits together.
create or replace view v_product_history as
select pc.shop_id, pc.product_id, pc.changed_at as at,
       u.full_name as by_whom,
       'price' as kind,
       -- Mention only what actually changed.
       'Batch ' || b.batch_no || ': ' || concat_ws(', ',
         case when pc.old_mrp <> pc.new_mrp
              then format('MRP ₹%s → ₹%s', pc.old_mrp, pc.new_mrp) end,
         case when pc.old_purchase_rate <> pc.new_purchase_rate
              then format('cost ₹%s → ₹%s', pc.old_purchase_rate, pc.new_purchase_rate) end
       ) as change,
       pc.reason
  from price_changes pc
  join batches b on b.id = pc.batch_id
  left join users u on u.id = pc.changed_by
union all
select a.shop_id, a.entity_id, a.created_at,
       u.full_name,
       'details',
       (select string_agg(format('%s: %s → %s', key, value->'from', value->'to'), '; ')
          from jsonb_each(a.detail)),
       null
  from audit_log a
  left join users u on u.id = a.user_id
 where a.action = 'product.update';

-- Runs with its owner's rights, so fence the shop and the role here.
create or replace view v_product_history_owner as
select * from v_product_history
 where shop_id = current_shop_id() and is_owner();

revoke all on v_product_history from authenticated;
grant select on v_product_history_owner to authenticated;
