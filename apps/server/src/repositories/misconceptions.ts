import {
  MisconceptionRecordSchema,
  type MisconceptionCounts,
  type MisconceptionRecord,
  type MisconceptionStatus,
} from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';

interface MisconceptionRow {
  id: string;
  workspace_id: string;
  concept_id: string;
  status: string;
  category: string;
  payload: string;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: MisconceptionRow): MisconceptionRecord {
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  return MisconceptionRecordSchema.parse({
    ...payload,
    id: row.id,
    workspaceId: row.workspace_id,
    conceptId: row.concept_id,
    status: row.status,
    category: row.category,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function createMisconceptionsRepo(db: SqliteDb) {
  return {
    insert(record: MisconceptionRecord): void {
      MisconceptionRecordSchema.parse(record);
      db.prepare(
        `INSERT INTO misconceptions (id, workspace_id, concept_id, status, category, payload, created_at, updated_at)
         VALUES (@id, @workspaceId, @conceptId, @status, @category, @payload, @createdAt, @updatedAt)`,
      ).run({
        id: record.id,
        workspaceId: record.workspaceId,
        conceptId: record.conceptId,
        status: record.status,
        category: record.category,
        payload: JSON.stringify(record),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      });
    },

    get(id: string): MisconceptionRecord | undefined {
      const row = db.prepare('SELECT * FROM misconceptions WHERE id = ?').get(id) as
        MisconceptionRow | undefined;
      return row ? rowToRecord(row) : undefined;
    },

    listByWorkspace(workspaceId: string, status?: MisconceptionStatus): MisconceptionRecord[] {
      const rows = (
        status
          ? db
              .prepare(
                `SELECT * FROM misconceptions WHERE workspace_id = ? AND status = ?
                 ORDER BY created_at ASC, id ASC`,
              )
              .all(workspaceId, status)
          : db
              .prepare(
                `SELECT * FROM misconceptions WHERE workspace_id = ?
                 ORDER BY created_at ASC, id ASC`,
              )
              .all(workspaceId)
      ) as MisconceptionRow[];
      return rows.map(rowToRecord);
    },

    listByConcept(conceptId: string): MisconceptionRecord[] {
      const rows = db
        .prepare(
          'SELECT * FROM misconceptions WHERE concept_id = ? ORDER BY created_at ASC, id ASC',
        )
        .all(conceptId) as MisconceptionRow[];
      return rows.map(rowToRecord);
    },

    /** Compact proposed/confirmed counts per concept (graph badges). */
    countsByConceptForWorkspace(workspaceId: string): Map<string, MisconceptionCounts> {
      const rows = db
        .prepare(
          `SELECT concept_id,
                  SUM(CASE WHEN status = 'proposed' THEN 1 ELSE 0 END) AS proposed,
                  SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed
           FROM misconceptions WHERE workspace_id = ? GROUP BY concept_id`,
        )
        .all(workspaceId) as Array<{ concept_id: string; proposed: number; confirmed: number }>;
      const map = new Map<string, MisconceptionCounts>();
      for (const row of rows) {
        map.set(row.concept_id, {
          conceptId: row.concept_id,
          proposed: row.proposed,
          confirmed: row.confirmed,
        });
      }
      return map;
    },

    /**
     * Persist a status change. The caller (misconceptions service) is the
     * ONLY place allowed to decide transitions; this repo just writes the
     * already-validated record.
     */
    updateStatus(
      id: string,
      status: MisconceptionStatus,
      decidedByQuizId: string | null,
      updatedAt: string,
    ): void {
      const row = db.prepare('SELECT * FROM misconceptions WHERE id = ?').get(id) as
        MisconceptionRow | undefined;
      if (!row) return;
      const record = rowToRecord(row);
      const next: MisconceptionRecord = {
        ...record,
        status,
        decidedByQuizId: decidedByQuizId ?? record.decidedByQuizId,
        updatedAt,
      };
      db.prepare(
        'UPDATE misconceptions SET status = ?, payload = ?, updated_at = ? WHERE id = ?',
      ).run(status, JSON.stringify(next), updatedAt, id);
    },
  };
}

export type MisconceptionsRepo = ReturnType<typeof createMisconceptionsRepo>;
