import {
  LessonExecutionEventSchema,
  LessonExecutionStateSchema,
  type LessonExecutionEvent,
  type LessonExecutionState,
} from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';

interface StateRow {
  id: string;
  session_id: string;
  agenda_item_id: string;
  curriculum_id: string;
  study_plan_id: string;
  learning_unit_id: string;
  teaching_brief_id: string | null;
  manifest_fingerprint: string;
  source_context_fingerprint: string | null;
  preparation_status: LessonExecutionState['preparationStatus'];
  preparation_operation_id: string | null;
  version: number;
  current_segment_index: number;
  presented_segment_indexes: string;
  informal_interactions: string;
  presentation_completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: string;
  lesson_execution_state_id: string;
  seq: number;
  command_id: string;
  kind: LessonExecutionEvent['kind'];
  payload: string;
  created_at: string;
}

function hydrateState(row: StateRow): LessonExecutionState {
  return LessonExecutionStateSchema.parse({
    id: row.id,
    sessionId: row.session_id,
    agendaItemId: row.agenda_item_id,
    curriculumVersionId: row.curriculum_id,
    studyPlanVersionId: row.study_plan_id,
    learningUnitId: row.learning_unit_id,
    teachingBriefId: row.teaching_brief_id,
    executionSourceManifestFingerprint: row.manifest_fingerprint,
    sourceContextFingerprint: row.source_context_fingerprint,
    preparationStatus: row.preparation_status,
    preparationOperationId: row.preparation_operation_id,
    version: row.version,
    currentSegmentIndex: row.current_segment_index,
    presentedSegmentIndexes: JSON.parse(row.presented_segment_indexes),
    informalInteractions: JSON.parse(row.informal_interactions),
    presentationCompletedAt: row.presentation_completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function hydrateEvent(row: EventRow): LessonExecutionEvent {
  return LessonExecutionEventSchema.parse({
    id: row.id,
    lessonExecutionStateId: row.lesson_execution_state_id,
    seq: row.seq,
    commandId: row.command_id,
    kind: row.kind,
    payload: JSON.parse(row.payload),
    createdAt: row.created_at,
  });
}

export function createLessonExecutionRepo(db: SqliteDb) {
  function get(id: string): LessonExecutionState | undefined {
    const row = db.prepare('SELECT * FROM lesson_execution_states WHERE id = ?').get(id) as
      StateRow | undefined;
    return row ? hydrateState(row) : undefined;
  }

  function getForSession(
    sessionId: string,
    agendaItemId: string,
  ): LessonExecutionState | undefined {
    const row = db
      .prepare('SELECT * FROM lesson_execution_states WHERE session_id = ? AND agenda_item_id = ?')
      .get(sessionId, agendaItemId) as StateRow | undefined;
    return row ? hydrateState(row) : undefined;
  }

  return {
    get,
    getForSession,
    listForSession(sessionId: string): LessonExecutionState[] {
      return (
        db
          .prepare(
            'SELECT * FROM lesson_execution_states WHERE session_id = ? ORDER BY updated_at ASC, id ASC',
          )
          .all(sessionId) as StateRow[]
      ).map(hydrateState);
    },
    create(input: LessonExecutionState): LessonExecutionState {
      const state = LessonExecutionStateSchema.parse(input);
      db.prepare(
        `INSERT INTO lesson_execution_states
           (id, session_id, agenda_item_id, curriculum_id, study_plan_id, learning_unit_id,
            teaching_brief_id, manifest_fingerprint, source_context_fingerprint,
            preparation_status, preparation_operation_id, version, current_segment_index,
            presented_segment_indexes, informal_interactions, presentation_completed_at,
            created_at, updated_at)
         VALUES (@id, @sessionId, @agendaItemId, @curriculumVersionId, @studyPlanVersionId,
            @learningUnitId, @teachingBriefId, @executionSourceManifestFingerprint,
            @sourceContextFingerprint, @preparationStatus, @preparationOperationId, @version,
            @currentSegmentIndex, @presentedSegmentIndexes, @informalInteractions,
            @presentationCompletedAt, @createdAt, @updatedAt)`,
      ).run({
        ...state,
        presentedSegmentIndexes: JSON.stringify(state.presentedSegmentIndexes),
        informalInteractions: JSON.stringify(state.informalInteractions),
      });
      return get(state.id)!;
    },
    update(input: LessonExecutionState, expectedVersion: number): LessonExecutionState {
      const state = LessonExecutionStateSchema.parse(input);
      if (state.version !== expectedVersion + 1) {
        throw new Error('Lesson execution update must advance version by one.');
      }
      const result = db
        .prepare(
          `UPDATE lesson_execution_states SET teaching_brief_id = @teachingBriefId,
             manifest_fingerprint = @executionSourceManifestFingerprint,
             source_context_fingerprint = @sourceContextFingerprint,
             preparation_status = @preparationStatus,
             preparation_operation_id = @preparationOperationId,
             version = @version, current_segment_index = @currentSegmentIndex,
             presented_segment_indexes = @presentedSegmentIndexes,
             informal_interactions = @informalInteractions,
             presentation_completed_at = @presentationCompletedAt,
             updated_at = @updatedAt
           WHERE id = @id AND version = @expectedVersion`,
        )
        .run({
          ...state,
          expectedVersion,
          presentedSegmentIndexes: JSON.stringify(state.presentedSegmentIndexes),
          informalInteractions: JSON.stringify(state.informalInteractions),
        });
      if (result.changes !== 1) throw new Error('Lesson execution state is stale.');
      return get(state.id)!;
    },
    appendEvent(input: LessonExecutionEvent): LessonExecutionEvent {
      const event = LessonExecutionEventSchema.parse(input);
      const latest = db
        .prepare(
          'SELECT COALESCE(MAX(seq), 0) AS seq FROM lesson_execution_events WHERE lesson_execution_state_id = ?',
        )
        .get(event.lessonExecutionStateId) as { seq: number };
      if (event.seq !== latest.seq + 1) {
        throw new Error('Lesson execution event sequence is stale.');
      }
      db.prepare(
        `INSERT INTO lesson_execution_events
           (id, lesson_execution_state_id, seq, command_id, kind, payload, created_at)
         VALUES (@id, @lessonExecutionStateId, @seq, @commandId, @kind, @payload, @createdAt)`,
      ).run({ ...event, payload: JSON.stringify(event.payload) });
      return event;
    },
    listEvents(stateId: string): LessonExecutionEvent[] {
      return (
        db
          .prepare(
            'SELECT * FROM lesson_execution_events WHERE lesson_execution_state_id = ? ORDER BY seq ASC',
          )
          .all(stateId) as EventRow[]
      ).map(hydrateEvent);
    },
  };
}

export type LessonExecutionRepo = ReturnType<typeof createLessonExecutionRepo>;
