import {
  AcceptedLessonCheckpointSchema,
  ApiErrorCode,
  type AcceptedLessonCheckpoint,
} from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';
import { AppError } from '../errors.js';

interface AcceptedLessonCheckpointRow {
  id: string;
  workspace_id: string;
  study_session_id: string;
  session_agenda_id: string;
  agenda_item_id: string;
  expected_session_version: number;
  expected_agenda_version: number;
  curriculum_id: string;
  study_plan_id: string;
  study_plan_item_id: string;
  learning_unit_id: string;
  manifest_fingerprint: string;
  source_context_fingerprint: string;
  skeleton_version: number;
  skeleton_fingerprint: string;
  skeleton_payload: string;
  lesson_payload: string;
  lesson_evaluation_payload: string;
  operation_id: string;
  lesson_logical_call_id: string | null;
  provider: string;
  provider_model: string | null;
  prompt_version: string;
  created_at: string;
}

export interface AcceptedLessonCheckpointIdentity {
  workspaceId: string;
  studySessionId: string;
  sessionAgendaId: string;
  agendaItemId: string;
  expectedSessionVersion: number;
  expectedAgendaVersion: number;
  curriculumVersionId: string;
  studyPlanVersionId: string;
  studyPlanItemId: string;
  learningUnitId: string;
  executionSourceManifestFingerprint: string;
  sourceContextFingerprint: string;
  skeletonFingerprint: string;
  promptVersion: string;
}

function hydrate(row: AcceptedLessonCheckpointRow): AcceptedLessonCheckpoint {
  return AcceptedLessonCheckpointSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    studySessionId: row.study_session_id,
    sessionAgendaId: row.session_agenda_id,
    agendaItemId: row.agenda_item_id,
    expectedSessionVersion: row.expected_session_version,
    expectedAgendaVersion: row.expected_agenda_version,
    curriculumVersionId: row.curriculum_id,
    studyPlanVersionId: row.study_plan_id,
    studyPlanItemId: row.study_plan_item_id,
    learningUnitId: row.learning_unit_id,
    executionSourceManifestFingerprint: row.manifest_fingerprint,
    sourceContextFingerprint: row.source_context_fingerprint,
    skeleton: JSON.parse(row.skeleton_payload),
    lessonContent: JSON.parse(row.lesson_payload),
    lessonEvaluation: JSON.parse(row.lesson_evaluation_payload),
    operationId: row.operation_id,
    lessonLogicalCallId: row.lesson_logical_call_id,
    provider: row.provider,
    providerModel: row.provider_model,
    promptVersion: row.prompt_version,
    createdAt: row.created_at,
  });
}

