import {
  fnv1a32,
  NormalizedStructuralUnitSchema,
  type Material,
  type EmbeddedAsset,
  EmbeddedAssetSchema,
  type NormalizedDocumentUnit,
  type NormalizedStructuralUnit,
  type SourceBlock,
  WebSnapshotMetadataSchema,
  type WebSnapshotMetadata,
} from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';
import { assertEmbeddedAssetBytes } from './embeddedAssets.js';
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
  chunkerVersion: string | null;
  chunkerFingerprint: string | null;
  sourceFingerprint: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: string;
  activatedAt: string | null;
  webSnapshot: WebSnapshotMetadata | null;
}

export interface EmbeddedAssetInput extends EmbeddedAsset {
  bytes: Buffer;
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
  chunker_version: string | null;
  chunker_fingerprint: string | null;
  source_fingerprint: string | null;
  failure_code: string | null;
  failure_message: string | null;
  created_at: string;
  activated_at: string | null;
  web_snapshot: string | null;
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
  line_start: number | null;
  line_end: number | null;
  page_end: number | null;
  slide_number: number | null;
  heading_path: string | null;
  content_origin: string | null;
  chunker_version: string | null;
}

interface AssetRow {
  id: string;
  material_id: string;
  material_revision_id: string;
  idx: number;
  parent_structural_unit_id: string | null;
  source_path: string;
  media_type: string;
  byte_hash: string;
  byte_length: number;
  width: number | null;
  height: number | null;
  location: string;
  relationship_kind: EmbeddedAsset['relationshipKind'];
  content_origin: 'extracted_original';
  parser_version: string;
}

function hydrateAsset(row: AssetRow): EmbeddedAsset {
  return EmbeddedAssetSchema.parse({
    id: row.id,
    materialId: row.material_id,
    materialRevisionId: row.material_revision_id,
    index: row.idx,
    parentStructuralUnitId: row.parent_structural_unit_id,
    sourcePath: row.source_path,
    mediaType: row.media_type,
    byteHash: row.byte_hash,
    byteLength: row.byte_length,
    width: row.width,
    height: row.height,
    location: JSON.parse(row.location),
    relationshipKind: row.relationship_kind,
    contentOrigin: row.content_origin,
    parserVersion: row.parser_version,
  });
}

function orderNormalizedUnits(units: NormalizedDocumentUnit[]): NormalizedDocumentUnit[] {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  if (byId.size !== units.length) throw new Error('Duplicate normalized unit id');
  const depthMemo = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const cached = depthMemo.get(id);
    if (cached !== undefined) return cached;
    const unit = byId.get(id);
    if (!unit) throw new Error(`Normalized unit parent is unknown: ${id}`);
    if (visiting.has(id)) throw new Error(`Normalized unit parent cycle: ${id}`);
    visiting.add(id);
    const depth = unit.parentUnitId ? depthOf(unit.parentUnitId) + 1 : 0;
    visiting.delete(id);
    depthMemo.set(id, depth);
    return depth;
  };
  return [...units].sort(
    (a, b) => depthOf(a.id) - depthOf(b.id) || a.index - b.index || a.id.localeCompare(b.id),
  );
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
    chunkerVersion: row.chunker_version,
    chunkerFingerprint: row.chunker_fingerprint,
    sourceFingerprint: row.source_fingerprint,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    webSnapshot: row.web_snapshot
      ? WebSnapshotMetadataSchema.parse(JSON.parse(row.web_snapshot))
      : null,
  };
}

export interface StageMaterialRevisionInput {
  revisionId: string;
  material: Material;
  blocks: SourceBlock[];
  originalData: Buffer | null;
  parserFingerprint: string | null;
  contentFingerprint: string | null;
  chunkerVersion?: string | null;
  chunkerFingerprint?: string | null;
  sourceFingerprint?: string | null;
  normalizedUnits?: NormalizedDocumentUnit[];
  embeddedAssets?: EmbeddedAssetInput[];
  parserAttemptId: string;
  createdAt: string;
  expectedActiveRevisionId?: string | null;
  webSnapshot?: WebSnapshotMetadata | null;
}

