/**
 * The shop's database: SQLite in a file on this computer.
 *
 * Node's built-in driver, so nothing has to be compiled or installed beyond
 * Node itself. No network, no server process, no cloud account.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, existsSync, copyFileSync, renameSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Today's date as the shop's own clock sees it: 'YYYY-MM-DD'. */
export function today(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function nowStamp(d = new Date()) {
  return `${today(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}
let db = null;
let dbPath = null;

export function open(path = process.env.SNM_DB || join(HERE, 'data', 'shop.db')) {
  if (db) return db;
  dbPath = resolve(path);
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);

  /* `create ... if not exists` leaves an existing definition alone, so a view
     or trigger whose wording has changed would keep its old body for ever.
     These two decide what counts as expired, so they are dropped and rebuilt
     from schema.sql on every start. Dropping a view or trigger touches no
     data. */
  for (const drop of ['drop view if exists v_expiry',
                      'drop trigger if exists sale_items_not_expired']) {
    try { db.exec(drop); } catch { /* nothing there yet */ }
  }

  db.exec(readFileSync(join(HERE, 'schema.sql'), 'utf8'));

  /* One medicine, one name — enforced by the database so that no future
     screen or import can split a medicine's stock in two.
     It is applied here rather than in schema.sql because schema.sql is run as
     one block on every start: were it to fail on a database that somehow
     already held two medicines of the same name, the shop could not open at
     all. Better to start, let billing carry on, and report the problem through
     "Check the figures" in Settings. */
  try {
    db.exec('create unique index if not exists products_name_unique on products (lower(trim(name)))');
  } catch { /* duplicates already present; integrityCheck() will say so */ }

  /* Columns added after the first shops were set up. `create table if not
     exists` leaves an existing table alone, so they are added here instead.
     Each one throws harmlessly if it is already there. */
  for (const alter of [
    'alter table purchases add column discount_bp integer not null default 0',
    'alter table purchase_items add column discount_bp integer not null default 0',
    'alter table purchase_items add column list_cost_paise integer',
    'alter table shop_settings add column pin_hash text',
    'alter table shop_settings add column pin_salt text',
    'alter table sale_items add column cost_total_paise integer',
  ]) {
    try { db.exec(alter); } catch { /* already present */ }
  }

  /* Bills written before the line cost was snapshotted: fill it in once, from
     the pack size as it stands now. That is the best figure available, and it
     freezes those days so a later correction cannot move them again. */
  try {
    db.exec(`update sale_items set cost_total_paise =
               qty * cost_paise / (select units_per_strip from products where id = sale_items.product_id)
             where cost_total_paise is null`);
  } catch { /* nothing to backfill */ }

  /* v_day and v_stock read the column that was just added, so they are rebuilt
     now rather than above: on an older database the column did not exist when
     schema.sql first ran. Running schema.sql a second time costs nothing —
     every statement in it is `if not exists` — and it is the only file that
     describes what these views should be. */
  for (const drop of ['drop view if exists v_day', 'drop view if exists v_stock']) {
    try { db.exec(drop); } catch { /* not there yet */ }
  }
  db.exec(readFileSync(join(HERE, 'schema.sql'), 'utf8'));

  clearPinIfAsked();
  return db;
}

/**
 * The way back in when the PIN has been forgotten.
 *
 * The owner has no support desk and no second device. Put an empty file called
 * RESET-PIN.txt next to shop.db, start the app, and the PIN is gone; the file
 * is removed so it cannot silently clear the PIN again tomorrow.
 *
 * This is not a weakness that a PIN would otherwise have prevented: anyone who
 * can create that file can already read shop.db itself. The PIN guards the
 * screens against a passer-by, never the disk against its owner.
 */
function clearPinIfAsked() {
  const flag = join(dirname(dbPath), 'RESET-PIN.txt');
  if (!existsSync(flag)) return;
  try {
    db.prepare('update shop_settings set pin_hash = null, pin_salt = null where id = 1').run();
    db.prepare(`insert into audit_log (action, entity, entity_id, detail) values (?,?,?,?)`)
      .run('pin.reset', 'shop', 1, JSON.stringify({ by: 'RESET-PIN.txt' }));
  } catch { /* nothing set up yet; there is no PIN to clear */ }
  try { unlinkSync(flag); } catch { /* read-only folder: the log still records it */ }
  console.log('\n  The PIN was cleared by RESET-PIN.txt. Set a new one in Settings.\n');
}

export const handle = () => db ?? open();
export const path = () => dbPath;

export function close() {
  if (db) { try { db.exec('pragma wal_checkpoint(truncate)'); } catch {} db.close(); db = null; }
}


// ---------------------------------------------------------------- helpers

export const all = (sql, ...args) => handle().prepare(sql).all(...args);
export const get = (sql, ...args) => handle().prepare(sql).get(...args);
export const run = (sql, ...args) => handle().prepare(sql).run(...args);

/**
 * Everything a bill touches happens inside one transaction: the bill, its
 * lines and every stock movement land together or not at all. A power cut
 * halfway through leaves no half-sold stock.
 */
export function tx(fn) {
  const d = handle();
  d.exec('begin immediate');
  try { const out = fn(); d.exec('commit'); return out; }
  catch (e) { try { d.exec('rollback'); } catch {} throw e; }
}

export function audit(action, entity, entityId, detail) {
  run('insert into audit_log (action, entity, entity_id, detail) values (?, ?, ?, ?)',
      action, entity ?? null, entityId ?? null, detail ? JSON.stringify(detail) : null);
}

// ---------------------------------------------------------------- backups

export function backupDir() {
  const dir = process.env.SNM_BACKUPS || join(dirname(dbPath ?? join(HERE, 'data', 'shop.db')), 'backups');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A backup is a complete, consistent copy of the database in one file, written
 * by SQLite itself. Copying the file by hand while the app is running can catch
 * it mid-write; VACUUM INTO cannot.
 */
export function backup(label = 'auto') {
  /* Two backups in the same second used to collide, because `vacuum into`
     refuses a file that already exists — and pressing "Back up now" twice is
     exactly what a worried owner does. A counter is added when needed. */
  const stamp = nowStamp().replace(/[: ]/g, '-');
  let file = join(backupDir(), `shop-${stamp}-${label}.db`);
  for (let n = 2; existsSync(file) && n < 100; n++) {
    file = join(backupDir(), `shop-${stamp}-${label}-${n}.db`);
  }
  handle().exec(`vacuum into '${file.replace(/'/g, "''")}'`);
  return { file, size: statSync(file).size };
}

