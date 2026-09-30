-- Sri Nachiya Medicals — seed data for testing
--
-- Run this against a DEV project, never production:
--     supabase db reset          (applies migrations, then this file)
--
-- Gives you a shop with suppliers, ~20 real Indian SKUs across GST slabs and
-- drug schedules, multiple batches per product with staggered expiry, and 60
-- days of plausible sales history. Enough to make every report and every MCP
-- tool return something real, so you can check the numbers before the shop
-- depends on them.

begin;

-- ------------------------------------------------------------ shop

insert into shops (id, name, address, city, state_code, gstin,
                   dl_number_20b, dl_number_21b, pharmacist_name, phone)
values ('11111111-1111-1111-1111-111111111111',
        'Sri Nachiya Medicals',
        'Saraswathi Complex, Ettimadai Pirivu, Ettimadai, Tamil Nadu 641112', 'Coimbatore', '33',
        -- GSTIN, drug licence numbers, pharmacist and phone come from the shop's
        -- own certificates at setup. Left empty here so no invented number is
        -- ever printed on a bill.
        null, null, null,
        null, null);

-- ------------------------------------------------------------ suppliers
-- lead_time_days feeds the reorder point; return_window_months decides which
-- near-expiry stock is still worth sending back.

insert into suppliers (id, shop_id, name, gstin, phone, lead_time_days, return_window_months) values
 ('22222222-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','Sakthi Pharma Distributors','33AABCS1234A1Z5','+91 90000 00011', 2, 3),
 ('22222222-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','Kovai Medical Agencies','33AABCK5678B1Z2','+91 90000 00022', 4, 6),
 ('22222222-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','Annai Drug House','33AABCA9012C1Z8','+91 90000 00033', 7, 3);

-- ------------------------------------------------------------ products
--
-- GST is DATA, not a constant: most medicines are 5% after the September 2025
-- rationalisation, vitamins and OTC supplements stayed at 18%. Two products
-- share a composition on purpose (Telma / Telsartan) so the substitute finder
-- has something to find.

