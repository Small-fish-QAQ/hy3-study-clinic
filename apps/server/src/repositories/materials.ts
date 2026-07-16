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
  title: string;
  sourceType: string;
  charCount: number;
  blockCount: number;
  createdAt: string;
}

interface MaterialRow {
  id: string;
  title: string;
  source_type: string;
  content: string;
  char_count: number;
  created_at: string;
}

interface BlockRow {
  id: string;
  material_id: string;
  idx: number;
  heading: string | null;
  heading_path: string;
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

function rowToMaterial(row: MaterialRow): Material {
  return MaterialSchema.parse({
    id: row.id,
    title: row.title,
    sourceType: row.source_type,
    content: row.content,
    charCount: row.char_count,
    createdAt: row.created_at,
  });
}

function rowToBlock(row: BlockRow): SourceBlock {
  return SourceBlockSchema.parse({
    id: row.id,
    materialId: row.material_id,
    index: row.idx,
    heading: row.heading,
    headingPath: JSON.parse(row.heading_path) as string[],
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
    `INSERT INTO materials (id, title, source_type, content, char_count, created_at)
     VALUES (@id, @title, @sourceType, @content, @charCount, @createdAt)`,
  );
  const insertBlockStmt = db.prepare(
    `INSERT INTO source_blocks (id, material_id, idx, heading, heading_path, content, start_offset, end_offset)
     VALUES (@id, @materialId, @index, @heading, @headingPath, @content, @startOffset, @endOffset)`,
  );
  const insertConceptStmt = db.prepare(
    `INSERT INTO concepts (id, material_id, name, summary, importance, grounding, created_at)
     VALUES (@id, @materialId, @name, @summary, @importance, @grounding, @createdAt)`,
  );
  const updateTitleStmt = db.prepare('UPDATE materials SET title = ? WHERE id = ?');
  const deleteMaterialStmt = db.prepare('DELETE FROM materials WHERE id = ?');

  const insertWithBlocks = db.transaction((material: Material, blocks: SourceBlock[]) => {
    insertMaterialStmt.run(material);
    for (const block of blocks) {
      insertBlockStmt.run({
        id: block.id,
        materialId: block.materialId,
        index: block.index,
        heading: block.heading,
        headingPath: JSON.stringify(block.headingPath),
        content: block.content,
        startOffset: block.startOffset,
        endOffset: block.endOffset,
      });
    }
  });

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
    insertWithBlocks(material: Material, blocks: SourceBlock[]): void {
      MaterialSchema.parse(material);
      blocks.forEach((b) => SourceBlockSchema.parse(b));
      insertWithBlocks(material, blocks);
    },

    get(id: string): Material | undefined {
      const row = db.prepare('SELECT * FROM materials WHERE id = ?').get(id) as
        MaterialRow | undefined;
      return row ? rowToMaterial(row) : undefined;
    },

    updateTitle(id: string, title: string): Material | undefined {
      if (updateTitleStmt.run(title, id).changes === 0) return undefined;
      const row = db.prepare('SELECT * FROM materials WHERE id = ?').get(id) as MaterialRow;
      return rowToMaterial(row);
    },

    delete(id: string): boolean {
      return deleteMaterial(id);
    },

    list(): MaterialSummary[] {
      const rows = db
        .prepare(
          `SELECT m.id, m.title, m.source_type, m.char_count, m.created_at,
                  (SELECT COUNT(*) FROM source_blocks b WHERE b.material_id = m.id) AS block_count
           FROM materials m
           ORDER BY m.created_at DESC, m.id DESC`,
        )
        .all() as Array<MaterialRow & { block_count: number }>;
      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        sourceType: row.source_type,
        charCount: row.char_count,
        blockCount: row.block_count,
        createdAt: row.created_at,
      }));
    },

    getBlocks(materialId: string): SourceBlock[] {
      const rows = db
        .prepare('SELECT * FROM source_blocks WHERE material_id = ? ORDER BY idx ASC')
        .all(materialId) as BlockRow[];
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

    getConcept(conceptId: string): Concept | undefined {
      const row = db.prepare('SELECT * FROM concepts WHERE id = ?').get(conceptId) as
        ConceptRow | undefined;
      return row ? rowToConcept(row) : undefined;
    },
  };
}

export type MaterialsRepo = ReturnType<typeof createMaterialsRepo>;
