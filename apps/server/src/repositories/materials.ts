import {
  ConceptSchema,
  MaterialSchema,
  SourceBlockSchema,
  type Concept,
  type Material,
  type SourceBlock,
} from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';

export interface MaterialSummary {
  id: string;
  workspaceId: string;
  title: string;
  sourceType: string;
  charCount: number;
  blockCount: number;
  createdAt: string;
}

interface MaterialRow {
  id: string;
  workspace_id: string;
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

interface BlockRow {
  id: string;
  material_id: string;
  idx: number;
  heading: string | null;
  heading_path: string;
  page_number: number | null;
  content: string;
  start_offset: number;
  end_offset: number;
}

interface ConceptRow {
  id: string;
  material_id: string;
  name: string;
  summary: string;
  importance: string;
  grounding: string;
  created_at: string;
}

const MATERIAL_COLUMNS = `id, workspace_id, title, source_type, media_type, original_filename,
  content, char_count, parse_status, page_count, extraction_warnings, parser_version,
  created_at, updated_at`;

function rowToMaterial(row: MaterialRow): Material {
  return MaterialSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
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

function rowToBlock(row: BlockRow): SourceBlock {
  return SourceBlockSchema.parse({
    id: row.id,
    materialId: row.material_id,
    index: row.idx,
    heading: row.heading,
    headingPath: JSON.parse(row.heading_path) as string[],
    pageNumber: row.page_number,
    content: row.content,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
  });
}

function rowToConcept(row: ConceptRow): Concept {
  return ConceptSchema.parse({
    id: row.id,
    materialId: row.material_id,
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
     VALUES (@id, @workspaceId, @title, @sourceType, @mediaType, @originalFilename,
             @content, @charCount, @parseStatus, @pageCount, @extractionWarnings,
             @parserVersion, @createdAt, @updatedAt, @originalData)`,
  );
  const insertBlockStmt = db.prepare(
    `INSERT INTO source_blocks (id, material_id, idx, heading, heading_path, page_number, content, start_offset, end_offset)
     VALUES (@id, @materialId, @index, @heading, @headingPath, @pageNumber, @content, @startOffset, @endOffset)`,
  );
  const insertConceptStmt = db.prepare(
    `INSERT INTO concepts (id, material_id, name, summary, importance, grounding, created_at)
     VALUES (@id, @materialId, @name, @summary, @importance, @grounding, @createdAt)`,
  );
  const updateTitleStmt = db.prepare('UPDATE materials SET title = ?, updated_at = ? WHERE id = ?');
  const deleteMaterialStmt = db.prepare('DELETE FROM materials WHERE id = ?');

  function materialParams(material: Material, originalData: Buffer | null) {
    return {
      id: material.id,
      workspaceId: material.workspaceId,
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

  function blockParams(block: SourceBlock) {
    return {
      id: block.id,
      materialId: block.materialId,
      index: block.index,
      heading: block.heading,
      headingPath: JSON.stringify(block.headingPath),
      pageNumber: block.pageNumber,
      content: block.content,
      startOffset: block.startOffset,
      endOffset: block.endOffset,
    };
  }

  const insertWithBlocks = db.transaction(
    (material: Material, blocks: SourceBlock[], originalData: Buffer | null) => {
      insertMaterialStmt.run(materialParams(material, originalData));
      for (const block of blocks) {
        insertBlockStmt.run(blockParams(block));
      }
    },
  );

  const replaceConcepts = db.transaction((materialId: string, concepts: Concept[]) => {
    db.prepare('DELETE FROM concepts WHERE material_id = ?').run(materialId);
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

  // The material row is the root of the verified ON DELETE CASCADE graph.
  // Keeping the root delete inside an explicit transaction makes the rollback
  // boundary clear and lets SQLite undo every cascade if any delete fails.
  const deleteMaterial = db.transaction((materialId: string): boolean => {
    return deleteMaterialStmt.run(materialId).changes === 1;
  });

  return {
    insertWithBlocks(
      material: Material,
      blocks: SourceBlock[],
      originalData: Buffer | null = null,
    ): void {
      MaterialSchema.parse(material);
      blocks.forEach((b) => SourceBlockSchema.parse(b));
      insertWithBlocks(material, blocks, originalData);
    },

    get(id: string): Material | undefined {
      const row = db.prepare(`SELECT ${MATERIAL_COLUMNS} FROM materials WHERE id = ?`).get(id) as
        MaterialRow | undefined;
      return row ? rowToMaterial(row) : undefined;
    },

    /** Raw uploaded bytes for reprocessing (PDF/DOCX only; null otherwise). */
    getOriginalData(id: string): Buffer | null {
      const row = db.prepare('SELECT original_data FROM materials WHERE id = ?').get(id) as
        { original_data: Buffer | null } | undefined;
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

    delete(id: string): boolean {
      return deleteMaterial(id);
    },

    list(): MaterialSummary[] {
      const rows = db
        .prepare(
          `SELECT m.id, m.workspace_id, m.title, m.source_type, m.char_count, m.created_at,
                  (SELECT COUNT(*) FROM source_blocks b WHERE b.material_id = m.id) AS block_count
           FROM materials m
           ORDER BY m.created_at DESC, m.id DESC`,
        )
        .all() as Array<MaterialRow & { block_count: number }>;
      return rows.map((row) => ({
        id: row.id,
        workspaceId: row.workspace_id,
        title: row.title,
        sourceType: row.source_type,
        charCount: row.char_count,
        blockCount: row.block_count,
        createdAt: row.created_at,
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

    getBlocks(materialId: string): SourceBlock[] {
      const rows = db
        .prepare('SELECT * FROM source_blocks WHERE material_id = ? ORDER BY idx ASC')
        .all(materialId) as BlockRow[];
      return rows.map(rowToBlock);
    },

    /** All blocks of every document in a workspace (document order, then block order). */
    getBlocksByWorkspace(workspaceId: string): SourceBlock[] {
      const rows = db
        .prepare(
          `SELECT b.* FROM source_blocks b
           JOIN materials m ON m.id = b.material_id
           WHERE m.workspace_id = ?
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

    getConcepts(materialId: string): Concept[] {
      const rows = db
        .prepare('SELECT * FROM concepts WHERE material_id = ? ORDER BY created_at ASC, id ASC')
        .all(materialId) as ConceptRow[];
      return rows.map(rowToConcept);
    },

    /** All concepts of every document in a workspace (stable order). */
    getConceptsByWorkspace(workspaceId: string): Concept[] {
      const rows = db
        .prepare(
          `SELECT c.* FROM concepts c
           JOIN materials m ON m.id = c.material_id
           WHERE m.workspace_id = ?
           ORDER BY m.created_at ASC, m.id ASC, c.created_at ASC, c.id ASC`,
        )
        .all(workspaceId) as ConceptRow[];
      return rows.map(rowToConcept);
    },

    getConcept(conceptId: string): Concept | undefined {
      const row = db.prepare('SELECT * FROM concepts WHERE id = ?').get(conceptId) as
        ConceptRow | undefined;
      return row ? rowToConcept(row) : undefined;
    },
  };
}

export type MaterialsRepo = ReturnType<typeof createMaterialsRepo>;
