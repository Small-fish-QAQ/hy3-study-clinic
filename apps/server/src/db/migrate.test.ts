import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { LATEST_MIGRATION_VERSION, migrate } from './migrate.js';

function providerGenerationSchema(db: ReturnType<typeof openDatabase>) {
  const column = (
    db.pragma('table_info(model_call_attempts)') as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>
  ).find((entry) => entry.name === 'provider_generation');
  const table = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'model_call_attempts'`)
    .get() as { sql: string };
  return { column, sql: table.sql };
}

function expectCanonicalProviderGenerationSchema(db: ReturnType<typeof openDatabase>): void {
  const schema = providerGenerationSchema(db);
  expect(schema.column).toMatchObject({
    name: 'provider_generation',
    notnull: 0,
    dflt_value: null,
  });
  expect(schema.sql).toContain(
    'provider_generation INTEGER CHECK (provider_generation IS NULL OR provider_generation >= 1)',
  );
}

function telemetryRows(db: ReturnType<typeof openDatabase>) {
  return {
    calls: db.prepare('SELECT * FROM model_logical_calls ORDER BY id').all(),
    attempts: db.prepare('SELECT * FROM model_call_attempts ORDER BY id').all(),
    usage: db.prepare('SELECT * FROM model_usage_records ORDER BY id').all(),
  };
}

function telemetryPhysicalSchema(db: ReturnType<typeof openDatabase>) {
  return db
    .prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_master
       WHERE sql IS NOT NULL AND (
         (type = 'table' AND name IN
           ('model_logical_calls', 'model_call_attempts', 'model_usage_records'))
         OR
         (type = 'index' AND tbl_name IN
           ('model_logical_calls', 'model_call_attempts', 'model_usage_records'))
       )
       ORDER BY type, name`,
    )
    .all();
}

function insertTelemetryFixture(
  db: ReturnType<typeof openDatabase>,
  id: string,
  providerGeneration: number | null,
  at = '2026-01-01T00:00:00.000Z',
): void {
  db.prepare(
    `INSERT INTO model_logical_calls
       (id, operation_id, workspace_id, study_session_id, learning_unit_id, assessment_id,
        operation_type, cache_key, cache_status, prompt_fingerprint, schema_fingerprint,
        policy_fingerprint, source_fingerprint, status, created_at, completed_at)
     VALUES (?, NULL, NULL, NULL, NULL, NULL, 'migration_fixture', NULL, 'not_checked',
       NULL, NULL, NULL, NULL, 'completed', ?, ?)`,
  ).run(`call_${id}`, at, at);
  db.prepare(
    `INSERT INTO model_call_attempts
       (id, logical_call_id, attempt_number, attempt_kind, fencing_token, provider, model,
        provider_generation, status, started_at, sent_at, first_token_at, completed_at,
        latency_ms, time_to_first_token_ms, error_code, error_message)
     VALUES (?, ?, 1, 'original', NULL, 'fake', NULL, ?, 'completed', ?, ?, NULL, ?,
       0, NULL, NULL, NULL)`,
  ).run(`attempt_${id}`, `call_${id}`, providerGeneration, at, at, at);
  db.prepare(
    `INSERT INTO model_usage_records
       (id, attempt_id, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,
        cache_write_tokens, estimated_cost_microunits, currency, pricing_source,
        pricing_version, recorded_at)
     VALUES (?, ?, 0, 0, 0, 0, 0, 0, 'USD', 'migration-fixture', '1', ?)`,
  ).run(`usage_${id}`, `attempt_${id}`, at);
}

