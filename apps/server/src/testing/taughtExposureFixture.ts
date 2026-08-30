import {
  projectAcceptedLessonSegments,
  type AcceptedLessonCheckpoint,
  type Curriculum,
  type TeachingBrief,
} from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';
import { curriculumSourceBlockFingerprint } from '../grounding/sourceFingerprint.js';
import type { Repositories } from '../repositories/index.js';
import { COMPOSITIONAL_LESSON_PEDAGOGY_POLICY_VERSION } from '../services/lessonPedagogyEvaluator.js';
import {
  LESSON_CONTENT_PROMPT_VERSION,
  PRACTICE_CONTENT_PROMPT_VERSION,
} from '../services/teachingBriefPreparation.js';
import { planTeachingSkeleton } from '../services/teachingSkeletonPlanner.js';

export function seedPresentedTeachingFixture(input: {
  db: SqliteDb;
  repos: Repositories;
  workspaceId: string;
  curriculum: Curriculum;
  studyPlanVersionId: string;
  learningUnitId: string;
  objectiveIds: string[];
  sessionAgendaId: string;
  agendaItemId: string;
  studyPlanItemId: string;
  at: string;
  presentedSegmentIndexes?: number[];
  preparationStatus?: 'ready' | 'retryable_failure';
  suffix?: string;
}): { brief: TeachingBrief; checkpoint: AcceptedLessonCheckpoint; stateId: string } {
  const suffix = input.suffix ?? input.learningUnitId;
  const unit = input.curriculum.nodes.find((node) => node.id === input.learningUnitId);
  if (!unit?.learningUnit) throw new Error('Taught-exposure fixture requires a LearningUnit.');
  const objectives = input.objectiveIds.map((id) => {
    const objective = unit.learningUnit!.objectives.find((candidate) => candidate.id === id);
    if (!objective) throw new Error(`Unknown fixture objective: ${id}`);
    return objective;
  });
  const sourceReference = unit.sourceReferences.find((reference) => reference.sourceBlockId);
  if (!sourceReference?.sourceBlockId) throw new Error('Taught-exposure fixture requires source.');
  const block = input.repos.materials.getBlock(sourceReference.sourceBlockId)!;
  const material = input.repos.materials.get(sourceReference.materialId)!;
  const sourceFingerprint = curriculumSourceBlockFingerprint(
    block,
    sourceReference.materialRevisionId,
  );
  const sourceContextFingerprint = `source-context-${suffix}`;
  const skeleton = planTeachingSkeleton({
    learningUnitTitle: unit.title,
    targetMinutes: 18,
    targetDepth: 'pass_oriented',
    objectives: objectives.map((objective, index) => ({
      objectiveRef: `O${index + 1}`,
      title: objective.title,
      description: objective.description,
      priority: objective.priority ?? 'required',
      construct: objective.formalAssessmentConstruct ?? 'explain',
      authorityMode: 'exact_source',
      allowedSourceRefs: ['S1'],
      allowedVisualRefs: [],
    })),
  });
  const sessionId = `study_session_taught_${suffix}`;
  const operationId = `operation_taught_${suffix}`;
  input.db
    .prepare(
      `INSERT INTO study_sessions
       (id, workspace_id, contract_id, curriculum_id, plan_id, agenda_id,
        manifest_fingerprint, version, status, route_state, current_agenda_item_id,
        route_stack, transcript_watermark, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'completed', 'on_route', ?, '[]', 0, ?, ?)`,
    )
    .run(
      sessionId,
      input.workspaceId,
      input.curriculum.contractVersionId,
      input.curriculum.id,
      input.studyPlanVersionId,
      input.sessionAgendaId,
      input.curriculum.executionSourceManifest.fingerprint,
      input.agendaItemId,
      input.at,
      input.at,
    );
  input.db
    .prepare(
      `INSERT INTO agent_operations
       (id, workspace_id, command_id, idempotency_key, logical_operation_id,
        operation_type, expected_fingerprint, status, lease_owner, lease_expires_at,
        fencing_token, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'prepare_teaching_brief', ?, 'completed', NULL, NULL, 1, ?, ?)`,
    )
    .run(
      operationId,
      input.workspaceId,
      `command_${operationId}`,
      `idempotency_${operationId}`,
      `logical_${operationId}`,
      sourceContextFingerprint,
      input.at,
      input.at,
    );
  const lessonEvaluation = {
    schemaVersion: 1 as const,
    policyVersion: COMPOSITIONAL_LESSON_PEDAGOGY_POLICY_VERSION,
    evaluator: 'independent-deterministic-lesson-evaluator',
    independent: true as const,
    status: 'pass' as const,
    boundedRepairAttempted: false,
    estimatedActiveMinutes: {
      min: skeleton.plannedActivityBudget.minMinutes,
      max: skeleton.plannedActivityBudget.maxMinutes,
    },
    claimedAgendaMinutes: skeleton.targetMinutes,
    findings: [],
    evaluatedAt: input.at,
  };
  const checkpoint: AcceptedLessonCheckpoint = {
    id: `accepted_lesson_taught_${suffix}`,
    workspaceId: input.workspaceId,
    studySessionId: sessionId,
    sessionAgendaId: input.sessionAgendaId,
    agendaItemId: input.agendaItemId,
    expectedSessionVersion: 1,
    expectedAgendaVersion: 1,
    curriculumVersionId: input.curriculum.id,
    studyPlanVersionId: input.studyPlanVersionId,
    studyPlanItemId: input.studyPlanItemId,
    learningUnitId: input.learningUnitId,
    executionSourceManifestFingerprint: input.curriculum.executionSourceManifest.fingerprint,
    sourceContextFingerprint,
    skeleton,
    lessonContent: skeleton.lessonSlots.map((slot) => ({
      slotId: slot.slotId,
      explanation: `Presented source-grounded teaching for ${slot.objectiveRefs.join(', ')}.`,
      sourceRefs: ['S1'],
      visualRefs: [],
      semanticRelations: [],
      workedProcess: null,
    })),
    lessonEvaluation,
    operationId,
    lessonLogicalCallId: null,
    provider: 'fake',
    providerModel: 'fake-deterministic',
    promptVersion: LESSON_CONTENT_PROMPT_VERSION,
    createdAt: input.at,
  };
  input.db
    .prepare(
      `INSERT INTO accepted_lesson_checkpoints
       (id, workspace_id, study_session_id, session_agenda_id, agenda_item_id,
        expected_session_version, expected_agenda_version, curriculum_id, study_plan_id,
        study_plan_item_id, learning_unit_id, manifest_fingerprint,
        source_context_fingerprint, skeleton_version, skeleton_fingerprint,
        skeleton_payload, lesson_payload, lesson_evaluation_payload, operation_id,
        lesson_logical_call_id, provider, provider_model, prompt_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    )
    .run(
      checkpoint.id,
      checkpoint.workspaceId,
      checkpoint.studySessionId,
      checkpoint.sessionAgendaId,
      checkpoint.agendaItemId,
      checkpoint.expectedSessionVersion,
      checkpoint.expectedAgendaVersion,
      checkpoint.curriculumVersionId,
      checkpoint.studyPlanVersionId,
      checkpoint.studyPlanItemId,
      checkpoint.learningUnitId,
      checkpoint.executionSourceManifestFingerprint,
      checkpoint.sourceContextFingerprint,
      checkpoint.skeleton.schemaVersion,
      checkpoint.skeleton.fingerprint,
      JSON.stringify(checkpoint.skeleton),
      JSON.stringify(checkpoint.lessonContent),
      JSON.stringify(checkpoint.lessonEvaluation),
      checkpoint.operationId,
      checkpoint.provider,
      checkpoint.providerModel,
      checkpoint.promptVersion,
      checkpoint.createdAt,
    );
  const segments = projectAcceptedLessonSegments(checkpoint, input.objectiveIds);
  const brief: TeachingBrief = {
    id: `brief_taught_${suffix}`,
    workspaceId: input.workspaceId,
    curriculumVersionId: input.curriculum.id,
    studyPlanVersionId: input.studyPlanVersionId,
    learningUnitId: input.learningUnitId,
    executionSourceManifestFingerprint: input.curriculum.executionSourceManifest.fingerprint,
    sourceContextFingerprint,
    sourceManifest: input.curriculum.executionSourceManifest,
    conceptIds: [...unit.learningUnit.conceptIds],
    canonicalConceptIds: [...unit.learningUnit.canonicalConceptIds],
    objective: {
      title: unit.title,
      whyNow: 'Required by the accepted route.',
      objectives: objectives.map((objective) => ({
        id: objective.id,
        title: objective.title,
        description: objective.description,
        priority: objective.priority,
        formalAssessmentReady: objective.formalAssessmentReady,
        construct: objective.formalAssessmentConstruct,
        authorityEnvelopeTier: objective.authorityEnvelopeTier,
        formalEvidenceSourceBlockIds: objective.formalEvidenceSourceBlockIds,
      })),
    },
    prerequisites: [],
    segments,
    formalOpportunities: [],
    summary: 'Fixture teaching summary.',
    nextConnection: null,
    sourceReferences: [
      {
        refId: 'S1',
        materialId: material.id,
        materialRevisionId: sourceReference.materialRevisionId,
        sourceBlockId: block.id,
        sourceBlockRevisionFingerprint: sourceFingerprint,
        startOffset: 0,
        endOffset: block.content.length,
        quote: block.content,
        headingPath: block.headingPath,
        pageNumber: block.pageNumber,
        slideNumber: block.slideNumber,
      },
    ],
    visualReferences: [],
    qualityProfile: {
      objectiveCoverage: 1,
      segmentCount: segments.length,
      sourceBackedSegmentCount: segments.length,
      sourceBackedSegmentRatio: 1,
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
      skeletonId: skeleton.id,
      skeletonSchemaVersion: skeleton.schemaVersion,
      skeletonPlannerVersion: skeleton.plannerVersion,
      skeletonFingerprint: skeleton.fingerprint,
      acceptedLessonCheckpointId: checkpoint.id,
      lessonOperationId: operationId,
      practiceOperationId: operationId,
      lessonPromptVersion: LESSON_CONTENT_PROMPT_VERSION,
      practicePromptVersion: PRACTICE_CONTENT_PROMPT_VERSION,
      targetMinutes: skeleton.targetMinutes,
      acceptableActiveMinutes: {
        min: skeleton.acceptableActiveMinutes.minMinutes,
        max: skeleton.acceptableActiveMinutes.maxMinutes,
      },
      protectedActivityMinutes: {
        min: skeleton.protectedActivityBudget.minMinutes,
        max: skeleton.protectedActivityBudget.maxMinutes,
      },
      plannedActivityMinutes: {
        min: skeleton.plannedActivityBudget.minMinutes,
        max: skeleton.plannedActivityBudget.maxMinutes,
      },
    },
    pedagogyEvaluation: lessonEvaluation,
    provider: 'fake',
    providerModel: 'fake-deterministic',
    promptVersion: 'teaching-brief-v2-s1-fixture',
    createdAt: input.at,
  };
  input.db
    .prepare(
      `INSERT INTO teaching_briefs
       (id, workspace_id, curriculum_id, study_plan_id, learning_unit_id,
        manifest_fingerprint, source_context_fingerprint, payload,
        provider, provider_model, prompt_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      brief.id,
      brief.workspaceId,
      brief.curriculumVersionId,
      brief.studyPlanVersionId,
      brief.learningUnitId,
      brief.executionSourceManifestFingerprint,
      brief.sourceContextFingerprint,
      JSON.stringify(brief),
      brief.provider,
      brief.providerModel,
      brief.promptVersion,
      brief.createdAt,
    );
  const stateId = `lesson_state_taught_${suffix}`;
  input.repos.lessonExecution.create({
    id: stateId,
    sessionId,
    agendaItemId: input.agendaItemId,
    curriculumVersionId: input.curriculum.id,
    studyPlanVersionId: input.studyPlanVersionId,
    learningUnitId: input.learningUnitId,
    teachingBriefId: brief.id,
    acceptedLessonCheckpointId: checkpoint.id,
    executionSourceManifestFingerprint: input.curriculum.executionSourceManifest.fingerprint,
    sourceContextFingerprint,
    preparationStatus: input.preparationStatus ?? 'ready',
    preparationOperationId: null,
    version: 1,
    currentSegmentIndex: 0,
    presentedSegmentIndexes: input.presentedSegmentIndexes ?? [0],
    informalInteractions: [],
    presentationCompletedAt: null,
    practiceInteractions: [],
    practiceCompletedAt: null,
    createdAt: input.at,
    updatedAt: input.at,
  });
  return { brief, checkpoint, stateId };
}
