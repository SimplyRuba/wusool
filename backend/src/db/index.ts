import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DB_PATH = process.env.DB_PATH ?? join(HERE, '..', '..', 'wusool.db');

/* node:sqlite ships with Node >=22.5, so there is no native module to compile.
   This is a deliberate change from better-sqlite3 in the spec: `npm i` cannot
   fail on a build toolchain the night before the demo. The API used here
   (prepare/run/get/all/exec) is the same shape either way. */
export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec(readFileSync(join(HERE, 'schema.sql'), 'utf8'));

type Row = Record<string, any>;

export const all = <T = Row>(sql: string, ...p: any[]): T[] =>
  db.prepare(sql).all(...p) as T[];

export const get = <T = Row>(sql: string, ...p: any[]): T | undefined =>
  db.prepare(sql).get(...p) as T | undefined;

export const run = (sql: string, ...p: any[]) => db.prepare(sql).run(...p);

/** INSERT and return the new row id. */
export const insert = (sql: string, ...p: any[]): number =>
  Number(db.prepare(sql).run(...p).lastInsertRowid);

export const tx = <T>(fn: () => T): T => {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
};

export function resetAll() {
  for (const t of ['points_ledger','road_events','orders','resolutions',
                   'addresses','entity_aliases','entities','checkpoints'])
    db.exec(`DELETE FROM ${t}`);
  // sqlite_sequence only exists when a table declares AUTOINCREMENT; ours use
  // plain INTEGER PRIMARY KEY (rowid alias), so the table may legitimately be absent.
  try { db.exec('DELETE FROM sqlite_sequence'); } catch { /* no AUTOINCREMENT tables */ }
}
