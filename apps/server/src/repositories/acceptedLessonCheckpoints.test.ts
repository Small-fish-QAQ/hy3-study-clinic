import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AcceptedLessonCheckpoint } from '@hy3-clinic/shared';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { planTeachingSkeleton } from '../services/teachingSkeletonPlanner.js';
import { makeWorkspace, T0 } from '../testing/fixtures.js';
import { createRepositories, type Repositories } from './index.js';

const T1 = '2026-01-01T00:01:00.000Z';
const LEASE_END = '2026-01-01T01:00:00.000Z';

let db: SqliteDb;
let repos: Repositories;

function seedActiveRoute(): void {
  repos.workspaces.insert(makeWorkspace());
  db.prepare(
    `INSERT INTO learning_contract_versions
       (id, workspace_id, version, status, payload, created_at)
     VALUES ('contract_1', 'ws_1', 1, 'active', '{}', ?)`,
  ).run(T0);
  db.prepare(
    `INSERT INTO execution_source_manifests
       (id, workspace_id, fingerprint, payload, created_at)
     VALUES ('manifest_1', 'ws_1', 'manifest-1', '{}', ?)`,
  ).run(T0);
  db.prepare(
    `INSERT INTO curriculum_versions
       (id, workspace_id, contract_id, manifest_id, manifest_fingerprint, version,
        status, validation_valid, payload, created_at)
     VALUES ('curriculum_1', 'ws_1', 'contract_1', 'manifest_1', 'manifest-1', 1,
        'accepted', 1, '{}', ?)`,
  ).run(T0);
  db.prepare(
    `INSERT INTO study_plan_versions
       (id, workspace_id, contract_id, curriculum_id, manifest_fingerprint, version,
        status, payload, created_at)
     VALUES ('plan_1', 'ws_1', 'contract_1', 'curriculum_1', 'manifest-1', 1,
        'accepted', '{}', ?)`,
  ).run(T0);
  db.prepare(
    `INSERT INTO study_plan_items
       (plan_id, plan_item_id, idx, kind, curriculum_learning_unit_id,
        objective_ids, completion_requirements)
     VALUES ('plan_1', 'plan_item_1', 0, 'teach_unit', 'unit_1', '["objective_1"]', '[]')`,
  ).run();
  db.prepare(
    `INSERT INTO session_agendas
       (id, workspace_id, contract_id, curriculum_id, plan_id, manifest_fingerprint,
        version, status, payload, created_at, updated_at)
     VALUES ('agenda_1', 'ws_1', 'contract_1', 'curriculum_1', 'plan_1', 'manifest-1',
        1, 'active', '{}', ?, ?)`,
  ).run(T0, T0);
  db.prepare(
    `INSERT INTO session_agenda_items
       (agenda_id, agenda_item_id, idx, linked_plan_item_id, kind, state,
        launch_status, launch_capability)
     VALUES ('agenda_1', 'agenda_item_1', 0, 'plan_item_1', 'learning_unit_teaching',
        'active', 'launchable', 'lesson')`,
  ).run();
  db.prepare(
    `INSERT INTO study_sessions
       (id, workspace_id, contract_id, curriculum_id, plan_id, agenda_id,
        manifest_fingerprint, version, status, route_state, current_agenda_item_id,
        route_stack, transcript_watermark, created_at, updated_at)
     VALUES ('session_1', 'ws_1', 'contract_1', 'curriculum_1', 'plan_1', 'agenda_1',
        'manifest-1', 1, 'active', 'on_route', 'agenda_item_1', '[]', 0, ?, ?)`,
  ).run(T0, T0);

  const insertOperation = db.prepare(
    `INSERT INTO agent_operations
       (id, workspace_id, command_id, idempotency_key, logical_operation_id,
        operation_type, expected_fingerprint, status, lease_owner, lease_expires_at,
        fencing_token, created_at, updated_at)
     VALUES
       (@id, 'ws_1', @commandId, @idempotencyKey, @logicalOperationId,
        @operationType, 'route-fingerprint', @status, @leaseOwner, @leaseExpiresAt,
        @fencingToken, @createdAt, @updatedAt)`,
  );
  insertOperation.run({
    id: 'operation_1',
    commandId: 'command_1',
    idempotencyKey: 'idempotency_1',
    logicalOperationId: 'logical_1',
    operationType: 'prepare_teaching_brief',
    status: 'running',
    leaseOwner: 'worker_1',
    leaseExpiresAt: LEASE_END,
    fencingToken: 1,
    createdAt: T0,
    updatedAt: T0,
  });
  insertOperation.run({
    id: 'operation_wrong_type',
    commandId: 'command_wrong_type',
    idempotencyKey: 'idempotency_wrong_type',
    logicalOperationId: 'logical_wrong_type',
    operationType: 'propose_curriculum',
    status: 'running',
    leaseOwner: 'worker_2',
    leaseExpiresAt: LEASE_END,
    fencingToken: 1,
    createdAt: T0,
    updatedAt: T0,
  });
  insertOperation.run({
    id: 'operation_completed',
    commandId: 'command_completed',
    idempotencyKey: 'idempotency_completed',
    logicalOperationId: 'logical_completed',
    operationType: 'prepare_teaching_brief',
    status: 'completed',
    leaseOwner: null,
    leaseExpiresAt: null,
    fencingToken: 1,
    createdAt: T0,
    updatedAt: T1,
  });

  const logicalCall = (
    id: string,
    overrides: Partial<Parameters<typeof repos.telemetry.insertLogicalCall>[0]> = {},
  ) =>
    repos.telemetry.insertLogicalCall({
      id,
      operationId: 'operation_1',
      workspaceId: 'ws_1',
      studySessionId: 'session_1',
      learningUnitId: 'unit_1',
      assessmentId: null,
      operationType: 'prepare_teaching_brief',
      cacheKey: null,
      cacheStatus: 'not_checked',
      promptFingerprint: null,
      schemaFingerprint: 'lesson-slot-content-proposal-v1',
      policyFingerprint: null,
      sourceFingerprint: 'source-context-1',
      status: 'completed',
      createdAt: T0,
      completedAt: T1,
      ...overrides,
    });
  logicalCall('lesson_logical_1');
  logicalCall('lesson_logical_wrong_type', {
    operationType: 'prepare_teaching_lesson_content',
  });
  logicalCall('lesson_logical_wrong_schema', {
    schemaFingerprint: 'practice-content-proposal-v1',
  });
  logicalCall('lesson_logical_wrong_source', {
    sourceFingerprint: 'source-context-other',
  });
  logicalCall('lesson_logical_missing_source', { sourceFingerprint: null });
  logicalCall('lesson_logical_wrong_operation', { operationId: 'operation_completed' });
  logicalCall('lesson_logical_failed', { status: 'failed' });
}

