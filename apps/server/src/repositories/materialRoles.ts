import { MaterialRoleAssignmentSchema, type MaterialRoleAssignment } from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';

interface MaterialRoleRow {
  id: string;
  material_id: string;
  version: number;
  predecessor_id: string | null;
  role: MaterialRoleAssignment['role'];
  status: MaterialRoleAssignment['status'];
  proposed_by: MaterialRoleAssignment['proposedBy'];
  learner_confirmed_at: string | null;
  created_at: string;
}

function hydrate(row: MaterialRoleRow): MaterialRoleAssignment {
  return MaterialRoleAssignmentSchema.parse({
    id: row.id,
    materialId: row.material_id,
    version: row.version,
    predecessorId: row.predecessor_id,
    role: row.role,
    status: row.status,
    proposedBy: row.proposed_by,
    learnerConfirmedAt: row.learner_confirmed_at,
    createdAt: row.created_at,
  });
}

export function createMaterialRolesRepo(db: SqliteDb) {
  function get(id: string): MaterialRoleAssignment | undefined {
    const row = db.prepare('SELECT * FROM material_role_versions WHERE id = ?').get(id) as
      MaterialRoleRow | undefined;
    return row ? hydrate(row) : undefined;
  }

  function getCurrent(materialId: string): MaterialRoleAssignment | undefined {
    const row = db
      .prepare(
        `SELECT * FROM material_role_versions
         WHERE material_id = ? ORDER BY version DESC LIMIT 1`,
      )
      .get(materialId) as MaterialRoleRow | undefined;
    return row ? hydrate(row) : undefined;
  }

  const createVersionTx = db.transaction((assignment: MaterialRoleAssignment) => {
    const parsed = MaterialRoleAssignmentSchema.parse(assignment);
    const material = db.prepare('SELECT id FROM materials WHERE id = ?').get(parsed.materialId);
    if (!material) throw new Error(`Unknown Material: ${parsed.materialId}`);
    const latest = db
      .prepare(
        `SELECT id, version FROM material_role_versions
         WHERE material_id = ? ORDER BY version DESC LIMIT 1`,
      )
      .get(parsed.materialId) as { id: string; version: number } | undefined;
    if (
      parsed.predecessorId !== (latest?.id ?? null) ||
      parsed.version !== (latest?.version ?? 0) + 1
    ) {
      throw new Error('Material role predecessor or version is stale.');
    }
    db.prepare(
      `INSERT INTO material_role_versions (
         id, material_id, version, predecessor_id, role, scope_included,
         learner_confirmed, actor, reason, created_at, status, proposed_by,
         learner_confirmed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    ).run(
      parsed.id,
      parsed.materialId,
      parsed.version,
      parsed.predecessorId,
      parsed.role,
      parsed.role === 'excluded' ? 0 : 1,
      parsed.status === 'learner_confirmed' ? 1 : 0,
      parsed.proposedBy,
      parsed.createdAt,
      parsed.status,
      parsed.proposedBy,
      parsed.learnerConfirmedAt,
    );
    if (parsed.predecessorId) {
      db.prepare(
        `UPDATE material_role_versions
         SET status = 'superseded'
         WHERE id = ? AND status = 'learner_confirmed'`,
      ).run(parsed.predecessorId);
    }
    return get(parsed.id)!;
  });

  return {
    get,

    getCurrent,

    listHistory(materialId: string): MaterialRoleAssignment[] {
      return (
        db
          .prepare(
            `SELECT * FROM material_role_versions
             WHERE material_id = ? ORDER BY version ASC`,
          )
          .all(materialId) as MaterialRoleRow[]
      ).map(hydrate);
    },

    createVersion(assignment: MaterialRoleAssignment): MaterialRoleAssignment {
      return createVersionTx(assignment);
    },

    confirm(id: string, confirmedAt: string): MaterialRoleAssignment {
      const current = get(id);
      if (!current || current.status !== 'proposed') {
        throw new Error('Only a current proposed Material role may be confirmed.');
      }
      const latest = getCurrent(current.materialId);
      if (latest?.id !== id) throw new Error('Material role proposal is stale.');
      const next = MaterialRoleAssignmentSchema.parse({
        ...current,
        status: 'learner_confirmed',
        learnerConfirmedAt: confirmedAt,
      });
      const changed = db
        .prepare(
          `UPDATE material_role_versions
           SET status = 'learner_confirmed', learner_confirmed = 1,
               learner_confirmed_at = ?
           WHERE id = ? AND status = 'proposed'`,
        )
        .run(confirmedAt, id).changes;
      if (changed !== 1) throw new Error('Material role proposal changed concurrently.');
      return next;
    },
  };
}

export type MaterialRolesRepo = ReturnType<typeof createMaterialRolesRepo>;
