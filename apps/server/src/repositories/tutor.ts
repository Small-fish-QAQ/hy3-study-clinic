import {
  TutorEventSchema,
  TutorRunSchema,
  type TutorEvent,
  type TutorRun,
} from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';

interface RunRow {
  id: string;
  workspace_id: string;
  concept_id: string;
  concept_name: string;
  status: string;
  iterations: number;
  tool_call_count: number;
  accepted_evidence: string;
  plan_id: string | null;
  activity: string | null;
  error_message: string | null;
  provider: string;
  provider_model: string | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: string;
  run_id: string;
  seq: number;
  kind: string;
  summary: string;
  detail: string | null;
  created_at: string;
}

function rowToRun(row: RunRow): TutorRun {
  return TutorRunSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    conceptId: row.concept_id,
    conceptName: row.concept_name,
    status: row.status,
    iterations: row.iterations,
    toolCallCount: row.tool_call_count,
    acceptedEvidence: JSON.parse(row.accepted_evidence),
    planId: row.plan_id,
    activity: row.activity ? JSON.parse(row.activity) : null,
    errorMessage: row.error_message,
    provider: row.provider,
    providerModel: row.provider_model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function rowToEvent(row: EventRow): TutorEvent {
  return TutorEventSchema.parse({
    id: row.id,
    runId: row.run_id,
    seq: row.seq,
    kind: row.kind,
    summary: row.summary,
    ...(row.detail ? { detail: JSON.parse(row.detail) } : {}),
    createdAt: row.created_at,
  });
}

export function createTutorRepo(db: SqliteDb) {
  return {
    insertRun(run: TutorRun): void {
      TutorRunSchema.parse(run);
      db.prepare(
        `INSERT INTO tutor_runs
           (id, workspace_id, concept_id, concept_name, status, iterations, tool_call_count,
            accepted_evidence, plan_id, activity, error_message, provider, provider_model,
            created_at, updated_at)
         VALUES
           (@id, @workspaceId, @conceptId, @conceptName, @status, @iterations, @toolCallCount,
            @acceptedEvidence, @planId, @activity, @errorMessage, @provider, @providerModel,
            @createdAt, @updatedAt)`,
      ).run(runParams(run));
    },

    updateRun(run: TutorRun): void {
      TutorRunSchema.parse(run);
      db.prepare(
        `UPDATE tutor_runs SET status = @status, iterations = @iterations,
           tool_call_count = @toolCallCount, accepted_evidence = @acceptedEvidence,
           plan_id = @planId, activity = @activity, error_message = @errorMessage,
           updated_at = @updatedAt
         WHERE id = @id`,
      ).run(runParams(run));
    },

    getRun(id: string): TutorRun | undefined {
      const row = db.prepare('SELECT * FROM tutor_runs WHERE id = ?').get(id) as RunRow | undefined;
      return row ? rowToRun(row) : undefined;
    },

    listRuns(workspaceId: string, limit = 20): TutorRun[] {
      const rows = db
        .prepare(
          `SELECT * FROM tutor_runs WHERE workspace_id = ?
           ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(workspaceId, limit) as RunRow[];
      return rows.map(rowToRun);
    },

    /**
     * Mark every run still recorded as `running` as `interrupted`. Called on
     * server startup: a run can only legitimately be `running` while its
     * request is in flight, so leftovers mean the process died mid-session.
     */
    markInterruptedRuns(at: string): number {
      return db
        .prepare(
          `UPDATE tutor_runs SET status = 'interrupted',
             error_message = COALESCE(error_message, '服务器重启时会话仍在进行,已标记为中断。'),
             updated_at = ?
           WHERE status = 'running'`,
        )
        .run(at).changes;
    },

    insertEvent(event: TutorEvent): void {
      TutorEventSchema.parse(event);
      db.prepare(
        `INSERT INTO tutor_events (id, run_id, seq, kind, summary, detail, created_at)
         VALUES (@id, @runId, @seq, @kind, @summary, @detail, @createdAt)`,
      ).run({
        id: event.id,
        runId: event.runId,
        seq: event.seq,
        kind: event.kind,
        summary: event.summary,
        detail: event.detail ? JSON.stringify(event.detail) : null,
        createdAt: event.createdAt,
      });
    },

    listEvents(runId: string): TutorEvent[] {
      const rows = db
        .prepare('SELECT * FROM tutor_events WHERE run_id = ? ORDER BY seq ASC')
        .all(runId) as EventRow[];
      return rows.map(rowToEvent);
    },
  };
}

function runParams(run: TutorRun) {
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    conceptId: run.conceptId,
    conceptName: run.conceptName,
    status: run.status,
    iterations: run.iterations,
    toolCallCount: run.toolCallCount,
    acceptedEvidence: JSON.stringify(run.acceptedEvidence),
    planId: run.planId,
    activity: run.activity ? JSON.stringify(run.activity) : null,
    errorMessage: run.errorMessage,
    provider: run.provider,
    providerModel: run.providerModel,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

export type TutorRepo = ReturnType<typeof createTutorRepo>;