insert into products (id, shop_id, name, generic_name, composition_key, strength, manufacturer,
                      pack_form, base_unit, units_per_strip, strips_per_box,
                      hsn_code, gst_rate, drug_schedule, rack_location) values
 ('33333333-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','Dolo 650','Paracetamol','paracetamol|650','650 mg','Micro Labs','tablet','tablet',15,10,'3004', 5,'OTC','A-1'),
 ('33333333-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','Crocin Advance','Paracetamol','paracetamol|500','500 mg','GSK','tablet','tablet',15,10,'3004', 5,'OTC','A-1'),
 ('33333333-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','Augmentin 625 Duo','Amoxicillin + Clavulanic Acid','amoxiclav|625','625 mg','GSK','tablet','tablet',10, 5,'3004', 5,'H1','B-3'),
 ('33333333-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','Azithral 500','Azithromycin','azithromycin|500','500 mg','Alembic','tablet','tablet', 5,10,'3004', 5,'H1','B-4'),
 ('33333333-0000-0000-0000-000000000005','11111111-1111-1111-1111-111111111111','Pan 40','Pantoprazole','pantoprazole|40','40 mg','Alkem','tablet','tablet',15,10,'3004', 5,'H','A-4'),
 ('33333333-0000-0000-0000-000000000006','11111111-1111-1111-1111-111111111111','Telma 40','Telmisartan','telmisartan|40','40 mg','Glenmark','tablet','tablet',15,10,'3004', 5,'H','C-2'),
 ('33333333-0000-0000-0000-000000000007','11111111-1111-1111-1111-111111111111','Telsartan 40','Telmisartan','telmisartan|40','40 mg','Dr. Reddy''s','tablet','tablet',15,10,'3004', 5,'H','C-2'),
 ('33333333-0000-0000-0000-000000000008','11111111-1111-1111-1111-111111111111','Zerodol SP','Aceclofenac + Paracetamol + Serratiopeptidase','aceclofenac-para-serra|100','100 mg','Ipca','tablet','tablet',10,10,'3004', 5,'H','A-2'),
 ('33333333-0000-0000-0000-000000000009','11111111-1111-1111-1111-111111111111','Glycomet GP 1','Metformin + Glimepiride','metformin-glimepiride|500-1','500/1 mg','USV','tablet','tablet',15,10,'3004', 5,'H','C-1'),
 ('33333333-0000-0000-0000-000000000010','11111111-1111-1111-1111-111111111111','Ecosprin 75','Aspirin','aspirin|75','75 mg','USV','tablet','tablet',14,10,'3004', 5,'H','C-1'),
 ('33333333-0000-0000-0000-000000000011','11111111-1111-1111-1111-111111111111','Thyronorm 50','Thyroxine','thyroxine|50','50 mcg','Abbott','tablet','tablet',30, 5,'3004', 5,'H','C-3'),
 ('33333333-0000-0000-0000-000000000012','11111111-1111-1111-1111-111111111111','Ascoril LS Syrup','Levosalbutamol + Ambroxol + Guaiphenesin','ascoril-ls|100ml','100 ml','Glenmark','syrup','ml', 1, 1,'3004', 5,'H','D-1'),
 ('33333333-0000-0000-0000-000000000013','11111111-1111-1111-1111-111111111111','Cheston Cold','Cetirizine + Phenylephrine + Paracetamol','cheston-cold|tab','—','Cipla','tablet','tablet',10,10,'3004', 5,'OTC','A-3'),
 ('33333333-0000-0000-0000-000000000014','11111111-1111-1111-1111-111111111111','Shelcal 500','Calcium Carbonate + Vitamin D3','calcium-d3|500','500 mg','Torrent','tablet','tablet',15,10,'3004',12,'OTC','B-1'),
 ('33333333-0000-0000-0000-000000000015','11111111-1111-1111-1111-111111111111','Becosules','Vitamin B-complex + Vitamin C','bcomplex-c|cap','—','Pfizer','capsule','capsule',20, 5,'3004',18,'OTC','B-2'),
 ('33333333-0000-0000-0000-000000000016','11111111-1111-1111-1111-111111111111','Volini Gel','Diclofenac topical','diclofenac-gel|30g','30 g','Sun Pharma','gel','piece', 1, 1,'3004', 5,'OTC','D-2'),
 ('33333333-0000-0000-0000-000000000017','11111111-1111-1111-1111-111111111111','Betadine Ointment','Povidone Iodine','povidone-iodine|20g','20 g','Win-Medicare','ointment','piece', 1, 1,'3004', 5,'OTC','D-2'),
 ('33333333-0000-0000-0000-000000000018','11111111-1111-1111-1111-111111111111','Accu-Chek Active Strips','Blood glucose test strips','glucose-strips|50','50 strips','Roche','device','piece', 1, 1,'3822', 5,'OTC','E-1'),
 ('33333333-0000-0000-0000-000000000019','11111111-1111-1111-1111-111111111111','Montair LC','Montelukast + Levocetirizine','montelukast-levocet|10-5','10/5 mg','Cipla','tablet','tablet',10,10,'3004', 5,'H','A-5'),
 ('33333333-0000-0000-0000-000000000020','11111111-1111-1111-1111-111111111111','Omnacortil 10','Prednisolone','prednisolone|10','10 mg','Macleods','tablet','tablet',10,10,'3004', 5,'H','B-5');

-- barcodes: only some packs carry a scannable code, which is the real situation
insert into product_barcodes (shop_id, product_id, code, code_type, pack_level) values
 ('11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000001','8901234567890','EAN13','strip'),
 ('11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000003','8901030865275','EAN13','strip'),
 ('11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000014','8904159632017','EAN13','strip');

-- ------------------------------------------------------------ batches
--
-- Staggered expiry on purpose, so every bucket of the expiry ladder is
-- populated: one already-expired batch, one inside 30 days, several in the
-- 91-180 return window, and the rest healthy.
--
-- qty_available is left at 0 here. It is NEVER set directly — the opening_stock
-- ledger rows below are what move it, via the trigger. That is the whole point
-- of the design and the seed file follows the same rule as the app.