function checkpoint(overrides: Partial<AcceptedLessonCheckpoint> = {}): AcceptedLessonCheckpoint {
  const skeleton = planTeachingSkeleton({
    learningUnitTitle: 'Bounded retrieval',
    targetMinutes: 18,
    objectives: [
      {
        objectiveRef: 'O1',
        title: 'Explain bounded retrieval',
        description:
          'Explain how a retrieval condition controls candidate eligibility and the returned result.',
        priority: 'required',
        construct: 'explain',
        authorityMode: 'exact_source',
        allowedSourceRefs: ['S1'],
        allowedVisualRefs: [],
      },
    ],
  });
  return {
    id: 'accepted_lesson_1',
    workspaceId: 'ws_1',
    studySessionId: 'session_1',
    sessionAgendaId: 'agenda_1',
    agendaItemId: 'agenda_item_1',
    expectedSessionVersion: 1,
    expectedAgendaVersion: 1,
    curriculumVersionId: 'curriculum_1',
    studyPlanVersionId: 'plan_1',
    studyPlanItemId: 'plan_item_1',
    learningUnitId: 'unit_1',
    executionSourceManifestFingerprint: 'manifest-1',
    sourceContextFingerprint: 'source-context-1',
    skeleton,
    lessonContent: skeleton.lessonSlots.map((slot) => ({
      slotId: slot.slotId,
      explanation: `Instructional content for immutable slot ${slot.slotId}.`,
      sourceRefs: slot.authorityMode === 'exact_source' ? ['S1'] : [],
      visualRefs: [],
      semanticRelations: [],
      workedProcess: null,
    })),
    lessonEvaluation: {
      schemaVersion: 1,
      policyVersion: 'lesson-pedagogy-v3-compositional',
      evaluator: 'independent-deterministic-lesson-evaluator',
      independent: true,
      status: 'pass',
      boundedRepairAttempted: false,
      estimatedActiveMinutes: {
        min: skeleton.plannedActivityBudget.minMinutes,
        max: skeleton.plannedActivityBudget.maxMinutes,
      },
      claimedAgendaMinutes: skeleton.targetMinutes,
      findings: [],
      evaluatedAt: T1,
    },
    operationId: 'operation_1',
    lessonLogicalCallId: 'lesson_logical_1',
    provider: 'fake',
    providerModel: 'fake-deterministic',
    promptVersion: 'lesson-content-v1-compositional',
    createdAt: T1,
    ...overrides,
  };
}

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  repos = createRepositories(db);
  seedActiveRoute();
});

