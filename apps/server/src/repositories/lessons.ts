import {
  ConceptLessonContentSchema,
  ConceptLessonSchema,
  LessonConflictSchema,
  type ConceptLesson,
} from '@hy3-clinic/shared';
import { z } from 'zod';
import type { SqliteDb } from '../db/database.js';

/**
 * Concept-lesson repository: one CURRENT lesson row per concept.
 *
 * Upsert replaces the previous card atomically; the service layer only calls
 * it AFTER full validation succeeded, so a failed regeneration never touches
 * the stored lesson. Rows cascade with their concept (and workspace), which
 * matches the extraction-derived lifecycle of everything else keyed to
 * concepts.
 */

interface LessonRow {
  id: string;
  workspace_id: string;
  concept_id: string;
  content: string;
  conflicts: string;
  provider: string;
  provider_model: string | null;
  prompt_version: string;
  created_at: string;
  updated_at: string;
}

const ConflictsSchema = z.array(LessonConflictSchema);

function rowToLesson(row: LessonRow): ConceptLesson {
  return ConceptLessonSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    conceptId: row.concept_id,
    content: ConceptLessonContentSchema.parse(JSON.parse(row.content)),
    conflicts: ConflictsSchema.parse(JSON.parse(row.conflicts)),
    provider: row.provider,
    providerModel: row.provider_model,
    promptVersion: row.prompt_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function createLessonsRepo(db: SqliteDb) {
  const upsertStmt = db.prepare(
    `INSERT INTO concept_lessons (
       id, workspace_id, concept_id, content, conflicts, provider,
       provider_model, prompt_version, created_at, updated_at
     ) VALUES (
       @id, @workspaceId, @conceptId, @content, @conflicts, @provider,
       @providerModel, @promptVersion, @createdAt, @updatedAt
     )
     ON CONFLICT(concept_id) DO UPDATE SET
       id = excluded.id,
       content = excluded.content,
       conflicts = excluded.conflicts,
       provider = excluded.provider,
       provider_model = excluded.provider_model,
       prompt_version = excluded.prompt_version,
       updated_at = excluded.updated_at`,
  );

  return {
    upsert(lesson: ConceptLesson): void {
      ConceptLessonSchema.parse(lesson);
      upsertStmt.run({
        id: lesson.id,
        workspaceId: lesson.workspaceId,
        conceptId: lesson.conceptId,
        content: JSON.stringify(lesson.content),
        conflicts: JSON.stringify(lesson.conflicts),
        provider: lesson.provider,
        providerModel: lesson.providerModel,
        promptVersion: lesson.promptVersion,
        createdAt: lesson.createdAt,
        updatedAt: lesson.updatedAt,
      });
    },

    getByConcept(conceptId: string): ConceptLesson | undefined {
      const row = db
        .prepare('SELECT * FROM concept_lessons WHERE concept_id = ?')
        .get(conceptId) as LessonRow | undefined;
      return row ? rowToLesson(row) : undefined;
    },

    listByWorkspace(workspaceId: string): ConceptLesson[] {
      const rows = db
        .prepare(
          'SELECT * FROM concept_lessons WHERE workspace_id = ? ORDER BY created_at ASC, id ASC',
        )
        .all(workspaceId) as LessonRow[];
      return rows.map(rowToLesson);
    },

    /** Lessons whose concept belongs to one document (for mapping anchors). */
    listByMaterial(materialId: string): ConceptLesson[] {
      const rows = db
        .prepare(
          `SELECT l.* FROM concept_lessons l
           JOIN concepts c ON c.id = l.concept_id
           WHERE c.material_id = ?
           ORDER BY l.created_at ASC, l.id ASC`,
        )
        .all(materialId) as LessonRow[];
      return rows.map(rowToLesson);
    },
  };
}

export type LessonsRepo = ReturnType<typeof createLessonsRepo>;
