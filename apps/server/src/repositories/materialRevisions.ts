import {
  NormalizedStructuralUnitSchema,
  type Material,
  type NormalizedStructuralUnit,
  type SourceBlock,
} from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';
import { newId } from '../util/ids.js';

export type MaterialRevisionStatus = 'candidate' | 'ready' | 'active' | 'failed' | 'retired';

export interface MaterialRevisionRecord {
  id: string;
  materialId: string;
  revisionNumber: number;
  predecessorRevisionId: string | null;
  status: MaterialRevisionStatus;
  sourceType: Material['sourceType'];
  mediaType: Material['mediaType'];
  originalFilename: string | null;
  content: string;
  charCount: number;
  parseStatus: Material['parseStatus'] | null;
  pageCount: number | null;
  extractionWarnings: string[];
  parserVersion: string | null;
  parserFingerprint: string | null;
  contentFingerprint: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: string;
  activatedAt: string | null;
}

interface RevisionRow {
  id: string;
  material_id: string;
  revision_number: number;
  predecessor_revision_id: string | null;
  status: MaterialRevisionStatus;
  source_type: Material['sourceType'];
  media_type: Material['mediaType'];
  original_filename: string | null;
  content: string;
  char_count: number;
  parse_status: Material['parseStatus'] | null;
  page_count: number | null;
  extraction_warnings: string;
  parser_version: string | null;
  parser_fingerprint: string | null;
  content_fingerprint: string | null;
  failure_code: string | null;
  failure_message: string | null;
  created_at: string;
  activated_at: string | null;
}

interface StructuralUnitRow {
  id: string;
  material_revision_id: string;
  parent_id: string | null;
  unit_type: NormalizedStructuralUnit['kind'];
  idx: number;
  title: string | null;
  start_offset: number | null;
  end_offset: number | null;
  page_number: number | null;
  metadata: string;
  revision_content: string;
}

function hydrate(row: RevisionRow): MaterialRevisionRecord {
  return {
    id: row.id,
    materialId: row.material_id,
    revisionNumber: row.revision_number,
    predecessorRevisionId: row.predecessor_revision_id,
    status: row.status,
    sourceType: row.source_type,
    mediaType: row.media_type,
    originalFilename: row.original_filename,
    content: row.content,
    charCount: row.char_count,
    parseStatus: row.parse_status,
    pageCount: row.page_count,
    extractionWarnings: JSON.parse(row.extraction_warnings) as string[],
    parserVersion: row.parser_version,
    parserFingerprint: row.parser_fingerprint,
    contentFingerprint: row.content_fingerprint,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
  };
}

export interface StageMaterialRevisionInput {
  revisionId: string;
  material: Material;
  blocks: SourceBlock[];
  originalData: Buffer | null;
  parserFingerprint: string | null;
  contentFingerprint: string | null;
  parserAttemptId: string;
  createdAt: string;
}

