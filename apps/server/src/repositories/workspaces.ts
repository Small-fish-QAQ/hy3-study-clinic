import {
  WorkspaceSchema,
  type DocumentSummary,
  type Material,
  type SourceBlock,
  type Workspace,
  type WorkspaceSummary,
} from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';

interface WorkspaceRow {
  id: string;
  name: string;
  description: string | null;
  active_graph_version_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return WorkspaceSchema.parse({
    id: row.id,
    name: row.name,
    description: row.description,
    activeGraphVersionId: row.active_graph_version_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function createWorkspacesRepo(db: SqliteDb) {
  const insertStmt = db.prepare(
    `INSERT INTO workspaces (id, name, description, active_graph_version_id, created_at, updated_at)
     VALUES (@id, @name, @description, @activeGraphVersionId, @createdAt, @updatedAt)`,
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

  const deleteDocumentTx = db.transaction((materialId: string, workspaceId: string, at: string) => {
    const deleted = db.prepare('DELETE FROM materials WHERE id = ?').run(materialId).changes === 1;
    if (!deleted) return false;
    cleanupWorkspaceDerivedData(workspaceId, at, `文档已删除:${materialId}`);
    db.prepare('UPDATE workspaces SET updated_at = ? WHERE id = ?').run(at, workspaceId);
    return true;
  });

  const reprocessDocumentTx = db.transaction(
    (material: Material, blocks: SourceBlock[], at: string) => {
      // Destructive by design (documented + confirmed in the UI): reprocessing
      // re-extracts text, so old blocks/concepts/questions no longer describe
      // the stored content. Learning artifacts tied to the OLD extraction are
      // removed explicitly; other documents' data is untouched.
      db.prepare('DELETE FROM source_blocks WHERE material_id = ?').run(material.id);
      db.prepare('DELETE FROM concepts WHERE material_id = ?').run(material.id);
      db.prepare('DELETE FROM quizzes WHERE material_id = ?').run(material.id);
      db.prepare('DELETE FROM mistakes WHERE material_id = ?').run(material.id);
      db.prepare('DELETE FROM mastery_states WHERE material_id = ?').run(material.id);

      db.prepare(
        `UPDATE materials SET content = @content, char_count = @charCount,
           parse_status = @parseStatus, page_count = @pageCount,
           extraction_warnings = @extractionWarnings, parser_version = @parserVersion,
           updated_at = @updatedAt
         WHERE id = @id`,
      ).run({
        id: material.id,
        content: material.content,
        charCount: material.charCount,
        parseStatus: material.parseStatus,
        pageCount: material.pageCount,
        extractionWarnings: JSON.stringify(material.extractionWarnings),
        parserVersion: material.parserVersion,
        updatedAt: material.updatedAt,
      });

      const insertBlock = db.prepare(
        `INSERT INTO source_blocks (id, material_id, idx, heading, heading_path, page_number, content, start_offset, end_offset)
         VALUES (@id, @materialId, @index, @heading, @headingPath, @pageNumber, @content, @startOffset, @endOffset)`,
      );
      for (const block of blocks) {
        insertBlock.run({
          id: block.id,
          materialId: block.materialId,
          index: block.index,
          heading: block.heading,
          headingPath: JSON.stringify(block.headingPath),
          pageNumber: block.pageNumber,
          content: block.content,
          startOffset: block.startOffset,
          endOffset: block.endOffset,
        });
      }

      cleanupWorkspaceDerivedData(material.workspaceId, at, `文档已重新解析:${material.id}`);
      db.prepare('UPDATE workspaces SET updated_at = ? WHERE id = ?').run(at, material.workspaceId);
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
             (SELECT COUNT(*) FROM materials m WHERE m.workspace_id = w.id) AS document_count,
             (SELECT COUNT(*) FROM concepts c JOIN materials m ON m.id = c.material_id
                WHERE m.workspace_id = w.id) AS concept_count
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
             (SELECT COUNT(*) FROM source_blocks b WHERE b.material_id = m.id) AS block_count,
             (SELECT COUNT(*) FROM concepts c WHERE c.material_id = m.id) AS concept_count
           FROM materials m
           WHERE m.workspace_id = ?
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
     * Delete one document plus all dependent data in a single transaction:
     * blocks/concepts/quizzes/mistakes/mastery via verified FK cascades,
     * graph edges via concept cascade, edge evidence via block cascade, then
     * the explicit derived-data cleanup documented above.
     */
    deleteDocument(materialId: string, workspaceId: string, at: string): boolean {
      return deleteDocumentTx(materialId, workspaceId, at) as boolean;
    },

    /** Replace a document's extracted content and blocks (see transaction doc). */
    reprocessDocument(material: Material, blocks: SourceBlock[], at: string): void {
      reprocessDocumentTx(material, blocks, at);
    },
  };
}

export type WorkspacesRepo = ReturnType<typeof createWorkspacesRepo>;