insert into batches (id, shop_id, product_id, batch_no, expiry_date, mfg_date, mrp, purchase_rate, supplier_id) values
 ('44444444-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000001','DL2291', (current_date + 24),  current_date - 400,  33.10,  25.40,'22222222-0000-0000-0000-000000000001'),
 ('44444444-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000001','DL3310', (current_date + 410), current_date - 120,  33.10,  25.40,'22222222-0000-0000-0000-000000000001'),
 ('44444444-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000002','CR4410', (current_date + 388), current_date - 140,  30.28,  22.90,'22222222-0000-0000-0000-000000000001'),
 ('44444444-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000003','AG7712', (current_date + 300), current_date - 200, 223.50, 171.20,'22222222-0000-0000-0000-000000000002'),
 ('44444444-0000-0000-0000-000000000005','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000005','PN1180', (current_date + 118), current_date - 300, 148.00, 112.00,'22222222-0000-0000-0000-000000000001'),
 ('44444444-0000-0000-0000-000000000006','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000005','PN2240', (current_date + 520), current_date - 60,  151.00, 115.60,'22222222-0000-0000-0000-000000000001'),
 ('44444444-0000-0000-0000-000000000007','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000006','TM4402', (current_date + 140), current_date - 280, 139.50, 104.30,'22222222-0000-0000-0000-000000000002'),
 ('44444444-0000-0000-0000-000000000008','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000007','TS9021', (current_date + 365), current_date - 100, 132.00,  98.70,'22222222-0000-0000-0000-000000000002'),
 ('44444444-0000-0000-0000-000000000009','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000008','ZD5510', (current_date + 58),  current_date - 360, 118.00,  88.20,'22222222-0000-0000-0000-000000000001'),
 ('44444444-0000-0000-0000-000000000010','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000008','ZD6620', (current_date + 430), current_date - 90,  121.00,  90.40,'22222222-0000-0000-0000-000000000001'),
 ('44444444-0000-0000-0000-000000000011','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000009','GM3341', (current_date + 205), current_date - 240, 146.50, 110.90,'22222222-0000-0000-0000-000000000002'),
 ('44444444-0000-0000-0000-000000000012','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000010','EC7788', (current_date + 160), current_date - 260,  12.50,   9.10,'22222222-0000-0000-0000-000000000001'),
 ('44444444-0000-0000-0000-000000000013','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000011','TH5512', (current_date + 150), current_date - 210, 168.00, 128.40,'22222222-0000-0000-0000-000000000002'),
 ('44444444-0000-0000-0000-000000000014','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000012','AS2210', (current_date + 96),  current_date - 270, 128.00,  96.50,'22222222-0000-0000-0000-000000000003'),
 ('44444444-0000-0000-0000-000000000015','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000013','CH1190', (current_date + 175), current_date - 190,  78.00,  58.20,'22222222-0000-0000-0000-000000000003'),
 ('44444444-0000-0000-0000-000000000016','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000014','SH8801', (current_date + 280), current_date - 150, 135.00, 101.20,'22222222-0000-0000-0000-000000000002'),
 ('44444444-0000-0000-0000-000000000017','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000015','BC1120', (current_date + 340), current_date - 130,  48.00,  35.90,'22222222-0000-0000-0000-000000000003'),
 ('44444444-0000-0000-0000-000000000018','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000016','VL3020', (current_date + 220), current_date - 170, 145.00, 109.00,'22222222-0000-0000-0000-000000000003'),
 ('44444444-0000-0000-0000-000000000019','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000017','BT4410', (current_date + 165), current_date - 200, 132.00,  99.50,'22222222-0000-0000-0000-000000000003'),
 ('44444444-0000-0000-0000-000000000020','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000018','AC9001', (current_date + 310), current_date - 110, 940.00, 782.00,'22222222-0000-0000-0000-000000000002'),
 ('44444444-0000-0000-0000-000000000021','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000019','MN2280', (current_date + 400), current_date - 80,  185.00, 139.20,'22222222-0000-0000-0000-000000000001'),
 -- already expired: shows up in the ladder and must never be sellable
 ('44444444-0000-0000-0000-000000000022','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000020','OM1102', (current_date - 12),  current_date - 730,  64.00,  47.80,'22222222-0000-0000-0000-000000000003');

