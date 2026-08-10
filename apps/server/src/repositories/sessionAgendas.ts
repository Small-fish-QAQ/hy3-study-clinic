import { SessionAgendaSchema, type SessionAgenda } from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';

interface AgendaRow {
  id: string;
  workspace_id: string;
  contract_id: string;
  curriculum_id: string;
  plan_id: string;
  manifest_fingerprint: string;
  version: number;
  status: SessionAgenda['status'];
  payload: string;
  created_at: string;
  updated_at: string;
}

export interface SessionAgendaEventInput {
  id: string;
  eventType: string;
  actor: string;
  payload: unknown;
  createdAt: string;
}

function hydrate(row: AgendaRow): SessionAgenda {
  return SessionAgendaSchema.parse({
    ...(JSON.parse(row.payload) as object),
    id: row.id,
    workspaceId: row.workspace_id,
    contractVersionId: row.contract_id,
    curriculumVersionId: row.curriculum_id,
    studyPlanVersionId: row.plan_id,
    executionSourceManifestFingerprint: row.manifest_fingerprint,
    version: row.version,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function createSessionAgendasRepo(db: SqliteDb) {
  function get(id: string): SessionAgenda | undefined {
    const row = db.prepare('SELECT * FROM session_agendas WHERE id = ?').get(id) as
      AgendaRow | undefined;
    return row ? hydrate(row) : undefined;
  }

  function appendEvent(agendaId: string, event: SessionAgendaEventInput): void {
    const seq = (
      db
        .prepare(
          `SELECT COALESCE(MAX(seq), 0) + 1 AS n
           FROM session_agenda_events WHERE agenda_id = ?`,
        )
        .get(agendaId) as { n: number }
    ).n;
    db.prepare(
      `INSERT INTO session_agenda_events
         (id, agenda_id, seq, event_type, actor, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.id,
      agendaId,
      seq,
      event.eventType,
      event.actor,
      JSON.stringify(event.payload),
      event.createdAt,
    );
  }

  const createTx = db.transaction((input: SessionAgenda, event: SessionAgendaEventInput) => {
    const agenda = SessionAgendaSchema.parse(input);
    if (agenda.status === 'active') {
      throw new Error('Agenda becomes active only during atomic Course route activation.');
    }
    const route = db
      .prepare(
        `SELECT p.workspace_id, p.contract_id, p.curriculum_id, p.manifest_fingerprint
         FROM study_plan_versions p WHERE p.id = ?`,
      )
      .get(agenda.studyPlanVersionId) as
      | {
          workspace_id: string;
          contract_id: string;
          curriculum_id: string;
          manifest_fingerprint: string;
        }
      | undefined;
    if (
      !route ||
      route.workspace_id !== agenda.workspaceId ||
      route.contract_id !== agenda.contractVersionId ||
      route.curriculum_id !== agenda.curriculumVersionId ||
      route.manifest_fingerprint !== agenda.executionSourceManifestFingerprint
    ) {
      throw new Error('SessionAgenda is incompatible with its StudyPlan route.');
    }
    const latest = db
      .prepare(
        'SELECT COALESCE(MAX(version), 0) AS version FROM session_agendas WHERE workspace_id = ?',
      )
      .get(agenda.workspaceId) as { version: number };
    if (agenda.version !== latest.version + 1) throw new Error('SessionAgenda version is stale.');
    if (new Set(agenda.items.map((item) => item.id)).size !== agenda.items.length) {
      throw new Error('SessionAgenda item IDs must be unique.');
    }
    for (const item of agenda.items) {
      if (item.linkedPlanItemId) {
        const planItem = db
          .prepare(
            `SELECT l.status, l.capability, l.resource_id
             FROM study_plan_items i
             JOIN study_plan_launch_validations l
               ON l.plan_id = i.plan_id AND l.plan_item_id = i.plan_item_id
             WHERE i.plan_id = ? AND i.plan_item_id = ?`,
          )
          .get(agenda.studyPlanVersionId, item.linkedPlanItemId) as
          { status: string; capability: string; resource_id: string | null } | undefined;
        if (!planItem) throw new Error('Agenda references an unknown or unvalidated Plan item.');
        if (
          planItem.status !== item.launch.status ||
          planItem.capability !== item.launch.capability ||
          planItem.resource_id !== item.launch.resourceId
        ) {
          throw new Error('Agenda cannot overstate its Plan item launchability.');
        }
      }
    }
    db.prepare(
      `INSERT INTO session_agendas
         (id, workspace_id, contract_id, curriculum_id, plan_id,
          manifest_fingerprint, version, status, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      agenda.id,
      agenda.workspaceId,
      agenda.contractVersionId,
      agenda.curriculumVersionId,
      agenda.studyPlanVersionId,
      agenda.executionSourceManifestFingerprint,
      agenda.version,
      agenda.status,
      JSON.stringify(agenda),
      agenda.createdAt,
      agenda.updatedAt,
    );
    const insertItem = db.prepare(
      `INSERT INTO session_agenda_items
         (agenda_id, agenda_item_id, idx, linked_plan_item_id, kind, state,
          launch_status, launch_capability, launch_resource_id, launch_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const item of agenda.items) {
      insertItem.run(
        agenda.id,
        item.id,
        item.index,
        item.linkedPlanItemId,
        item.kind,
        item.state,
        item.launch.status,
        item.launch.capability,
        item.launch.resourceId,
        item.launch.reason,
      );
    }
    appendEvent(agenda.id, event);
    return get(agenda.id)!;
  });

  return {
    get,
    create: createTx,

    list(workspaceId: string): SessionAgenda[] {
      return (
        db
          .prepare(`SELECT * FROM session_agendas WHERE workspace_id = ? ORDER BY version ASC`)
          .all(workspaceId) as AgendaRow[]
      ).map(hydrate);
    },
  };
}

export type SessionAgendasRepo = ReturnType<typeof createSessionAgendasRepo>;