export function createMaterialRevisionsRepo(db: SqliteDb) {
  const hasWebSnapshot = (
    db.pragma('table_info(material_revisions)') as Array<{ name: string }>
  ).some((column) => column.name === 'web_snapshot');
  const stage = db.transaction((input: StageMaterialRevisionInput): MaterialRevisionRecord => {
    const active = db
      .prepare('SELECT active_revision_id FROM materials WHERE id = ?')
      .get(input.material.id) as { active_revision_id: string | null } | undefined;
    if (!active) throw new Error(`Unknown material: ${input.material.id}`);
    if (
      input.expectedActiveRevisionId !== undefined &&
      active.active_revision_id !== input.expectedActiveRevisionId
    ) {
      throw new Error('STALE_REPROCESS_ACTIVATION');
    }

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
          parser_fingerprint, content_fingerprint, chunker_version, chunker_fingerprint,
         source_fingerprint, original_data, failure_code,
         failure_message, created_at, activated_at${hasWebSnapshot ? ', web_snapshot' : ''}
       ) VALUES (
         @id, @materialId, @revisionNumber, @predecessorRevisionId, 'candidate',
         @sourceType, @mediaType, @originalFilename, @content, @charCount,
         @parseStatus, @pageCount, @extractionWarnings, @parserVersion,
          @parserFingerprint, @contentFingerprint, @chunkerVersion, @chunkerFingerprint,
         @sourceFingerprint, @originalData, NULL, NULL,
         @createdAt, NULL${hasWebSnapshot ? ', @webSnapshot' : ''}
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
      chunkerVersion: input.chunkerVersion ?? null,
      chunkerFingerprint: input.chunkerFingerprint ?? null,
      sourceFingerprint: input.sourceFingerprint ?? null,
      originalData: input.originalData,
      createdAt: input.createdAt,
      ...(hasWebSnapshot
        ? { webSnapshot: input.webSnapshot ? JSON.stringify(input.webSnapshot) : null }
        : {}),
    });

    const insertUnit = db.prepare(
      `INSERT INTO normalized_structural_units (
         id, material_revision_id, parent_id, unit_type, idx, title,
         start_offset, end_offset, page_number, metadata, line_start, line_end,
         page_end, slide_number, heading_path, content_origin, chunker_version
       ) VALUES (
         @id, @materialRevisionId, @parentId, @kind, @index, @title,
         @startOffset, @endOffset, @pageNumber, @metadata, @lineStart, @lineEnd,
         @pageEnd, @slideNumber, @headingPath, @contentOrigin, @chunkerVersion
       )`,
    );
    const insertBlock = db.prepare(
      `INSERT INTO source_blocks (
         id, material_id, material_revision_id, idx, heading, heading_path,
         page_number, page_end, slide_number, content, start_offset, end_offset,
         structural_unit_id, chunker_version, content_origin
       ) VALUES (
         @id, @materialId, @materialRevisionId, @index, @heading, @headingPath,
         @pageNumber, @pageEnd, @slideNumber, @content, @startOffset, @endOffset,
         @structuralUnitId, @chunkerVersion, @contentOrigin
       )`,
    );
    const unitIdMap = new Map<string, string>();
    for (const unit of input.normalizedUnits ?? []) {
      if (unit.materialRevisionId !== input.revisionId) {
        throw new Error(`Normalized unit belongs to a foreign revision: ${unit.id}`);
      }
      if (unitIdMap.has(unit.id)) throw new Error(`Duplicate normalized unit: ${unit.id}`);
      const persistedId = `unit_${fnv1a32(`${input.revisionId}:${unit.id}`).toString(16).padStart(8, '0')}`;
      unitIdMap.set(unit.id, persistedId);
    }
    for (const unit of orderNormalizedUnits(input.normalizedUnits ?? [])) {
      const persistedId = unitIdMap.get(unit.id)!;
      const metadata = {
        content: unit.content,
        sourceLocator: unit.location.domPath ?? null,
        derivation: unit.derivation,
        confidence: null,
        headingPath: unit.headingPath,
      };
      insertUnit.run({
        id: persistedId,
        materialRevisionId: input.revisionId,
        parentId: unit.parentUnitId ? (unitIdMap.get(unit.parentUnitId) ?? null) : null,
        kind: unit.kind,
        index: unit.index,
        title: unit.title,
        startOffset: unit.startOffset,
        endOffset: unit.endOffset,
        pageNumber: unit.location.pageNumber ?? null,
        metadata: JSON.stringify(metadata),
        lineStart: unit.location.lineStart ?? null,
        lineEnd: unit.location.lineEnd ?? null,
        pageEnd: unit.location.pageEnd ?? null,
        slideNumber: unit.location.slideNumber ?? null,
        headingPath: JSON.stringify(unit.headingPath),
        contentOrigin: unit.contentOrigin,
        chunkerVersion: input.chunkerVersion ?? null,
      });
    }
    for (const block of input.blocks) {
      if (block.materialId !== input.material.id)
        throw new Error(`SourceBlock belongs to a foreign material: ${block.id}`);
      if (
        (input.normalizedUnits?.length ?? 0) > 0 &&
        block.structuralUnitId &&
        !unitIdMap.has(block.structuralUnitId)
      ) {
        throw new Error(`SourceBlock structural unit is unknown: ${block.structuralUnitId}`);
      }
      insertBlock.run({
        id: block.id,
        materialId: block.materialId,
        materialRevisionId: input.revisionId,
        index: block.index,
        heading: block.heading,
        headingPath: JSON.stringify(block.headingPath),
        pageNumber: block.pageNumber,
        pageEnd: block.pageEnd,
        slideNumber: block.slideNumber ?? null,
        content: block.content,
        startOffset: block.startOffset,
        endOffset: block.endOffset,
        structuralUnitId: block.structuralUnitId
          ? (unitIdMap.get(block.structuralUnitId) ?? null)
          : null,
        chunkerVersion: block.chunkerVersion ?? input.chunkerVersion ?? null,
        contentOrigin: block.contentOrigin ?? 'extracted_original',
      });
    }

    const insertBlob = db.prepare(
      `INSERT OR IGNORE INTO source_asset_blobs
         (byte_hash, media_type, byte_length, original_data)
       VALUES (@byteHash, @mediaType, @byteLength, @bytes)`,
    );
    const insertAsset = db.prepare(
      `INSERT INTO material_revision_assets (
         id, material_id, material_revision_id, idx, parent_structural_unit_id,
         source_path, media_type, byte_hash, byte_length, width, height,
         location, relationship_kind, content_origin, parser_version, created_at
       ) VALUES (
         @id, @materialId, @materialRevisionId, @index, @parentStructuralUnitId,
         @sourcePath, @mediaType, @byteHash, @byteLength, @width, @height,
         @location, @relationshipKind, 'extracted_original', @parserVersion, @createdAt
       )`,
    );
    for (const asset of input.embeddedAssets ?? []) {
      const { bytes: _bytes, ...metadata } = asset;
      EmbeddedAssetSchema.parse(metadata);
      if (asset.materialId !== input.material.id || asset.materialRevisionId !== input.revisionId) {
        throw new Error(`Embedded asset ownership mismatch: ${asset.id}`);
      }
      if (asset.parentStructuralUnitId && !unitIdMap.has(asset.parentStructuralUnitId)) {
        throw new Error(`Embedded asset structural unit is unknown: ${asset.id}`);
      }
      assertEmbeddedAssetBytes(asset);
      insertBlob.run({
        byteHash: asset.byteHash,
        mediaType: asset.mediaType,
        byteLength: asset.byteLength,
        bytes: asset.bytes,
      });
      const existing = db
        .prepare('SELECT original_data FROM source_asset_blobs WHERE byte_hash = ?')
        .get(asset.byteHash) as { original_data: Buffer } | undefined;
      if (!existing || !existing.original_data.equals(asset.bytes)) {
        throw new Error(`Embedded asset hash collision: ${asset.id}`);
      }
      insertAsset.run({
        id: `asset_${fnv1a32(`${input.revisionId}:${asset.id}`).toString(16).padStart(8, '0')}`,
        materialId: input.material.id,
        materialRevisionId: input.revisionId,
        index: asset.index,
        parentStructuralUnitId: asset.parentStructuralUnitId
          ? (unitIdMap.get(asset.parentStructuralUnitId) ?? null)
          : null,
        sourcePath: asset.sourcePath,
        mediaType: asset.mediaType,
        byteHash: asset.byteHash,
        byteLength: asset.byteLength,
        width: asset.width,
        height: asset.height,
        location: JSON.stringify(asset.location),
        relationshipKind: asset.relationshipKind,
        parserVersion: asset.parserVersion,
        createdAt: input.createdAt,
      });
    }

    db.prepare(
      `INSERT INTO material_parser_attempts (
         id, material_id, revision_id, status, parser_version,
         parser_fingerprint, chunker_version, chunker_fingerprint, started_at, finished_at
       ) VALUES (?, ?, ?, 'succeeded', ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.parserAttemptId,
      input.material.id,
      input.revisionId,
      input.material.parserVersion,
      input.parserFingerprint,
      input.chunkerVersion ?? null,
      input.chunkerFingerprint ?? null,
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
    (
      materialId: string,
      revisionId: string,
      at: string,
      expectedActiveRevisionId?: string | null,
    ): MaterialRevisionRecord => {
      const material = db
        .prepare('SELECT workspace_id, active_revision_id FROM materials WHERE id = ?')
        .get(materialId) as { workspace_id: string; active_revision_id: string | null } | undefined;
      if (!material) throw new Error(`Unknown material: ${materialId}`);
      if (
        expectedActiveRevisionId !== undefined &&
        material.active_revision_id !== expectedActiveRevisionId
      ) {
        throw new Error('STALE_REPROCESS_ACTIVATION');
      }
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

    getAssets(revisionId: string): EmbeddedAsset[] {
      const rows = db
        .prepare(
          `SELECT * FROM material_revision_assets
           WHERE material_revision_id = ? ORDER BY idx ASC`,
        )
        .all(revisionId) as AssetRow[];
      return rows.map(hydrateAsset);
    },

    getAssetBytes(assetId: string): Buffer | undefined {
      const row = db
        .prepare(
          `SELECT b.original_data FROM source_asset_blobs b
           JOIN material_revision_assets a ON a.byte_hash = b.byte_hash
           WHERE a.id = ?`,
        )
        .get(assetId) as { original_data: Buffer } | undefined;
      return row?.original_data;
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
              : row.slide_number !== null
                ? `slide:${row.slide_number}`
                : hasOffsets
                  ? `offsets:${row.start_offset}-${row.end_offset}`
                  : null;
        const derivationValues = new Set([
          'source_text',
          'parser_derived',
          'ocr_derived',
          'extracted_original',
          'derived_ocr',
          'derived_visual_description',
          'derived_layout_label',
          'derived_summary',
        ]);
        const derivation =
          typeof metadata.derivation === 'string' && derivationValues.has(metadata.derivation)
            ? metadata.derivation
            : 'parser_derived';
        const confidence =
          typeof metadata.confidence === 'number' &&
          metadata.confidence >= 0 &&
          metadata.confidence <= 1
            ? metadata.confidence
            : null;
        const parsed = {
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
          ...(row.line_start !== null ? { lineStart: row.line_start } : {}),
          ...(row.line_end !== null ? { lineEnd: row.line_end } : {}),
          ...(row.page_end !== null ? { pageEnd: row.page_end } : {}),
          ...(row.slide_number !== null ? { slideNumber: row.slide_number } : {}),
          ...(row.heading_path && JSON.parse(row.heading_path).length > 0
            ? { headingPath: JSON.parse(row.heading_path) as string[] }
            : {}),
          ...(row.content_origin ? { contentOrigin: row.content_origin } : {}),
        };
        return NormalizedStructuralUnitSchema.parse(parsed);
      });
    },

    stage(input: StageMaterialRevisionInput): MaterialRevisionRecord {
      return stage(input);
    },

    activate(
      materialId: string,
      revisionId: string,
      at: string,
      expectedActiveRevisionId?: string | null,
    ): MaterialRevisionRecord {
      return activate(materialId, revisionId, at, expectedActiveRevisionId);
    },

    recordFailedAttempt(input: {
      id: string;
      materialId: string;
      parserVersion: string | null;
      parserFingerprint: string | null;
      chunkerVersion?: string | null;
      chunkerFingerprint?: string | null;
      errorCode: string | null;
      errorMessage: string;
      startedAt: string;
      finishedAt: string;
    }): void {
      db.prepare(
        `INSERT INTO material_parser_attempts (
           id, material_id, revision_id, status, parser_version,
           parser_fingerprint, chunker_version, chunker_fingerprint,
           error_code, error_message, started_at, finished_at
         ) VALUES (
           @id, @materialId, NULL, 'failed', @parserVersion,
           @parserFingerprint, @chunkerVersion, @chunkerFingerprint,
           @errorCode, @errorMessage, @startedAt, @finishedAt
         )`,
      ).run({
        ...input,
        chunkerVersion: input.chunkerVersion ?? null,
        chunkerFingerprint: input.chunkerFingerprint ?? null,
      });
    },

    retire(materialId: string, at: string): boolean {
      return retireMaterial(materialId, at);
    },
  };
}

export type MaterialRevisionsRepo = ReturnType<typeof createMaterialRevisionsRepo>;