-- Opening stock. Quantities in BASE UNITS (tablets, ml, pieces).
-- Azithral 500 (product ...004) is deliberately given no stock, so the
-- stock-out and substitute paths have something to trigger on.
insert into stock_ledger (shop_id, product_id, batch_id, delta, reason, note)
select '11111111-1111-1111-1111-111111111111', b.product_id, b.id, v.qty, 'opening_stock', 'Seed'
from (values
 ('44444444-0000-0000-0000-000000000001',  675),
 ('44444444-0000-0000-0000-000000000002', 4500),
 ('44444444-0000-0000-0000-000000000003', 3300),
 ('44444444-0000-0000-0000-000000000004',  600),
 ('44444444-0000-0000-0000-000000000005', 1800),
 ('44444444-0000-0000-0000-000000000006', 2250),
 ('44444444-0000-0000-0000-000000000007', 1350),
 ('44444444-0000-0000-0000-000000000008', 1125),
 ('44444444-0000-0000-0000-000000000009',  400),
 ('44444444-0000-0000-0000-000000000010', 2000),
 ('44444444-0000-0000-0000-000000000011', 2700),
 ('44444444-0000-0000-0000-000000000012', 1400),
 ('44444444-0000-0000-0000-000000000013', 1500),
 ('44444444-0000-0000-0000-000000000014',   22),
 ('44444444-0000-0000-0000-000000000015',  900),
 ('44444444-0000-0000-0000-000000000016', 1575),
 ('44444444-0000-0000-0000-000000000017', 3200),
 ('44444444-0000-0000-0000-000000000018',   18),
 ('44444444-0000-0000-0000-000000000019',   26),
 ('44444444-0000-0000-0000-000000000020',   14),
 ('44444444-0000-0000-0000-000000000021', 1200),
 ('44444444-0000-0000-0000-000000000022',  300)
) as v(batch_id, qty)
join batches b on b.id = v.batch_id::uuid;

-- ------------------------------------------------------------ sales history
--
-- 60 days of bills so the analytics have something to chew on: weekday/weekend
-- shape, a monsoon lift on fever and cough lines, and enough variance for the
-- reorder engine's sigma to be meaningful.

-- Bills are immutable once written (see forbid_sale_edit in 0002), so totals
-- must be known at INSERT time. The real POS works the same way: it computes
-- the whole bill on the client, then writes sales first and sale_items second,
-- because sale_items carries the foreign key. The seed mirrors that order
-- rather than inserting a bill and updating its totals afterwards.

create temporary table _draft_line (
  bill_id     uuid,
  product_id  uuid,
  batch_id    uuid,
  qty_base    int,
  mrp         numeric,
  unit_price  numeric,
  purchase_rate numeric,
  gst_rate    numeric,
  taxable     numeric,
  gst         numeric,
  gross       numeric
) on commit drop;

create temporary table _draft_bill (
  bill_id    uuid,
  bill_no    text,
  created_at timestamptz,
  payment    payment_mode
) on commit drop;

do $$
declare
  d          date;
  bill_id    uuid;
  bill_count int;
  i          int;
  j          int;
  v_batch    record;
  v_qty      int;
  v_unit     numeric;
  v_gross    numeric;
  v_taxable  numeric;
  -- running per-batch reservation, so the draft cannot oversell a batch before
  -- the ledger rows are written
  v_reserved int;
  seq        int := 1;
  weekday    int;
