import {
  MasteryStateSchema,
  MistakeRecordSchema,
  type MasteryState,
  type MistakeRecord,
} from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';

interface MistakeRow {
  id: string;
  material_id: string;
  quiz_id: string;
  question_id: string;
  concept_id: string;
  concept_name: string;
  payload: string;
  score: number;
  status: string;
  remediation_count: number;
  created_at: string;
  resolved_at: string | null;
}

function rowToMistake(row: MistakeRow): MistakeRecord {
  const payload = JSON.parse(row.payload) as Omit<
    MistakeRecord,
    | 'id'
    | 'materialId'
    | 'quizId'
    | 'questionId'
    | 'conceptId'
    | 'conceptName'
    | 'score'
    | 'status'
    | 'remediationCount'
    | 'createdAt'
    | 'resolvedAt'
  >;
  return MistakeRecordSchema.parse({
    ...payload,
    id: row.id,
    materialId: row.material_id,
    quizId: row.quiz_id,
    questionId: row.question_id,
    conceptId: row.concept_id,
    conceptName: row.concept_name,
    score: row.score,
    status: row.status,
    remediationCount: row.remediation_count,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  });
}

export interface WeakConcept {
  conceptId: string;
  conceptName: string;
  openMistakes: number;
}

export function createMistakesRepo(db: SqliteDb) {
  return {
    insert(mistake: MistakeRecord): void {
      MistakeRecordSchema.parse(mistake);
      db.prepare(
        `INSERT INTO mistakes
           (id, material_id, quiz_id, question_id, concept_id, concept_name,
            payload, score, status, remediation_count, created_at, resolved_at)
         VALUES
           (@id, @materialId, @quizId, @questionId, @conceptId, @conceptName,
            @payload, @score, @status, @remediationCount, @createdAt, @resolvedAt)`,
      ).run({
        id: mistake.id,
        materialId: mistake.materialId,
        quizId: mistake.quizId,
        questionId: mistake.questionId,
        conceptId: mistake.conceptId,
        conceptName: mistake.conceptName,
        payload: JSON.stringify(mistake),
        score: mistake.score,
        status: mistake.status,
        remediationCount: mistake.remediationCount,
        createdAt: mistake.createdAt,
        resolvedAt: mistake.resolvedAt,
      });
    },

    listByMaterial(materialId: string): MistakeRecord[] {
      const rows = db
        .prepare('SELECT * FROM mistakes WHERE material_id = ? ORDER BY created_at DESC, id DESC')
        .all(materialId) as MistakeRow[];
      return rows.map(rowToMistake);
    },

    listOpenByMaterial(materialId: string): MistakeRecord[] {
      const rows = db
        .prepare(
          `SELECT * FROM mistakes WHERE material_id = ? AND status = 'open'
           ORDER BY created_at DESC, id DESC`,
        )
        .all(materialId) as MistakeRow[];
      return rows.map(rowToMistake);
    },

    get(id: string): MistakeRecord | undefined {
      const row = db.prepare('SELECT * FROM mistakes WHERE id = ?').get(id) as
        MistakeRow | undefined;
      return row ? rowToMistake(row) : undefined;
    },

    /** Concepts with at least one open mistake, most-mistaken first. */
    weakConcepts(materialId: string): WeakConcept[] {
      const rows = db
        .prepare(
          `SELECT concept_id, concept_name, COUNT(*) AS open_mistakes
           FROM mistakes
           WHERE material_id = ? AND status = 'open'
           GROUP BY concept_id, concept_name
           ORDER BY open_mistakes DESC, concept_name ASC`,
        )
        .all(materialId) as Array<{
        concept_id: string;
        concept_name: string;
        open_mistakes: number;
      }>;
      return rows.map((row) => ({
        conceptId: row.concept_id,
        conceptName: row.concept_name,
        openMistakes: row.open_mistakes,
      }));
    },

    incrementRemediation(ids: string[]): void {
      const stmt = db.prepare(
        'UPDATE mistakes SET remediation_count = remediation_count + 1 WHERE id = ?',
      );
      const run = db.transaction((mistakeIds: string[]) => {
        for (const id of mistakeIds) stmt.run(id);
      });
      run(ids);
    },

    resolve(id: string, resolvedAt: string): void {
      db.prepare("UPDATE mistakes SET status = 'resolved', resolved_at = ? WHERE id = ?").run(
        resolvedAt,
        id,
      );
    },
  };
}

export type MistakesRepo = ReturnType<typeof createMistakesRepo>;

interface MasteryRow {
  material_id: string;
  concept_id: string;
  concept_name: string;
  mastery: number;
  attempts: number;
  correct_count: number;
  last_score: number | null;
  updated_at: string;
}

function rowToMastery(row: MasteryRow): MasteryState {
  return MasteryStateSchema.parse({
    materialId: row.material_id,
    conceptId: row.concept_id,
    conceptName: row.concept_name,
    mastery: row.mastery,
    attempts: row.attempts,
    correctCount: row.correct_count,
    lastScore: row.last_score,
    updatedAt: row.updated_at,
  });
}

export function createMasteryRepo(db: SqliteDb) {
  return {
    get(materialId: string, conceptId: string): MasteryState | undefined {
      const row = db
        .prepare('SELECT * FROM mastery_states WHERE material_id = ? AND concept_id = ?')
        .get(materialId, conceptId) as MasteryRow | undefined;
      return row ? rowToMastery(row) : undefined;
    },

    listByMaterial(materialId: string): MasteryState[] {
      const rows = db
        .prepare(
          'SELECT * FROM mastery_states WHERE material_id = ? ORDER BY mastery ASC, concept_name ASC',
        )
        .all(materialId) as MasteryRow[];
      return rows.map(rowToMastery);
    },

    upsert(state: MasteryState): void {
      MasteryStateSchema.parse(state);
      db.prepare(
        `INSERT INTO mastery_states
           (material_id, concept_id, concept_name, mastery, attempts, correct_count, last_score, updated_at)
         VALUES
           (@materialId, @conceptId, @conceptName, @mastery, @attempts, @correctCount, @lastScore, @updatedAt)
         ON CONFLICT (material_id, concept_id) DO UPDATE SET
           concept_name = excluded.concept_name,
           mastery = excluded.mastery,
           attempts = excluded.attempts,
           correct_count = excluded.correct_count,
           last_score = excluded.last_score,
           updated_at = excluded.updated_at`,
      ).run({
        materialId: state.materialId,
        conceptId: state.conceptId,
        conceptName: state.conceptName,
        mastery: state.mastery,
        attempts: state.attempts,
        correctCount: state.correctCount,
        lastScore: state.lastScore,
        updatedAt: state.updatedAt,
      });
    },
  };
}

export type MasteryRepo = ReturnType<typeof createMasteryRepo>;
