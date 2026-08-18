import {
  StudyExchangeSchema,
  StudySessionSchema,
  StudySessionSummarySchema,
  StudyTurnEventSchema,
  StudyTurnSchema,
  type StudyExchange,
  type StudySession,
  type StudySessionSummary,
  type StudyTurn,
  type StudyTurnEvent,
  type TutorTurnMetadata,
} from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';

interface SessionRow {
  id: string;
  workspace_id: string;
  contract_id: string;
  curriculum_id: string;
  plan_id: string;
  agenda_id: string;
  manifest_fingerprint: string;
  version: number;
  status: StudySession['status'];
  route_state: StudySession['routeState'];
  current_agenda_item_id: string | null;
  route_stack: string;
  transcript_watermark: number;
  created_at: string;
  updated_at: string;
}

interface TurnRow {
  id: string;
  session_id: string;
  seq: number;
  command_id: string;
  status: StudyTurn['status'];
  context_manifest: string;
  pedagogy_metadata: string | null;
  logical_call_id: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

interface ExchangeRow {
  id: string;
  session_id: string;
  turn_id: string;
  seq: number;
  role: StudyExchange['role'];
  content: string;
  channel: StudyExchange['channel'];
  created_at: string;
}

interface TurnEventRow {
  id: string;
  session_id: string;
  turn_id: string;
  seq: number;
  kind: StudyTurnEvent['kind'];
  provisional: number;
  content: string | null;
  created_at: string;
}

interface SummaryRow {
  id: string;
  session_id: string;
  version: number;
  through_exchange_seq: number;
  context_fingerprint: string;
  payload: string;
  created_at: string;
}

function hydrateSession(row: SessionRow): StudySession {
  return StudySessionSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    contractVersionId: row.contract_id,
    curriculumVersionId: row.curriculum_id,
    studyPlanVersionId: row.plan_id,
    sessionAgendaId: row.agenda_id,
    executionSourceManifestFingerprint: row.manifest_fingerprint,
    version: row.version,
    status: row.status,
    routeState: row.route_state,
    currentAgendaItemId: row.current_agenda_item_id,
    routeStack: JSON.parse(row.route_stack),
    transcriptWatermark: row.transcript_watermark,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function hydrateTurn(row: TurnRow): StudyTurn {
  return StudyTurnSchema.parse({
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    commandId: row.command_id,
    status: row.status,
    contextManifest: JSON.parse(row.context_manifest),
    ...(row.pedagogy_metadata
      ? { tutorMetadata: JSON.parse(row.pedagogy_metadata) as TutorTurnMetadata }
      : {}),
    logicalCallId: row.logical_call_id,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  });
}

function hydrateExchange(row: ExchangeRow): StudyExchange {
  return StudyExchangeSchema.parse({
    id: row.id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    seq: row.seq,
    role: row.role,
    content: row.content,
    channel: row.channel,
    createdAt: row.created_at,
  });
}

function hydrateTurnEvent(row: TurnEventRow): StudyTurnEvent {
  return StudyTurnEventSchema.parse({
    id: row.id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    seq: row.seq,
    kind: row.kind,
    provisional: row.provisional === 1,
    content: row.content,
    createdAt: row.created_at,
  });
}

function hydrateSummary(row: SummaryRow): StudySessionSummary {
  return StudySessionSummarySchema.parse({
    ...(JSON.parse(row.payload) as object),
    id: row.id,
    sessionId: row.session_id,
    version: row.version,
    throughExchangeSeq: row.through_exchange_seq,
    contextFingerprint: row.context_fingerprint,
    createdAt: row.created_at,
  });
}

/** Durable conversational execution state. Does not own formal learner progression. */
export function createStudySessionsRepo(db: SqliteDb) {
  function get(id: string): StudySession | undefined {
    const row = db.prepare('SELECT * FROM study_sessions WHERE id = ?').get(id) as
      SessionRow | undefined;
    return row ? hydrateSession(row) : undefined;
  }

  function validateRoute(session: StudySession): void {
    const route = db
      .prepare(
        `SELECT a.workspace_id, a.contract_id, a.curriculum_id, a.plan_id, a.manifest_fingerprint
         FROM session_agendas a WHERE a.id = ?`,
      )
      .get(session.sessionAgendaId) as
      | {
          workspace_id: string;
          contract_id: string;
          curriculum_id: string;
          plan_id: string;
          manifest_fingerprint: string;
        }
      | undefined;
    if (
      !route ||
      route.workspace_id !== session.workspaceId ||
      route.contract_id !== session.contractVersionId ||
      route.curriculum_id !== session.curriculumVersionId ||
      route.plan_id !== session.studyPlanVersionId ||
      route.manifest_fingerprint !== session.executionSourceManifestFingerprint
    ) {
      throw new Error('StudySession is incompatible with its SessionAgenda route.');
    }
    if (session.currentAgendaItemId) {
      const item = db
        .prepare('SELECT 1 FROM session_agenda_items WHERE agenda_id = ? AND agenda_item_id = ?')
        .get(session.sessionAgendaId, session.currentAgendaItemId);
      if (!item) throw new Error('StudySession references an unknown SessionAgenda item.');
    }
  }

  function assertTurnOwner(sessionId: string, turnId: string): void {
    const owner = db
      .prepare('SELECT session_id FROM study_session_turns WHERE id = ?')
      .get(turnId) as { session_id: string } | undefined;
    if (!owner || owner.session_id !== sessionId) {
      throw new Error('StudySession record references a Turn from another Session.');
    }
  }

  function getTurn(id: string): StudyTurn | undefined {
    const row = db.prepare('SELECT * FROM study_session_turns WHERE id = ?').get(id) as
      TurnRow | undefined;
    return row ? hydrateTurn(row) : undefined;
  }

  return {
    get,

    create(input: StudySession): StudySession {
      const session = StudySessionSchema.parse(input);
      validateRoute(session);
      db.prepare(
        `INSERT INTO study_sessions
           (id, workspace_id, contract_id, curriculum_id, plan_id, agenda_id, manifest_fingerprint,
            version, status, route_state, current_agenda_item_id, route_stack, transcript_watermark,
            created_at, updated_at)
         VALUES (@id, @workspaceId, @contractVersionId, @curriculumVersionId, @studyPlanVersionId,
            @sessionAgendaId, @executionSourceManifestFingerprint, @version, @status, @routeState,
            @currentAgendaItemId, @routeStack, @transcriptWatermark, @createdAt, @updatedAt)`,
      ).run({ ...session, routeStack: JSON.stringify(session.routeStack) });
      return get(session.id)!;
    },

    update(input: StudySession, expectedVersion: number): StudySession {
      const session = StudySessionSchema.parse(input);
      if (session.version !== expectedVersion + 1) {
        throw new Error('StudySession update must advance version by one.');
      }
      validateRoute(session);
      const result = db
        .prepare(
          `UPDATE study_sessions SET version = @version, status = @status, route_state = @routeState,
             current_agenda_item_id = @currentAgendaItemId, route_stack = @routeStack,
             transcript_watermark = @transcriptWatermark, updated_at = @updatedAt
           WHERE id = @id AND version = @expectedVersion`,
        )
        .run({ ...session, expectedVersion, routeStack: JSON.stringify(session.routeStack) });
      if (result.changes !== 1) throw new Error('StudySession is stale.');
      return get(session.id)!;
    },

    list(workspaceId: string, limit = 50): StudySession[] {
      return (
        db
          .prepare(
            `SELECT * FROM study_sessions WHERE workspace_id = ?
             ORDER BY updated_at DESC, id DESC LIMIT ?`,
          )
          .all(workspaceId, limit) as SessionRow[]
      ).map(hydrateSession);
    },

    insertTurn(input: StudyTurn): StudyTurn {
      const turn = StudyTurnSchema.parse(input);
      if (!get(turn.sessionId)) throw new Error('StudySession does not exist.');
      db.prepare(
        `INSERT INTO study_session_turns
           (id, session_id, seq, command_id, status, context_manifest, logical_call_id,
            pedagogy_metadata, error_message, created_at, completed_at)
         VALUES (@id, @sessionId, @seq, @commandId, @status, @contextManifest, @logicalCallId,
            @pedagogyMetadata, @errorMessage, @createdAt, @completedAt)`,
      ).run({
        ...turn,
        contextManifest: JSON.stringify(turn.contextManifest),
        pedagogyMetadata: turn.tutorMetadata ? JSON.stringify(turn.tutorMetadata) : null,
      });
      return getTurn(turn.id)!;
    },

    updateTurn(input: StudyTurn, expectedSessionVersion?: number): StudyTurn {
      const turn = StudyTurnSchema.parse(input);
      const owningSession = get(turn.sessionId);
      if (!owningSession) throw new Error('StudySession does not exist.');
      if (
        expectedSessionVersion !== undefined &&
        owningSession.version !== expectedSessionVersion
      ) {
        throw new Error('StudySession turn update is stale.');
      }
      const result = db
        .prepare(
          `UPDATE study_session_turns SET status = @status, context_manifest = @contextManifest,
             logical_call_id = @logicalCallId, pedagogy_metadata = @pedagogyMetadata,
             error_message = @errorMessage,
             completed_at = @completedAt
           WHERE id = @id AND session_id = @sessionId`,
        )
        .run({
          ...turn,
          contextManifest: JSON.stringify(turn.contextManifest),
          pedagogyMetadata: turn.tutorMetadata ? JSON.stringify(turn.tutorMetadata) : null,
        });
      if (result.changes !== 1) throw new Error('StudySession turn does not exist.');
      return getTurn(turn.id)!;
    },

    getTurn,

    getTurnByCommand(sessionId: string, commandId: string): StudyTurn | undefined {
      const row = db
        .prepare(
          'SELECT * FROM study_session_turns WHERE session_id = ? AND command_id = ? LIMIT 1',
        )
        .get(sessionId, commandId) as TurnRow | undefined;
      return row ? hydrateTurn(row) : undefined;
    },

    listTurns(sessionId: string): StudyTurn[] {
      return (
        db
          .prepare('SELECT * FROM study_session_turns WHERE session_id = ? ORDER BY seq ASC')
          .all(sessionId) as TurnRow[]
      ).map(hydrateTurn);
    },

    insertExchange(input: StudyExchange): StudyExchange {
      const exchange = StudyExchangeSchema.parse(input);
      assertTurnOwner(exchange.sessionId, exchange.turnId);
      db.prepare(
        `INSERT INTO study_session_exchanges
           (id, session_id, turn_id, seq, role, content, channel, created_at)
         VALUES (@id, @sessionId, @turnId, @seq, @role, @content, @channel, @createdAt)`,
      ).run(exchange);
      return hydrateExchange(
        db
          .prepare('SELECT * FROM study_session_exchanges WHERE id = ?')
          .get(exchange.id) as ExchangeRow,
      );
    },

    listExchanges(sessionId: string, afterSeq = -1): StudyExchange[] {
      return (
        db
          .prepare(
            `SELECT * FROM study_session_exchanges
             WHERE session_id = ? AND seq > ? ORDER BY seq ASC`,
          )
          .all(sessionId, afterSeq) as ExchangeRow[]
      ).map(hydrateExchange);
    },

    insertTurnEvent(input: StudyTurnEvent): StudyTurnEvent {
      const event = StudyTurnEventSchema.parse(input);
      assertTurnOwner(event.sessionId, event.turnId);
      db.prepare(
        `INSERT INTO study_turn_events
           (id, session_id, turn_id, seq, kind, provisional, content, created_at)
         VALUES (@id, @sessionId, @turnId, @seq, @kind, @provisional, @content, @createdAt)`,
      ).run({ ...event, provisional: event.provisional ? 1 : 0 });
      return hydrateTurnEvent(
        db.prepare('SELECT * FROM study_turn_events WHERE id = ?').get(event.id) as TurnEventRow,
      );
    },

    listTurnEvents(turnId: string): StudyTurnEvent[] {
      return (
        db
          .prepare('SELECT * FROM study_turn_events WHERE turn_id = ? ORDER BY seq ASC')
          .all(turnId) as TurnEventRow[]
      ).map(hydrateTurnEvent);
    },

    insertSummary(input: StudySessionSummary): StudySessionSummary {
      const summary = StudySessionSummarySchema.parse(input);
      if (!get(summary.sessionId)) throw new Error('StudySession does not exist.');
      db.prepare(
        `INSERT INTO study_session_summaries
           (id, session_id, version, through_exchange_seq, context_fingerprint, payload, created_at)
         VALUES (@id, @sessionId, @version, @throughExchangeSeq, @contextFingerprint, @payload, @createdAt)`,
      ).run({ ...summary, payload: JSON.stringify(summary) });
      return hydrateSummary(
        db
          .prepare('SELECT * FROM study_session_summaries WHERE id = ?')
          .get(summary.id) as SummaryRow,
      );
    },

    latestSummary(sessionId: string): StudySessionSummary | undefined {
      const row = db
        .prepare(
          `SELECT * FROM study_session_summaries WHERE session_id = ?
           ORDER BY version DESC LIMIT 1`,
        )
        .get(sessionId) as SummaryRow | undefined;
      return row ? hydrateSummary(row) : undefined;
    },

    markInterruptedTurns(at: string): number {
      const mark = db.transaction(() => {
        const rows = db
          .prepare(
            `SELECT id, session_id FROM study_session_turns
             WHERE status IN ('queued', 'running') ORDER BY session_id, seq`,
          )
          .all() as Array<{ id: string; session_id: string }>;
        for (const row of rows) {
          const changed = db
            .prepare(
              `UPDATE study_session_turns SET status = 'interrupted', completed_at = COALESCE(completed_at, ?),
                 error_message = COALESCE(error_message, 'Server restart interrupted this StudySession turn.')
               WHERE id = ? AND status IN ('queued', 'running')`,
            )
            .run(at, row.id).changes;
          if (changed !== 1) continue;
          const next = (
            db
              .prepare(
                `SELECT COALESCE(MAX(seq), -1) + 1 AS seq
                 FROM study_turn_events WHERE turn_id = ?`,
              )
              .get(row.id) as { seq: number }
          ).seq;
          db.prepare(
            `INSERT INTO study_turn_events
               (id, session_id, turn_id, seq, kind, provisional, content, created_at)
             VALUES (?, ?, ?, ?, 'interrupted', 0, NULL, ?)`,
          ).run(`${row.id}:restart`, row.session_id, row.id, next, at);
        }
        return rows.length;
      });
      return mark();
    },
  };
}

export type StudySessionsRepo = ReturnType<typeof createStudySessionsRepo>;