export function createMaterialRevisionsRepo(db: SqliteDb) {
  const stage = db.transaction((input: StageMaterialRevisionInput): MaterialRevisionRecord => {
    const active = db
      .prepare('SELECT active_revision_id FROM materials WHERE id = ?')
      .get(input.material.id) as { active_revision_id: string | null } | undefined;
    if (!active) throw new Error(`Unknown material: ${input.material.id}`);

    const nextNumber = (
      db
        .prepare(
          'SELECT COALESCE(MAX(revision_number), 0) + 1 AS n FROM material_revisions WHERE material_id = ?',
        )
        .get(input.material.id) as { n: number }
    ).n;

    db.prepare(
      `INSERT INTO material_revisions (
         id, material_id, revision_number, predecessor_revision_id, status,
         source_type, media_type, original_filename, content, char_count,
         parse_status, page_count, extraction_warnings, parser_version,
         parser_fingerprint, content_fingerprint, original_data, failure_code,
         failure_message, created_at, activated_at
       ) VALUES (
         @id, @materialId, @revisionNumber, @predecessorRevisionId, 'candidate',
         @sourceType, @mediaType, @originalFilename, @content, @charCount,
         @parseStatus, @pageCount, @extractionWarnings, @parserVersion,
         @parserFingerprint, @contentFingerprint, @originalData, NULL, NULL,
         @createdAt, NULL
       )`,
    ).run({
      id: input.revisionId,
      materialId: input.material.id,
      revisionNumber: nextNumber,
      predecessorRevisionId: active.active_revision_id,
      sourceType: input.material.sourceType,
      mediaType: input.material.mediaType,
      originalFilename: input.material.originalFilename,
      content: input.material.content,
      charCount: input.material.charCount,
      parseStatus: input.material.parseStatus,
      pageCount: input.material.pageCount,
      extractionWarnings: JSON.stringify(input.material.extractionWarnings),
      parserVersion: input.material.parserVersion,
      parserFingerprint: input.parserFingerprint,
      contentFingerprint: input.contentFingerprint,
      originalData: input.originalData,
      createdAt: input.createdAt,
    });

    const insertBlock = db.prepare(
      `INSERT INTO source_blocks (
         id, material_id, material_revision_id, idx, heading, heading_path,
         page_number, page_end, content, start_offset, end_offset
       ) VALUES (
         @id, @materialId, @materialRevisionId, @index, @heading, @headingPath,
         @pageNumber, @pageEnd, @content, @startOffset, @endOffset
       )`,
    );
    for (const block of input.blocks) {
      insertBlock.run({
        id: block.id,
        materialId: block.materialId,
        materialRevisionId: input.revisionId,
        index: block.index,
        heading: block.heading,
        headingPath: JSON.stringify(block.headingPath),
        pageNumber: block.pageNumber,
        pageEnd: block.pageEnd,
        content: block.content,
        startOffset: block.startOffset,
        endOffset: block.endOffset,
      });
    }

    db.prepare(
      `INSERT INTO material_parser_attempts (
         id, material_id, revision_id, status, parser_version,
         parser_fingerprint, started_at, finished_at
       ) VALUES (?, ?, ?, 'succeeded', ?, ?, ?, ?)`,
    ).run(
      input.parserAttemptId,
      input.material.id,
      input.revisionId,
      input.material.parserVersion,
      input.parserFingerprint,
      input.createdAt,
      input.createdAt,
    );
    db.prepare(`UPDATE material_revisions SET status = 'ready' WHERE id = ?`).run(input.revisionId);
    return hydrate(
      db
        .prepare('SELECT * FROM material_revisions WHERE id = ?')
        .get(input.revisionId) as RevisionRow,
    );
  });

  const activate = db.transaction(
    (materialId: string, revisionId: string, at: string): MaterialRevisionRecord => {
      const material = db
        .prepare('SELECT workspace_id, active_revision_id FROM materials WHERE id = ?')
        .get(materialId) as { workspace_id: string; active_revision_id: string | null } | undefined;
      if (!material) throw new Error(`Unknown material: ${materialId}`);
      if (material.active_revision_id === revisionId) {
        return hydrate(
          db
            .prepare('SELECT * FROM material_revisions WHERE id = ?')
            .get(revisionId) as RevisionRow,
        );
      }
      const revision = db
        .prepare(
          `SELECT * FROM material_revisions
           WHERE id = ? AND material_id = ? AND status = 'ready'`,
        )
        .get(revisionId, materialId) as RevisionRow | undefined;
      if (!revision) throw new Error(`Revision is not ready for activation: ${revisionId}`);

      if (material.active_revision_id) {
        db.prepare(
          `UPDATE material_revisions SET status = 'retired'
           WHERE id = ? AND status = 'active'`,
        ).run(material.active_revision_id);
      }
      const revisionBytes = db
        .prepare('SELECT original_data FROM material_revisions WHERE id = ?')
        .get(revisionId) as { original_data: Buffer | null };
      db.prepare(
        `UPDATE material_revisions SET status = 'active', activated_at = ? WHERE id = ?`,
      ).run(at, revisionId);
      db.prepare(
        `UPDATE materials SET
           active_revision_id = @revisionId,
           content = @content,
           char_count = @charCount,
           parse_status = @parseStatus,
           page_count = @pageCount,
           extraction_warnings = @extractionWarnings,
           parser_version = @parserVersion,
           original_data = @originalData,
           availability = 'active',
           retired_at = NULL,
           updated_at = @at
         WHERE id = @materialId`,
      ).run({
        revisionId,
        content: revision.content,
        charCount: revision.char_count,
        parseStatus: revision.parse_status,
        pageCount: revision.page_count,
        extractionWarnings: revision.extraction_warnings,
        parserVersion: revision.parser_version,
        originalData: revisionBytes.original_data,
        at,
        materialId,
      });

      // Active graph/remediation pointers may describe old source entities.
      // Clear only current pointers; every historical row remains intact.
      db.prepare(
        'UPDATE workspaces SET active_graph_version_id = NULL, updated_at = ? WHERE id = ?',
      ).run(at, material.workspace_id);
      const staleRecords = db
        .prepare(
          `SELECT id FROM truth_authority_records
           WHERE material_id = ? AND validation_state = 'validated'
             AND (material_revision_id IS NULL OR material_revision_id <> ?)`,
        )
        .all(materialId, revisionId) as Array<{ id: string }>;
      for (const record of staleRecords) {
        db.prepare(
          `UPDATE truth_authority_records
           SET validation_state = 'stale', updated_at = ? WHERE id = ?`,
        ).run(at, record.id);
        const seq = (
          db
            .prepare(
              'SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM truth_authority_events WHERE authority_record_id = ?',
            )
            .get(record.id) as { n: number }
        ).n;
        db.prepare(
          `INSERT INTO truth_authority_events
             (id, authority_record_id, seq, event_type, actor, payload, created_at)
           VALUES (?, ?, ?, 'revision_stale', 'system', ?, ?)`,
        ).run(newId('tae'), record.id, seq, JSON.stringify({ activeRevisionId: revisionId }), at);
      }

      return hydrate(
        db.prepare('SELECT * FROM material_revisions WHERE id = ?').get(revisionId) as RevisionRow,
      );
    },
  );

  const retireMaterial = db.transaction((materialId: string, at: string): boolean => {
    const material = db
      .prepare("SELECT workspace_id FROM materials WHERE id = ? AND availability = 'active'")
      .get(materialId) as { workspace_id: string } | undefined;
    if (!material) return false;
    db.prepare(
      `UPDATE materials SET availability = 'retired', retired_at = ?, updated_at = ?
       WHERE id = ? AND availability = 'active'`,
    ).run(at, at, materialId);
    db.prepare(
      'UPDATE workspaces SET active_graph_version_id = NULL, updated_at = ? WHERE id = ?',
    ).run(at, material.workspace_id);
    db.prepare(
      `UPDATE course_execution_state
       SET route_validation_status = 'revalidation_required', version = version + 1, updated_at = ?
       WHERE workspace_id = ? AND active_contract_id IS NOT NULL`,
    ).run(at, material.workspace_id);

    const authorityIds = db
      .prepare(
        `SELECT id FROM truth_authority_records
         WHERE material_id = ? AND validation_state = 'validated'`,
      )
      .all(materialId) as Array<{ id: string }>;
    for (const record of authorityIds) {
      db.prepare(
        `UPDATE truth_authority_records
         SET validation_state = 'stale', updated_at = ? WHERE id = ?`,
      ).run(at, record.id);
      const seq = (
        db
          .prepare(
            'SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM truth_authority_events WHERE authority_record_id = ?',
          )
          .get(record.id) as { n: number }
      ).n;
      db.prepare(
        `INSERT INTO truth_authority_events
           (id, authority_record_id, seq, event_type, actor, payload, created_at)
         VALUES (?, ?, ?, 'material_retired', 'system', ?, ?)`,
      ).run(newId('tae'), record.id, seq, JSON.stringify({ materialId }), at);
    }
    return true;
  });

  return {
    get(id: string): MaterialRevisionRecord | undefined {
      const row = db.prepare('SELECT * FROM material_revisions WHERE id = ?').get(id) as
        RevisionRow | undefined;
      return row ? hydrate(row) : undefined;
    },

    getActive(materialId: string): MaterialRevisionRecord | undefined {
      const row = db
        .prepare(
          `SELECT r.* FROM material_revisions r
           JOIN materials m ON m.active_revision_id = r.id
           WHERE m.id = ?`,
        )
        .get(materialId) as RevisionRow | undefined;
      return row ? hydrate(row) : undefined;
    },

    list(materialId: string): MaterialRevisionRecord[] {
      return (
        db
          .prepare(
            `SELECT * FROM material_revisions WHERE material_id = ?
             ORDER BY revision_number DESC`,
          )
          .all(materialId) as RevisionRow[]
      ).map(hydrate);
    },

    getOriginalData(revisionId: string): Buffer | null {
      const row = db
        .prepare('SELECT original_data FROM material_revisions WHERE id = ?')
        .get(revisionId) as { original_data: Buffer | null } | undefined;
      return row?.original_data ?? null;
    },

    getStructuralUnits(revisionId: string): NormalizedStructuralUnit[] {
      const rows = db
        .prepare(
          `SELECT u.*, r.content AS revision_content
           FROM normalized_structural_units u
           JOIN material_revisions r ON r.id = u.material_revision_id
           WHERE u.material_revision_id = ?
           ORDER BY u.idx ASC, u.id ASC`,
        )
        .all(revisionId) as StructuralUnitRow[];
      return rows.map((row) => {
        const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
        const hasOffsets =
          row.start_offset !== null &&
          row.end_offset !== null &&
          row.start_offset >= 0 &&
          row.end_offset >= row.start_offset &&
          row.end_offset <= row.revision_content.length;
        const storedContent = typeof metadata.content === 'string' ? metadata.content : '';
        const sourceLocator =
          typeof metadata.sourceLocator === 'string' && metadata.sourceLocator.length > 0
            ? metadata.sourceLocator
            : row.page_number !== null
              ? `page:${row.page_number}`
              : hasOffsets
                ? `offsets:${row.start_offset}-${row.end_offset}`
                : null;
        const derivation =
          metadata.derivation === 'source_text' ||
          metadata.derivation === 'parser_derived' ||
          metadata.derivation === 'ocr_derived'
            ? metadata.derivation
            : 'parser_derived';
        const confidence =
          typeof metadata.confidence === 'number' &&
          metadata.confidence >= 0 &&
          metadata.confidence <= 1
            ? metadata.confidence
            : null;
        return NormalizedStructuralUnitSchema.parse({
          id: row.id,
          materialRevisionId: row.material_revision_id,
          parentUnitId: row.parent_id,
          kind: row.unit_type,
          index: row.idx,
          title: row.title,
          content: hasOffsets
            ? row.revision_content.slice(row.start_offset!, row.end_offset!)
            : storedContent,
          sourceLocator,
          derivation,
          confidence,
        });
      });
    },

    stage(input: StageMaterialRevisionInput): MaterialRevisionRecord {
      return stage(input);
    },

    activate(materialId: string, revisionId: string, at: string): MaterialRevisionRecord {
      return activate(materialId, revisionId, at);
    },

    recordFailedAttempt(input: {
      id: string;
      materialId: string;
      parserVersion: string | null;
      parserFingerprint: string | null;
      errorCode: string | null;
      errorMessage: string;
      startedAt: string;
      finishedAt: string;
    }): void {
      db.prepare(
        `INSERT INTO material_parser_attempts (
           id, material_id, revision_id, status, parser_version,
           parser_fingerprint, error_code, error_message, started_at, finished_at
         ) VALUES (
           @id, @materialId, NULL, 'failed', @parserVersion,
           @parserFingerprint, @errorCode, @errorMessage, @startedAt, @finishedAt
         )`,
      ).run(input);
    },

    retire(materialId: string, at: string): boolean {
      return retireMaterial(materialId, at);
    },
  };
}

export type MaterialRevisionsRepo = ReturnType<typeof createMaterialRevisionsRepo>;
