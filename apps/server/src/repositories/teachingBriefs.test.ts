import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  projectAcceptedLessonSegments,
  type AcceptedLessonCheckpoint,
  type TeachingBrief,
} from '@hy3-clinic/shared';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { curriculumSourceBlockFingerprint } from '../grounding/sourceFingerprint.js';
import {
  COMPOSITIONAL_LESSON_PEDAGOGY_POLICY_VERSION,
  COMPOSITIONAL_PRACTICE_QUALITY_POLICY_VERSION,
} from '../services/lessonPedagogyEvaluator.js';
import {
  LESSON_CONTENT_PROMPT_VERSION,
  PRACTICE_CONTENT_PROMPT_VERSION,
  TEACHING_BRIEF_PROMPT_VERSION,
} from '../services/teachingBriefPreparation.js';
import { planTeachingSkeleton } from '../services/teachingSkeletonPlanner.js';
import { makeBlock, makeMaterial, makeWorkspace, T0 } from '../testing/fixtures.js';
import { createRepositories, type Repositories } from './index.js';

const T1 = '2026-01-01T00:01:00.000Z';
const T2 = '2026-01-01T00:02:00.000Z';
const SOURCE_CONTEXT_FINGERPRINT = 'lesson-context-current';

let db: SqliteDb;
let repos: Repositories;
let sourceReference: TeachingBrief['sourceReferences'][number];
let sourceManifest: TeachingBrief['sourceManifest'];

function insertOperation(id: string, sessionId: string): void {
  db.prepare(
    `INSERT INTO agent_operations
       (id, workspace_id, command_id, idempotency_key, logical_operation_id,
        operation_type, expected_fingerprint, status, lease_owner, lease_expires_at,
        fencing_token, created_at, updated_at)
     VALUES (?, 'ws_1', ?, ?, ?, 'prepare_teaching_brief', 'route-fingerprint',
       'running', ?, '2026-01-01T01:00:00.000Z', 1, ?, ?)`,
  ).run(id, `command_${id}`, `idempotency_${id}`, `logical_${id}`, `worker_${sessionId}`, T0, T0);
}

function insertLogicalCall(
  id: string,
  operationId: string,
  sessionId: string,
  schemaFingerprint: 'lesson-slot-content-proposal-v1' | 'practice-content-proposal-v1',
  sourceFingerprint: string | null = SOURCE_CONTEXT_FINGERPRINT,
): void {
  repos.telemetry.insertLogicalCall({
    id,
    operationId,
    workspaceId: 'ws_1',
    studySessionId: sessionId,
    learningUnitId: 'unit_1',
    assessmentId: null,
    operationType: 'prepare_teaching_brief',
    cacheKey: null,
    cacheStatus: 'not_checked',
    promptFingerprint: null,
    schemaFingerprint,
    policyFingerprint: null,
    sourceFingerprint,
    status: 'completed',
    createdAt: T0,
    completedAt: T1,
  });
}

function seedSession(sessionId: string, operationId: string): void {
  db.prepare(
    `INSERT INTO study_sessions
       (id, workspace_id, contract_id, curriculum_id, plan_id, agenda_id,
        manifest_fingerprint, version, status, route_state, current_agenda_item_id,
        route_stack, transcript_watermark, created_at, updated_at)
     VALUES (?, 'ws_1', 'contract_1', 'curriculum_1', 'plan_1', 'agenda_1',
       'manifest-1', 1, 'active', 'on_route', 'agenda_item_1', '[]', 0, ?, ?)`,
  ).run(sessionId, T0, T0);
  insertOperation(operationId, sessionId);
  insertLogicalCall(
    `lesson_logical_${sessionId}`,
    operationId,
    sessionId,
    'lesson-slot-content-proposal-v1',
  );
}