function rewriteAsInterimMigration18(db: ReturnType<typeof openDatabase>): void {
  db.pragma('foreign_keys = OFF');
  try {
    db.exec(`
      CREATE TABLE model_call_attempts_interim_v18 (
        id TEXT PRIMARY KEY,
        logical_call_id TEXT NOT NULL REFERENCES model_logical_calls(id) ON DELETE CASCADE,
        attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
        attempt_kind TEXT NOT NULL CHECK (attempt_kind IN
          ('original', 'repair', 'retry', 'fallback')),
        fencing_token INTEGER CHECK (fencing_token IS NULL OR fencing_token >= 1),
        provider TEXT NOT NULL,
        model TEXT,
        provider_generation INTEGER NOT NULL DEFAULT 1 CHECK (provider_generation >= 1),
        status TEXT NOT NULL CHECK (status IN
          ('queued', 'sent', 'completed', 'failed', 'cancelled', 'interrupted', 'outcome_unknown')),
        started_at TEXT NOT NULL,
        sent_at TEXT,
        first_token_at TEXT,
        completed_at TEXT,
        latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
        time_to_first_token_ms INTEGER CHECK (time_to_first_token_ms IS NULL OR time_to_first_token_ms >= 0),
        error_code TEXT,
        error_message TEXT,
        UNIQUE (logical_call_id, attempt_number)
      );
      INSERT INTO model_call_attempts_interim_v18
        (id, logical_call_id, attempt_number, attempt_kind, fencing_token, provider, model,
         provider_generation, status, started_at, sent_at, first_token_at, completed_at,
         latency_ms, time_to_first_token_ms, error_code, error_message)
      SELECT id, logical_call_id, attempt_number, attempt_kind, fencing_token, provider, model,
             COALESCE(provider_generation, 1), status, started_at, sent_at, first_token_at,
             completed_at, latency_ms, time_to_first_token_ms, error_code, error_message
      FROM model_call_attempts;

      CREATE TABLE model_usage_records_interim_v18 (
        id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL UNIQUE
          REFERENCES model_call_attempts_interim_v18(id) ON DELETE CASCADE,
        input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
        output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
        reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
        cache_read_tokens INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
        cache_write_tokens INTEGER CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
        estimated_cost_microunits INTEGER CHECK
          (estimated_cost_microunits IS NULL OR estimated_cost_microunits >= 0),
        currency TEXT,
        pricing_source TEXT,
        pricing_version TEXT,
        recorded_at TEXT NOT NULL
      );
      INSERT INTO model_usage_records_interim_v18 SELECT * FROM model_usage_records;

      DROP TABLE model_usage_records;
      DROP TABLE model_call_attempts;
      ALTER TABLE model_call_attempts_interim_v18 RENAME TO model_call_attempts;
      ALTER TABLE model_usage_records_interim_v18 RENAME TO model_usage_records;
      CREATE INDEX idx_model_call_attempts_logical
        ON model_call_attempts(logical_call_id, attempt_number);
    `);
  } finally {
    db.pragma('foreign_keys = ON');
  }
  expect(db.pragma('foreign_key_check')).toEqual([]);
}

