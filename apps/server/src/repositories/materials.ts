import {
  ConceptSchema,
  EmbeddedAssetSchema,
  fnv1a32,
  MaterialSchema,
  SourceBlockSchema,
  type Concept,
  type EmbeddedAsset,
  type Material,
  type NormalizedDocumentUnit,
  type SourceBlock,
} from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';
import { newId } from '../util/ids.js';
import { assertEmbeddedAssetBytes } from './embeddedAssets.js';

export interface MaterialSummary {
  id: string;
  workspaceId: string;
  title: string;
  sourceType: string;
  charCount: number;
  blockCount: number;
  createdAt: string;
  /** Origin of the owning workspace — decides the deletion lifecycle. */
  workspaceOrigin: 'manual' | 'material_import' | 'unknown';
  /** Documents currently in the owning workspace (including this one). */
  workspaceDocumentCount: number;
}

/**
 * Small immutable/current identity used by route validation. Source content,
 * parser diagnostics, and original bytes are deliberately excluded.
 */
export interface MaterialRouteIdentity {
  id: string;
  workspaceId: string;
  activeRevisionId: string | null;
  availability: 'active' | 'retired';
  title: string;
  sourceType: string;
}

interface MaterialRow {
  id: string;
  workspace_id: string;
  active_revision_id: string | null;
  availability: 'active' | 'retired';
  retired_at: string | null;
  title: string;
  source_type: string;
  media_type: string | null;
  original_filename: string | null;
  content: string;
  char_count: number;
  parse_status: string;
  page_count: number | null;
  extraction_warnings: string;
  parser_version: string | null;
  created_at: string;
  updated_at: string;
}

interface MaterialRouteRow {
  id: string;
  workspace_id: string;
  active_revision_id: string | null;
  availability: 'active' | 'retired';
  title: string;
  source_type: string;
}