function seedAcceptedRoute(): void {
  repos.workspaces.insert(makeWorkspace());
  const content = 'Working memory has limited capacity.';
  repos.materials.insertWithBlocks(makeMaterial({ content, charCount: content.length }), [
    makeBlock({
      content,
      startOffset: 0,
      endOffset: content.length,
      heading: 'Memory',
      chunkerVersion: 'structure-aware-v1',
    }),
  ]);
  const material = repos.materials.get('mat_1')!;
  const block = repos.materials.getBlock('blk_1')!;
  const blockFingerprint = curriculumSourceBlockFingerprint(block, material.activeRevisionId!);
  sourceReference = {
    refId: 'S1',
    materialId: material.id,
    materialRevisionId: material.activeRevisionId!,
    sourceBlockId: block.id,
    sourceBlockRevisionFingerprint: blockFingerprint,
    startOffset: 0,
    endOffset: content.length,
    quote: content,
    headingPath: ['Memory'],
    pageNumber: null,
    slideNumber: null,
  };
  sourceManifest = {
    fingerprint: 'manifest-1',
    revisions: [
      {
        materialId: material.id,
        materialRevisionId: material.activeRevisionId!,
        parserVersion: material.parserVersion,
        parserFingerprint: 'parser-fingerprint-1',
        chunkerVersion: 'structure-aware-v1',
        chunkerFingerprint: 'chunker-fingerprint-1',
        sourceBlockRevisionIds: [blockFingerprint],
      },
    ],
  };

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
    `INSERT INTO curriculum_node_index
       (curriculum_id, node_id, parent_node_id, kind, idx, title)
     VALUES ('curriculum_1', 'unit_1', NULL, 'learning_unit', 0, 'Working memory')`,
  ).run();
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
  seedSession('session_a', 'operation_a');
  seedSession('session_b', 'operation_b');
}

