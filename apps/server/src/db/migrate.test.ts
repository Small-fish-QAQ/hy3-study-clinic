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
      'material_revisions',
      'material_role_versions',
      'truth_authority_records',
      'agent_operations',
      'model_logical_calls',
      'model_call_attempts',
      'model_usage_records',
      'semantic_cache_entries',
      'cost_policies',
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
    expect(version.v).toBe(LATEST_MIGRATION_VERSION);
    db.close();
  });

  it('upgrades populated v12 materials into honest revision-1 lineage', () => {
    const db = openDatabase(':memory:');
    migrate(db, { toVersion: 12 });
    db.prepare(
      `INSERT INTO workspaces (id, name, origin, created_at, updated_at)
       VALUES ('ws_v12', 'Course', 'manual', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO materials
         (id, title, source_type, content, char_count, created_at, workspace_id,
          parse_status, extraction_warnings, parser_version, updated_at)
       VALUES ('mat_v12', 'Legacy material', 'paste', 'legacy truth', 12,
         '2026-01-01T00:00:00.000Z', 'ws_v12', 'parsed', '[]', NULL,
         '2026-01-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO source_blocks
         (id, material_id, idx, heading_path, content, start_offset, end_offset)
       VALUES ('blk_v12', 'mat_v12', 0, '[]', 'legacy truth', 0, 12)`,
    ).run();
    db.prepare(
      `INSERT INTO concepts
         (id, material_id, name, summary, importance, grounding, created_at)
       VALUES ('con_v12', 'mat_v12', 'Legacy', 'Legacy summary', 'high',
         '{"blockId":"blk_v12","quote":"legacy truth","startOffset":0,"endOffset":12,"occurrenceCount":1,"reanchored":false}',
         '2026-01-01T00:00:00.000Z')`,
    ).run();

    migrate(db);

    const revision = db
      .prepare(
        `SELECT id, revision_number, status, parser_version, parser_fingerprint,
                content_fingerprint
         FROM material_revisions WHERE material_id = 'mat_v12'`,
      )
      .get();
    expect(revision).toEqual({
      id: 'rev_legacy_mat_v12',
      revision_number: 1,
      status: 'active',
      parser_version: null,
      parser_fingerprint: null,
      content_fingerprint: null,
    });
    expect(
      db.prepare(`SELECT active_revision_id FROM materials WHERE id = 'mat_v12'`).get(),
    ).toEqual({ active_revision_id: 'rev_legacy_mat_v12' });
    expect(
      db.prepare(`SELECT material_revision_id FROM source_blocks WHERE id = 'blk_v12'`).get(),
    ).toEqual({ material_revision_id: 'rev_legacy_mat_v12' });
    expect(
      db.prepare(`SELECT material_revision_id FROM concepts WHERE id = 'con_v12'`).get(),
    ).toEqual({ material_revision_id: 'rev_legacy_mat_v12' });
    expect(db.prepare(`SELECT role, learner_confirmed FROM material_role_versions`).get()).toEqual({
      role: 'unknown',
      learner_confirmed: 0,
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });
});
