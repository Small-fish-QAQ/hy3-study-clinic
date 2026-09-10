import {
  AttemptProviderSchema,
  GradingResultSchema,
  QuestionSchema,
  QuizKindSchema,
  QuizSchema,
  SubmissionSchema,
  SubmissionStateChangesSchema,
  type AttemptProvider,
  type CompletedAttemptSummary,
  type GradingResult,
  type Question,
  type Quiz,
  type Submission,
  type SubmissionStateChanges,
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
  provider: string | null;
  state_changes: string | null;
}

/** Joined row backing one completed-attempt history entry. */
interface AttemptListRow {
  id: string;
  quiz_id: string;
  payload: string;
  created_at: string;
  provider: string | null;
  kind: string;
  assessment_mode: string | null;
  material_id: string | null;
  material_title: string | null;
  attempt_workspace_id: string;
}

/** A grading result plus the attempt metadata persisted alongside it. */
export interface AttemptRecord {
  grading: GradingResult;
  provider: AttemptProvider | null;
  stateChanges: SubmissionStateChanges | null;
}

/** Parse the persisted provider tag; unknown/legacy values read as null. */
function parseProvider(raw: string | null): AttemptProvider | null {
  const parsed = AttemptProviderSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
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

    /**
     * Whether the quiz already has a grading result. Used as the
     * transaction-local duplicate-submission recheck: better-sqlite3
     * transactions are synchronous, so check-then-insert inside one
     * transaction cannot interleave with another submission.
     */
    hasResultForQuiz(quizId: string): boolean {
      const row = db.prepare('SELECT 1 FROM grading_results WHERE quiz_id = ? LIMIT 1').get(quizId);
      return row !== undefined;
    },

    insertGradingResult(result: GradingResult, provider?: AttemptProvider): void {
      GradingResultSchema.parse(result);
      db.prepare(
        `INSERT INTO grading_results (id, submission_id, quiz_id, payload, created_at, provider)
         VALUES (@id, @submissionId, @quizId, @payload, @createdAt, @provider)`,
      ).run({
        id: result.id,
        submissionId: result.submissionId,
        quizId: result.quizId,
        payload: JSON.stringify(result),
        createdAt: result.createdAt,
        provider: provider ?? null,
      });
    },

    /**
     * Record the deterministic state-change summary of a graded submission.
     * Write-once by design: the snapshot describes what the ORIGINAL grading
     * changed, so an existing value is never overwritten.
     */
    recordStateChanges(gradingResultId: string, stateChanges: SubmissionStateChanges): void {
      SubmissionStateChangesSchema.parse(stateChanges);
      db.prepare(
        `UPDATE grading_results SET state_changes = @stateChanges
         WHERE id = @id AND state_changes IS NULL`,
      ).run({ id: gradingResultId, stateChanges: JSON.stringify(stateChanges) });
    },

    /** One grading result plus its persisted attempt metadata. */
    getAttemptRecord(id: string): AttemptRecord | undefined {
      const row = db.prepare('SELECT * FROM grading_results WHERE id = ?').get(id) as
        GradingRow | undefined;
      if (!row) return undefined;
      return {
        grading: GradingResultSchema.parse(JSON.parse(row.payload)),
        provider: parseProvider(row.provider),
        stateChanges: row.state_changes
          ? SubmissionStateChangesSchema.parse(JSON.parse(row.state_changes))
          : null,
      };
    },

    /**
     * Completed (graded) attempts of one workspace, newest first. Standard
     * and remediation quizzes resolve their workspace through the owning
     * document; workspace assessments carry it directly. Ordering is
     * deterministic: created_at DESC with the id as a tie-breaker.
     */
    listCompletedByWorkspace(workspaceId: string, limit: number): CompletedAttemptSummary[] {
      const rows = db
        .prepare(
          `SELECT gr.id, gr.quiz_id, gr.payload, gr.created_at, gr.provider,
                  q.kind, q.assessment_mode, q.material_id, m.title AS material_title,
                  COALESCE(q.workspace_id, m.workspace_id) AS attempt_workspace_id
           FROM grading_results gr
           JOIN quizzes q ON q.id = gr.quiz_id
           LEFT JOIN materials m ON m.id = q.material_id
           WHERE COALESCE(q.workspace_id, m.workspace_id) = ?
             AND NOT EXISTS (
               SELECT 1 FROM assessment_progression_reconciliations apr
               WHERE apr.grading_result_id = gr.id
             )
           ORDER BY gr.created_at DESC, gr.id DESC
           LIMIT ?`,
        )
        .all(workspaceId, limit) as AttemptListRow[];
      return rows.map((row) => {
        const grading = GradingResultSchema.parse(JSON.parse(row.payload));
        return {
          id: row.id,
          quizId: row.quiz_id,
          workspaceId: row.attempt_workspace_id,
          kind: QuizKindSchema.parse(row.kind),
          ...(row.assessment_mode ? { assessmentMode: row.assessment_mode } : {}),
          materialId: row.material_id,
          materialTitle: row.material_title,
          questionCount: grading.grades.length,
          totalAwarded: grading.totalAwarded,
          totalPossible: grading.totalPossible,
          overallScore: grading.overallScore,
          provider: parseProvider(row.provider),
          completedAt: row.created_at,
        };
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