export function listBackups() {
  return readdirSync(backupDir())
    .filter(f => f.endsWith('.db'))
    .map(f => { const s = statSync(join(backupDir(), f)); return { file: f, size: s.size, at: nowStamp(s.mtime) }; })
    .sort((a, b) => b.file.localeCompare(a.file));
}

/**
 * Restoring puts today's database aside first, so a restore can itself be
 * undone. The caller reopens afterwards.
 */
export function restore(fileName) {
  const src = join(backupDir(), fileName);
  if (!existsSync(src)) throw new Error(`No backup called ${fileName}`);
  const check = new DatabaseSync(src, { readOnly: true });
  const ok = check.prepare('select count(*) as n from sqlite_master where name = ?').get('sales');
  check.close();
  if (!ok || !ok.n) throw new Error('That file is not a Sri Nachiya backup.');

  const p = dbPath;
  close();
  const aside = `${p}.replaced-${nowStamp().replace(/[: ]/g, '-')}`;
  if (existsSync(p)) renameSync(p, aside);
  for (const suffix of ['-wal', '-shm']) if (existsSync(p + suffix)) renameSync(p + suffix, aside + suffix);
  copyFileSync(src, p);
  open(p);
  return { restored: fileName, previousSavedAs: aside };
}

/**
 * Keeps the newest `keep` backups and deletes the rest, so the folder cannot
 * fill the disk. A copy is written at every start, every close, every evening
 * and every time the button is pressed, so without this it grows for ever.
 *
 * It counts every backup, not only the evening ones: the start and close
 * copies are by far the most numerous on a shop PC that is switched on and off
 * daily.
 */
export function pruneBackups(keep = 30) {
  const files = listBackups();               // newest first
  const remove = files.slice(keep);
  let deleted = 0;
  for (const b of remove) {
    try { unlinkSync(join(backupDir(), b.file)); deleted++; }
    catch { /* in use or already gone; it will be caught next time */ }
  }
  return deleted;
}
