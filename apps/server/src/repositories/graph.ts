import {
  GRAPH_VERSIONS_RETAINED,
  GraphEdgeSchema,
  GraphVersionSchema,
  RemediationPlanSchema,
  type GraphEdge,
  type GraphValidationSummary,
  type GraphVersion,
  type RemediationPlan,
  type VerifiedGrounding,
} from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';

interface VersionRow {
  id: string;
  workspace_id: string;
  status: string;
  provider: string;
  provider_model: string | null;
  validation_summary: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface EdgeRow {
  id: string;
  graph_version_id: string;
  source_concept_id: string;
  target_concept_id: string;
  relation: string;
  explanation: string;
  created_at: string;
}

interface EvidenceRow {
  id: string;
  edge_id: string;
  block_id: string;
  idx: number;
  quote: string;
  start_offset: number;
  end_offset: number;
  occurrence_count: number;
  reanchored: number;
}

interface PlanRow {
  id: string;
  workspace_id: string;
  concept_id: string;
  payload: string;
  provider: string;
  created_at: string;
}

function rowToVersion(row: VersionRow): GraphVersion {
  return GraphVersionSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    status: row.status,
    provider: row.provider,
    providerModel: row.provider_model,
    validationSummary: row.validation_summary
      ? (JSON.parse(row.validation_summary) as unknown)
      : null,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function evidenceFromRows(rows: EvidenceRow[]): VerifiedGrounding[] {
  return rows.map((row) => ({
    blockId: row.block_id,
    quote: row.quote,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    occurrenceCount: row.occurrence_count,
    reanchored: row.reanchored === 1,
  }));
}

export function createGraphRepo(db: SqliteDb) {
  const insertVersionStmt = db.prepare(
    `INSERT INTO graph_versions
       (id, workspace_id, status, provider, provider_model, validation_summary, error_message, created_at, updated_at)
     VALUES (@id, @workspaceId, @status, @provider, @providerModel, @validationSummary, @errorMessage, @createdAt, @updatedAt)`,
  );
  const insertEdgeStmt = db.prepare(
    `INSERT INTO graph_edges
       (id, graph_version_id, source_concept_id, target_concept_id, relation, explanation, created_at)
     VALUES (@id, @graphVersionId, @sourceConceptId, @targetConceptId, @relation, @explanation, @createdAt)`,
  );
  const insertEvidenceStmt = db.prepare(
    `INSERT INTO graph_edge_evidence
       (id, edge_id, block_id, idx, quote, start_offset, end_offset, occurrence_count, reanchored)
     VALUES (@id, @edgeId, @blockId, @idx, @quote, @startOffset, @endOffset, @occurrenceCount, @reanchored)`,
  );

  function loadEdges(versionId: string): GraphEdge[] {
    const edgeRows = db
      .prepare(
        'SELECT * FROM graph_edges WHERE graph_version_id = ? ORDER BY created_at ASC, id ASC',
      )
      .all(versionId) as EdgeRow[];
    if (edgeRows.length === 0) return [];
    const evidenceRows = db
      .prepare(
        `SELECT e.* FROM graph_edge_evidence e
         JOIN graph_edges g ON g.id = e.edge_id
         WHERE g.graph_version_id = ?
         ORDER BY e.edge_id ASC, e.idx ASC`,
      )
      .all(versionId) as EvidenceRow[];
    const evidenceByEdge = new Map<string, EvidenceRow[]>();
    for (const row of evidenceRows) {
      const list = evidenceByEdge.get(row.edge_id) ?? [];
      list.push(row);
      evidenceByEdge.set(row.edge_id, list);
    }
    return edgeRows.map((row) =>
      GraphEdgeSchema.parse({
        id: row.id,
        graphVersionId: row.graph_version_id,
        sourceConceptId: row.source_concept_id,
        targetConceptId: row.target_concept_id,
        relation: row.relation,
        explanation: row.explanation,
        evidence: evidenceFromRows(evidenceByEdge.get(row.id) ?? []),
        createdAt: row.created_at,
      }),
    );
  }

  /**
   * Persist accepted edges into a version, mark it ready, activate it on the
   * workspace, and prune superseded non-active versions beyond the retention
   * window — all in ONE transaction, so activation/replacement is atomic and
   * a failure leaves the previously active graph untouched.
   */
  const finalizeReadyTx = db.transaction(
    (
      versionId: string,
      workspaceId: string,
      edges: GraphEdge[],
      summary: GraphValidationSummary,
      at: string,
    ) => {
      for (const edge of edges) {
        insertEdgeStmt.run({
          id: edge.id,
          graphVersionId: edge.graphVersionId,
          sourceConceptId: edge.sourceConceptId,
          targetConceptId: edge.targetConceptId,
          relation: edge.relation,
          explanation: edge.explanation,
          createdAt: edge.createdAt,
        });
        edge.evidence.forEach((evidence, idx) => {
          insertEvidenceStmt.run({
            id: `${edge.id}_ev${idx}`,
            edgeId: edge.id,
            blockId: evidence.blockId,
            idx,
            quote: evidence.quote,
            startOffset: evidence.startOffset,
            endOffset: evidence.endOffset,
            occurrenceCount: evidence.occurrenceCount,
            reanchored: evidence.reanchored ? 1 : 0,
          });
        });
      }
      db.prepare(
        `UPDATE graph_versions SET status = 'ready', validation_summary = ?, updated_at = ?
         WHERE id = ?`,
      ).run(JSON.stringify(summary), at, versionId);
      db.prepare(
        'UPDATE workspaces SET active_graph_version_id = ?, updated_at = ? WHERE id = ?',
      ).run(versionId, at, workspaceId);

      const stale = db
        .prepare(
          `SELECT id FROM graph_versions
           WHERE workspace_id = ? AND id != ?
           ORDER BY created_at DESC, id DESC`,
        )
        .all(workspaceId, versionId) as Array<{ id: string }>;
      for (const old of stale.slice(GRAPH_VERSIONS_RETAINED - 1)) {
        db.prepare('DELETE FROM graph_versions WHERE id = ?').run(old.id);
      }
    },
  );

  const activateTx = db.transaction((workspaceId: string, versionId: string, at: string) => {
    db.prepare(
      'UPDATE workspaces SET active_graph_version_id = ?, updated_at = ? WHERE id = ?',
    ).run(versionId, at, workspaceId);
    db.prepare('UPDATE graph_versions SET updated_at = ? WHERE id = ?').run(at, versionId);
  });

  return {
    insertVersion(version: GraphVersion): void {
      GraphVersionSchema.parse(version);
      insertVersionStmt.run({
        id: version.id,
        workspaceId: version.workspaceId,
        status: version.status,
        provider: version.provider,
        providerModel: version.providerModel,
        validationSummary: version.validationSummary
          ? JSON.stringify(version.validationSummary)
          : null,
        errorMessage: version.errorMessage,
        createdAt: version.createdAt,
        updatedAt: version.updatedAt,
      });
    },

    getVersion(id: string): GraphVersion | undefined {
      const row = db.prepare('SELECT * FROM graph_versions WHERE id = ?').get(id) as
        VersionRow | undefined;
      return row ? rowToVersion(row) : undefined;
    },

    listVersions(workspaceId: string): GraphVersion[] {
      const rows = db
        .prepare(
          `SELECT * FROM graph_versions WHERE workspace_id = ?
           ORDER BY created_at DESC, id DESC`,
        )
        .all(workspaceId) as VersionRow[];
      return rows.map(rowToVersion);
    },

    getEdges(versionId: string): GraphEdge[] {
      return loadEdges(versionId);
    },

    /** See transaction doc above: persist + activate + retention, atomically. */
    finalizeReady(
      versionId: string,
      workspaceId: string,
      edges: GraphEdge[],
      summary: GraphValidationSummary,
      at: string,
    ): void {
      edges.forEach((e) => GraphEdgeSchema.parse(e));
      finalizeReadyTx(versionId, workspaceId, edges, summary, at);
    },

    markFailed(
      versionId: string,
      summary: GraphValidationSummary | null,
      errorMessage: string,
      at: string,
    ): void {
      db.prepare(
        `UPDATE graph_versions SET status = 'failed', validation_summary = ?, error_message = ?, updated_at = ?
         WHERE id = ?`,
      ).run(summary ? JSON.stringify(summary) : null, errorMessage.slice(0, 500), at, versionId);
    },

    /** Point the workspace at an existing ready version (atomic). */
    activate(workspaceId: string, versionId: string, at: string): void {
      activateTx(workspaceId, versionId, at);
    },

    upsertPlan(plan: RemediationPlan): void {
      RemediationPlanSchema.parse(plan);
      db.prepare(
        `INSERT INTO remediation_plans (id, workspace_id, concept_id, payload, provider, created_at)
         VALUES (@id, @workspaceId, @conceptId, @payload, @provider, @createdAt)
         ON CONFLICT (workspace_id, concept_id) DO UPDATE SET
           id = excluded.id,
           payload = excluded.payload,
           provider = excluded.provider,
           created_at = excluded.created_at`,
      ).run({
        id: plan.id,
        workspaceId: plan.workspaceId,
        conceptId: plan.conceptId,
        payload: JSON.stringify(plan),
        provider: plan.provider,
        createdAt: plan.createdAt,
      });
    },

    getPlan(workspaceId: string, conceptId: string): RemediationPlan | undefined {
      const row = db
        .prepare('SELECT * FROM remediation_plans WHERE workspace_id = ? AND concept_id = ?')
        .get(workspaceId, conceptId) as PlanRow | undefined;
      return row ? RemediationPlanSchema.parse(JSON.parse(row.payload)) : undefined;
    },

    getPlanById(planId: string): RemediationPlan | undefined {
      const row = db.prepare('SELECT * FROM remediation_plans WHERE id = ?').get(planId) as
        PlanRow | undefined;
      return row ? RemediationPlanSchema.parse(JSON.parse(row.payload)) : undefined;
    },
  };
}

export type GraphRepo = ReturnType<typeof createGraphRepo>;
