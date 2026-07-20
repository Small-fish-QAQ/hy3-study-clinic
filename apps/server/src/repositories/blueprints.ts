import { QuestionBlueprintSchema, type QuestionBlueprint } from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';

interface BlueprintRow {
  id: string;
  workspace_id: string;
  quiz_id: string | null;
  payload: string;
  scope: string;
  created_at: string;
}

function rowToBlueprint(row: BlueprintRow): QuestionBlueprint {
  return QuestionBlueprintSchema.parse(JSON.parse(row.payload));
}

export function createBlueprintsRepo(db: SqliteDb) {
  return {
    insert(blueprint: QuestionBlueprint, quizId: string | null): void {
      QuestionBlueprintSchema.parse(blueprint);
      db.prepare(
        `INSERT INTO question_blueprints (id, workspace_id, quiz_id, payload, scope, created_at)
         VALUES (@id, @workspaceId, @quizId, @payload, @scope, @createdAt)`,
      ).run({
        id: blueprint.id,
        workspaceId: blueprint.workspaceId,
        quizId,
        payload: JSON.stringify(blueprint),
        scope: blueprint.scope,
        createdAt: blueprint.createdAt,
      });
    },

    get(id: string): QuestionBlueprint | undefined {
      const row = db.prepare('SELECT * FROM question_blueprints WHERE id = ?').get(id) as
        BlueprintRow | undefined;
      return row ? rowToBlueprint(row) : undefined;
    },

    listByQuiz(quizId: string): QuestionBlueprint[] {
      const rows = db
        .prepare(
          'SELECT * FROM question_blueprints WHERE quiz_id = ? ORDER BY created_at ASC, id ASC',
        )
        .all(quizId) as BlueprintRow[];
      return rows.map(rowToBlueprint);
    },

    listByWorkspace(workspaceId: string): QuestionBlueprint[] {
      const rows = db
        .prepare(
          `SELECT * FROM question_blueprints WHERE workspace_id = ?
           ORDER BY created_at ASC, id ASC`,
        )
        .all(workspaceId) as BlueprintRow[];
      return rows.map(rowToBlueprint);
    },
  };
}

export type BlueprintsRepo = ReturnType<typeof createBlueprintsRepo>;