function acceptedLessonCheckpoint(sessionId: 'session_a' | 'session_b'): AcceptedLessonCheckpoint {
  const skeleton = planTeachingSkeleton({
    learningUnitTitle: 'Working memory',
    targetMinutes: 18,
    objectives: [
      {
        objectiveRef: 'O1',
        title: 'Explain working-memory capacity',
        description: 'Explain why limited capacity affects processing.',
        priority: 'required',
        construct: 'explain',
        authorityMode: 'exact_source',
        allowedSourceRefs: ['S1'],
        allowedVisualRefs: [],
      },
    ],
  });
  return {
    id: `accepted_lesson_${sessionId}`,
    workspaceId: 'ws_1',
    studySessionId: sessionId,
    sessionAgendaId: 'agenda_1',
    agendaItemId: 'agenda_item_1',
    expectedSessionVersion: 1,
    expectedAgendaVersion: 1,
    curriculumVersionId: 'curriculum_1',
    studyPlanVersionId: 'plan_1',
    studyPlanItemId: 'plan_item_1',
    learningUnitId: 'unit_1',
    executionSourceManifestFingerprint: 'manifest-1',
    sourceContextFingerprint: SOURCE_CONTEXT_FINGERPRINT,
    skeleton,
    lessonContent: skeleton.lessonSlots.map((slot) => ({
      slotId: slot.slotId,
      explanation: `Immutable Lesson bytes for ${sessionId} in ${slot.slotId}.`,
      sourceRefs: slot.authorityMode === 'exact_source' ? ['S1'] : [],
      visualRefs: [],
      semanticRelations: [],
      workedProcess: null,
    })),
    lessonEvaluation: {
      schemaVersion: 1,
      policyVersion: COMPOSITIONAL_LESSON_PEDAGOGY_POLICY_VERSION,
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
    operationId: sessionId === 'session_a' ? 'operation_a' : 'operation_b',
    lessonLogicalCallId: `lesson_logical_${sessionId}`,
    provider: 'fake',
    providerModel: 'fake-deterministic',
    promptVersion: LESSON_CONTENT_PROMPT_VERSION,
    createdAt: T1,
  };
}

function practiceItem() {
  const surface = (prefix: string) => ({
    prompt: `${prefix}: explain the capacity consequence.`,
    options: [
      {
        id: `${prefix}_a`,
        text: 'Capacity constrains processing.',
        feedbackIfSelected: 'Correct.',
      },
      {
        id: `${prefix}_b`,
        text: 'Capacity is unlimited.',
        feedbackIfSelected: 'Use the source limit.',
      },
      {
        id: `${prefix}_c`,
        text: 'Capacity is irrelevant.',
        feedbackIfSelected: 'Trace the effect.',
      },
    ],
    correctOptionId: `${prefix}_a`,
    hint: 'Use the explicit source-backed capacity constraint.',
    explanation: 'A limit constrains what can be processed at once.',
  });
  return {
    id: 'practice_1',
    objectiveId: 'objective_1',
    objectiveTitle: 'Explain working-memory capacity',
    construct: 'explain' as const,
    capabilityTested: 'Explain the consequence of a capacity limit.',
    pedagogicalReason: 'The learner must connect the constraint to its effect.',
    authority: 'exact_source' as const,
    sourceRefIds: ['S1'],
    visualRefIds: [],
    initial: surface('initial'),
    retry: surface('retry'),
  };
}

function teachingBrief(
  checkpoint: AcceptedLessonCheckpoint,
  practiceLogicalCallId: string,
  id: string,
  createdAt = T2,
): TeachingBrief {
  const segments = projectAcceptedLessonSegments(checkpoint, ['objective_1']);
  const sourceBackedSegmentCount = segments.filter(
    (segment) => segment.explanationAuthority === 'source_backed_teaching',
  ).length;
  return {
    id,
    workspaceId: 'ws_1',
    curriculumVersionId: 'curriculum_1',
    studyPlanVersionId: 'plan_1',
    learningUnitId: 'unit_1',
    executionSourceManifestFingerprint: 'manifest-1',
    sourceContextFingerprint: SOURCE_CONTEXT_FINGERPRINT,
    sourceManifest,
    conceptIds: [],
    canonicalConceptIds: [],
    objective: {
      title: 'Working memory',
      whyNow: 'Capacity is required for the active route.',
      objectives: [
        {
          id: 'objective_1',
          title: 'Explain working-memory capacity',
          description: 'Explain why limited capacity affects processing.',
          priority: 'required',
          formalAssessmentReady: true,
          construct: 'explain',
          authorityEnvelopeTier: 'teaching_only',
          formalEvidenceSourceBlockIds: ['blk_1'],
        },
      ],
    },
    prerequisites: [],
    segments,
    formalOpportunities: [],
    summary: 'Working memory has limited capacity.',
    nextConnection: null,
    sourceReferences: [sourceReference],
    visualReferences: [],
    qualityProfile: {
      objectiveCoverage: 1,
      segmentCount: segments.length,
      sourceBackedSegmentCount,
      sourceBackedSegmentRatio: sourceBackedSegmentCount / segments.length,
      sourceReferenceCount: 1,
      sourceMaterialCount: 1,
      exampleCount: 0,
      contrastCount: 0,
      misconceptionCount: 0,
      informalCheckCount: 0,
      prerequisiteCount: 0,
      formalOpportunityCount: 0,
      hasSummary: true,
      hasNextConnection: false,
      unsupportedSourceRefCount: 0,
      duplicatedTeachingIntentCount: 0,
      dimensions: [{ name: 'structure', kind: 'deterministic', note: 'Fixture profile.' }],
      nonclaims: ['Structure does not prove semantic entailment.'],
    },
    composition: {
      schemaVersion: 1,
      skeletonId: checkpoint.skeleton.id,
      skeletonSchemaVersion: checkpoint.skeleton.schemaVersion,
      skeletonPlannerVersion: checkpoint.skeleton.plannerVersion,
      skeletonFingerprint: checkpoint.skeleton.fingerprint,
      acceptedLessonCheckpointId: checkpoint.id,
      lessonOperationId: checkpoint.operationId,
      practiceOperationId: checkpoint.operationId,
      lessonLogicalCallId: checkpoint.lessonLogicalCallId!,
      practiceLogicalCallId,
      lessonPromptVersion: LESSON_CONTENT_PROMPT_VERSION,
      practicePromptVersion: PRACTICE_CONTENT_PROMPT_VERSION,
      targetMinutes: checkpoint.skeleton.targetMinutes,
      acceptableActiveMinutes: {
        min: checkpoint.skeleton.acceptableActiveMinutes.minMinutes,
        max: checkpoint.skeleton.acceptableActiveMinutes.maxMinutes,
      },
      protectedActivityMinutes: {
        min: checkpoint.skeleton.protectedActivityBudget.minMinutes,
        max: checkpoint.skeleton.protectedActivityBudget.maxMinutes,
      },
      plannedActivityMinutes: {
        min: checkpoint.skeleton.plannedActivityBudget.minMinutes,
        max: checkpoint.skeleton.plannedActivityBudget.maxMinutes,
      },
    },
    pedagogyEvaluation: checkpoint.lessonEvaluation,
    practice: {
      schemaVersion: 1,
      items: [practiceItem()],
      qualityEvaluation: {
        schemaVersion: 1,
        policyVersion: COMPOSITIONAL_PRACTICE_QUALITY_POLICY_VERSION,
        evaluator: 'independent-deterministic-practice-evaluator',
        independent: true,
        status: 'pass',
        boundedRepairAttempted: false,
        findings: [],
        evaluatedAt: T2,
      },
      credit: 'none',
    },
    provider: 'fake',
    providerModel: 'fake-deterministic',
    promptVersion: TEACHING_BRIEF_PROMPT_VERSION,
    createdAt,
  };
}

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  repos = createRepositories(db);
  seedAcceptedRoute();
});