begin
  for d in select generate_series(current_date - 59, current_date - 1, '1 day')::date loop
    weekday := extract(isodow from d);
    -- Sundays busiest, midweek quietest. Roughly the shape of a real shop.
    bill_count := case when weekday = 7 then 22 when weekday = 6 then 18 else 12 end
                  + (random() * 6)::int;

    for i in 1..bill_count loop
      bill_id := gen_random_uuid();

      insert into _draft_bill values (
        bill_id,
        'SNM-C1-' || lpad(seq::text, 6, '0'),
        d + make_interval(hours => 9 + (random()*12)::int, mins => (random()*59)::int),
        (array['cash','upi','cash','upi','card'])[1 + (random()*4)::int]::payment_mode);
      seq := seq + 1;

      for j in 1..(1 + (random()*3)::int) loop
        -- Sell only from healthy batches. Near-expiry stock exists precisely
        -- BECAUSE it did not move — a slow mover is how stock reaches its
        -- expiry window with quantity still on the shelf. Draining those here
        -- would empty the expiry ladder and hide the reports that matter most.
        select b.id, b.product_id, b.mrp, b.purchase_rate, b.qty_available,
               p.units_per_strip, p.gst_rate
          into v_batch
          from batches b
          join products p on p.id = b.product_id
         where b.qty_available > 200
           and b.expiry_date > current_date + 90
         order by random()
         limit 1;

        continue when v_batch.id is null;

        select coalesce(sum(qty_base), 0) into v_reserved
          from _draft_line where batch_id = v_batch.id;

        v_qty := (array[10, 15, 15, 30, 10, 20])[1 + (random()*5)::int];
        continue when v_qty + v_reserved > v_batch.qty_available;

        v_unit    := v_batch.mrp / v_batch.units_per_strip;
        v_gross   := round(v_unit * v_qty, 2);
        v_taxable := round(v_gross * 100 / (100 + v_batch.gst_rate), 2);

        insert into _draft_line values (
          bill_id, v_batch.product_id, v_batch.id, v_qty, v_batch.mrp,
          round(v_unit, 4), v_batch.purchase_rate, v_batch.gst_rate,
          v_taxable, v_gross - v_taxable, v_gross);
      end loop;
    end loop;
  end loop;
end $$;

-- Drop bills that ended up with no lines (every batch was too low that day).
delete from _draft_bill b
 where not exists (select 1 from _draft_line l where l.bill_id = b.bill_id);

-- Write the bills, totals already known. GST is backed OUT of the MRP, never
-- added on top, and the payable is rounded to the nearest rupee exactly once.
-- A bill containing a Schedule H1 line cannot be saved without prescriber and
-- patient details — enforced by enforce_h1_details() on sale_items insert. The
-- seed fills them in for exactly those bills, which also gives the H1 register
-- report real rows to print. Names below are fictional.
-- synced_at = created_at: these bills went online the moment they were made,
-- so none of them should count as a late, offline bill.
insert into sales (id, shop_id, bill_no, device_id, payment_mode, created_at, synced_at,
                   subtotal, cgst, sgst, round_off, total,
                   prescriber_name, patient_name, patient_address)
select b.bill_id, '11111111-1111-1111-1111-111111111111', b.bill_no, 'C1',
       b.payment, b.created_at, b.created_at,
       t.gross,
       round(t.gst / 2, 2),
       t.gst - round(t.gst / 2, 2),
       round(t.gross) - t.gross,
       round(t.gross),
       case when h.has_h1 then
         (array['Dr. S. Ramanathan','Dr. Priya Venkatesh','Dr. A. Krishnamoorthy',
                'Dr. Lakshmi Narayanan'])[1 + (abs(hashtext(b.bill_id::text)) % 4)] end,
       case when h.has_h1 then
         (array['M. Suresh','K. Anitha','R. Devi','P. Ganesan',
                'S. Meena'])[1 + (abs(hashtext(b.bill_no)) % 5)] end,
       case when h.has_h1 then
         (array['Saibaba Colony, Coimbatore','R.S. Puram, Coimbatore',
                'Ganapathy, Coimbatore','Peelamedu, Coimbatore'])
                [1 + (abs(hashtext(b.bill_no || 'a')) % 4)] end
  from _draft_bill b
  join (select bill_id, sum(gross) as gross, sum(gst) as gst
          from _draft_line group by bill_id) t on t.bill_id = b.bill_id
  join lateral (
    select exists (
      select 1 from _draft_line l
        join products p on p.id = l.product_id
       where l.bill_id = b.bill_id and p.drug_schedule = 'H1') as has_h1
  ) h on true;

