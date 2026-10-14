import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from './database.js';
import { initializeClinic } from './schema.js';
import { acquireDatabaseLock } from './processLock.js';
import { sha256 } from '../util/canonical.js';
describe('新版独立初始化 A01/A10', () => {
  it('v6知识清单按版本保留，迁移不改旧内容或引用，重启幂等且旧版本仍不可写', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys=ON');
      db.pragma('application_id=1396921906');
      db.pragma('user_version=6');
      db.exec(`CREATE TABLE workspaces(id TEXT PRIMARY KEY);
        INSERT INTO workspaces VALUES('w');
        CREATE TABLE course_knowledge_inventories(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),source_scope_hash TEXT NOT NULL,policy_version TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(workspace_id,source_scope_hash,policy_version));
        INSERT INTO course_knowledge_inventories VALUES('old','w','scope','policy','protected','time');
        CREATE TABLE curriculum_versions(inventory_id TEXT REFERENCES course_knowledge_inventories(id));
        INSERT INTO curriculum_versions VALUES('old');
        CREATE TRIGGER immutable_course_knowledge_inventories BEFORE UPDATE ON course_knowledge_inventories BEGIN SELECT RAISE(ABORT,'immutable record'); END;`);
      const before = db.prepare('SELECT * FROM course_knowledge_inventories').all();
      initializeClinic(db);
      expect(db.prepare('SELECT * FROM course_knowledge_inventories').all()).toEqual(before);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(() => db.exec("UPDATE course_knowledge_inventories SET payload='changed'")).toThrow(
        'immutable',
      );
      db.exec(
        "INSERT INTO course_knowledge_inventories VALUES('corrected','w','scope','policy','new version','later')",
      );
      initializeClinic(db);
      expect(db.prepare('SELECT COUNT(*) AS n FROM course_knowledge_inventories').get()).toEqual({
        n: 2,
      });
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    } finally {
      db.close();
    }
  });
  it('指定合成旧库时零修改，新库初始化重启不重置，FK和活动索引可用', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clinic-schema-'));
    try {
      const old = join(dir, 'old.sqlite');
      const legacy = new Database(old);
      legacy.exec("CREATE TABLE legacy(id TEXT);INSERT INTO legacy VALUES('protected')");
      legacy.close();
      const before = sha256(readFileSync(old));
      expect(() => openDatabase(old)).toThrow('旧版');
      expect(sha256(readFileSync(old))).toBe(before);
      const path = join(dir, 'v2.sqlite');
      const db = openDatabase(path);
      initializeClinic(db);
      db.prepare('INSERT INTO workspaces VALUES(?,?,?)').run('w', '课', '2026-10-12T00:00:00.000Z');
      initializeClinic(db);
      expect(db.prepare('SELECT title FROM workspaces').get()).toEqual({ title: '课' });
      expect(db.pragma('foreign_key_check')).toEqual([]);
      db.close();
      const again = openDatabase(path);
      initializeClinic(again);
      expect(again.prepare('SELECT COUNT(*) AS n FROM workspaces').get()).toEqual({ n: 1 });
      const active = again
        .prepare("SELECT sql FROM sqlite_master WHERE name='active_repair_submission'")
        .get() as { sql: string };
      expect(active.sql).not.toContain('failed');
      again.close();
      const release = acquireDatabaseLock(path);
      expect(() => acquireDatabaseLock(path)).toThrow('已有');
      release();
      const second = acquireDatabaseLock(path);
      second();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