interface BlockRow {
  id: string;
  material_id: string;
  idx: number;
  heading: string | null;
  heading_path: string;
  page_number: number | null;
  page_end: number | null;
  slide_number: number | null;
  content: string;
  start_offset: number;
  end_offset: number;
  material_revision_id: string | null;
  structural_unit_id: string | null;
  chunker_version: string | null;
  content_origin: string | null;
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

export interface EmbeddedAssetInput extends EmbeddedAsset {
  bytes: Buffer;
}

interface ConceptRow {
  id: string;
  material_id: string;
  name: string;
  summary: string;
  importance: string;
  grounding: string;
  created_at: string;
  material_revision_id: string | null;
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

const MATERIAL_COLUMNS = `id, workspace_id, active_revision_id, availability, retired_at,
  title, source_type, media_type, original_filename,
  content, char_count, parse_status, page_count, extraction_warnings, parser_version,
  created_at, updated_at`;

const MATERIAL_ROUTE_COLUMNS =
  'id, workspace_id, active_revision_id, availability, title, source_type';

function rowToMaterial(row: MaterialRow): Material {
  return MaterialSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    activeRevisionId: row.active_revision_id,
    availability: row.availability,
    retiredAt: row.retired_at,
    title: row.title,
    sourceType: row.source_type,
    mediaType: row.media_type,
    originalFilename: row.original_filename,
    content: row.content,
    charCount: row.char_count,
    parseStatus: row.parse_status,
    pageCount: row.page_count,
    extractionWarnings: JSON.parse(row.extraction_warnings) as string[],
    parserVersion: row.parser_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function rowToRouteIdentity(row: MaterialRouteRow): MaterialRouteIdentity {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    activeRevisionId: row.active_revision_id,
    availability: row.availability,
    title: row.title,
    sourceType: row.source_type,
  };
}

function rowToBlock(row: BlockRow): SourceBlock {
  const parsed = {
    id: row.id,
    materialId: row.material_id,
    materialRevisionId: row.material_revision_id,
    index: row.idx,
    heading: row.heading,
    headingPath: JSON.parse(row.heading_path) as string[],
    pageNumber: row.page_number,
    pageEnd: row.page_end,
    slideNumber: row.slide_number,
    content: row.content,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    ...(row.structural_unit_id ? { structuralUnitId: row.structural_unit_id } : {}),
    ...(row.chunker_version ? { chunkerVersion: row.chunker_version } : {}),
    ...(row.content_origin ? { contentOrigin: row.content_origin } : {}),
  };
  return SourceBlockSchema.parse(parsed);
}

function rowToAsset(row: AssetRow): EmbeddedAsset {
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

function rowToConcept(row: ConceptRow): Concept {
  return ConceptSchema.parse({
    id: row.id,
    materialId: row.material_id,
    materialRevisionId: row.material_revision_id,
    name: row.name,
    summary: row.summary,
    importance: row.importance,
    grounding: JSON.parse(row.grounding),
    createdAt: row.created_at,
  });
}

export function createMaterialsRepo(db: SqliteDb) {
  const insertMaterialStmt = db.prepare(
    `INSERT INTO materials (${MATERIAL_COLUMNS}, original_data)
     VALUES (@id, @workspaceId, @activeRevisionId, @availability, @retiredAt,
             @title, @sourceType, @mediaType, @originalFilename,
             @content, @charCount, @parseStatus, @pageCount, @extractionWarnings,
             @parserVersion, @createdAt, @updatedAt, @originalData)`,
  );
  const insertBlockStmt = db.prepare(
    `INSERT INTO source_blocks (id, material_id, material_revision_id, idx, heading, heading_path, page_number, page_end, slide_number, content, start_offset, end_offset, structural_unit_id, chunker_version, content_origin)
      VALUES (@id, @materialId, @materialRevisionId, @index, @heading, @headingPath, @pageNumber, @pageEnd, @slideNumber, @content, @startOffset, @endOffset, @structuralUnitId, @chunkerVersion, @contentOrigin)`,
  );
  const hasWebSnapshot = (
    db.pragma('table_info(material_revisions)') as Array<{ name: string }>
  ).some((column) => column.name === 'web_snapshot');
  const insertMaterialRevisionStmt = db.prepare(
    `INSERT INTO material_revisions (
       id, material_id, revision_number, predecessor_revision_id, status,
       source_type, media_type, original_filename, content, char_count,
       parse_status, page_count, extraction_warnings, parser_version,
       parser_fingerprint, content_fingerprint, chunker_version, chunker_fingerprint,
       source_fingerprint, original_data, failure_code,
       failure_message, created_at, activated_at${hasWebSnapshot ? ', web_snapshot' : ''}
     ) VALUES (
       @id, @materialId, 1, NULL, 'active', @sourceType, @mediaType,
       @originalFilename, @content, @charCount, @parseStatus, @pageCount,
       @extractionWarnings, @parserVersion, @parserFingerprint,
       @contentFingerprint, @chunkerVersion, @chunkerFingerprint,
       @sourceFingerprint, @originalData, NULL, NULL, @createdAt, @activatedAt${hasWebSnapshot ? ', @webSnapshot' : ''}
     )`,
  );
  const insertConceptStmt = db.prepare(
    `INSERT INTO concepts (id, material_id, material_revision_id, name, summary, importance, grounding, created_at)
     VALUES (@id, @materialId,
       (SELECT active_revision_id FROM materials WHERE id = @materialId),
       @name, @summary, @importance, @grounding, @createdAt)`,
  );
  const updateTitleStmt = db.prepare('UPDATE materials SET title = ?, updated_at = ? WHERE id = ?');
  const deleteMaterialStmt = db.prepare('DELETE FROM materials WHERE id = ?');

  function materialParams(material: Material, originalData: Buffer | null) {
    return {
      id: material.id,
      workspaceId: material.workspaceId,
      activeRevisionId: material.activeRevisionId ?? null,
      availability: material.availability ?? 'active',
      retiredAt: material.retiredAt ?? null,
      title: material.title,
      sourceType: material.sourceType,
      mediaType: material.mediaType,
      originalFilename: material.originalFilename,
      content: material.content,
      charCount: material.charCount,
      parseStatus: material.parseStatus,
      pageCount: material.pageCount,
      extractionWarnings: JSON.stringify(material.extractionWarnings),
      parserVersion: material.parserVersion,
      createdAt: material.createdAt,
      updatedAt: material.updatedAt,
      originalData,
    };
  }

  function blockParams(block: SourceBlock, materialRevisionId: string) {
    return {
      id: block.id,
      materialId: block.materialId,
      index: block.index,
      heading: block.heading,
      headingPath: JSON.stringify(block.headingPath),
      pageNumber: block.pageNumber,
      pageEnd: block.pageEnd,
      slideNumber: block.slideNumber ?? null,
      content: block.content,
      startOffset: block.startOffset,
      endOffset: block.endOffset,
      materialRevisionId,
      structuralUnitId: block.structuralUnitId ?? null,
      chunkerVersion: block.chunkerVersion ?? null,
      contentOrigin: block.contentOrigin ?? null,
    };
  }

  const insertWithBlocks = db.transaction(
    (
      material: Material,
      blocks: SourceBlock[],
      originalData: Buffer | null,
      normalizedUnits: NormalizedDocumentUnit[] = [],
      derivation: {
        parserFingerprint?: string | null;
        chunkerVersion?: string | null;
        chunkerFingerprint?: string | null;
        sourceFingerprint?: string | null;
        webSnapshot?: unknown | null;
      } = {},
      embeddedAssets: EmbeddedAssetInput[] = [],
    ) => {
      insertMaterialStmt.run(materialParams(material, originalData));
      const revisionId = newId('rev');
      const contentFingerprint = fnv1a32(material.content).toString(16).padStart(8, '0');
      const parserFingerprint =
        derivation.parserFingerprint ??
        (material.parserVersion
          ? fnv1a32(
              JSON.stringify({
                parserVersion: material.parserVersion,
                sourceType: material.sourceType,
                mediaType: material.mediaType,
              }),
            )
              .toString(16)
              .padStart(8, '0')
          : null);
      insertMaterialRevisionStmt.run({
        id: revisionId,
        materialId: material.id,
        sourceType: material.sourceType,
        mediaType: material.mediaType,
        originalFilename: material.originalFilename,
        content: material.content,
        charCount: material.charCount,
        parseStatus: material.parseStatus,
        pageCount: material.pageCount,
        extractionWarnings: JSON.stringify(material.extractionWarnings),
        parserVersion: material.parserVersion,
        parserFingerprint,
        contentFingerprint,
        chunkerVersion: derivation.chunkerVersion ?? null,
        chunkerFingerprint: derivation.chunkerFingerprint ?? null,
        sourceFingerprint: derivation.sourceFingerprint ?? null,
        originalData,
        createdAt: material.createdAt,
        activatedAt: material.updatedAt,
        ...(hasWebSnapshot
          ? { webSnapshot: derivation.webSnapshot ? JSON.stringify(derivation.webSnapshot) : null }
          : {}),
      });
      db.prepare('UPDATE materials SET active_revision_id = ? WHERE id = ?').run(
        revisionId,
        material.id,
      );
      db.prepare(
        `INSERT INTO material_role_versions (
           id, material_id, version, predecessor_id, role, scope_included,
           learner_confirmed, actor, reason, created_at
         ) VALUES (?, ?, 1, NULL, 'unknown', 0, 0, 'system',
           'Role awaits learner confirmation.', ?)`,
      ).run(newId('role'), material.id, material.createdAt);
      const orderedUnits = orderNormalizedUnits(normalizedUnits);
      const unitIdMap = new Map<string, string>();
      for (const unit of orderedUnits) {
        if (unit.materialRevisionId !== `${material.id}:candidate`) {
          throw new Error(`Normalized unit belongs to a foreign revision: ${unit.id}`);
        }
        unitIdMap.set(
          unit.id,
          `unit_${fnv1a32(`${revisionId}:${unit.id}`).toString(16).padStart(8, '0')}`,
        );
      }
      const insertUnitStmt = db.prepare(
        `INSERT INTO normalized_structural_units (
           id, material_revision_id, parent_id, unit_type, idx, title,
           start_offset, end_offset, page_number, metadata, line_start, line_end,
           page_end, slide_number, heading_path, content_origin, chunker_version
         ) VALUES (@id, @materialRevisionId, @parentId, @kind, @index, @title,
           @startOffset, @endOffset, @pageNumber, @metadata, @lineStart, @lineEnd,
           @pageEnd, @slideNumber, @headingPath, @contentOrigin, @chunkerVersion)`,
      );
      for (const unit of orderedUnits) {
        insertUnitStmt.run({
          id: unitIdMap.get(unit.id),
          materialRevisionId: revisionId,
          parentId: unit.parentUnitId ? (unitIdMap.get(unit.parentUnitId) ?? null) : null,
          kind: unit.kind,
          index: unit.index,
          title: unit.title,
          startOffset: unit.startOffset,
          endOffset: unit.endOffset,
          pageNumber: unit.location.pageNumber ?? null,
          metadata: JSON.stringify({
            content: unit.content,
            sourceLocator: unit.location.domPath ?? null,
            derivation: unit.derivation,
            confidence: null,
          }),
          lineStart: unit.location.lineStart ?? null,
          lineEnd: unit.location.lineEnd ?? null,
          pageEnd: unit.location.pageEnd ?? null,
          slideNumber: unit.location.slideNumber ?? null,
          headingPath: JSON.stringify(unit.headingPath),
          contentOrigin: unit.contentOrigin,
          chunkerVersion: derivation.chunkerVersion ?? null,
        });
      }
      for (const block of blocks) {
        if (block.materialId !== material.id) {
          throw new Error(`SourceBlock belongs to a foreign material: ${block.id}`);
        }
        if (
          normalizedUnits.length > 0 &&
          block.structuralUnitId &&
          !unitIdMap.has(block.structuralUnitId)
        ) {
          throw new Error(`SourceBlock structural unit is unknown: ${block.structuralUnitId}`);
        }
        insertBlockStmt.run({
          ...blockParams(block, revisionId),
          structuralUnitId: block.structuralUnitId
            ? (unitIdMap.get(block.structuralUnitId) ?? null)
            : null,
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
      for (const asset of embeddedAssets) {
        if (asset.materialId !== material.id) {
          throw new Error(`Embedded asset belongs to a foreign material: ${asset.id}`);
        }
        if (asset.materialRevisionId !== `${material.id}:candidate`) {
          throw new Error(`Embedded asset belongs to a foreign revision: ${asset.id}`);
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
          id: `asset_${fnv1a32(`${revisionId}:${asset.id}`).toString(16).padStart(8, '0')}`,
          materialId: material.id,
          materialRevisionId: revisionId,
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
          createdAt: material.createdAt,
        });
      }
    },
  );

  const replaceConcepts = db.transaction((materialId: string, concepts: Concept[]) => {
    db.prepare(
      `DELETE FROM concepts
       WHERE material_revision_id = (SELECT active_revision_id FROM materials WHERE id = ?)`,
    ).run(materialId);
    for (const concept of concepts) {
      insertConceptStmt.run({
        id: concept.id,
        materialId: concept.materialId,
        name: concept.name,
        summary: concept.summary,
        importance: concept.importance,
        grounding: JSON.stringify(concept.grounding),
        createdAt: concept.createdAt,
      });
    }
  });

  const addConcepts = db.transaction((concepts: Concept[]) => {
    for (const concept of concepts) {
      insertConceptStmt.run({
        id: concept.id,
        materialId: concept.materialId,
        name: concept.name,
        summary: concept.summary,
        importance: concept.importance,
        grounding: JSON.stringify(concept.grounding),
        createdAt: concept.createdAt,
      });
    }
  });

  // Destructive purge is an internal maintenance primitive, distinct from the
  // learner-facing retirement path. No product route exposes this operation.
  const purgeMaterial = db.transaction((materialId: string): boolean => {
    return deleteMaterialStmt.run(materialId).changes === 1;
  });

  return {
    insertWithBlocks(
      material: Material,
      blocks: SourceBlock[],
      originalData: Buffer | null = null,
      normalizedUnits: NormalizedDocumentUnit[] = [],
      derivation: {
        parserFingerprint?: string | null;
        chunkerVersion?: string | null;
        chunkerFingerprint?: string | null;
        sourceFingerprint?: string | null;
        webSnapshot?: unknown | null;
      } = {},
      embeddedAssets: EmbeddedAssetInput[] = [],
    ): void {
      MaterialSchema.parse(material);
      blocks.forEach((b) => SourceBlockSchema.parse(b));
      embeddedAssets.forEach(({ bytes: _bytes, ...asset }) => EmbeddedAssetSchema.parse(asset));
      insertWithBlocks(material, blocks, originalData, normalizedUnits, derivation, embeddedAssets);
    },

    get(id: string): Material | undefined {
      const row = db.prepare(`SELECT ${MATERIAL_COLUMNS} FROM materials WHERE id = ?`).get(id) as
        MaterialRow | undefined;
      return row ? rowToMaterial(row) : undefined;
    },

    getRouteIdentity(id: string): MaterialRouteIdentity | undefined {
      const row = db
        .prepare(`SELECT ${MATERIAL_ROUTE_COLUMNS} FROM materials WHERE id = ?`)
        .get(id) as MaterialRouteRow | undefined;
      return row ? rowToRouteIdentity(row) : undefined;
    },

    /** Raw uploaded bytes for reprocessing (PDF/DOCX only; null otherwise). */
    getOriginalData(id: string): Buffer | null {
      const row = db
        .prepare(
          `SELECT r.original_data FROM material_revisions r
           JOIN materials m ON m.active_revision_id = r.id
           WHERE m.id = ?`,
        )
        .get(id) as { original_data: Buffer | null } | undefined;
      return row?.original_data ?? null;
    },

    updateTitle(id: string, title: string, updatedAt?: string): Material | undefined {
      const changes = updatedAt
        ? updateTitleStmt.run(title, updatedAt, id).changes
        : db.prepare('UPDATE materials SET title = ? WHERE id = ?').run(title, id).changes;
      if (changes === 0) return undefined;
      const row = db
        .prepare(`SELECT ${MATERIAL_COLUMNS} FROM materials WHERE id = ?`)
        .get(id) as MaterialRow;
      return rowToMaterial(row);
    },

    purge(id: string): boolean {
      return purgeMaterial(id);
    },

    list(): MaterialSummary[] {
      const rows = db
        .prepare(
          `SELECT m.id, m.workspace_id, m.title, m.source_type, m.char_count, m.created_at,
                  (SELECT COUNT(*) FROM source_blocks b
                    WHERE b.material_revision_id = m.active_revision_id) AS block_count,
                  w.origin AS workspace_origin,
                  (SELECT COUNT(*) FROM materials m2 WHERE m2.workspace_id = m.workspace_id)
                    AS workspace_document_count
           FROM materials m
           JOIN workspaces w ON w.id = m.workspace_id
           WHERE m.availability = 'active'
           ORDER BY m.created_at DESC, m.id DESC`,
        )
        .all() as Array<
        MaterialRow & {
          block_count: number;
          workspace_origin: MaterialSummary['workspaceOrigin'];
          workspace_document_count: number;
        }
      >;
      return rows.map((row) => ({
        id: row.id,
        workspaceId: row.workspace_id,
        title: row.title,
        sourceType: row.source_type,
        charCount: row.char_count,
        blockCount: row.block_count,
        createdAt: row.created_at,
        workspaceOrigin: row.workspace_origin,
        workspaceDocumentCount: row.workspace_document_count,
      }));
    },

    listByWorkspace(workspaceId: string): Material[] {
      const rows = db
        .prepare(
          `SELECT ${MATERIAL_COLUMNS} FROM materials WHERE workspace_id = ?
           ORDER BY created_at ASC, id ASC`,
        )
        .all(workspaceId) as MaterialRow[];
      return rows.map(rowToMaterial);
    },

    listRouteIdentitiesByWorkspace(workspaceId: string): MaterialRouteIdentity[] {
      const rows = db
        .prepare(
          `SELECT ${MATERIAL_ROUTE_COLUMNS} FROM materials WHERE workspace_id = ?
           ORDER BY created_at ASC, id ASC`,
        )
        .all(workspaceId) as MaterialRouteRow[];
      return rows.map(rowToRouteIdentity);
    },

    getBlocks(materialId: string): SourceBlock[] {
      const rows = db
        .prepare(
          `SELECT b.* FROM source_blocks b
           JOIN materials m ON m.active_revision_id = b.material_revision_id
           WHERE m.id = ? ORDER BY b.idx ASC`,
        )
        .all(materialId) as BlockRow[];
      return rows.map(rowToBlock);
    },

    getAssets(materialId: string): EmbeddedAsset[] {
      const rows = db
        .prepare(
          `SELECT a.* FROM material_revision_assets a
           JOIN materials m ON m.active_revision_id = a.material_revision_id
           WHERE m.id = ? ORDER BY a.idx ASC`,
        )
        .all(materialId) as AssetRow[];
      return rows.map(rowToAsset);
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

    /** All blocks of every document in a workspace (document order, then block order). */
    getBlocksByWorkspace(workspaceId: string): SourceBlock[] {
      const rows = db
        .prepare(
          `SELECT b.* FROM source_blocks b
           JOIN materials m ON m.id = b.material_id
           WHERE m.workspace_id = ? AND b.material_revision_id = m.active_revision_id
           ORDER BY m.created_at ASC, m.id ASC, b.idx ASC`,
        )
        .all(workspaceId) as BlockRow[];
      return rows.map(rowToBlock);
    },

    getBlock(blockId: string): SourceBlock | undefined {
      const row = db.prepare('SELECT * FROM source_blocks WHERE id = ?').get(blockId) as
        BlockRow | undefined;
      return row ? rowToBlock(row) : undefined;
    },

    replaceConcepts(materialId: string, concepts: Concept[]): void {
      concepts.forEach((c) => ConceptSchema.parse(c));
      replaceConcepts(materialId, concepts);
    },

    /**
     * Append concepts WITHOUT touching existing rows. Additive deepening
     * depends on this: existing concept ids (and everything keyed to them —
     * quizzes, mistakes, mastery, graph edges, alignment) stay stable.
     */
    addConcepts(concepts: Concept[]): void {
      concepts.forEach((c) => ConceptSchema.parse(c));
      addConcepts(concepts);
    },

    getConcepts(materialId: string): Concept[] {
      const rows = db
        .prepare(
          `SELECT c.* FROM concepts c
           JOIN materials m ON m.active_revision_id = c.material_revision_id
           WHERE m.id = ? ORDER BY c.created_at ASC, c.id ASC`,
        )
        .all(materialId) as ConceptRow[];
      return rows.map(rowToConcept);
    },

    /** Historical Concept rows for one active Material, including superseded revisions. */
    getConceptHistory(materialId: string): Concept[] {
      const rows = db
        .prepare(
          `SELECT c.* FROM concepts c
           JOIN materials m ON m.id = c.material_id
           WHERE m.id = ? AND m.availability = 'active'
           ORDER BY c.created_at ASC, c.id ASC`,
        )
        .all(materialId) as ConceptRow[];
      return rows.map(rowToConcept);
    },

    /** All concepts of every document in a workspace (stable order). */
    getConceptsByWorkspace(workspaceId: string): Concept[] {
      const rows = db
        .prepare(
          `SELECT c.* FROM concepts c
           JOIN materials m ON m.id = c.material_id
           WHERE m.workspace_id = ? AND c.material_revision_id = m.active_revision_id
           ORDER BY m.created_at ASC, m.id ASC, c.created_at ASC, c.id ASC`,
        )
        .all(workspaceId) as ConceptRow[];
      return rows.map(rowToConcept);
    },

    getConcept(conceptId: string): Concept | undefined {
      const row = db
        .prepare(
          `SELECT c.* FROM concepts c
           JOIN materials m ON m.active_revision_id = c.material_revision_id
           WHERE c.id = ?`,
        )
        .get(conceptId) as ConceptRow | undefined;
      return row ? rowToConcept(row) : undefined;
    },

    /** Historical lookup for immutable evidence/audit views. */
    getConceptAtAnyRevision(conceptId: string): Concept | undefined {
      const row = db.prepare('SELECT * FROM concepts WHERE id = ?').get(conceptId) as
        ConceptRow | undefined;
      return row ? rowToConcept(row) : undefined;
    },
  };
}

export type MaterialsRepo = ReturnType<typeof createMaterialsRepo>;
