import {
  MAX_ATTEMPT_HISTORY,
  type CompletedAttemptDetail,
  type CompletedAttemptSummary,
  type SourceBlock,
} from '@hy3-clinic/shared';
import { notFound } from '../errors.js';
import type { Repositories } from '../repositories/index.js';
import { toPublicQuiz } from './quizzes.js';

export interface AttemptsServiceDeps {
  repos: Repositories;
}

/**
 * Read-only completed-quiz history.
 *
 * Every method here only READS persisted rows (quizzes, submissions,
 * grading results, source blocks). Opening history never grades, never
 * calls the provider, and never touches mastery, mistakes, misconceptions,
 * review scheduling, or any other learning state — those updates happened
 * exactly once when the submission was graded.
 */
export function createAttemptsService({ repos }: AttemptsServiceDeps) {
  function requireWorkspace(workspaceId: string): void {
    if (!repos.workspaces.get(workspaceId)) {
      throw notFound(`课程空间不存在:${workspaceId}`);
    }
  }

  return {
    /** Completed attempts of a workspace, newest first (bounded). */
    listByWorkspace(workspaceId: string): CompletedAttemptSummary[] {
      requireWorkspace(workspaceId);
      return repos.submissions.listCompletedByWorkspace(workspaceId, MAX_ATTEMPT_HISTORY);
    },

    /**
     * Faithful replay of one graded attempt: the persisted questions,
     * answers, grades and state-change snapshot, plus whichever source
     * blocks the evidence references still resolve to. Blocks of deleted or
     * reprocessed documents are simply absent — the persisted grounding
     * quotes inside the questions remain the honest historical evidence.
     */
    get(workspaceId: string, attemptId: string): CompletedAttemptDetail {
      requireWorkspace(workspaceId);
      const missing = () => notFound(`历史测验记录不存在:${attemptId}`);

      const record = repos.submissions.getAttemptRecord(attemptId);
      if (!record) throw missing();
      const quiz = repos.quizzes.get(record.grading.quizId);
      if (!quiz) throw missing();

      // Workspace membership: assessments carry it directly; document
      // quizzes resolve through their material. A mismatch 404s exactly like
      // a missing record so foreign attempt ids are not enumerable.
      const material = quiz.materialId ? repos.materials.get(quiz.materialId) : undefined;
      const attemptWorkspaceId = quiz.workspaceId ?? material?.workspaceId;
      if (attemptWorkspaceId !== workspaceId) throw missing();

      const submission = repos.submissions.getSubmission(record.grading.submissionId);
      if (!submission) throw missing();

      const blockIds = new Set<string>();
      for (const question of quiz.questions) {
        blockIds.add(question.grounding.blockId);
        for (const evidence of question.supplementaryEvidence ?? []) {
          blockIds.add(evidence.blockId);
        }
      }
      const blocks: SourceBlock[] = [];
      for (const blockId of blockIds) {
        const block = repos.materials.getBlock(blockId);
        if (block) blocks.push(block);
      }

      return {
        summary: {
          id: record.grading.id,
          quizId: quiz.id,
          workspaceId,
          kind: quiz.kind,
          ...(quiz.assessmentMode ? { assessmentMode: quiz.assessmentMode } : {}),
          materialId: quiz.materialId,
          materialTitle: material?.title ?? null,
          questionCount: record.grading.grades.length,
          totalAwarded: record.grading.totalAwarded,
          totalPossible: record.grading.totalPossible,
          overallScore: record.grading.overallScore,
          provider: record.provider,
          completedAt: record.grading.createdAt,
        },
        quiz: toPublicQuiz(quiz),
        questions: quiz.questions,
        answers: submission.answers,
        grading: record.grading,
        stateChanges: record.stateChanges,
        blocks,
      };
    },
  };
}

export type AttemptsService = ReturnType<typeof createAttemptsService>;