afterEach(() => {
  db.close();
});

describe('accepted Lesson checkpoints repository', () => {
  it('accepts and reuses only the exact active Session, Agenda, Plan, and operation route', () => {
    const expected = checkpoint();
    expect(repos.acceptedLessonCheckpoints.create(expected)).toEqual(expected);
    expect(repos.acceptedLessonCheckpoints.get(expected.id)).toEqual(expected);
    expect(
      repos.acceptedLessonCheckpoints.findReusable({
        workspaceId: expected.workspaceId,
        studySessionId: expected.studySessionId,
        sessionAgendaId: expected.sessionAgendaId,
        agendaItemId: expected.agendaItemId,
        expectedSessionVersion: expected.expectedSessionVersion,
        expectedAgendaVersion: expected.expectedAgendaVersion,
        curriculumVersionId: expected.curriculumVersionId,
        studyPlanVersionId: expected.studyPlanVersionId,
        studyPlanItemId: expected.studyPlanItemId,
        learningUnitId: expected.learningUnitId,
        executionSourceManifestFingerprint: expected.executionSourceManifestFingerprint,
        sourceContextFingerprint: expected.sourceContextFingerprint,
        skeletonFingerprint: expected.skeleton.fingerprint,
        promptVersion: expected.promptVersion,
      }),
    ).toEqual(expected);
    expect(
      repos.acceptedLessonCheckpoints.findReusable({
        workspaceId: expected.workspaceId,
        studySessionId: expected.studySessionId,
        sessionAgendaId: expected.sessionAgendaId,
        agendaItemId: expected.agendaItemId,
        expectedSessionVersion: expected.expectedSessionVersion,
        expectedAgendaVersion: expected.expectedAgendaVersion,
        curriculumVersionId: expected.curriculumVersionId,
        studyPlanVersionId: expected.studyPlanVersionId,
        studyPlanItemId: expected.studyPlanItemId,
        learningUnitId: expected.learningUnitId,
        executionSourceManifestFingerprint: expected.executionSourceManifestFingerprint,
        sourceContextFingerprint: expected.sourceContextFingerprint,
        skeletonFingerprint: expected.skeleton.fingerprint,
        promptVersion: 'stale-lesson-prompt',
      }),
    ).toBeUndefined();
  });

  it.each([
    ['Session version', { expectedSessionVersion: 2 }],
    ['Agenda version', { expectedAgendaVersion: 2 }],
    ['Agenda identity', { sessionAgendaId: 'agenda_other' }],
    ['Agenda item', { agendaItemId: 'agenda_item_other' }],
    ['Plan identity', { studyPlanVersionId: 'plan_other' }],
    ['Plan item', { studyPlanItemId: 'plan_item_other' }],
    ['LearningUnit', { learningUnitId: 'unit_other' }],
    ['missing operation', { operationId: 'operation_missing' }],
    ['wrong operation type', { operationId: 'operation_wrong_type' }],
    ['terminal operation', { operationId: 'operation_completed' }],
  ] satisfies Array<[string, Partial<AcceptedLessonCheckpoint>]>)(
    'rejects a mismatched %s route fence',
    (_label, overrides) => {
      expect(() =>
        repos.acceptedLessonCheckpoints.create(
          checkpoint({ id: `rejected_${_label.replace(/\W+/gu, '_')}`, ...overrides }),
        ),
      ).toThrow('exact active Session and Agenda item route');
      expect(db.prepare('SELECT COUNT(*) AS count FROM accepted_lesson_checkpoints').get()).toEqual(
        { count: 0 },
      );
    },
  );

  it.each([
    ['missing', null],
    ['unknown', 'lesson_logical_missing'],
    ['wrong operation type', 'lesson_logical_wrong_type'],
    ['wrong phase schema', 'lesson_logical_wrong_schema'],
    ['wrong source fingerprint', 'lesson_logical_wrong_source'],
    ['missing source fingerprint', 'lesson_logical_missing_source'],
    ['wrong operation', 'lesson_logical_wrong_operation'],
    ['failed', 'lesson_logical_failed'],
  ] satisfies Array<[string, string | null]>)(
    'rejects %s Lesson logical-call provenance',
    (_label, lessonLogicalCallId) => {
      expect(() =>
        repos.acceptedLessonCheckpoints.create(
          checkpoint({
            id: `rejected_logical_${_label.replace(/\W+/gu, '_')}`,
            lessonLogicalCallId,
          }),
        ),
      ).toThrow('exact completed Lesson logical call');
    },
  );

  it('does not persist a checkpoint whose independent Lesson evaluation failed', () => {
    const failed = checkpoint();
    failed.lessonEvaluation.status = 'fail';
    expect(() => repos.acceptedLessonCheckpoints.create(failed)).toThrow();
    expect(db.prepare('SELECT COUNT(*) AS count FROM accepted_lesson_checkpoints').get()).toEqual({
      count: 0,
    });
  });

  it('enforces immutable UPDATE and DELETE triggers while the owning Session exists', () => {
    const accepted = repos.acceptedLessonCheckpoints.create(checkpoint());

    expect(() =>
      db
        .prepare('UPDATE accepted_lesson_checkpoints SET provider = ? WHERE id = ?')
        .run('changed', accepted.id),
    ).toThrow('Accepted Lesson checkpoints are immutable');
    expect(() =>
      db.prepare('DELETE FROM accepted_lesson_checkpoints WHERE id = ?').run(accepted.id),
    ).toThrow('Accepted Lesson checkpoints are immutable');
    expect(repos.acceptedLessonCheckpoints.get(accepted.id)).toEqual(accepted);
  });

  it('validates hydrated JSON with the runtime checkpoint schema', () => {
    const accepted = repos.acceptedLessonCheckpoints.create(checkpoint());
    db.prepare(
      `INSERT INTO accepted_lesson_checkpoints
         (id, workspace_id, study_session_id, session_agenda_id, agenda_item_id,
          expected_session_version, expected_agenda_version, curriculum_id, study_plan_id,
          study_plan_item_id, learning_unit_id, manifest_fingerprint,
          source_context_fingerprint, skeleton_version, skeleton_fingerprint,
          skeleton_payload, lesson_payload, lesson_evaluation_payload, operation_id,
          provider, provider_model, prompt_version, created_at)
       SELECT
          'accepted_lesson_corrupt', workspace_id, study_session_id, session_agenda_id,
          agenda_item_id, expected_session_version, expected_agenda_version, curriculum_id,
          study_plan_id, study_plan_item_id, learning_unit_id, manifest_fingerprint,
          'source-context-corrupt', skeleton_version, skeleton_fingerprint,
          skeleton_payload, lesson_payload, '{"schemaVersion":1,"status":"pass"}',
          operation_id, provider, provider_model, prompt_version, created_at
       FROM accepted_lesson_checkpoints WHERE id = ?`,
    ).run(accepted.id);

    expect(() => repos.acceptedLessonCheckpoints.get('accepted_lesson_corrupt')).toThrow();
    expect(() =>
      repos.acceptedLessonCheckpoints.findReusable({
        workspaceId: accepted.workspaceId,
        studySessionId: accepted.studySessionId,
        sessionAgendaId: accepted.sessionAgendaId,
        agendaItemId: accepted.agendaItemId,
        expectedSessionVersion: accepted.expectedSessionVersion,
        expectedAgendaVersion: accepted.expectedAgendaVersion,
        curriculumVersionId: accepted.curriculumVersionId,
        studyPlanVersionId: accepted.studyPlanVersionId,
        studyPlanItemId: accepted.studyPlanItemId,
        learningUnitId: accepted.learningUnitId,
        executionSourceManifestFingerprint: accepted.executionSourceManifestFingerprint,
        sourceContextFingerprint: 'source-context-corrupt',
        skeletonFingerprint: accepted.skeleton.fingerprint,
        promptVersion: accepted.promptVersion,
      }),
    ).toThrow();
  });
});
