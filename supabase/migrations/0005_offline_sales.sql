-- Sri Nachiya Medicals
-- Migration 0005: accept sales that were made offline
--
-- The problem this fixes. Migration 0002 refuses any ledger row that would push
-- a batch below zero. At a live counter that is right: the sale is blocked and
-- the pharmacist is told immediately.
--
-- A bill made while the internet was down is different. The medicine has
-- already left the shop. If two counters were both offline and both sold the
-- last strips of a batch, the second one to sync would be refused, and a real
-- sale would silently drop out of the books — or the sync loop would retry it
-- forever. Refusing a fact does not un-sell the medicine.
--
-- So: a row pushed by the sync engine from the offline queue is ACCEPTED even
-- when it takes stock negative, and a discrepancy is recorded for the owner to
-- resolve with a physical count. Online sales keep the hard block.
--
-- The ledger stays the truth either way. Nothing is clamped or rewritten.

alter table stock_ledger
  add column if not exists from_offline_queue boolean not null default false;

comment on column stock_ledger.from_offline_queue is
  'True when the row was created on a device while offline and pushed later by '
  'the sync engine. Such rows may take stock negative; see stock_discrepancies.';

create table if not exists stock_discrepancies (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references shops(id) on delete cascade,
  batch_id    uuid not null references batches(id),
  product_id  uuid not null references products(id),
  ledger_id   uuid not null references stock_ledger(id),
  shortfall   integer not null check (shortfall > 0),   -- base units below zero
  device_id   text,
  detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references users(id),
  resolution  text           -- e.g. 'counted: 3 strips found on shelf B-4'
);
create index if not exists stock_discrepancies_open
  on stock_discrepancies (shop_id, detected_at desc) where resolved_at is null;

alter table stock_discrepancies enable row level security;
alter table stock_discrepancies force row level security;

create policy discrepancies_read on stock_discrepancies for select
  using (shop_id = current_shop_id());
create policy discrepancies_resolve on stock_discrepancies for update
  using (shop_id = current_shop_id() and is_owner())
  with check (shop_id = current_shop_id() and is_owner());

-- Replaces the version in 0002. Same behaviour for everything except a row
-- that came from the offline queue.
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

  if new_qty < 0 then
    if new.from_offline_queue and new.delta < 0 then
      -- Already happened in the physical world. Record it; do not refuse it.
      insert into stock_discrepancies (shop_id, batch_id, product_id, ledger_id,
                                       shortfall, device_id)
      values (new.shop_id, new.batch_id, new.product_id, new.id,
              -new_qty, new.device_id);
    else
      raise exception
        'Batch % would go negative (% units). Stock on hand is insufficient.',
        new.batch_id, new_qty;
    end if;
  end if;

  return new;
end;
$$ language plpgsql;

-- The owner sees open discrepancies through the reporting role too.
create or replace view v_rep_discrepancies as
select d.shop_id,
       p.name        as product_name,
       b.batch_no,
       d.shortfall   as units_short,
       d.device_id,
       d.detected_at
  from stock_discrepancies d
  join products p on p.id = d.product_id
  join batches  b on b.id = d.batch_id
 where d.resolved_at is null;

grant select on v_rep_discrepancies to snm_reporting;
