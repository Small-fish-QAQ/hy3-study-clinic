import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { LATEST_MIGRATION_VERSION, migrate } from './migrate.js';
import { createCurriculaRepo } from '../repositories/curricula.js';

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

function insertAcceptedLessonCascadeFixture(db: ReturnType<typeof openDatabase>): void {
  const at = '2026-01-01T00:00:00.000Z';
  db.prepare(
    `INSERT INTO workspaces (id, name, origin, created_at, updated_at)
     VALUES ('ws_checkpoint_cascade', 'Checkpoint cascade', 'manual', ?, ?)`,
  ).run(at, at);
  db.prepare(
    `INSERT INTO learning_contract_versions
       (id, workspace_id, version, status, payload, created_at)
     VALUES ('contract_checkpoint_cascade', 'ws_checkpoint_cascade', 1, 'active', '{}', ?)`,
  ).run(at);
  db.prepare(
    `INSERT INTO execution_source_manifests
       (id, workspace_id, fingerprint, payload, created_at)
     VALUES ('manifest_checkpoint_cascade', 'ws_checkpoint_cascade',
       'manifest-checkpoint-cascade', '{}', ?)`,
  ).run(at);
  db.prepare(
    `INSERT INTO curriculum_versions
       (id, workspace_id, contract_id, manifest_id, manifest_fingerprint, version,
        status, validation_valid, payload, created_at)
     VALUES ('curriculum_checkpoint_cascade', 'ws_checkpoint_cascade',
       'contract_checkpoint_cascade', 'manifest_checkpoint_cascade',
       'manifest-checkpoint-cascade', 1, 'accepted', 1, '{}', ?)`,
  ).run(at);
  db.prepare(
    `INSERT INTO study_plan_versions
       (id, workspace_id, contract_id, curriculum_id, manifest_fingerprint, version,
        status, payload, created_at)
     VALUES ('plan_checkpoint_cascade', 'ws_checkpoint_cascade',
       'contract_checkpoint_cascade', 'curriculum_checkpoint_cascade',
       'manifest-checkpoint-cascade', 1, 'accepted', '{}', ?)`,
  ).run(at);
  db.prepare(
    `INSERT INTO session_agendas
       (id, workspace_id, contract_id, curriculum_id, plan_id, manifest_fingerprint,
        version, status, payload, created_at, updated_at)
     VALUES ('agenda_checkpoint_cascade', 'ws_checkpoint_cascade',
       'contract_checkpoint_cascade', 'curriculum_checkpoint_cascade',
       'plan_checkpoint_cascade', 'manifest-checkpoint-cascade', 1, 'active', '{}', ?, ?)`,
  ).run(at, at);
  db.prepare(
    `INSERT INTO study_sessions
       (id, workspace_id, contract_id, curriculum_id, plan_id, agenda_id,
        manifest_fingerprint, version, status, route_state, current_agenda_item_id,
        route_stack, transcript_watermark, created_at, updated_at)
     VALUES ('session_checkpoint_cascade', 'ws_checkpoint_cascade',
       'contract_checkpoint_cascade', 'curriculum_checkpoint_cascade',
       'plan_checkpoint_cascade', 'agenda_checkpoint_cascade',
       'manifest-checkpoint-cascade', 1, 'active', 'on_route', 'agenda_item_checkpoint_cascade',
       '[]', 0, ?, ?)`,
  ).run(at, at);
  db.prepare(
    `INSERT INTO accepted_lesson_checkpoints
       (id, workspace_id, study_session_id, session_agenda_id, agenda_item_id,
        expected_session_version, expected_agenda_version, curriculum_id, study_plan_id,
        study_plan_item_id, learning_unit_id, manifest_fingerprint,
        source_context_fingerprint, skeleton_version, skeleton_fingerprint,
        skeleton_payload, lesson_payload, lesson_evaluation_payload, operation_id,
        provider, provider_model, prompt_version, created_at)
     VALUES ('checkpoint_cascade', 'ws_checkpoint_cascade', 'session_checkpoint_cascade',
       'agenda_checkpoint_cascade', 'agenda_item_checkpoint_cascade', 1, 1,
       'curriculum_checkpoint_cascade', 'plan_checkpoint_cascade',
       'plan_item_checkpoint_cascade', 'unit_checkpoint_cascade',
       'manifest-checkpoint-cascade', 'source-checkpoint-cascade', 1,
       'skeleton-checkpoint-cascade', '{}', '[]', '{}', 'operation_checkpoint_cascade',
       'fake', 'fake-deterministic', 'lesson-content-v1-compositional', ?)`,
  ).run(at);
}

