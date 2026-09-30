#!/usr/bin/env node
/**
 * Sri Nachiya Medicals — owner reporting MCP server.
 *
 * Lets the owner ask the shop questions in plain language from Claude on his
 * laptop. It runs over stdio, so it lives on that machine; reaching it from a
 * phone needs it hosted as a remote (HTTP) MCP server with proper sign-in:
 *
 *   "What's expiring next month and what's it worth?"
 *   "Which items did people ask for that we didn't have this week?"
 *   "How did Sunday compare to last Sunday?"
 *   "What should I order from Sakthi Pharma?"
 *
 * Deliberately NOT exposed: a run_sql tool. Free-form SQL is an injection
 * surface wearing a helpful hat — an agent that can be talked into writing a
 * query can be talked into writing the wrong one. Every tool below takes typed
 * parameters and runs a fixed, parameterised statement.
 *
 * Also deliberately absent: anything returning a customer name, phone number,
 * prescriber, or patient. Bill-level rows are not reachable from here at all.
 * The reporting role (migration 0004) has no grant that would allow it.
 *
 * This server holds owner-level credentials because margin and cost price are
 * the point of it. It therefore belongs on the owner's device only, never on
 * the counter PC.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { query, asTable, textResult, errorResult, shopId, closePool } from './db.ts';

const server = new McpServer({
  name: 'sri-nachiya-medicals',
  version: '1.0.0',
});

/** Tools here only read. Saying so lets a client skip confirmation prompts. */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

// ============================================================ sales

server.registerTool('sales_summary', {
  title: 'Sales and margin for a date range',
  description:
    'Daily revenue, bill count, average bill value and true gross margin between ' +
    'two dates. Margin uses the purchase rate captured at the time of sale, so it ' +
    'stays correct even after a distributor raises prices. Use this for questions ' +
    'like "how was last week" or "compare Sunday to last Sunday".',
  inputSchema: {
    date_from: isoDate.describe('First business date, inclusive'),
    date_to: isoDate.describe('Last business date, inclusive'),
  },
  annotations: READ_ONLY,
}, async ({ date_from, date_to }) => {
  try {
    const res = await query(
      `select business_date, bills, revenue, gross_margin, avg_bill_value,
              round(gross_margin * 100 / nullif(revenue, 0), 1) as margin_pct
         from v_rep_daily
        where shop_id = $1 and business_date between $2 and $3
        order by business_date`,
      [shopId(), date_from, date_to],
    );
    return textResult(asTable(res, `No sales recorded between ${date_from} and ${date_to}.`));
  } catch (e) { return errorResult(e); }
});

server.registerTool('top_products', {
  title: 'Best or worst selling products',
  description:
    'Ranks products over a date range by revenue, margin or units sold. ' +
    'Ascending order surfaces the slow movers.',
  inputSchema: {
    date_from: isoDate,
    date_to: isoDate,
    rank_by: z.enum(['revenue', 'margin', 'units']).default('revenue'),
    direction: z.enum(['desc', 'asc']).default('desc')
      .describe('desc for best sellers, asc for slowest'),
    limit: z.number().int().min(1).max(50).default(10),
  },
  annotations: READ_ONLY,
}, async ({ date_from, date_to, rank_by, direction, limit }) => {
  try {
    // rank_by and direction are enums validated by zod, then mapped through a
    // lookup — never interpolated from raw caller input.
    const orderColumn = { revenue: 'revenue', margin: 'margin', units: 'units' }[rank_by];
    const orderDir = direction === 'asc' ? 'asc' : 'desc';

    const res = await query(
      `select name, manufacturer,
              sum(units)   as units,
              sum(revenue) as revenue,
              sum(margin)  as margin
         from v_rep_product_sales
        where shop_id = $1 and business_date between $2 and $3
        group by name, manufacturer
        order by ${orderColumn} ${orderDir}
        limit $4`,
      [shopId(), date_from, date_to, limit],
    );
    return textResult(asTable(res, 'No sales in that range.'));
  } catch (e) { return errorResult(e); }
});

// ============================================================ expiry money

server.registerTool('expiry_ladder', {
  title: 'Stock value at risk from expiry',
  description:
    'Value of stock in each expiry window: already expired, 0-30, 31-90, 91-180 ' +
    'days and beyond, at both cost and MRP. The 91-180 bucket is the one worth ' +
    'acting on — it is usually still inside the distributor return window.',
  inputSchema: {},
  annotations: READ_ONLY,
}, async () => {
  try {
    const res = await query(
      `select bucket, batch_count, units, value_at_cost, value_at_mrp
         from v_expiry_ladder
        where shop_id = $1
        order by case bucket
                   when 'expired' then 0 when '0-30' then 1
                   when '31-90'  then 2 when '91-180' then 3 else 4 end`,
      [shopId()],
    );
    return textResult(asTable(res, 'No stock on hand.'));
  } catch (e) { return errorResult(e); }
});

server.registerTool('returnable_stock', {
  title: 'Stock that can still go back to the distributor',
  description:
    'Batches near enough to expiry to be worth returning, but still inside the ' +
    "supplier's return window — so they become a credit note instead of a " +
    'write-off. Grouped by supplier so the list can be sent straight to them. ' +
    'This is the report that recovers real money; most shops notice expiry only ' +
    'once returns are no longer accepted.',
  inputSchema: {
    supplier_name: z.string().min(2).max(80).optional()
      .describe('Partial supplier name to filter by. Omit for all suppliers.'),
  },
  annotations: READ_ONLY,
}, async ({ supplier_name }) => {
  try {
    const res = await query(
      `select supplier_name, phone, product_name, batch_no, expiry,
              strips, recoverable_value
         from v_returnable_to_supplier
        where shop_id = $1
          and ($2::text is null or supplier_name ilike '%' || $2 || '%')
        order by supplier_name, recoverable_value desc`,
      [shopId(), supplier_name ?? null],
    );
    return textResult(asTable(res,
      'Nothing is due for return right now. Everything on hand is either well ' +
      'inside its shelf life or already past the return window.'));
  } catch (e) { return errorResult(e); }
});