describe('migrations', () => {
  it('applies all migrations to the latest version', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const row = db
      .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations')
      .get() as { v: number };
    expect(row.v).toBe(LATEST_MIGRATION_VERSION);
    expect(row.v).toBe(22);
    expectCanonicalProviderGenerationSchema(db);
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

  it('adds the append-only Teaching Brief store when upgrading v19 data', () => {
    const db = openDatabase(':memory:');
    migrate(db, { toVersion: 19 });
    db.prepare(
      `INSERT INTO workspaces (id, name, origin, created_at, updated_at)
       VALUES ('ws_v20', 'Teaching Brief course', 'manual', ?, ?)`,
    ).run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

    migrate(db);

    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'teaching_briefs'")
        .get(),
    ).toEqual({ name: 'teaching_briefs' });
    expect(
      db.prepare('SELECT version, name FROM schema_migrations WHERE version = 20').get(),
    ).toEqual({ version: 20, name: 'immutable_learning_unit_teaching_briefs' });
    expect(
      db.prepare('SELECT version, name FROM schema_migrations WHERE version = 21').get(),
    ).toEqual({ version: 21, name: 'session_owned_lesson_execution' });
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lesson_execution_states'",
        )
        .get(),
    ).toEqual({ name: 'lesson_execution_states' });
    expect(db.pragma('foreign_key_check')).toEqual([]);
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
      'learning_contract_versions',
      'execution_source_manifests',
      'curriculum_versions',
      'study_plan_versions',
      'session_agendas',
      'coverage_risk_entries',
      'course_execution_state',
      'study_sessions',
      'study_session_turns',
      'study_session_exchanges',
      'study_turn_events',
      'study_session_summaries',
      'teaching_briefs',
      'lesson_execution_states',
      'lesson_execution_events',
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

  it('upgrades a populated v14 database without fabricating Agent execution state', () => {
    const db = openDatabase(':memory:');
    migrate(db, { toVersion: 14 });
    db.prepare(
      `INSERT INTO workspaces (id, name, origin, created_at, updated_at)
       VALUES ('ws_v14', 'Existing course', 'manual', ?, ?)`,
    ).run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    db.prepare(
      `INSERT INTO materials
         (id, workspace_id, title, source_type, content, char_count,
          parse_status, extraction_warnings, created_at, updated_at)
       VALUES ('mat_v14', 'ws_v14', 'Existing material', 'paste', 'truth', 5,
         'parsed', '[]', ?, ?)`,
    ).run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

    migrate(db);

    expect(db.prepare(`SELECT title FROM materials WHERE id = 'mat_v14'`).get()).toEqual({
      title: 'Existing material',
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM learning_contract_versions').get()).toEqual({
      count: 0,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM course_execution_state').get()).toEqual({
      count: 0,
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('upgrades v17 telemetry without fabricating historical provider generation', () => {
    const db = openDatabase(':memory:');
    migrate(db, { toVersion: 17 });
    db.prepare(
      `INSERT INTO workspaces (id, name, origin, created_at, updated_at)
       VALUES ('ws_v17', 'Existing course', 'manual', ?, ?)`,
    ).run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    db.prepare(
      `INSERT INTO model_logical_calls
         (id, operation_id, workspace_id, study_session_id, learning_unit_id, assessment_id,
          operation_type, cache_key, cache_status, prompt_fingerprint, schema_fingerprint,
          policy_fingerprint, source_fingerprint, status, created_at, completed_at)
       VALUES ('call_v17', NULL, 'ws_v17', NULL, NULL, NULL, 'legacy_call', NULL,
         'not_checked', NULL, NULL, NULL, NULL, 'completed', ?, ?)`,
    ).run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z');
    db.prepare(
      `INSERT INTO model_call_attempts
         (id, logical_call_id, attempt_number, attempt_kind, fencing_token, provider, model,
          status, started_at, sent_at, completed_at, latency_ms)
       VALUES ('attempt_v17', 'call_v17', 1, 'original', 1, 'hy3', 'old-model',
         'completed', ?, ?, ?, 1000)`,
    ).run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z');

    migrate(db);

    expect(
      db
        .prepare(
          `SELECT provider_generation, fencing_token FROM model_call_attempts
           WHERE id = 'attempt_v17'`,
        )
        .get(),
    ).toEqual({ provider_generation: null, fencing_token: 1 });
    expect(() =>
      db
        .prepare(
          `INSERT INTO model_logical_calls
             (id, operation_id, workspace_id, study_session_id, learning_unit_id, assessment_id,
              operation_type, cache_key, cache_status, prompt_fingerprint, schema_fingerprint,
              policy_fingerprint, source_fingerprint, status, created_at, completed_at)
           VALUES ('call_global', NULL, NULL, NULL, NULL, NULL, 'provider_connection_test', NULL,
             'not_checked', NULL, NULL, NULL, NULL, 'open', ?, NULL)`,
        )
        .run('2026-01-01T00:00:02.000Z'),
    ).not.toThrow();
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('upgrades canonical v18 telemetry to v19 without changing known or unknown generations', () => {
    const db = openDatabase(':memory:');
    migrate(db, { toVersion: 18 });
    insertTelemetryFixture(db, 'canonical_unknown', null);
    insertTelemetryFixture(db, 'canonical_generation_1', 1);
    insertTelemetryFixture(db, 'canonical_generation_3', 3);
    const before = telemetryRows(db);

    migrate(db);

    expect(telemetryRows(db)).toEqual(before);
    expect(
      db.prepare(`SELECT id, provider_generation FROM model_call_attempts ORDER BY id`).all(),
    ).toEqual([
      { id: 'attempt_canonical_generation_1', provider_generation: 1 },
      { id: 'attempt_canonical_generation_3', provider_generation: 3 },
      { id: 'attempt_canonical_unknown', provider_generation: null },
    ]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM model_usage_records').get()).toEqual({
      count: 3,
    });
    expectCanonicalProviderGenerationSchema(db);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('upgrades interim incident v18 without guessing between indistinguishable generation-1 rows', () => {
    const db = openDatabase(':memory:');
    migrate(db, { toVersion: 18 });
    insertTelemetryFixture(db, 'interim_backfill', null, '2026-01-01T00:00:00.000Z');
    rewriteAsInterimMigration18(db);

    // A fixed/custom application clock can make a genuinely observed post-migration
    // row predate schema_migrations.applied_at, so timestamps cannot prove provenance.
    insertTelemetryFixture(db, 'observed_generation_1', 1, '2026-01-01T00:00:00.000Z');
    const interimSchema = providerGenerationSchema(db);
    expect(interimSchema.column).toMatchObject({
      name: 'provider_generation',
      notnull: 1,
      dflt_value: '1',
    });
    const before = telemetryRows(db);

    migrate(db);

    expect(telemetryRows(db)).toEqual(before);
    expect(
      db.prepare(`SELECT id, provider_generation FROM model_call_attempts ORDER BY id`).all(),
    ).toEqual([
      { id: 'attempt_interim_backfill', provider_generation: 1 },
      { id: 'attempt_observed_generation_1', provider_generation: 1 },
    ]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM model_usage_records').get()).toEqual({
      count: 2,
    });
    expectCanonicalProviderGenerationSchema(db);
    expect(() => insertTelemetryFixture(db, 'unknown_after_recovery', null)).not.toThrow();
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('converges fresh, canonical-v18, and interim-v18 databases on the v19 telemetry schema', () => {
    const fresh = openDatabase(':memory:');
    const canonical = openDatabase(':memory:');
    const interim = openDatabase(':memory:');
    migrate(fresh);
    migrate(canonical, { toVersion: 18 });
    migrate(interim, { toVersion: 18 });
    rewriteAsInterimMigration18(interim);
    migrate(canonical);
    migrate(interim);

    const expected = telemetryPhysicalSchema(fresh);
    expect(telemetryPhysicalSchema(canonical)).toEqual(expected);
    expect(telemetryPhysicalSchema(interim)).toEqual(expected);
    for (const db of [fresh, canonical, interim]) {
      expectCanonicalProviderGenerationSchema(db);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      db.close();
    }
  });
});
