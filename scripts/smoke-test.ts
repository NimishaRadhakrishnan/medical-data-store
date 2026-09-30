/**
 * End-to-end check of the reporting MCP server.
 *
 * With SNM_REPORTING_DATABASE_URL pointing at a seeded database it calls every
 * tool and prints the output, so you can eyeball the numbers before the shop
 * relies on them. Without a database it still verifies the server starts and
 * registers its tools.
 *
 *   npm run mcp:smoke
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['--experimental-strip-types', '--no-warnings', 'mcp/server.ts'],
  env: {
    ...process.env,
    SNM_SHOP_ID: process.env.SNM_SHOP_ID ?? '11111111-1111-1111-1111-111111111111',
    SNM_REPORTING_DATABASE_URL:
      process.env.SNM_REPORTING_DATABASE_URL ??
      'postgres://snm_reporting:testpw@127.0.0.1:5432/snm',
  } as Record<string, string>,
});

const client = new Client({ name: 'snm-smoke', version: '1.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`${tools.length} tools registered\n`);

const today = new Date();
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(today.getTime() - n * 86_400_000));

const calls: Array<[string, Record<string, unknown>]> = [
  ['expiry_ladder', {}],
  ['returnable_stock', {}],
  ['sales_summary', { date_from: daysAgo(7), date_to: daysAgo(1) }],
  ['top_products', { date_from: daysAgo(30), date_to: daysAgo(1), rank_by: 'margin', limit: 5 }],
  ['stockouts', { days: 14 }],
  ['reorder_suggestions', { limit: 5 }],
  ['stock_on_hand', { search: 'telmisartan' }],
  ['dead_stock', { limit: 5 }],
  ['list_suppliers', {}],
];

let failures = 0;
for (const [name, args] of calls) {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  const label = `${name}(${Object.keys(args).join(', ')})`;
  console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 60 - label.length))}`);
  console.log(res.content[0].text);
  if (res.isError) failures++;
}

await client.close();
console.log(failures ? `\n${failures} tool(s) errored` : '\nAll tools answered.');
process.exit(failures ? 1 : 0);
