import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type SqliteDb = Database.Database;

/**
 * Open (and create if needed) the SQLite database.
 * `:memory:` is supported for tests.
 */
export function openDatabase(path: string): SqliteDb {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  // WAL improves concurrent read behaviour for file databases; harmless in memory.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}