function objectiveSemanticSupportPayload() {
  return {
    schemaVersion: 1 as const,
    policyVersion: 'objective-authority-semantic-support-v1',
    evaluator: 'independent-semantic-evaluator-v1',
    provider: 'fake',
    providerModel: null,
    independent: true as const,
    objectiveId: 'objective_v41',
    proposition: 'Explain the exact source relationship.',
    propositionFingerprint: 'proposition-v41',
    construct: 'explain' as const,
    boundAuthorityRecordIds: ['authority_v41'],
    boundSourceBlockIds: ['block_v41'],
    boundAuthorityClaimIds: ['claim_v41'],
    bindingFingerprint: 'binding-v41',
    fragments: [
      {
        fragmentId: 'fragment_v41',
        text: 'Explain the exact source relationship.',
        status: 'supported' as const,
        supportType: 'relationship' as const,
        sourceBlockIds: ['block_v41'],
        authorityRecordIds: ['authority_v41'],
        authorityClaimIds: ['claim_v41'],
        rationale: 'The bound claim states the requested relationship.',
      },
    ],
    unsupportedFragmentIds: [],
    conflicts: [],
    overreach: [],
    verdict: 'pass' as const,
    rationale: 'Every objective fragment is supported by bound authority.',
    evaluatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function insertObjectiveSemanticSupportMigrationFixture(
  db: ReturnType<typeof openDatabase>,
): string {
  const at = '2026-01-01T00:00:00.000Z';
  const curriculumPayload = JSON.stringify({
    id: 'curriculum_v41',
    workspaceId: 'ws_v41',
    contractVersionId: 'contract_v41',
    version: 1,
    predecessorId: null,
    status: 'accepted',
    executionSourceManifest: {
      fingerprint: 'manifest-v41',
      revisions: [
        {
          materialId: 'material_v41',
          materialRevisionId: 'revision_v41',
          parserVersion: 'fixture-v1',
          parserFingerprint: null,
          sourceBlockRevisionIds: ['block_v41'],
        },
      ],
    },
    nodes: [
      {
        id: 'root_v41',
        parentId: null,
        kind: 'course',
        index: 0,
        title: 'Legacy Curriculum',
        sourceReferences: [],
        learningUnit: null,
      },
      {
        id: 'unit_v41',
        parentId: 'root_v41',
        kind: 'learning_unit',
        index: 0,
        title: 'Legacy unit',
        sourceReferences: [],
        learningUnit: {
          conceptIds: [],
          canonicalConceptIds: [],
          objectives: [
            {
              id: 'objective_v41',
              title: 'Explain the relationship',
              description: 'Explain the exact source relationship.',
              truthPremiseStatus: 'independently_verified',
              truthAuthorityRecordIds: ['authority_v41'],
              authorityClaimIds: ['claim_v41'],
              formalAssessmentConstruct: 'explain',
            },
          ],
          prerequisiteUnitIds: [],
          graphRelationIds: [],
          riskIds: [],
        },
      },
    ],
    synthesisGroups: [],
    validation: { valid: true, errors: [], warnings: [], unmappedStructuralUnitIds: [] },
    provider: 'fake',
    providerModel: null,
    createdAt: at,
    acceptedAt: at,
  });
  db.prepare(
    `INSERT INTO workspaces (id, name, origin, created_at, updated_at)
     VALUES ('ws_v41', 'Semantic support migration', 'manual', ?, ?)`,
  ).run(at, at);
  db.prepare(
    `INSERT INTO learning_contract_versions
       (id, workspace_id, version, status, payload, created_at)
     VALUES ('contract_v41', 'ws_v41', 1, 'active', '{}', ?)`,
  ).run(at);
  db.prepare(
    `INSERT INTO execution_source_manifests
       (id, workspace_id, fingerprint, payload, created_at)
     VALUES ('manifest_v41', 'ws_v41', 'manifest-v41', '{}', ?)`,
  ).run(at);
  db.prepare(
    `INSERT INTO curriculum_versions
       (id, workspace_id, contract_id, manifest_id, manifest_fingerprint, version,
        status, validation_valid, payload, created_at, accepted_at)
     VALUES ('curriculum_v41', 'ws_v41', 'contract_v41', 'manifest_v41',
       'manifest-v41', 1, 'accepted', 1, ?, ?, ?)`,
  ).run(curriculumPayload, at, at);
  db.prepare(
    `INSERT INTO curriculum_node_index
       (curriculum_id, node_id, parent_node_id, kind, idx, title)
     VALUES ('curriculum_v41', 'root_v41', NULL, 'course', 0, 'Legacy Curriculum'),
            ('curriculum_v41', 'unit_v41', 'root_v41', 'learning_unit', 0, 'Legacy unit')`,
  ).run();
  db.prepare(
    `INSERT INTO curriculum_objective_index
       (curriculum_id, learning_unit_id, objective_id, truth_premise_status)
     VALUES ('curriculum_v41', 'unit_v41', 'objective_v41', 'independently_verified')`,
  ).run();
  return curriculumPayload;
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
    expect(row.v).toBe(LATEST_MIGRATION_VERSION);
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
      'accepted_lesson_checkpoints',
      'lesson_execution_states',
      'lesson_execution_events',
      'pace_observations',
      'curriculum_quality_evaluations',
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

  it('creates the append-only Curriculum quality evaluation store', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'curriculum_quality_evaluations'",
        )
        .get(),
    ).toEqual({ name: 'curriculum_quality_evaluations' });
    db.close();
  });

  it('adds weak informal Practice state without creating Formal authority paths', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const columns = db.pragma('table_info(lesson_execution_states)') as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    expect(columns.find((column) => column.name === 'practice_interactions')).toMatchObject({
      notnull: 1,
      dflt_value: "'[]'",
    });
    expect(columns.find((column) => column.name === 'practice_completed_at')).toMatchObject({
      notnull: 0,
    });
    const eventSql = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'lesson_execution_events'",
      )
      .get() as { sql: string };
    expect(eventSql.sql).toContain("'practice_response_recorded'");
    expect(eventSql.sql).toContain("'practice_completed'");
    expect(eventSql.sql).not.toMatch(/mastery|formal_evidence|progression_decision/iu);
    db.close();
  });

  it('adds immutable accepted-Lesson checkpoints without learner-state authority paths', () => {
    const db = openDatabase(':memory:');
    migrate(db, { toVersion: 36 });
    migrate(db, { toVersion: 37 });

    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'accepted_lesson_checkpoints'",
        )
        .get(),
    ).toEqual({ name: 'accepted_lesson_checkpoints' });
    expect(
      db.prepare('SELECT version, name FROM schema_migrations WHERE version = 37').get(),
    ).toEqual({ version: 37, name: 'immutable_accepted_lesson_checkpoints' });
    expect(
      (db.pragma('table_info(accepted_lesson_checkpoints)') as Array<{ name: string }>).some(
        (column) => column.name === 'lesson_logical_call_id',
      ),
    ).toBe(false);
    const freshDeleteTriggerSql = (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'prevent_accepted_lesson_checkpoint_delete'",
        )
        .get() as { sql: string }
    ).sql;
    expect(freshDeleteTriggerSql).toContain('FROM study_sessions');
    expect(freshDeleteTriggerSql).toContain('FROM workspaces');

    migrate(db);
    expect(
      db.prepare('SELECT version, name FROM schema_migrations WHERE version = 38').get(),
    ).toEqual({ version: 38, name: 'accepted_lesson_logical_call_provenance' });
    expect(
      (
        db.pragma('table_info(accepted_lesson_checkpoints)') as Array<{
          name: string;
          notnull: number;
        }>
      ).find((column) => column.name === 'lesson_logical_call_id'),
    ).toMatchObject({ notnull: 0 });

    const tableSql = (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'accepted_lesson_checkpoints'",
        )
        .get() as { sql: string }
    ).sql;
    expect(tableSql).toContain('expected_session_version');
    expect(tableSql).toContain('expected_agenda_version');
    expect(tableSql).toContain('skeleton_fingerprint');
    expect(tableSql).not.toMatch(/formal_evidence|mastery|mistake|progression/iu);

    const triggerSql = (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'prevent_accepted_lesson_checkpoint_update'",
        )
        .get() as { sql: string }
    ).sql;
    expect(triggerSql).toContain('Accepted Lesson checkpoints are immutable');
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'prevent_accepted_lesson_checkpoint_delete'",
        )
        .get(),
    ).toEqual({ name: 'prevent_accepted_lesson_checkpoint_delete' });
    const lessonStateColumns = db.pragma('table_info(lesson_execution_states)') as Array<{
      name: string;
      notnull: number;
    }>;
    expect(
      lessonStateColumns.find((column) => column.name === 'accepted_lesson_checkpoint_id'),
    ).toMatchObject({ notnull: 0 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it.each([
    ['exact', 'source-checkpoint-cascade', 'lesson-slot-content-proposal-v1', 'lesson_call_exact'],
    ['mismatched', 'source-checkpoint-other', 'lesson-slot-content-proposal-v1', null],
    ['missing', null, 'lesson-slot-content-proposal-v1', null],
    ['wrong-schema', 'source-checkpoint-cascade', 'practice-content-proposal-v1', null],
  ] as const)(
    'backfills only %s Lesson logical-call source provenance',
    (_label, sourceFingerprint, schemaFingerprint, expectedLogicalCallId) => {
      const db = openDatabase(':memory:');
      const at = '2026-01-01T00:00:00.000Z';
      migrate(db, { toVersion: 37 });
      insertAcceptedLessonCascadeFixture(db);
      db.prepare(
        `INSERT INTO agent_operations
           (id, workspace_id, command_id, idempotency_key, logical_operation_id,
            operation_type, expected_fingerprint, status, lease_owner, lease_expires_at,
            fencing_token, created_at, updated_at)
         VALUES ('operation_checkpoint_cascade', 'ws_checkpoint_cascade',
           'command_checkpoint_cascade', 'idempotency_checkpoint_cascade',
           'logical_operation_checkpoint_cascade', 'prepare_teaching_brief',
           'route-fingerprint', 'completed', NULL, NULL, 1, ?, ?)`,
      ).run(at, at);
      db.prepare(
        `INSERT INTO model_logical_calls
           (id, operation_id, workspace_id, study_session_id, learning_unit_id,
            assessment_id, operation_type, cache_key, cache_status, prompt_fingerprint,
            schema_fingerprint, policy_fingerprint, source_fingerprint, status,
            created_at, completed_at)
         VALUES ('lesson_call_exact', 'operation_checkpoint_cascade',
           'ws_checkpoint_cascade', 'session_checkpoint_cascade', 'unit_checkpoint_cascade',
           NULL, 'prepare_teaching_brief', NULL, 'not_checked', NULL,
           ?, NULL, ?, 'completed', ?, ?)`,
      ).run(schemaFingerprint, sourceFingerprint, at, at);

      migrate(db, { toVersion: 38 });

      expect(
        db
          .prepare(
            "SELECT lesson_logical_call_id FROM accepted_lesson_checkpoints WHERE id = 'checkpoint_cascade'",
          )
          .get(),
      ).toEqual({ lesson_logical_call_id: expectedLogicalCallId });
      expect(db.pragma('foreign_key_check')).toEqual([]);
      db.close();
    },
  );

  it('keeps accepted Lessons immutable while allowing an owning workspace cascade', () => {
    const db = openDatabase(':memory:');
    migrate(db, { toVersion: 38 });
    insertAcceptedLessonCascadeFixture(db);

    migrate(db);
    expect(
      db.prepare('SELECT version, name FROM schema_migrations WHERE version = 39').get(),
    ).toEqual({ version: 39, name: 'allow_accepted_lesson_workspace_cascade' });
    expect(() =>
      db.prepare("DELETE FROM accepted_lesson_checkpoints WHERE id = 'checkpoint_cascade'").run(),
    ).toThrow('Accepted Lesson checkpoints are immutable');
    expect(db.prepare('SELECT COUNT(*) AS count FROM accepted_lesson_checkpoints').get()).toEqual({
      count: 1,
    });

    db.prepare("DELETE FROM workspaces WHERE id = 'ws_checkpoint_cascade'").run();
    expect(db.prepare('SELECT COUNT(*) AS count FROM accepted_lesson_checkpoints').get()).toEqual({
      count: 0,
    });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM study_sessions WHERE id = 'session_checkpoint_cascade'",
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('allows an accepted Lesson checkpoint to cascade with its owning StudySession', () => {
    const db = openDatabase(':memory:');
    migrate(db, { toVersion: 38 });
    insertAcceptedLessonCascadeFixture(db);
    migrate(db);

    db.prepare("DELETE FROM study_sessions WHERE id = 'session_checkpoint_cascade'").run();

    expect(db.prepare('SELECT COUNT(*) AS count FROM accepted_lesson_checkpoints').get()).toEqual({
      count: 0,
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('preserves Brief data and child foreign keys while allowing session-bound finals', () => {
    const db = openDatabase(':memory:');
    const at = '2026-01-01T00:00:00.000Z';
    migrate(db, { toVersion: 39 });
    db.prepare(
      `INSERT INTO workspaces (id, name, origin, created_at, updated_at)
       VALUES ('ws_brief_v40', 'Brief migration', 'manual', ?, ?)`,
    ).run(at, at);
    db.prepare(
      `INSERT INTO learning_contract_versions
         (id, workspace_id, version, status, payload, created_at)
       VALUES ('contract_brief_v40', 'ws_brief_v40', 1, 'active', '{}', ?)`,
    ).run(at);
    db.prepare(
      `INSERT INTO execution_source_manifests
         (id, workspace_id, fingerprint, payload, created_at)
       VALUES ('manifest_brief_v40', 'ws_brief_v40', 'manifest-v40', '{}', ?)`,
    ).run(at);
    db.prepare(
      `INSERT INTO curriculum_versions
         (id, workspace_id, contract_id, manifest_id, manifest_fingerprint, version,
          status, validation_valid, payload, created_at)
       VALUES ('curriculum_brief_v40', 'ws_brief_v40', 'contract_brief_v40',
         'manifest_brief_v40', 'manifest-v40', 1, 'accepted', 1, '{}', ?)`,
    ).run(at);
    db.prepare(
      `INSERT INTO study_plan_versions
         (id, workspace_id, contract_id, curriculum_id, manifest_fingerprint, version,
          status, payload, created_at)
       VALUES ('plan_brief_v40', 'ws_brief_v40', 'contract_brief_v40',
         'curriculum_brief_v40', 'manifest-v40', 1, 'accepted', '{}', ?)`,
    ).run(at);
    db.prepare(
      `INSERT INTO session_agendas
         (id, workspace_id, contract_id, curriculum_id, plan_id, manifest_fingerprint,
          version, status, payload, created_at, updated_at)
       VALUES ('agenda_brief_v40', 'ws_brief_v40', 'contract_brief_v40',
         'curriculum_brief_v40', 'plan_brief_v40', 'manifest-v40', 1, 'active', '{}', ?, ?)`,
    ).run(at, at);
    db.prepare(
      `INSERT INTO study_sessions
         (id, workspace_id, contract_id, curriculum_id, plan_id, agenda_id,
          manifest_fingerprint, version, status, route_state, current_agenda_item_id,
          route_stack, transcript_watermark, created_at, updated_at)
       VALUES ('session_brief_v40', 'ws_brief_v40', 'contract_brief_v40',
         'curriculum_brief_v40', 'plan_brief_v40', 'agenda_brief_v40', 'manifest-v40',
         1, 'active', 'on_route', NULL, '[]', 0, ?, ?)`,
    ).run(at, at);
    const insertBrief = db.prepare(
      `INSERT INTO teaching_briefs
         (id, workspace_id, curriculum_id, study_plan_id, learning_unit_id,
          manifest_fingerprint, source_context_fingerprint, payload, provider,
          provider_model, prompt_version, created_at)
       VALUES (?, 'ws_brief_v40', 'curriculum_brief_v40', 'plan_brief_v40', 'unit_v40',
         'manifest-v40', 'context-v40', ?, 'fake', NULL, 'legacy-prompt', ?)`,
    );
    insertBrief.run('brief_v40_a', '{"session":"a"}', at);
    db.prepare(
      `INSERT INTO lesson_execution_states
         (id, session_id, agenda_item_id, curriculum_id, study_plan_id, learning_unit_id,
          teaching_brief_id, manifest_fingerprint, source_context_fingerprint,
          preparation_status, preparation_operation_id, version, current_segment_index,
          presented_segment_indexes, informal_interactions, presentation_completed_at,
          created_at, updated_at, practice_interactions, practice_completed_at,
          accepted_lesson_checkpoint_id)
       VALUES ('lesson_state_v40', 'session_brief_v40', 'agenda_item_v40',
         'curriculum_brief_v40', 'plan_brief_v40', 'unit_v40', 'brief_v40_a',
         'manifest-v40', 'context-v40', 'ready', NULL, 1, 0, '[]', '[]', NULL,
         ?, ?, '[]', NULL, NULL)`,
    ).run(at, at);

    expect(() => insertBrief.run('brief_v40_pre_conflict', '{"session":"pre"}', at)).toThrow();
    migrate(db);

    expect(
      db.prepare('SELECT version, name FROM schema_migrations WHERE version = 40').get(),
    ).toEqual({ version: 40, name: 'session_bound_compositional_teaching_briefs' });
    expect(
      db.prepare("SELECT payload FROM teaching_briefs WHERE id = 'brief_v40_a'").get(),
    ).toEqual({ payload: '{"session":"a"}' });
    expect(
      db
        .prepare(
          "SELECT teaching_brief_id FROM lesson_execution_states WHERE id = 'lesson_state_v40'",
        )
        .get(),
    ).toEqual({ teaching_brief_id: 'brief_v40_a' });
    expect(() =>
      insertBrief.run('brief_v40_b', '{"session":"b"}', '2026-01-01T00:01:00.000Z'),
    ).not.toThrow();
    const tableSql = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'teaching_briefs'")
        .get() as { sql: string }
    ).sql;
    expect(tableSql).not.toContain(
      'UNIQUE (curriculum_id, study_plan_id, learning_unit_id, manifest_fingerprint, source_context_fingerprint)',
    );
    expect(db.prepare('SELECT COUNT(*) AS count FROM teaching_briefs').get()).toEqual({ count: 2 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('adds immutable objective semantic support with composite objective ownership', () => {
    const db = openDatabase(':memory:');
    migrate(db, { toVersion: 40 });
    insertObjectiveSemanticSupportMigrationFixture(db);
    migrate(db);

    expect(
      db.prepare('SELECT version, name FROM schema_migrations WHERE version = 41').get(),
    ).toEqual({ version: 41, name: 'objective_authority_semantic_support' });
    const columns = db.pragma('table_info(curriculum_objective_semantic_support)') as Array<{
      name: string;
      notnull: number;
    }>;
    expect(columns.map(({ name, notnull }) => ({ name, notnull }))).toEqual([
      { name: 'curriculum_id', notnull: 1 },
      { name: 'objective_id', notnull: 1 },
      { name: 'policy_version', notnull: 1 },
      { name: 'evaluator', notnull: 1 },
      { name: 'provider', notnull: 1 },
      { name: 'provider_model', notnull: 0 },
      { name: 'status', notnull: 1 },
      { name: 'proposition_fingerprint', notnull: 1 },
      { name: 'binding_fingerprint', notnull: 1 },
      { name: 'payload', notnull: 1 },
      { name: 'evaluated_at', notnull: 1 },
    ]);

    const support = objectiveSemanticSupportPayload();
    const insertSupport = db.prepare(
      `INSERT INTO curriculum_objective_semantic_support
         (curriculum_id, objective_id, policy_version, evaluator, provider,
          provider_model, status, proposition_fingerprint, binding_fingerprint,
          payload, evaluated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    expect(() =>
      insertSupport.run(
        'curriculum_v41',
        'unknown_objective',
        support.policyVersion,
        support.evaluator,
        support.provider,
        support.providerModel,
        support.verdict,
        support.propositionFingerprint,
        support.bindingFingerprint,
        JSON.stringify(support),
        support.evaluatedAt,
      ),
    ).toThrow(/FOREIGN KEY/);
    insertSupport.run(
      'curriculum_v41',
      support.objectiveId,
      support.policyVersion,
      support.evaluator,
      support.provider,
      support.providerModel,
      support.verdict,
      support.propositionFingerprint,
      support.bindingFingerprint,
      JSON.stringify(support),
      support.evaluatedAt,
    );
    const replacementSupport = {
      ...support,
      evaluator: 'replacement-evaluator-must-not-persist',
    };
    expect(() =>
      db
        .prepare(
          `INSERT OR REPLACE INTO curriculum_objective_semantic_support
             (curriculum_id, objective_id, policy_version, evaluator, provider,
              provider_model, status, proposition_fingerprint, binding_fingerprint,
              payload, evaluated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'curriculum_v41',
          replacementSupport.objectiveId,
          replacementSupport.policyVersion,
          replacementSupport.evaluator,
          replacementSupport.provider,
          replacementSupport.providerModel,
          replacementSupport.verdict,
          replacementSupport.propositionFingerprint,
          replacementSupport.bindingFingerprint,
          JSON.stringify(replacementSupport),
          replacementSupport.evaluatedAt,
        ),
    ).toThrow(/semantic support is immutable/i);
    expect(
      db
        .prepare(
          `SELECT evaluator, payload FROM curriculum_objective_semantic_support
           WHERE curriculum_id = 'curriculum_v41' AND objective_id = 'objective_v41'`,
        )
        .get(),
    ).toEqual({ evaluator: support.evaluator, payload: JSON.stringify(support) });
    expect(() =>
      db
        .prepare(
          `UPDATE curriculum_objective_semantic_support SET status = 'fail'
           WHERE curriculum_id = 'curriculum_v41' AND objective_id = 'objective_v41'`,
        )
        .run(),
    ).toThrow(/semantic support is immutable/i);
    expect(() =>
      db
        .prepare(
          `DELETE FROM curriculum_objective_semantic_support
           WHERE curriculum_id = 'curriculum_v41' AND objective_id = 'objective_v41'`,
        )
        .run(),
    ).toThrow(/semantic support is immutable/i);

    expect(() => db.prepare("DELETE FROM workspaces WHERE id = 'ws_v41'").run()).not.toThrow();
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM curriculum_objective_semantic_support').get(),
    ).toEqual({ count: 0 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('prevents erasing semantic support through its objective index owner', () => {
    const db = openDatabase(':memory:');
    migrate(db, { toVersion: 40 });
    insertObjectiveSemanticSupportMigrationFixture(db);
    migrate(db);

    const support = objectiveSemanticSupportPayload();
    db.prepare(
      `INSERT INTO curriculum_objective_semantic_support
         (curriculum_id, objective_id, policy_version, evaluator, provider,
          provider_model, status, proposition_fingerprint, binding_fingerprint,
          payload, evaluated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'curriculum_v41',
      support.objectiveId,
      support.policyVersion,
      support.evaluator,
      support.provider,
      support.providerModel,
      support.verdict,
      support.propositionFingerprint,
      support.bindingFingerprint,
      JSON.stringify(support),
      support.evaluatedAt,
    );

    const eraseAndReinsertOwner = db.transaction(() => {
      db.prepare(
        `DELETE FROM curriculum_objective_index
         WHERE curriculum_id = 'curriculum_v41' AND objective_id = 'objective_v41'`,
      ).run();
      db.prepare(
        `INSERT INTO curriculum_objective_index
           (curriculum_id, learning_unit_id, objective_id, truth_premise_status)
         VALUES ('curriculum_v41', 'unit_v41', 'objective_v41', 'independently_verified')`,
      ).run();
    });
    expect(() => eraseAndReinsertOwner()).toThrow(/semantic support ownership is immutable/i);
    expect(() =>
      db
        .prepare(
          `INSERT OR REPLACE INTO curriculum_objective_index
             (curriculum_id, learning_unit_id, objective_id, truth_premise_status)
           VALUES ('curriculum_v41', 'unit_v41', 'objective_v41', 'unverified')`,
        )
        .run(),
    ).toThrow(/semantic support ownership is immutable/i);
    expect(
      db
        .prepare(
          `SELECT truth_premise_status FROM curriculum_objective_index
           WHERE curriculum_id = 'curriculum_v41' AND objective_id = 'objective_v41'`,
        )
        .get(),
    ).toEqual({ truth_premise_status: 'independently_verified' });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM curriculum_objective_index
           WHERE curriculum_id = 'curriculum_v41' AND objective_id = 'objective_v41'`,
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM curriculum_objective_semantic_support
           WHERE curriculum_id = 'curriculum_v41' AND objective_id = 'objective_v41'`,
        )
        .get(),
    ).toEqual({ count: 1 });

    expect(() =>
      db.prepare("DELETE FROM curriculum_versions WHERE id = 'curriculum_v41'").run(),
    ).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS count FROM curriculum_objective_index').get()).toEqual({
      count: 0,
    });
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM curriculum_objective_semantic_support').get(),
    ).toEqual({ count: 0 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('keeps migration-40 Curricula readable without fabricating semantic support', () => {
    const db = openDatabase(':memory:');
    migrate(db, { toVersion: 40 });
    const legacyPayload = insertObjectiveSemanticSupportMigrationFixture(db);

    migrate(db);

    expect(
      db.prepare("SELECT payload FROM curriculum_versions WHERE id = 'curriculum_v41'").get(),
    ).toEqual({ payload: legacyPayload });
    const curriculum = createCurriculaRepo(db).get('curriculum_v41');
    expect(curriculum?.nodes[1]?.learningUnit?.objectives[0]?.semanticSupport).toBeUndefined();
    expect(db.pragma('foreign_key_check')).toEqual([]);
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

  it('upgrades migration-31 pending Review rows without fabricating FSRS memory', () => {
    const db = openDatabase(':memory:');
    migrate(db, { toVersion: 31 });
    const cutoverAt = '2026-01-01T00:00:00.000Z';
    db.prepare(
      `INSERT INTO workspaces (id, name, origin, created_at, updated_at)
       VALUES ('ws_review_v31', 'Review migration', 'manual', ?, ?)`,
    ).run(cutoverAt, cutoverAt);
    db.prepare(
      `INSERT INTO review_scheduler_configurations
         (version, algorithm_generation, package_name, package_version, local_adapter_version,
          rating_policy_version, requested_retention, config_hash, fuzz, short_term,
          maximum_due_horizon_days, effective_at, retired_at)
       VALUES ('review-policy-fsrs6-v1', 'FSRS-6', 'ts-fsrs', '5.4.1',
         'study-clinic-fsrs6-v1', 'formal-review-outcome-binary-v1', 0.9,
         'migration-fixture', 0, 0, 365, ?, NULL)`,
    ).run(cutoverAt);
    db.prepare(
      `INSERT INTO review_targets
         (id, workspace_id, course_id, target_kind, origin_evidence_id, status,
          current_binding_version, created_at, updated_at)
       VALUES ('target_v31', 'ws_review_v31', 'ws_review_v31', 'curriculum_objective',
         NULL, 'pending_initial_review', 1, ?, ?)`,
    ).run(cutoverAt, cutoverAt);
    db.prepare(
      `INSERT INTO memory_schedule_states
         (review_target_id, policy_version, lifecycle_state, due_at, last_reviewed_at,
          stability, difficulty, scheduled_days, repetitions, lapses, last_review_event_id,
          row_version, created_at, updated_at)
       VALUES ('target_v31', 'review-policy-fsrs6-v1', 'new', ?, NULL,
         0, 1, 0, 0, 0, NULL, 1, ?, ?)`,
    ).run(cutoverAt, cutoverAt, cutoverAt);

    migrate(db);

    expect(
      db
        .prepare(
          `SELECT lifecycle_state, due_at, last_reviewed_at, stability, difficulty,
                  scheduled_days, repetitions, lapses, last_review_event_id
           FROM memory_schedule_states WHERE review_target_id = 'target_v31'`,
        )
        .get(),
    ).toEqual({
      lifecycle_state: 'pending_initial_review',
      due_at: cutoverAt,
      last_reviewed_at: null,
      stability: null,
      difficulty: null,
      scheduled_days: null,
      repetitions: null,
      lapses: null,
      last_review_event_id: null,
    });
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_backfill_audits'",
        )
        .get(),
    ).toEqual({ name: 'review_backfill_audits' });
    db.prepare(
      `INSERT INTO successor_review_events
         (id, review_target_id, binding_version, policy_version, kind, sequence,
          source_outcome_id, review_execution_id, rating, occurred_at, recorded_at,
          pre_state, post_state, exact_input_time, due_at, idempotency_key)
       VALUES ('event_v32', 'target_v31', NULL, 'review-policy-fsrs6-v1', 'activation', 1,
         'source_v32', NULL, 'Good', ?, ?, '{}', '{}', ?, ?, 'event_v32')`,
    ).run(cutoverAt, cutoverAt, cutoverAt, cutoverAt);
    expect(() =>
      db.prepare("DELETE FROM successor_review_events WHERE id = 'event_v32'").run(),
    ).toThrow(/append-only/);
    db.prepare("DELETE FROM workspaces WHERE id = 'ws_review_v31'").run();
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM successor_review_events WHERE id = 'event_v32'").get(),
    ).toEqual({ n: 0 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });
});