afterEach(() => {
  db.close();
});

describe('Teaching Brief repository compositional provenance', () => {
  it('rejects final Lesson or skeleton bytes mutated after checkpoint assembly', () => {
    const checkpoint = repos.acceptedLessonCheckpoints.create(
      acceptedLessonCheckpoint('session_a'),
    );
    insertLogicalCall(
      'practice_logical_projection',
      'operation_a',
      'session_a',
      'practice-content-proposal-v1',
    );

    const mutatedLesson = teachingBrief(
      checkpoint,
      'practice_logical_projection',
      'brief_mutated_lesson',
    );
    mutatedLesson.segments[0]!.explanation += ' MUTATED_AFTER_CHECKPOINT_ASSEMBLY';
    expect(() => repos.teachingBriefs.create(mutatedLesson)).toThrow(
      'exact accepted Lesson predecessor and active Practice operation',
    );

    const mutatedSkeleton = teachingBrief(
      checkpoint,
      'practice_logical_projection',
      'brief_mutated_skeleton',
    );
    mutatedSkeleton.composition!.skeletonId = `teaching_skeleton_${'f'.repeat(40)}`;
    expect(() => repos.teachingBriefs.create(mutatedSkeleton)).toThrow(
      'exact accepted Lesson predecessor and active Practice operation',
    );

    const mutatedObjectiveId = teachingBrief(
      checkpoint,
      'practice_logical_projection',
      'brief_mutated_objective_id',
    );
    mutatedObjectiveId.objective.objectives[0]!.id = 'objective_forged';
    for (const segment of mutatedObjectiveId.segments) {
      segment.objectiveIds = segment.objectiveIds.map(() => 'objective_forged');
    }
    mutatedObjectiveId.practice!.items[0]!.objectiveId = 'objective_forged';
    expect(() => repos.teachingBriefs.create(mutatedObjectiveId)).toThrow(
      'exact accepted Lesson predecessor and active Practice operation',
    );
    expect(repos.teachingBriefs.listForUnit('ws_1', 'unit_1')).toEqual([]);
    expect(repos.acceptedLessonCheckpoints.get(checkpoint.id)).toEqual(checkpoint);
  });

  it('requires exact source-bound Practice telemetry and both logical-call identities', () => {
    const checkpoint = repos.acceptedLessonCheckpoints.create(
      acceptedLessonCheckpoint('session_a'),
    );
    insertLogicalCall(
      'practice_logical_valid',
      'operation_a',
      'session_a',
      'practice-content-proposal-v1',
    );
    insertLogicalCall(
      'practice_logical_wrong_source',
      'operation_a',
      'session_a',
      'practice-content-proposal-v1',
      'different-source-context',
    );
    insertLogicalCall(
      'practice_logical_missing_source',
      'operation_a',
      'session_a',
      'practice-content-proposal-v1',
      null,
    );

    const valid = teachingBrief(checkpoint, 'practice_logical_valid', 'brief_valid');
    expect(repos.teachingBriefs.create(valid)).toEqual(valid);

    expect(() =>
      repos.teachingBriefs.create(
        teachingBrief(checkpoint, 'practice_logical_wrong_source', 'brief_wrong_source'),
      ),
    ).toThrow('exact accepted Lesson predecessor and active Practice operation');
    expect(() =>
      repos.teachingBriefs.create(
        teachingBrief(checkpoint, 'practice_logical_missing_source', 'brief_missing_source'),
      ),
    ).toThrow('exact accepted Lesson predecessor and active Practice operation');

    const missingCalls = structuredClone(valid);
    missingCalls.id = 'brief_missing_calls';
    delete missingCalls.composition!.lessonLogicalCallId;
    delete missingCalls.composition!.practiceLogicalCallId;
    expect(() => repos.teachingBriefs.create(missingCalls)).toThrow(
      'exact accepted Lesson predecessor and active Practice operation',
    );
  });

  it('keeps Session A checkpoint and Lesson bytes when Session B succeeds before A retries', () => {
    const checkpointA = repos.acceptedLessonCheckpoints.create(
      acceptedLessonCheckpoint('session_a'),
    );
    const checkpointB = repos.acceptedLessonCheckpoints.create(
      acceptedLessonCheckpoint('session_b'),
    );
    insertLogicalCall(
      'practice_logical_b',
      'operation_b',
      'session_b',
      'practice-content-proposal-v1',
    );
    const briefB = repos.teachingBriefs.create(
      teachingBrief(checkpointB, 'practice_logical_b', 'brief_b', T1),
    );

    expect(
      repos.teachingBriefs.findReusable({
        workspaceId: 'ws_1',
        curriculumVersionId: 'curriculum_1',
        studyPlanVersionId: 'plan_1',
        learningUnitId: 'unit_1',
        manifestFingerprint: 'manifest-1',
        sourceContextFingerprint: SOURCE_CONTEXT_FINGERPRINT,
        acceptedLessonCheckpointId: checkpointA.id,
      }),
    ).toBeUndefined();
    expect(briefB.composition?.acceptedLessonCheckpointId).toBe(checkpointB.id);

    insertLogicalCall(
      'practice_logical_a_retry',
      'operation_a',
      'session_a',
      'practice-content-proposal-v1',
    );
    const briefA = repos.teachingBriefs.create(
      teachingBrief(checkpointA, 'practice_logical_a_retry', 'brief_a', T2),
    );

    expect(repos.acceptedLessonCheckpoints.get(checkpointA.id)?.lessonContent).toEqual(
      checkpointA.lessonContent,
    );
    expect(briefA.segments.map((segment) => segment.explanation)).toEqual(
      checkpointA.lessonContent.map((content) => content.explanation),
    );
    expect(
      repos.teachingBriefs.findReusable({
        workspaceId: 'ws_1',
        curriculumVersionId: 'curriculum_1',
        studyPlanVersionId: 'plan_1',
        learningUnitId: 'unit_1',
        manifestFingerprint: 'manifest-1',
        sourceContextFingerprint: SOURCE_CONTEXT_FINGERPRINT,
        acceptedLessonCheckpointId: checkpointA.id,
      })?.id,
    ).toBe(briefA.id);
    expect(
      repos.teachingBriefs.findReusable({
        workspaceId: 'ws_1',
        curriculumVersionId: 'curriculum_1',
        studyPlanVersionId: 'plan_1',
        learningUnitId: 'unit_1',
        manifestFingerprint: 'manifest-1',
        sourceContextFingerprint: SOURCE_CONTEXT_FINGERPRINT,
        acceptedLessonCheckpointId: checkpointB.id,
      })?.id,
    ).toBe(briefB.id);
    expect(repos.teachingBriefs.listForUnit('ws_1', 'unit_1')).toHaveLength(2);
  });
});
