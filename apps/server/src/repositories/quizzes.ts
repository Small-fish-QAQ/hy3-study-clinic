import {
  GradingResultSchema,
  QuestionSchema,
  QuizSchema,
  SubmissionSchema,
  type GradingResult,
  type Question,
  type Quiz,
  type Submission,
} from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';

interface QuizRow {
  id: string;
  material_id: string | null;
  workspace_id: string | null;
  kind: string;
  assessment_mode: string | null;
  config: string;
  target_concept_ids: string | null;
  created_at: string;
}

interface QuestionRow {
  id: string;
  quiz_id: string;
  idx: number;
  payload: string;
}

export function createQuizzesRepo(db: SqliteDb) {
  const insertQuizStmt = db.prepare(
    `INSERT INTO quizzes (id, material_id, workspace_id, kind, assessment_mode, config, target_concept_ids, created_at)
     VALUES (@id, @materialId, @workspaceId, @kind, @assessmentMode, @config, @targetConceptIds, @createdAt)`,
  );
  const insertQuestionStmt = db.prepare(
    `INSERT INTO questions (id, quiz_id, idx, payload) VALUES (@id, @quizId, @index, @payload)`,
  );

  const insertQuiz = db.transaction((quiz: Quiz) => {
    insertQuizStmt.run({
      id: quiz.id,
      materialId: quiz.materialId,
      workspaceId: quiz.workspaceId ?? null,
      kind: quiz.kind,
      assessmentMode: quiz.assessmentMode ?? null,
      config: JSON.stringify(quiz.config),
      targetConceptIds: quiz.targetConceptIds ? JSON.stringify(quiz.targetConceptIds) : null,
      createdAt: quiz.createdAt,
    });
    for (const question of quiz.questions) {
      insertQuestionStmt.run({
        id: question.id,
        quizId: quiz.id,
        index: question.index,
        payload: JSON.stringify(question),
      });
    }
  });

  function loadQuestions(quizId: string): Question[] {
    const rows = db
      .prepare('SELECT * FROM questions WHERE quiz_id = ? ORDER BY idx ASC')
      .all(quizId) as QuestionRow[];
    return rows.map((row) => QuestionSchema.parse(JSON.parse(row.payload)));
  }

  return {
    insert(quiz: Quiz): void {
      QuizSchema.parse(quiz);
      insertQuiz(quiz);
    },

    get(id: string): Quiz | undefined {
      const row = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(id) as QuizRow | undefined;
      if (!row) return undefined;
      return QuizSchema.parse({
        id: row.id,
        materialId: row.material_id,
        // Legacy rows have no workspace; omit the key so their hydrated shape
        // is unchanged from before the workspace-assessment upgrade.
        ...(row.workspace_id !== null ? { workspaceId: row.workspace_id } : {}),
        kind: row.kind,
        ...(row.assessment_mode ? { assessmentMode: row.assessment_mode } : {}),
        config: JSON.parse(row.config),
        questions: loadQuestions(row.id),
        targetConceptIds: row.target_concept_ids
          ? (JSON.parse(row.target_concept_ids) as string[])
          : undefined,
        createdAt: row.created_at,
      });
    },

    getQuestion(questionId: string): Question | undefined {
      const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(questionId) as
        QuestionRow | undefined;
      return row ? QuestionSchema.parse(JSON.parse(row.payload)) : undefined;
    },
  };
}

export type QuizzesRepo = ReturnType<typeof createQuizzesRepo>;

interface SubmissionRow {
  id: string;
  quiz_id: string;
  answers: string;
  created_at: string;
}

interface GradingRow {
  id: string;
  submission_id: string;
  quiz_id: string;
  payload: string;
  created_at: string;
}

export function createSubmissionsRepo(db: SqliteDb) {
  return {
    insertSubmission(submission: Submission): void {
      SubmissionSchema.parse(submission);
      db.prepare(
        `INSERT INTO submissions (id, quiz_id, answers, created_at)
         VALUES (@id, @quizId, @answers, @createdAt)`,
      ).run({
        id: submission.id,
        quizId: submission.quizId,
        answers: JSON.stringify(submission.answers),
        createdAt: submission.createdAt,
      });
    },

    getSubmission(id: string): Submission | undefined {
      const row = db.prepare('SELECT * FROM submissions WHERE id = ?').get(id) as
        SubmissionRow | undefined;
      if (!row) return undefined;
      return SubmissionSchema.parse({
        id: row.id,
        quizId: row.quiz_id,
        answers: JSON.parse(row.answers),
        createdAt: row.created_at,
      });
    },

    insertGradingResult(result: GradingResult): void {
      GradingResultSchema.parse(result);
      db.prepare(
        `INSERT INTO grading_results (id, submission_id, quiz_id, payload, created_at)
         VALUES (@id, @submissionId, @quizId, @payload, @createdAt)`,
      ).run({
        id: result.id,
        submissionId: result.submissionId,
        quizId: result.quizId,
        payload: JSON.stringify(result),
        createdAt: result.createdAt,
      });
    },

    getGradingResult(id: string): GradingResult | undefined {
      const row = db.prepare('SELECT * FROM grading_results WHERE id = ?').get(id) as
        GradingRow | undefined;
      return row ? GradingResultSchema.parse(JSON.parse(row.payload)) : undefined;
    },

    getGradingResultForSubmission(submissionId: string): GradingResult | undefined {
      const row = db
        .prepare('SELECT * FROM grading_results WHERE submission_id = ?')
        .get(submissionId) as GradingRow | undefined;
      return row ? GradingResultSchema.parse(JSON.parse(row.payload)) : undefined;
    },
  };
}

export type SubmissionsRepo = ReturnType<typeof createSubmissionsRepo>;