server.registerTool('dead_stock', {
  title: 'Capital locked in stock that is not moving',
  description:
    'Products with stock on hand and no sale in the last 90 days, sorted by the ' +
    'rupees tied up in them.',
  inputSchema: {
    limit: z.number().int().min(1).max(50).default(20),
  },
  annotations: READ_ONLY,
}, async ({ limit }) => {
  try {
    const res = await query(
      `select name, rack_location, units_on_hand, capital_locked, last_sold
         from v_dead_stock
        where shop_id = $1
        order by capital_locked desc
        limit $2`,
      [shopId(), limit],
    );
    return textResult(asTable(res, 'Nothing has been sitting unsold for 90 days.'));
  } catch (e) { return errorResult(e); }
});

// ============================================================ stock

server.registerTool('stock_on_hand', {
  title: 'Current stock for a medicine',
  description:
    'Units and strips on hand, nearest expiry, live batch count and rack ' +
    'location. Matches on brand name, generic name or manufacturer.',
  inputSchema: {
    search: z.string().min(2).max(60)
      .describe('Brand name, generic name or manufacturer — partial is fine'),
    only_in_stock: z.boolean().default(false),
    limit: z.number().int().min(1).max(50).default(15),
  },
  annotations: READ_ONLY,
}, async ({ search, only_in_stock, limit }) => {
  try {
    const res = await query(
      `select name, generic_name, manufacturer, rack_location, drug_schedule,
              strips_on_hand, units_on_hand, nearest_expiry, live_batches
         from v_rep_stock
        where shop_id = $1
          and (name ilike '%' || $2 || '%'
            or generic_name ilike '%' || $2 || '%'
            or manufacturer  ilike '%' || $2 || '%')
          and ($3 = false or units_on_hand > 0)
        order by units_on_hand desc, name
        limit $4`,
      [shopId(), search, only_in_stock, limit],
    );
    return textResult(asTable(res, `Nothing in the catalogue matches "${search}".`));
  } catch (e) { return errorResult(e); }
});

server.registerTool('stockouts', {
  title: 'What customers asked for and the shop did not have',
  description:
    'Every failed counter search, ranked by how often it came up. The best ' +
    'reorder signal there is, because it measures demand the sales figures ' +
    'cannot see. Items flagged never_stocked are ones the shop has never ' +
    'carried at all.',
  inputSchema: {
    days: z.number().int().min(1).max(365).default(7),
    limit: z.number().int().min(1).max(50).default(20),
  },
  annotations: READ_ONLY,
}, async ({ days, limit }) => {
  try {
    const res = await query(
      `select asked_for, times_asked, never_stocked, last_asked
         from v_rep_stockouts
        where shop_id = $1
          and last_asked >= now() - make_interval(days => $2)
        order by times_asked desc, last_asked desc
        limit $3`,
      [shopId(), days, limit],
    );
    return textResult(asTable(res,
      `No missed requests logged in the last ${days} days.`));
  } catch (e) { return errorResult(e); }
});

server.registerTool('reorder_suggestions', {
  title: 'What to order, and how much',
  description:
    'Suggested order quantities from the reorder point: average daily demand × ' +
    'lead time + safety stock, less what is on hand. Demand is divided by the ' +
    'days an item was actually in stock rather than by calendar days, so a past ' +
    'stock-out does not depress the suggestion and cause the same item to run ' +
    'out again. Filter by supplier to build one purchase order.',
  inputSchema: {
    supplier_name: z.string().min(2).max(80).optional(),
    limit: z.number().int().min(1).max(60).default(25),
  },
  annotations: READ_ONLY,
}, async ({ supplier_name, limit }) => {
  try {
    const res = await query(
      `select name, supplier_name, lead_time_days, avg_daily_demand,
              reorder_point, units_on_hand, suggested_order_units
         from v_rep_reorder
        where shop_id = $1
          and suggested_order_units > 0
          and ($2::text is null or supplier_name ilike '%' || $2 || '%')
        order by suggested_order_units desc
        limit $3`,
      [shopId(), supplier_name ?? null, limit],
    );
    return textResult(asTable(res,
      'Nothing needs ordering right now against current demand and lead times.'));
  } catch (e) { return errorResult(e); }
});

server.registerTool('list_suppliers', {
  title: 'Distributors this shop buys from',
  description:
    'Names, phone numbers, lead times and return windows. Use this to resolve a ' +
    'supplier name before calling the other tools.',
  inputSchema: {},
  annotations: READ_ONLY,
}, async () => {
  try {
    const res = await query(
      `select name, phone, lead_time_days, return_window_months
         from v_rep_suppliers where shop_id = $1 order by name`,
      [shopId()],
    );
    return textResult(asTable(res, 'No suppliers on file.'));
  } catch (e) { return errorResult(e); }
});

// ============================================================ start

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the protocol channel. Anything logged must go to stderr.
  process.stderr.write('sri-nachiya-medicals MCP server ready (read-only)\n');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { void closePool().finally(() => process.exit(0)); });
}

main().catch(err => {
  process.stderr.write(`Failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
