-- Tests for migration 0007: business date, returns, profit, and the summaries.
-- Runs inside a transaction that is rolled back, so the database is unchanged.
--
--   scripts/test-db.sh        (builds a Supabase-like local database, then runs this)

\set ON_ERROR_STOP on
begin;

do $$
declare
  shop   uuid := '11111111-1111-1111-1111-111111111111';
  today  date := (now() at time zone 'Asia/Kolkata')::date;
  y      date := (now() at time zone 'Asia/Kolkata')::date - 1;
  d0     date;
  v_sale uuid := gen_random_uuid();
  v_ret  uuid;
  v_item record;
  before numeric; after numeric; expect numeric; got numeric;
  m jsonb; sum_sales numeric; sum_profit numeric; sum_bills numeric; mon date;
begin
  ------------------------------------------------------------------ 1
  -- A bill made offline at 8:55 PM yesterday that reaches the server today
  -- belongs to yesterday.
  insert into sales (id, shop_id, bill_no, device_id, client_created_at, subtotal, total)
  values (v_sale, shop, 'TEST-OFFLINE-1', 'C1',
          (y + time '20:55') at time zone 'Asia/Kolkata', 100, 100);
  if (select business_date from sales where id = v_sale) <> y then
    raise exception 'FAIL 1: offline bill dated %, expected %',
      (select business_date from sales where id = v_sale), y;
  end if;
  raise notice 'PASS 1  offline bill from 8:55 PM yesterday counts on yesterday';

  ------------------------------------------------------------------ 2
  if (daily_summary(shop, y) ->> 'late_bills')::int < 1 then
    raise exception 'FAIL 2: late bill not reported';
  end if;
  raise notice 'PASS 2  the day reports that a bill arrived late';

  ------------------------------------------------------------------ 3
  -- A counter clock set two days ahead is not trusted.
  insert into sales (shop_id, bill_no, device_id, client_created_at, subtotal, total)
  values (shop, 'TEST-CLOCK-1', 'C1', now() + interval '2 days', 10, 10);
  if not (select date_from_server and business_date = today from sales where bill_no = 'TEST-CLOCK-1') then
    raise exception 'FAIL 3: wrong-clock bill not caught';
  end if;
  raise notice 'PASS 3  a wrong counter clock falls back to server time and is flagged';

  ------------------------------------------------------------------ 4
  -- A return lowers that day's sales by exactly the refund.
  select max(business_date) into d0 from sales where bill_no like 'SNM-C1-%';
  before := (daily_summary(shop, d0) ->> 'sales')::numeric;
  select si.id, si.sale_id, si.qty_base into v_item
    from sale_items si join sales s on s.id = si.sale_id
   where s.business_date = d0 and s.bill_no like 'SNM-C1-%'
     and si.qty_base - coalesce((select sum(qty_base) from sale_return_items r where r.sale_item_id = si.id), 0) >= 1
   limit 1;
  insert into sale_returns (shop_id, sale_id, return_no, business_date)
  values (shop, v_item.sale_id, 'TEST-CN-1', d0) returning id into v_ret;
  insert into sale_return_items (return_id, sale_item_id, qty_base, refund_amount, taxable_value, gst_amount)
  values (v_ret, v_item.id, 1, 50.00, 47.62, 2.38);
  after := (daily_summary(shop, d0) ->> 'sales')::numeric;
  if after <> before - 50.00 then
    raise exception 'FAIL 4: sales went % -> %, expected a drop of exactly 50.00', before, after;
  end if;
  raise notice 'PASS 4  a ₹50 return lowers the day''s sales by exactly ₹50';

  ------------------------------------------------------------------ 5
  -- Profit is taxable value minus cost, with returns taken back out.
  select round(
           coalesce((select sum(si.taxable_value - si.qty_base::numeric / p.units_per_strip * si.purchase_rate)
                       from sales s join sale_items si on si.sale_id = s.id join products p on p.id = si.product_id
                      where s.shop_id = shop and s.business_date = d0 and not s.is_cancelled), 0)
         - coalesce((select sum(ri.taxable_value - ri.qty_base::numeric / p.units_per_strip * si.purchase_rate)
                       from sale_returns r join sale_return_items ri on ri.return_id = r.id
                       join sale_items si on si.id = ri.sale_item_id join products p on p.id = si.product_id
                      where r.shop_id = shop and r.business_date = d0), 0), 2)
    into expect;
  got := (daily_summary(shop, d0) ->> 'profit')::numeric;
  if got <> expect then
    raise exception 'FAIL 5: profit % but taxable value minus cost is %', got, expect;
  end if;
  raise notice 'PASS 5  profit = taxable value − cost (₹%), GST left out', got;

  ------------------------------------------------------------------ 6
  -- The days of a month add up exactly to the month, for this month and last.
  foreach mon in array array[date_trunc('month', today)::date,
                             (date_trunc('month', today) - interval '1 month')::date] loop
    select sum((daily_summary(shop, g::date) ->> 'sales')::numeric),
           sum((daily_summary(shop, g::date) ->> 'profit')::numeric),
           sum((daily_summary(shop, g::date) ->> 'bills')::numeric)
      into sum_sales, sum_profit, sum_bills
      from generate_series(mon, (mon + interval '1 month - 1 day')::date, interval '1 day') g;
    m := monthly_summary(shop, mon);
    if sum_sales <> (m ->> 'sales')::numeric or sum_profit <> (m ->> 'profit')::numeric
       or sum_bills <> (m ->> 'bills')::numeric then
      raise exception 'FAIL 6: % days add to sales % profit % bills %, month says % % %',
        to_char(mon, 'Mon YYYY'), sum_sales, sum_profit, sum_bills, m ->> 'sales', m ->> 'profit', m ->> 'bills';
    end if;
    raise notice 'PASS 6  % : days add up to the month (₹%, % bills)', to_char(mon, 'Mon YYYY'), m ->> 'sales', m ->> 'bills';
  end loop;

  ------------------------------------------------------------------ 7
  -- Cannot return more than was sold on the line.
  begin
    insert into sale_return_items (return_id, sale_item_id, qty_base, refund_amount, taxable_value, gst_amount)
    values (v_ret, v_item.id, v_item.qty_base + 100, 1, 1, 0);
    raise exception 'FAIL 7: over-return accepted';
  exception when others then
    if sqlerrm not like 'Only % of this line can still be returned%' then raise; end if;
  end;
  raise notice 'PASS 7  returning more than was sold is refused';

  ------------------------------------------------------------------ 8
  begin
    update sale_returns set reason = 'edited' where id = v_ret;
    raise exception 'FAIL 8: credit note edited';
  exception when others then
    if sqlerrm not like 'Credit notes cannot be changed%' then raise; end if;
  end;
  raise notice 'PASS 8  credit notes cannot be edited';

  ------------------------------------------------------------------ 9
  -- The GST pack balances: taxable + CGST + SGST by rate equals the line totals.
  m := monthly_summary(shop, (date_trunc('month', today) - interval '1 month')::date);
  select sum((r ->> 'taxable')::numeric + (r ->> 'cgst')::numeric + (r ->> 'sgst')::numeric)
    into got from jsonb_array_elements(m -> 'gst_by_rate') r;
  select sum(si.line_total) into expect
    from sales s join sale_items si on si.sale_id = s.id
   where s.shop_id = shop and not s.is_cancelled
     and date_trunc('month', s.business_date) = date_trunc('month', today) - interval '1 month';
  if got <> expect then
    raise exception 'FAIL 9: GST by rate adds to %, line totals are %', got, expect;
  end if;
  raise notice 'PASS 9  GST by rate adds back to the month''s line totals (₹%)', got;

  ------------------------------------------------------------------ 12
  -- A month in progress is compared with the same days of last month.
  m := monthly_summary(shop, today);
  select coalesce(sum((daily_summary(shop, g::date) ->> 'sales')::numeric), 0) into expect
    from generate_series((date_trunc('month', today) - interval '1 month')::date,
                         least((date_trunc('month', today) - interval '1 month')::date + extract(day from today)::int - 1,
                               date_trunc('month', today)::date - 1),
                         interval '1 day') g;
  if (m -> 'last_month_same_days' ->> 'sales')::numeric <> expect then
    raise exception 'FAIL 12: same-days comparison %, expected %', m -> 'last_month_same_days' ->> 'sales', expect;
  end if;
  raise notice 'PASS 12 this month so far is compared with the same % days of last month (₹%)',
    m -> 'last_month_same_days' ->> 'days', expect;
end $$;

------------------------------------------------------------------ 10, 11
-- Only the owner may read summaries. These need the test users created by
-- scripts/test-db.sh.
set local role authenticated;
do $$
begin
  perform set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000003', true);  -- counter staff
  perform daily_summary('11111111-1111-1111-1111-111111111111', current_date);
  raise exception 'FAIL 10: counter staff read the summary';
exception when others then
  if sqlerrm not like 'Only the owner can see sales summaries%' then raise; end if;
  raise notice 'PASS 10 counter staff cannot read sales summaries';
end $$;

do $$
begin
  perform set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', true);  -- owner
  perform daily_summary('11111111-1111-1111-1111-111111111111', current_date);
  perform monthly_summary('11111111-1111-1111-1111-111111111111', current_date);
  raise notice 'PASS 11 the owner can read both summaries';
end $$;

rollback;