export function createAcceptedLessonCheckpointsRepo(db: SqliteDb) {
  function get(id: string): AcceptedLessonCheckpoint | undefined {
    const row = db.prepare('SELECT * FROM accepted_lesson_checkpoints WHERE id = ?').get(id) as
      AcceptedLessonCheckpointRow | undefined;
    return row ? hydrate(row) : undefined;
  }

  function findReusable(
    input: AcceptedLessonCheckpointIdentity,
  ): AcceptedLessonCheckpoint | undefined {
    const row = db
      .prepare(
        `SELECT * FROM accepted_lesson_checkpoints
         WHERE workspace_id = @workspaceId
           AND study_session_id = @studySessionId
           AND session_agenda_id = @sessionAgendaId
           AND agenda_item_id = @agendaItemId
           AND expected_session_version = @expectedSessionVersion
           AND expected_agenda_version = @expectedAgendaVersion
           AND curriculum_id = @curriculumVersionId
           AND study_plan_id = @studyPlanVersionId
           AND study_plan_item_id = @studyPlanItemId
           AND learning_unit_id = @learningUnitId
           AND manifest_fingerprint = @executionSourceManifestFingerprint
           AND source_context_fingerprint = @sourceContextFingerprint
           AND skeleton_fingerprint = @skeletonFingerprint
           AND prompt_version = @promptVersion
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(input) as AcceptedLessonCheckpointRow | undefined;
    return row ? hydrate(row) : undefined;
  }

  const createTx = db.transaction(
    (rawInput: AcceptedLessonCheckpoint): AcceptedLessonCheckpoint => {
      const checkpoint = AcceptedLessonCheckpointSchema.parse(rawInput);
      const route = db
        .prepare(
          `SELECT s.workspace_id, s.curriculum_id, s.plan_id, s.agenda_id,
                  s.manifest_fingerprint, s.version AS session_version,
                  s.current_agenda_item_id,
                  a.version AS agenda_version, a.curriculum_id AS agenda_curriculum_id,
                  a.plan_id AS agenda_plan_id, a.manifest_fingerprint AS agenda_manifest,
                  ai.linked_plan_item_id, ai.kind AS agenda_item_kind,
                  pi.curriculum_learning_unit_id, pi.kind AS plan_item_kind,
                  op.workspace_id AS operation_workspace_id, op.status AS operation_status,
                  op.operation_type
           FROM study_sessions s
           JOIN session_agendas a ON a.id = s.agenda_id
           JOIN session_agenda_items ai
             ON ai.agenda_id = a.id AND ai.agenda_item_id = ?
           JOIN study_plan_items pi
             ON pi.plan_id = s.plan_id AND pi.plan_item_id = ai.linked_plan_item_id
           JOIN agent_operations op ON op.id = ?
           WHERE s.id = ?`,
        )
        .get(checkpoint.agendaItemId, checkpoint.operationId, checkpoint.studySessionId) as
        | {
            workspace_id: string;
            curriculum_id: string;
            plan_id: string;
            agenda_id: string;
            manifest_fingerprint: string;
            session_version: number;
            current_agenda_item_id: string | null;
            agenda_version: number;
            agenda_curriculum_id: string;
            agenda_plan_id: string;
            agenda_manifest: string;
            linked_plan_item_id: string | null;
            agenda_item_kind: string;
            curriculum_learning_unit_id: string | null;
            plan_item_kind: string;
            operation_workspace_id: string;
            operation_status: string;
            operation_type: string;
          }
        | undefined;
      if (
        !route ||
        route.workspace_id !== checkpoint.workspaceId ||
        route.operation_workspace_id !== checkpoint.workspaceId ||
        route.operation_status !== 'running' ||
        route.operation_type !== 'prepare_teaching_brief' ||
        route.curriculum_id !== checkpoint.curriculumVersionId ||
        route.agenda_curriculum_id !== checkpoint.curriculumVersionId ||
        route.plan_id !== checkpoint.studyPlanVersionId ||
        route.agenda_plan_id !== checkpoint.studyPlanVersionId ||
        route.agenda_id !== checkpoint.sessionAgendaId ||
        route.session_version !== checkpoint.expectedSessionVersion ||
        route.agenda_version !== checkpoint.expectedAgendaVersion ||
        route.current_agenda_item_id !== checkpoint.agendaItemId ||
        route.linked_plan_item_id !== checkpoint.studyPlanItemId ||
        route.curriculum_learning_unit_id !== checkpoint.learningUnitId ||
        route.agenda_item_kind !== 'learning_unit_teaching' ||
        route.plan_item_kind !== 'teach_unit' ||
        route.manifest_fingerprint !== checkpoint.executionSourceManifestFingerprint ||
        route.agenda_manifest !== checkpoint.executionSourceManifestFingerprint
      ) {
        throw new AppError(
          ApiErrorCode.VersionConflict,
          'Accepted Lesson checkpoint persistence requires the exact active Session and Agenda item route.',
        );
      }
      const lessonLogicalCall = checkpoint.lessonLogicalCallId
        ? (db
            .prepare(
              `SELECT operation_id, workspace_id, study_session_id, learning_unit_id,
                      operation_type, schema_fingerprint, source_fingerprint, status
                 FROM model_logical_calls WHERE id = ?`,
            )
            .get(checkpoint.lessonLogicalCallId) as
            | {
                operation_id: string | null;
                workspace_id: string | null;
                study_session_id: string | null;
                learning_unit_id: string | null;
                operation_type: string;
                schema_fingerprint: string | null;
                source_fingerprint: string | null;
                status: string;
              }
            | undefined)
        : undefined;
      if (
        !lessonLogicalCall ||
        lessonLogicalCall.operation_id !== checkpoint.operationId ||
        lessonLogicalCall.workspace_id !== checkpoint.workspaceId ||
        lessonLogicalCall.study_session_id !== checkpoint.studySessionId ||
        lessonLogicalCall.learning_unit_id !== checkpoint.learningUnitId ||
        lessonLogicalCall.operation_type !== 'prepare_teaching_brief' ||
        lessonLogicalCall.schema_fingerprint !== 'lesson-slot-content-proposal-v1' ||
        lessonLogicalCall.source_fingerprint !== checkpoint.sourceContextFingerprint ||
        lessonLogicalCall.status !== 'completed'
      ) {
        throw new AppError(
          ApiErrorCode.VersionConflict,
          'Accepted Lesson checkpoint persistence requires its exact completed Lesson logical call.',
        );
      }
      db.prepare(
        `INSERT INTO accepted_lesson_checkpoints
           (id, workspace_id, study_session_id, session_agenda_id, agenda_item_id,
            expected_session_version, expected_agenda_version, curriculum_id, study_plan_id,
            study_plan_item_id, learning_unit_id, manifest_fingerprint,
            source_context_fingerprint, skeleton_version, skeleton_fingerprint,
            skeleton_payload, lesson_payload, lesson_evaluation_payload, operation_id,
            lesson_logical_call_id, provider, provider_model, prompt_version, created_at)
         VALUES
           (@id, @workspaceId, @studySessionId, @sessionAgendaId, @agendaItemId,
            @expectedSessionVersion, @expectedAgendaVersion, @curriculumVersionId,
            @studyPlanVersionId, @studyPlanItemId, @learningUnitId,
            @executionSourceManifestFingerprint, @sourceContextFingerprint, @skeletonVersion,
            @skeletonFingerprint, @skeletonPayload, @lessonPayload, @lessonEvaluationPayload,
            @operationId, @lessonLogicalCallId, @provider, @providerModel, @promptVersion,
            @createdAt)`,
      ).run({
        ...checkpoint,
        skeletonVersion: checkpoint.skeleton.schemaVersion,
        skeletonFingerprint: checkpoint.skeleton.fingerprint,
        skeletonPayload: JSON.stringify(checkpoint.skeleton),
        lessonPayload: JSON.stringify(checkpoint.lessonContent),
        lessonEvaluationPayload: JSON.stringify(checkpoint.lessonEvaluation),
      });
      return get(checkpoint.id)!;
    },
  );

  return { get, findReusable, create: createTx };
}

export type AcceptedLessonCheckpointsRepo = ReturnType<typeof createAcceptedLessonCheckpointsRepo>;
