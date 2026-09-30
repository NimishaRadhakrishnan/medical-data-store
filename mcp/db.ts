/**
 * Database access for the owner's MCP server.
 *
 * Three guarantees enforced here, independently of what the SQL says:
 *   1. The connection is opened read-only at the session level.
 *   2. Every query is parameterised. There is no code path that concatenates
 *      a caller-supplied string into SQL.
 *   3. Results are capped, so a question like "show me everything" returns a
 *      page rather than the whole database.
 *
 * The role grants in migration 0004 are the real fence. This is the second one.
 */

import pg from 'pg';

const MAX_ROWS = 200;

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (pool) return pool;

  const connectionString = process.env.SNM_REPORTING_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'SNM_REPORTING_DATABASE_URL is not set. It must point at the snm_reporting ' +
      'role, never at postgres or the service role. See .env.example.',
    );
  }
  // Guard against being pointed at a privileged account by accident. The check
  // is on the USERNAME, not the whole string: every valid Postgres URL starts
  // with the scheme "postgres://", so a naive substring match would reject
  // everything.
  let username = '';
  try {
    username = decodeURIComponent(new URL(connectionString).username);
  } catch {
    throw new Error('SNM_REPORTING_DATABASE_URL is not a valid connection URL.');
  }
  if (username !== 'snm_reporting') {
    throw new Error(
      `Refusing to start: connecting as "${username}". This server must run as ` +
      'snm_reporting, the read-only role created in migration 0004 — never as ' +
      'postgres, an admin user, or the Supabase service role.',
    );
  }

  // TLS with a verified certificate for anything over the network. Only a
  // loopback address may go without it, so a local test database does not
  // require certificate setup — and so no remote connection can ever be
  // silently downgraded, whatever the connection string says.
  const host = new URL(connectionString).hostname;
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';

  pool = new pg.Pool({
    connectionString,
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
    ssl: isLoopback ? false : { rejectUnauthorized: true },
  });

  pool.on('connect', client => {
    // Belt and braces: even if the role grants were loosened by mistake.
    void client.query('set session characteristics as transaction read only');
    void client.query("set statement_timeout = '8s'");
  });

  return pool;
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}

export async function query(sql: string, params: unknown[] = []): Promise<QueryResult> {
  const client = await getPool().connect();
  try {
    const res = await client.query(sql, params as never[]);
    const truncated = res.rows.length > MAX_ROWS;
    return {
      rows: res.rows.slice(0, MAX_ROWS),
      rowCount: res.rows.length,
      truncated,
    };
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) { await pool.end(); pool = null; }
}

/** The shop this server reports on. One server, one shop. */
export function shopId(): string {
  const id = process.env.SNM_SHOP_ID;
  if (!id) throw new Error('SNM_SHOP_ID is not set.');
  return id;
}

// ---------------------------------------------------------------- formatting

const inr = (n: unknown): string => {
  const v = Number(n ?? 0);
  return '₹' + v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const MONEY_KEYS = /(revenue|margin|value|recoverable|capital|rate|mrp|total|locked)/i;
// A percentage or a day count is not money, even when the column name contains
// a money word: margin_pct, gst_rate and lead_time_days all would be otherwise.
const NOT_MONEY = /(_pct|_percent|_days|_rate$|^gst_rate|count|units|qty)/i;

/**
 * Render rows as a compact table. An agent reads a small aligned table far more
 * reliably than a wall of JSON, and it costs a fraction of the tokens.
 */
export function asTable(result: QueryResult, emptyMessage: string): string {
  if (result.rows.length === 0) return emptyMessage;

  const cols = Object.keys(result.rows[0]);
  const fmt = (col: string, v: unknown): string => {
    if (v === null || v === undefined) return '—';
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (NOT_MONEY.test(col)) return String(v);
    if (MONEY_KEYS.test(col) && typeof v !== 'boolean') return inr(v);
    return String(v);
  };

  const body = result.rows.map(r => cols.map(c => fmt(c, r[c])));
  const widths = cols.map((c, i) =>
    Math.max(c.length, ...body.map(row => row[i].length)));

  const line = (cells: string[]) =>
    cells.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();

  const out = [line(cols), line(widths.map(w => '-'.repeat(w))), ...body.map(line)];
  if (result.truncated) {
    out.push(`… ${result.rowCount - result.rows.length} more rows not shown; narrow the question.`);
  }
  return out.join('\n');
}

export function textResult(body: string) {
  return { content: [{ type: 'text' as const, text: body }] };
}

export function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text' as const, text: `Could not answer that: ${message}` }],
    isError: true,
  };
}
