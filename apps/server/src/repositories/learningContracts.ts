import {
  LearningContractFeasibilitySchema,
  LearningContractSchema,
  type LearningContract,
  type LearningContractFeasibility,
} from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';

interface ContractRow {
  id: string;
  workspace_id: string;
  version: number;
  predecessor_id: string | null;
  status: LearningContract['status'];
  payload: string;
  learner_confirmed_at: string | null;
  created_at: string;
}

function hydrate(row: ContractRow): LearningContract {
  const payload = JSON.parse(row.payload) as unknown;
  return LearningContractSchema.parse({
    ...(payload as object),
    id: row.id,
    workspaceId: row.workspace_id,
    version: row.version,
    predecessorId: row.predecessor_id,
    status: row.status,
    learnerConfirmedAt: row.learner_confirmed_at,
    createdAt: row.created_at,
  });
}

export interface ContractEventInput {
  id: string;
  eventType: string;
  actor: string;
  payload: unknown;
  createdAt: string;
}

export function createLearningContractsRepo(db: SqliteDb) {
  function get(id: string): LearningContract | undefined {
    const row = db.prepare('SELECT * FROM learning_contract_versions WHERE id = ?').get(id) as
      ContractRow | undefined;
    return row ? hydrate(row) : undefined;
  }

  function appendEvent(contractId: string, event: ContractEventInput): void {
    const seq = (
      db
        .prepare(
          `SELECT COALESCE(MAX(seq), 0) + 1 AS n
           FROM learning_contract_events WHERE contract_id = ?`,
        )
        .get(contractId) as { n: number }
    ).n;
    db.prepare(
      `INSERT INTO learning_contract_events
         (id, contract_id, seq, event_type, actor, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.id,
      contractId,
      seq,
      event.eventType,
      event.actor,
      JSON.stringify(event.payload),
      event.createdAt,
    );
  }

  const createVersionTx = db.transaction(
    (
      contractInput: LearningContract,
      feasibilityInput: LearningContractFeasibility,
      event: ContractEventInput,
    ): LearningContract => {
      const contract = LearningContractSchema.parse(contractInput);
      const feasibility = LearningContractFeasibilitySchema.parse(feasibilityInput);
      if (contract.status === 'active') {
        throw new Error('A Contract may become active only during atomic route activation.');
      }
      const latest = db
        .prepare(
          `SELECT id, version FROM learning_contract_versions
           WHERE workspace_id = ? ORDER BY version DESC LIMIT 1`,
        )
        .get(contract.workspaceId) as { id: string; version: number } | undefined;
      if (
        contract.predecessorId !== (latest?.id ?? null) ||
        contract.version !== (latest?.version ?? 0) + 1
      ) {
        throw new Error('Learning Contract predecessor or version is stale.');
      }

      db.prepare(
        `INSERT INTO learning_contract_versions
           (id, workspace_id, version, predecessor_id, status, payload,
            learner_confirmed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        contract.id,
        contract.workspaceId,
        contract.version,
        contract.predecessorId,
        contract.status,
        JSON.stringify(contract),
        contract.learnerConfirmedAt,
        contract.createdAt,
      );
      const insertScope = db.prepare(
        `INSERT INTO learning_contract_material_scope
           (contract_id, material_id, material_role_assignment_id,
            material_role_assignment_version, role, disposition)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const scope of contract.courseScope.materials) {
        const role = db
          .prepare(
            `SELECT material_id, version, role, status
             FROM material_role_versions WHERE id = ?`,
          )
          .get(scope.materialRoleAssignmentId) as
          { material_id: string; version: number; role: string; status: string } | undefined;
        if (
          !role ||
          role.material_id !== scope.materialId ||
          role.version !== scope.materialRoleAssignmentVersion ||
          role.role !== scope.role ||
          role.status !== 'learner_confirmed'
        ) {
          throw new Error('Contract scope requires an exact learner-confirmed Material role.');
        }
        insertScope.run(
          contract.id,
          scope.materialId,
          scope.materialRoleAssignmentId,
          scope.materialRoleAssignmentVersion,
          scope.role,
          scope.disposition,
        );
      }
      db.prepare(
        `INSERT INTO learning_contract_feasibility_snapshots
           (id, contract_id, policy_version, payload, computed_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        `${contract.id}:${feasibility.policyVersion}:${feasibility.computedAt}`,
        contract.id,
        feasibility.policyVersion,
        JSON.stringify(feasibility),
        feasibility.computedAt,
      );
      appendEvent(contract.id, event);
      return get(contract.id)!;
    },
  );

  const transitionTx = db.transaction(
    (
      id: string,
      expectedStatus: LearningContract['status'],
      nextStatus: 'proposed' | 'learner_confirmed' | 'withdrawn',
      at: string,
      event: ContractEventInput,
    ) => {
      const current = get(id);
      if (!current || current.status !== expectedStatus) {
        throw new Error('Learning Contract status is stale.');
      }
      const allowed =
        (expectedStatus === 'draft' && nextStatus === 'proposed') ||
        (expectedStatus === 'proposed' && nextStatus === 'learner_confirmed') ||
        ((expectedStatus === 'draft' || expectedStatus === 'proposed') &&
          nextStatus === 'withdrawn');
      if (!allowed) throw new Error('Invalid Learning Contract transition.');
      const learnerConfirmedAt =
        nextStatus === 'learner_confirmed' ? at : current.learnerConfirmedAt;
      const next = LearningContractSchema.parse({
        ...current,
        status: nextStatus,
        learnerConfirmedAt,
      });
      const changed = db
        .prepare(
          `UPDATE learning_contract_versions
           SET status = ?, learner_confirmed_at = ?, payload = ?
           WHERE id = ? AND status = ?`,
        )
        .run(nextStatus, learnerConfirmedAt, JSON.stringify(next), id, expectedStatus).changes;
      if (changed !== 1) throw new Error('Learning Contract changed concurrently.');
      appendEvent(id, event);
      return get(id)!;
    },
  );

  return {
    get,

    list(workspaceId: string): LearningContract[] {
      return (
        db
          .prepare(
            `SELECT * FROM learning_contract_versions
             WHERE workspace_id = ? ORDER BY version ASC`,
          )
          .all(workspaceId) as ContractRow[]
      ).map(hydrate);
    },

    createVersion(
      contract: LearningContract,
      feasibility: LearningContractFeasibility,
      event: ContractEventInput,
    ): LearningContract {
      return createVersionTx(contract, feasibility, event);
    },

    transition(
      id: string,
      expectedStatus: LearningContract['status'],
      nextStatus: 'proposed' | 'learner_confirmed' | 'withdrawn',
      at: string,
      event: ContractEventInput,
    ): LearningContract {
      return transitionTx(id, expectedStatus, nextStatus, at, event);
    },

    getLatestFeasibility(contractId: string): LearningContractFeasibility | undefined {
      const row = db
        .prepare(
          `SELECT payload FROM learning_contract_feasibility_snapshots
           WHERE contract_id = ? ORDER BY computed_at DESC LIMIT 1`,
        )
        .get(contractId) as { payload: string } | undefined;
      return row
        ? LearningContractFeasibilitySchema.parse(JSON.parse(row.payload) as unknown)
        : undefined;
    },
  };
}

export type LearningContractsRepo = ReturnType<typeof createLearningContractsRepo>;
