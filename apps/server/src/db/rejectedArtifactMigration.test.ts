import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDb } from './database.js';
import { LATEST_MIGRATION_VERSION, migrate } from './migrate.js';
import { createRepositories, type Repositories } from '../repositories/index.js';
import type { RejectedGenerationArtifactInput } from '../llm/rejectedArtifact.js';

/**
 * Migration 46 retains rejected model candidates locally for diagnosis. The
 * table is purely additive: historical rows keep their meaning, foreign keys
 * stay valid, and one physical attempt can own at most one artifact.
 */

const T = '2026-08-29T00:00:00.000Z';

function seedModelCall(db: SqliteDb, callId: string, attemptId: string): void {
  db.prepare(
    `INSERT INTO model_logical_calls
       (id, operation_id, workspace_id, study_session_id, learning_unit_id, assessment_id,
        operation_type, cache_key, cache_status, prompt_fingerprint, schema_fingerprint,
        policy_fingerprint, source_fingerprint, status, created_at, completed_at)
     VALUES (?, NULL, NULL, NULL, NULL, NULL, 'concept_lesson', NULL, 'not_checked',
             NULL, NULL, NULL, NULL, 'open', ?, NULL)`,
  ).run(callId, T);
  db.prepare(
    `INSERT INTO model_call_attempts
       (id, logical_call_id, attempt_number, attempt_kind, provider, model, provider_generation,
        fencing_token, status, started_at, sent_at, first_token_at, completed_at, latency_ms,
        time_to_first_token_ms, error_code, error_message)
     VALUES (?, ?, 1, 'original', 'hy3', 'test-model', 1, 1, 'queued', ?,
             NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
  ).run(attemptId, callId, T);
}

function artifactInput(
  overrides: Partial<RejectedGenerationArtifactInput> = {},
): RejectedGenerationArtifactInput {
  return {
    logicalCallId: 'call_1',
    attemptId: 'att_1',
    attemptNumber: 1,
    attemptKind: 'original',
    operationKind: 'concept_lesson',
    schemaName: 'ConceptLessonPayload',
    createdAt: T,
    validationKind: 'schema',
    failureCategory: 'SCHEMA_VALIDATION_FAILURE',
    repairExhausted: false,
    candidate: {
      representation: 'json',
      body: '{"steps":[]}',
      bytes: 12,
      truncated: false,
      contentHash: 'a'.repeat(64),
    },
    findings: [{ kind: 'schema', path: 'steps', code: 'too_small', message: 'Array too small' }],
    promptFingerprint: 'b'.repeat(64),
    schemaFingerprint: null,
    policyFingerprint: null,
    sourceFingerprint: null,
    validationFingerprint: null,
    ...overrides,
  };
}

describe('rejected generation artifact migration', () => {
  let db: SqliteDb;
  let repos: Repositories;

  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db);
    repos = createRepositories(db);
  });

  it('registers migration 46 as the additive latest version', () => {
    const applied = db
      .prepare('SELECT version, name FROM schema_migrations WHERE version = 46')
      .get() as { version: number; name: string } | undefined;
    expect(applied).toEqual({ version: 46, name: 'rejected_generation_artifacts' });
    expect(LATEST_MIGRATION_VERSION).toBeGreaterThanOrEqual(46);
  });

  it('migrates a pre-46 database with existing model-call history and keeps it readable', () => {
    const legacy = openDatabase(':memory:');
    migrate(legacy, { toVersion: 45 });
    seedModelCall(legacy, 'call_hist', 'att_hist');
    expect(
      legacy.prepare('SELECT COUNT(*) AS n FROM model_call_attempts').get() as { n: number },
    ).toEqual({ n: 1 });

    migrate(legacy);

    expect(
      legacy.prepare('SELECT COUNT(*) AS n FROM model_call_attempts').get() as { n: number },
    ).toEqual({ n: 1 });
    expect(legacy.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    const table = legacy
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get('rejected_generation_artifacts');
    expect(table).toBeTruthy();
    legacy.close();
  });

  it('round-trips a retained artifact and enforces referential integrity', () => {
    seedModelCall(db, 'call_1', 'att_1');
    const id = repos.telemetry.insertRejectedArtifact('rej_1', artifactInput());
    expect(id).toBe('rej_1');

    const stored = repos.telemetry.getRejectedArtifact('rej_1');
    expect(stored).toMatchObject({
      id: 'rej_1',
      logicalCallId: 'call_1',
      attemptId: 'att_1',
      validationKind: 'schema',
      failureCategory: 'SCHEMA_VALIDATION_FAILURE',
      repairExhausted: false,
    });
    expect(stored?.candidate.body).toBe('{"steps":[]}');
    expect(stored?.findings).toEqual([
      { kind: 'schema', path: 'steps', code: 'too_small', message: 'Array too small' },
    ]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('rejects an artifact whose attempt identity does not exist', () => {
    expect(() =>
      repos.telemetry.insertRejectedArtifact('rej_orphan', artifactInput()),
    ).toThrowError(/FOREIGN KEY/iu);
  });

  it('cascades artifact removal with its logical call', () => {
    seedModelCall(db, 'call_1', 'att_1');
    repos.telemetry.insertRejectedArtifact('rej_1', artifactInput());
    db.prepare('DELETE FROM model_logical_calls WHERE id = ?').run('call_1');
    expect(repos.telemetry.getRejectedArtifact('rej_1')).toBeUndefined();
  });

  // Test G: the uniqueness invariant is one artifact per physical attempt, so a
  // duplicated callback can never create two candidates for the same attempt.
  it('keeps one artifact per physical attempt when a callback repeats', () => {
    seedModelCall(db, 'call_1', 'att_1');
    expect(repos.telemetry.insertRejectedArtifact('rej_1', artifactInput())).toBe('rej_1');
    expect(repos.telemetry.insertRejectedArtifact('rej_2', artifactInput())).toBeUndefined();

    expect(repos.telemetry.listRejectedArtifacts('call_1')).toHaveLength(1);
    expect(repos.telemetry.getRejectedArtifactByAttempt('att_1')?.id).toBe('rej_1');
    expect(repos.telemetry.getRejectedArtifact('rej_2')).toBeUndefined();
  });

  it('constrains the retained candidate representation to the closed vocabulary', () => {
    seedModelCall(db, 'call_1', 'att_1');
    expect(() =>
      db
        .prepare(
          `INSERT INTO rejected_generation_artifacts
             (id, logical_call_id, attempt_id, attempt_number, attempt_kind, operation_kind,
              schema_name, created_at, validation_kind, failure_category, repair_exhausted,
              candidate_representation, candidate_body, candidate_bytes, candidate_truncated,
              candidate_content_hash, finding_count, findings, prompt_fingerprint,
              schema_fingerprint, policy_fingerprint, source_fingerprint, validation_fingerprint)
           VALUES ('rej_bad', 'call_1', 'att_1', 1, 'original', 'concept_lesson',
                   'S', ?, 'schema', 'SCHEMA_VALIDATION_FAILURE', 0,
                   'binary_blob', NULL, 0, 0, NULL, 0, '[]', NULL, NULL, NULL, NULL, NULL)`,
        )
        .run(T),
    ).toThrowError(/CHECK/iu);
  });
});
