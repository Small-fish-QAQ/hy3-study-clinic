import {
  WorkspaceSchema,
  type DocumentSummary,
  type Workspace,
  type WorkspaceSummary,
} from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';

interface WorkspaceRow {
  id: string;
  name: string;
  description: string | null;
  active_graph_version_id: string | null;
  origin: string;
  created_at: string;
  updated_at: string;
}

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return WorkspaceSchema.parse({
    id: row.id,
    name: row.name,
    description: row.description,
    activeGraphVersionId: row.active_graph_version_id,
    origin: row.origin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/** Outcome of the internal transactional document purge (see purgeDocumentTx). */
export interface DocumentDeletionOutcome {
  deleted: boolean;
  /** True when the final document retired its `material_import` workspace. */
  workspaceDeleted: boolean;
}

export function createWorkspacesRepo(db: SqliteDb) {
  const insertStmt = db.prepare(
    `INSERT INTO workspaces (id, name, description, active_graph_version_id, origin, created_at, updated_at)
     VALUES (@id, @name, @description, @activeGraphVersionId, @origin, @createdAt, @updatedAt)`,
  );
  const getStmt = db.prepare('SELECT * FROM workspaces WHERE id = ?');

  /**
   * Explicit destructive dependent-data cleanup that FK cascades cannot
   * express, run INSIDE the same transaction as a document delete/reprocess:
   *
   * 1. graph edges whose evidence rows were all cascade-deleted with the
   *    document's source blocks are removed (an edge without evidence is
   *    invalid by definition);
   * 2. graph versions that lost edges get a visible `pruned` marker in their
   *    validation summary;
   * 3. every remediation plan in the workspace is deleted — plan payloads may
   *    reference concepts/evidence of any workspace document, so this is the
   *    only rule that guarantees no dangling plan references. Plans are cheap
   *    to regenerate and carry no learning history.
   * 4. canonical concepts whose LAST member concept was cascade-deleted are
   *    removed (documented policy: a canonical concept survives while at
   *    least one backing document remains; deleting the final backing
   *    document removes it). Canonical concepts still backed by other
   *    documents are untouched.
   */
  function cleanupWorkspaceDerivedData(
    workspaceId: string,
    prunedAt: string,
    reason: string,
  ): void {
    db.prepare(
      `DELETE FROM graph_edges
       WHERE graph_version_id IN (SELECT id FROM graph_versions WHERE workspace_id = ?)
         AND id NOT IN (SELECT edge_id FROM graph_edge_evidence)`,
    ).run(workspaceId);

    db.prepare(
      `DELETE FROM canonical_concepts
       WHERE workspace_id = ?
         AND id NOT IN (SELECT canonical_concept_id FROM canonical_members)`,
    ).run(workspaceId);

    const versions = db
      .prepare('SELECT id, validation_summary FROM graph_versions WHERE workspace_id = ?')
      .all(workspaceId) as Array<{ id: string; validation_summary: string | null }>;
    for (const version of versions) {
      const edgeCount = (
        db
          .prepare('SELECT COUNT(*) AS n FROM graph_edges WHERE graph_version_id = ?')
          .get(version.id) as { n: number }
      ).n;
      let summary: Record<string, unknown> = {};
      try {
        summary = version.validation_summary
          ? (JSON.parse(version.validation_summary) as Record<string, unknown>)
          : {};
      } catch {
        summary = {};
      }
      if (typeof summary.acceptedCount === 'number' && summary.acceptedCount !== edgeCount) {
        summary.pruned = { at: prunedAt, reason };
        summary.acceptedCount = edgeCount;
        db.prepare(
          'UPDATE graph_versions SET validation_summary = ?, updated_at = ? WHERE id = ?',
        ).run(JSON.stringify(summary), prunedAt, version.id);
      }
    }

    db.prepare('DELETE FROM remediation_plans WHERE workspace_id = ?').run(workspaceId);
  }

  const purgeDocumentTx = db.transaction(
    (materialId: string, workspaceId: string, at: string): DocumentDeletionOutcome => {
      const deleted =
        db.prepare('DELETE FROM materials WHERE id = ?').run(materialId).changes === 1;
      if (!deleted) return { deleted: false, workspaceDeleted: false };
      cleanupWorkspaceDerivedData(workspaceId, at, `文档已删除:${materialId}`);

      // Final-document rule, re-checked INSIDE the transaction so concurrent
      // imports cannot race it: a workspace auto-created for a 资料库 import
      // is an implementation detail of that import — when its last document
      // goes, the workspace (and its remaining workspace-scoped rows, via
      // verified FK cascades) is retired with it. Manually created and
      // legacy/unknown-origin workspaces are always preserved.
      const workspace = db
        .prepare('SELECT origin FROM workspaces WHERE id = ?')
        .get(workspaceId) as { origin: string } | undefined;
      const remaining = (
        db
          .prepare('SELECT COUNT(*) AS n FROM materials WHERE workspace_id = ?')
          .get(workspaceId) as {
          n: number;
        }
      ).n;
      if (workspace?.origin === 'material_import' && remaining === 0) {
        db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);
        return { deleted: true, workspaceDeleted: true };
      }

      db.prepare('UPDATE workspaces SET updated_at = ? WHERE id = ?').run(at, workspaceId);
      return { deleted: true, workspaceDeleted: false };
    },
  );

  return {
    insert(workspace: Workspace): void {
      WorkspaceSchema.parse(workspace);
      insertStmt.run({
        id: workspace.id,
        name: workspace.name,
        description: workspace.description,
        activeGraphVersionId: workspace.activeGraphVersionId,
        origin: workspace.origin,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      });
    },

    get(id: string): Workspace | undefined {
      const row = getStmt.get(id) as WorkspaceRow | undefined;
      return row ? rowToWorkspace(row) : undefined;
    },

    list(): WorkspaceSummary[] {
      const rows = db
        .prepare(
          `SELECT w.*,
             (SELECT COUNT(*) FROM materials m
                WHERE m.workspace_id = w.id AND m.availability = 'active') AS document_count,
             (SELECT COUNT(*) FROM concepts c JOIN materials m ON m.id = c.material_id
                 WHERE m.workspace_id = w.id
                   AND m.availability = 'active'
                   AND c.material_revision_id = m.active_revision_id) AS concept_count
           FROM workspaces w
           ORDER BY w.updated_at DESC, w.id DESC`,
        )
        .all() as Array<WorkspaceRow & { document_count: number; concept_count: number }>;
      return rows.map((row) => ({
        ...rowToWorkspace(row),
        documentCount: row.document_count,
        conceptCount: row.concept_count,
      }));
    },

    updateName(id: string, name: string, updatedAt: string): Workspace | undefined {
      const changes = db
        .prepare('UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?')
        .run(name, updatedAt, id).changes;
      if (changes === 0) return undefined;
      return this.get(id);
    },

    touch(id: string, updatedAt: string): void {
      db.prepare('UPDATE workspaces SET updated_at = ? WHERE id = ?').run(updatedAt, id);
    },

    /** Delete a workspace and every dependent row (FK cascade, transactional). */
    delete(id: string): boolean {
      const run = db.transaction(
        (workspaceId: string) =>
          db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId).changes === 1,
      );
      return run(id);
    },

    listDocumentSummaries(workspaceId: string): DocumentSummary[] {
      const rows = db
        .prepare(
          `SELECT m.id, m.workspace_id, m.title, m.source_type, m.media_type,
                  m.original_filename, m.char_count, m.parse_status, m.page_count,
                  m.extraction_warnings, m.parser_version, m.created_at, m.updated_at,
             (SELECT COUNT(*) FROM source_blocks b
                WHERE b.material_revision_id = m.active_revision_id) AS block_count,
             (SELECT COUNT(*) FROM concepts c
                WHERE c.material_revision_id = m.active_revision_id) AS concept_count
           FROM materials m
           WHERE m.workspace_id = ? AND m.availability = 'active'
           ORDER BY m.created_at ASC, m.id ASC`,
        )
        .all(workspaceId) as Array<{
        id: string;
        workspace_id: string;
        title: string;
        source_type: string;
        media_type: string | null;
        original_filename: string | null;
        char_count: number;
        parse_status: string;
        page_count: number | null;
        extraction_warnings: string;
        parser_version: string | null;
        created_at: string;
        updated_at: string;
        block_count: number;
        concept_count: number;
      }>;
      return rows.map((row) => ({
        id: row.id,
        workspaceId: row.workspace_id,
        title: row.title,
        sourceType: row.source_type as DocumentSummary['sourceType'],
        mediaType: row.media_type as DocumentSummary['mediaType'],
        originalFilename: row.original_filename,
        charCount: row.char_count,
        blockCount: row.block_count,
        conceptCount: row.concept_count,
        parseStatus: row.parse_status as DocumentSummary['parseStatus'],
        pageCount: row.page_count,
        extractionWarnings: JSON.parse(row.extraction_warnings) as string[],
        parserVersion: row.parser_version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    },

    /**
     * Internal destructive purge for migration and repository maintenance.
     * Product deletion routes retire Materials and never call this method.
     * Purge removes one document plus all dependent data in one transaction:
     * blocks/concepts/quizzes/mistakes/mastery via verified FK cascades,
     * graph edges via concept cascade, edge evidence via block cascade, then
     * the explicit derived-data cleanup documented above. If the deleted
     * document was the final one of a `material_import` workspace, the
     * workspace itself is retired in the same transaction (see
     * purgeDocumentTx) and the outcome reports it.
     */
    purgeDocument(materialId: string, workspaceId: string, at: string): DocumentDeletionOutcome {
      return purgeDocumentTx(materialId, workspaceId, at) as DocumentDeletionOutcome;
    },
  };
}

export type WorkspacesRepo = ReturnType<typeof createWorkspacesRepo>;