insert into sale_items (sale_id, product_id, batch_id, qty_base, mrp, unit_price,
                        purchase_rate, gst_rate, taxable_value, gst_amount, line_total)
select bill_id, product_id, batch_id, qty_base, mrp, unit_price,
       purchase_rate, gst_rate, taxable, gst, gross
  from _draft_line;

-- The ledger rows are what actually move stock; batches.qty_available is only
-- their cached sum.
insert into stock_ledger (shop_id, product_id, batch_id, delta, reason,
                          ref_type, ref_id, created_at)
select '11111111-1111-1111-1111-111111111111', l.product_id, l.batch_id,
       -l.qty_base, 'sale', 'sale', l.bill_id, b.created_at
  from _draft_line l
  join _draft_bill b on b.bill_id = l.bill_id;

-- Missed requests. The best reorder signal there is, because it measures
-- demand the sales figures cannot see.
insert into stockout_log (shop_id, search_term, product_id, created_at) values
 ('11111111-1111-1111-1111-111111111111','Azithral 500','33333333-0000-0000-0000-000000000004', now() - interval '1 day'),
 ('11111111-1111-1111-1111-111111111111','Azithral 500','33333333-0000-0000-0000-000000000004', now() - interval '2 days'),
 ('11111111-1111-1111-1111-111111111111','Azithral 500','33333333-0000-0000-0000-000000000004', now() - interval '4 days'),
 ('11111111-1111-1111-1111-111111111111','Zincovit',    null,                                   now() - interval '2 days'),
 ('11111111-1111-1111-1111-111111111111','Zincovit',    null,                                   now() - interval '5 days'),
 ('11111111-1111-1111-1111-111111111111','Dettol 500ml',null,                                   now() - interval '3 days');

-- ------------------------------------------------------------ returns
--
-- About one bill in fifty comes back: one strip, refunded in cash on the same
-- day, with the stock put back. Gives the summaries real returns to subtract.
-- Returns belong in migration 0007's tables; skipped if they don't exist yet.
do $$
declare
  r record; v_ret uuid; n int := 1;
begin
  if to_regclass('public.sale_returns') is null then return; end if;
  for r in
    select si.id as item_id, si.sale_id, si.product_id, si.batch_id, si.qty_base,
           si.line_total, si.taxable_value, si.gst_amount, s.business_date, s.created_at,
           p.units_per_strip
      from sale_items si
      join sales s    on s.id = si.sale_id
      join products p on p.id = si.product_id
     where si.qty_base >= p.units_per_strip and p.units_per_strip > 1
       and abs(hashtext(si.id::text)) % 50 = 0
  loop
    insert into sale_returns (shop_id, sale_id, return_no, business_date, refund_mode, reason, created_at)
    values ('11111111-1111-1111-1111-111111111111', r.sale_id, 'SNM-CN-' || lpad(n::text, 6, '0'),
            r.business_date, 'cash', 'Customer returned unopened strip', r.created_at)
    returning id into v_ret;
    -- Refund one strip, in proportion to what the line charged.
    insert into sale_return_items (return_id, sale_item_id, qty_base, refund_amount, taxable_value, gst_amount)
    values (v_ret, r.item_id, r.units_per_strip,
            round(r.line_total    * r.units_per_strip / r.qty_base, 2),
            round(r.taxable_value * r.units_per_strip / r.qty_base, 2),
            round(r.line_total    * r.units_per_strip / r.qty_base, 2)
              - round(r.taxable_value * r.units_per_strip / r.qty_base, 2));
    insert into stock_ledger (shop_id, product_id, batch_id, delta, reason, ref_type, ref_id, created_at)
    values ('11111111-1111-1111-1111-111111111111', r.product_id, r.batch_id,
            r.units_per_strip, 'sale_return', 'sale_return', v_ret, r.created_at);
    n := n + 1;
  end loop;
end $$;

commit;

-- ------------------------------------------------------------ verify
--
-- The invariant: the ledger must explain every balance. If this returns any
-- rows, something is wrong and the ledger is the truth.
--    select * from rebuild_batch_quantities('11111111-1111-1111-1111-111111111111');
