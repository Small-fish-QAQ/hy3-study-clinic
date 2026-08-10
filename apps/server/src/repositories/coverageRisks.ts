import { CoverageRiskEntrySchema, type CoverageRiskEntry } from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';

interface RiskRow {
  id: string;
  workspace_id: string;
  contract_id: string;
  stable_scope_fingerprint: string;
  material_id: string | null;
  objective_id: string | null;
  origin: CoverageRiskEntry['origin'];
  status: CoverageRiskEntry['status'];
  truth_premise_status: CoverageRiskEntry['truthPremiseStatus'];
  payload: string;
  first_observed_at: string;
  updated_at: string;
}

export interface CoverageRiskEventInput {
  id: string;
  eventType: string;
  actor: string;
  payload: unknown;
  createdAt: string;
}

function hydrate(row: RiskRow): CoverageRiskEntry {
  return CoverageRiskEntrySchema.parse({
    ...(JSON.parse(row.payload) as object),
    id: row.id,
    workspaceId: row.workspace_id,
    contractVersionId: row.contract_id,
    stableScopeFingerprint: row.stable_scope_fingerprint,
    materialId: row.material_id,
    objectiveId: row.objective_id,
    origin: row.origin,
    status: row.status,
    truthPremiseStatus: row.truth_premise_status,
    firstObservedAt: row.first_observed_at,
    updatedAt: row.updated_at,
  });
}

export function createCoverageRisksRepo(db: SqliteDb) {
  function get(id: string): CoverageRiskEntry | undefined {
    const row = db.prepare('SELECT * FROM coverage_risk_entries WHERE id = ?').get(id) as
      RiskRow | undefined;
    return row ? hydrate(row) : undefined;
  }

  function appendEvent(riskId: string, event: CoverageRiskEventInput): void {
    const seq = (
      db
        .prepare(
          `SELECT COALESCE(MAX(seq), 0) + 1 AS n
           FROM coverage_risk_events WHERE risk_id = ?`,
        )
        .get(riskId) as { n: number }
    ).n;
    db.prepare(
      `INSERT INTO coverage_risk_events
         (id, risk_id, seq, event_type, actor, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.id,
      riskId,
      seq,
      event.eventType,
      event.actor,
      JSON.stringify(event.payload),
      event.createdAt,
    );
  }

  const createTx = db.transaction((input: CoverageRiskEntry, event: CoverageRiskEventInput) => {
    const risk = CoverageRiskEntrySchema.parse(input);
    const contract = db
      .prepare('SELECT workspace_id FROM learning_contract_versions WHERE id = ?')
      .get(risk.contractVersionId) as { workspace_id: string } | undefined;
    if (!contract || contract.workspace_id !== risk.workspaceId) {
      throw new Error('Coverage risk Contract does not belong to this Course.');
    }
    if (risk.materialId) {
      const material = db
        .prepare('SELECT workspace_id FROM materials WHERE id = ?')
        .get(risk.materialId) as { workspace_id: string } | undefined;
      if (!material || material.workspace_id !== risk.workspaceId) {
        throw new Error('Coverage risk Material does not belong to this Course.');
      }
    }
    for (const authorityId of risk.truthAuthorityRecordIds) {
      if (!db.prepare('SELECT 1 FROM truth_authority_records WHERE id = ?').get(authorityId)) {
        throw new Error('Coverage risk references unknown truth authority.');
      }
    }
    for (const nodeId of risk.referencedCurriculumNodeIds) {
      const node = db
        .prepare(
          `SELECT 1 FROM curriculum_node_index n
           JOIN curriculum_versions c ON c.id = n.curriculum_id
           WHERE n.node_id = ? AND c.contract_id = ?`,
        )
        .get(nodeId, risk.contractVersionId);
      if (!node) throw new Error('Coverage risk references an unknown Curriculum node.');
    }
    for (const conceptId of risk.referencedConceptIds) {
      if (!db.prepare('SELECT 1 FROM concepts WHERE id = ?').get(conceptId)) {
        throw new Error('Coverage risk references an unknown Concept.');
      }
    }
    for (const observation of risk.observations) {
      if (observation.materialRevisionId) {
        const revision = db
          .prepare('SELECT material_id FROM material_revisions WHERE id = ?')
          .get(observation.materialRevisionId) as { material_id: string } | undefined;
        if (!revision || (risk.materialId && revision.material_id !== risk.materialId)) {
          throw new Error('Coverage risk observation revision has the wrong Material owner.');
        }
      }
      if (observation.sourceBlockId) {
        const block = db
          .prepare(`SELECT material_revision_id FROM source_blocks WHERE id = ?`)
          .get(observation.sourceBlockId) as { material_revision_id: string | null } | undefined;
        if (
          !block ||
          (observation.materialRevisionId &&
            block.material_revision_id !== observation.materialRevisionId)
        ) {
          throw new Error('Coverage risk observation SourceBlock has the wrong revision owner.');
        }
      }
    }

    db.prepare(
      `INSERT INTO coverage_risk_entries
         (id, workspace_id, contract_id, stable_scope_fingerprint, material_id,
          objective_id, origin, status, truth_premise_status, payload,
          first_observed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      risk.id,
      risk.workspaceId,
      risk.contractVersionId,
      risk.stableScopeFingerprint,
      risk.materialId,
      risk.objectiveId,
      risk.origin,
      risk.status,
      risk.truthPremiseStatus,
      JSON.stringify(risk),
      risk.firstObservedAt,
      risk.updatedAt,
    );
    const insertObservation = db.prepare(
      `INSERT INTO coverage_risk_observations
         (risk_id, observation_id, material_revision_id, source_block_id,
          source_block_revision_fingerprint, manifest_fingerprint,
          reconciliation_status, payload, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const observation of risk.observations) {
      insertObservation.run(
        risk.id,
        observation.id,
        observation.materialRevisionId,
        observation.sourceBlockId,
        observation.sourceBlockRevisionFingerprint,
        observation.executionSourceManifestFingerprint,
        observation.reconciliationStatus,
        JSON.stringify(observation),
        observation.observedAt,
      );
    }
    const insertAuthority = db.prepare(
      `INSERT INTO coverage_risk_authority_links (risk_id, authority_record_id) VALUES (?, ?)`,
    );
    for (const authorityId of risk.truthAuthorityRecordIds)
      insertAuthority.run(risk.id, authorityId);
    appendEvent(risk.id, event);
    return get(risk.id)!;
  });

  return {
    get,
    create: createTx,

    list(workspaceId: string, contractId?: string): CoverageRiskEntry[] {
      const rows = contractId
        ? (db
            .prepare(
              `SELECT * FROM coverage_risk_entries
               WHERE workspace_id = ? AND contract_id = ? ORDER BY updated_at DESC, id`,
            )
            .all(workspaceId, contractId) as RiskRow[])
        : (db
            .prepare(
              `SELECT * FROM coverage_risk_entries
               WHERE workspace_id = ? ORDER BY updated_at DESC, id`,
            )
            .all(workspaceId) as RiskRow[]);
      return rows.map(hydrate);
    },
  };
}

export type CoverageRisksRepo = ReturnType<typeof createCoverageRisksRepo>;
