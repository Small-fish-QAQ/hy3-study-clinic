import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { LATEST_MIGRATION_VERSION, migrate } from './migrate.js';

describe('migrations', () => {
  it('applies all migrations to the latest version', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const row = db
      .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations')
      .get() as { v: number };
    expect(row.v).toBe(LATEST_MIGRATION_VERSION);
    db.close();
  });

  it('is repeatable: running twice applies nothing new', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const first = db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number };
    migrate(db);
    const second = db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number };
    expect(second.c).toBe(first.c);
    db.close();
  });

  it('creates all expected tables', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    for (const expected of [
      'materials',
      'source_blocks',
      'concepts',
      'quizzes',
      'questions',
      'submissions',
      'grading_results',
      'mistakes',
      'mastery_states',
      'concept_lessons',
    ]) {
      expect(tables).toContain(expected);
    }
    db.close();
  });

  it('enforces mastery bounds via a CHECK constraint', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    db.prepare(
      `INSERT INTO materials (id, title, source_type, content, char_count, created_at)
       VALUES ('m1', 't', 'paste', 'c', 1, '2026-01-01T00:00:00.000Z')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO mastery_states
             (material_id, concept_id, concept_name, mastery, attempts, correct_count, last_score, updated_at)
           VALUES ('m1', 'c1', 'name', 1.7, 0, 0, NULL, '2026-01-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow();
    db.close();
  });

  it('adds nullable page_end to source_blocks (migration 9)', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const columns = (
      db.prepare("PRAGMA table_info('source_blocks')").all() as Array<{
        name: string;
        notnull: number;
      }>
    ).filter((c) => c.name === 'page_end');
    expect(columns).toHaveLength(1);
    expect(columns[0]!.notnull).toBe(0);
    db.close();
  });

  it('adds nullable provider and state_changes to grading_results (migration 10)', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const columns = (
      db.prepare("PRAGMA table_info('grading_results')").all() as Array<{
        name: string;
        notnull: number;
      }>
    ).filter((c) => c.name === 'provider' || c.name === 'state_changes');
    expect(columns.map((c) => c.name).sort()).toEqual(['provider', 'state_changes']);
    for (const column of columns) {
      expect(column.notnull, column.name).toBe(0);
    }
    db.close();
  });

  it('upgrades a populated v11 database to additive concept lessons without changing existing rows', () => {
    const db = openDatabase(':memory:');
    migrate(db, { toVersion: 11 });
    db.prepare(
      `INSERT INTO workspaces (id, name, created_at, updated_at)
       VALUES ('ws_v11', '迁移兼容空间', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO materials
         (id, title, source_type, content, char_count, created_at, workspace_id)
       VALUES
         ('mat_v11', '迁移兼容资料', 'paste', '课程原文', 4,
          '2026-01-01T00:00:00.000Z', 'ws_v11')`,
    ).run();
    db.prepare(
      `INSERT INTO concepts
         (id, material_id, name, summary, importance, grounding, created_at)
       VALUES
         ('con_v11', 'mat_v11', '原有概念', '原有摘要', 'high',
          '{"blockId":"blk_v11","quote":"课程原文","startOffset":0,"endOffset":4}',
          '2026-01-01T00:00:00.000Z')`,
    ).run();

    migrate(db);

    expect(db.prepare('SELECT name FROM concepts WHERE id = ?').get('con_v11')).toEqual({
      name: '原有概念',
    });
    const lessonTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'concept_lessons'")
      .get();
    expect(lessonTable).toEqual({ name: 'concept_lessons' });
    const version = db
      .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations')
      .get() as { v: number };
    expect(version.v).toBe(12);
    db.close();
  });
});
