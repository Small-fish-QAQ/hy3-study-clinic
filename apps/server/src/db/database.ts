import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';

export type SqliteDb = Database.Database;

/**
 * Open (and create if needed) the SQLite database.
 * `:memory:` is supported for tests.
 */
export function openDatabase(path: string): SqliteDb {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      const inspect = new Database(path, { readonly: true, fileMustExist: true });
      try {
        const count = inspect
          .prepare(
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          )
          .get() as { n: number };
        if (count.n && inspect.pragma('application_id', { simple: true }) !== 0x53435632)
          throw new Error(
            '该路径是旧版或其他数据库，请使用独立的 clinic-v2.sqlite；现有文件未修改。',
          );
      } finally {
        inspect.close();
      }
    }
  }
  const db = new Database(path);
  // WAL improves concurrent read behaviour for file databases; harmless in memory.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}
