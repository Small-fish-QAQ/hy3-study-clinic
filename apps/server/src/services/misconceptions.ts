import {
  isMisconceptionTransitionAllowed,
  type Answer,
  type MisconceptionCounts,
  type MisconceptionRecord,
  type MisconceptionStatus,
  type QuestionGrade,
  type Quiz,
  type VerifiedGrounding,
} from '@hy3-clinic/shared';
import { ApiErrorCode } from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import { verifyGrounding } from '../grounding/verify.js';
import { ProviderError } from '../llm/errors.js';
import type { LlmProvider, ProviderCallOptions } from '../llm/provider.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';

export interface MisconceptionsServiceDeps {
  repos: Repositories;
  provider: LlmProvider;
  clock: Clock;
}

/** At most this many misconception proposals per graded submission. */
const MAX_PROPOSALS_PER_SUBMISSION = 2;
/** Only wrong answers below this score are considered for proposals. */
const PROPOSAL_SCORE_THRESHOLD = 0.6;

/**
 * Deterministic misconception lifecycle owner.
 *
 * State machine (local code only; the model can never set a status):
 *   proposed → confirmed   (wrong answer on a discriminating question)
 *   proposed → rejected    (correct answer on a discriminating question)
 *   confirmed → resolved   (correct answer on a later discriminating question)
 *   rejected / resolved    (terminal, audit-only)
 *
 * A wrong answer may CREATE a proposed hypothesis (via a bounded provider
 * call whose output is schema- and evidence-validated), but one wrong answer
 * never confirms anything.
 */
export function createMisconceptionsService({ repos, provider, clock }: MisconceptionsServiceDeps) {
  function transition(
    record: MisconceptionRecord,
    to: MisconceptionStatus,
    quizId: string | null,
    at: string,
  ): boolean {
    if (!isMisconceptionTransitionAllowed(record.status, to)) return false;
    repos.misconceptions.updateStatus(record.id, to, quizId, at);
    return true;
  }

  return {
    get(id: string): MisconceptionRecord {
      const record = repos.misconceptions.get(id);
      if (!record) throw notFound(`误区假设不存在:${id}`);
      return record;
    },

    listByWorkspace(workspaceId: string, status?: MisconceptionStatus): MisconceptionRecord[] {
      if (!repos.workspaces.get(workspaceId)) throw notFound(`课程空间不存在:${workspaceId}`);
      return repos.misconceptions.listByWorkspace(workspaceId, status);
    },

    countsByConcept(workspaceId: string): Map<string, MisconceptionCounts> {
      return repos.misconceptions.countsByConceptForWorkspace(workspaceId);
    },

    /**
     * Explicit transition entry point for services (never exposed as a raw
     * "set status" API). Throws on illegal transitions so callers cannot
     * silently corrupt the lifecycle.
     */
    applyTransition(
      id: string,
      to: MisconceptionStatus,
      quizId: string | null,
    ): MisconceptionRecord {
      const record = this.get(id);
      if (!isMisconceptionTransitionAllowed(record.status, to)) {
        throw new AppError(
          ApiErrorCode.ValidationError,
          `不允许的误区状态转换:${record.status} → ${to}`,
        );
      }
      transition(record, to, quizId, clock.now().toISOString());
      return this.get(id);
    },

    /**
     * Deterministic transitions driven by a graded submission: questions that
     * carry a misconceptionId are discriminating questions. A correct answer
     * rejects a proposed hypothesis (or resolves a confirmed one); a wrong
     * answer confirms a proposed hypothesis. Illegal transitions are skipped
     * (e.g. re-grading against an already-rejected hypothesis).
     */
    applyGradedTransitions(
      quiz: Quiz,
      grades: QuestionGrade[],
      at: string,
    ): { confirmed: number; rejected: number; resolved: number } {
      const questionById = new Map(quiz.questions.map((q) => [q.id, q]));
      let confirmed = 0;
      let rejected = 0;
      let resolved = 0;

      for (const grade of grades) {
        const question = questionById.get(grade.questionId);
        if (!question?.misconceptionId) continue;
        const record = repos.misconceptions.get(question.misconceptionId);
        if (!record) continue;

        if (grade.correct) {
          if (record.status === 'proposed' && transition(record, 'rejected', quiz.id, at)) {
            rejected++;
          } else if (record.status === 'confirmed' && transition(record, 'resolved', quiz.id, at)) {
            resolved++;
          }
        } else if (record.status === 'proposed' && transition(record, 'confirmed', quiz.id, at)) {
          confirmed++;
        }
      }
      return { confirmed, rejected, resolved };
    },

    /**
     * Bounded provider-backed proposal step for wrong answers of workspace
     * (adaptive) assessments. The model may only PROPOSE (category +
     * hypothesis + evidence); local code validates evidence against real
     * source blocks and returns at most MAX_PROPOSALS_PER_SUBMISSION records
     * with status 'proposed'. Provider failures are swallowed — grading
     * output must never depend on this step.
     *
     * This method performs NO database writes: it runs the provider calls and
     * evidence verification only, so the grading service can execute it
     * BEFORE opening its write transaction and insert the returned records
     * inside that transaction (no model calls inside a transaction).
     */
    async collectProposalsFromWrongAnswers(
      quiz: Quiz,
      grades: QuestionGrade[],
      answersById: Map<string, Answer>,
      at: string,
      opts?: ProviderCallOptions,
    ): Promise<MisconceptionRecord[]> {
      if (quiz.kind !== 'adaptive' || !quiz.workspaceId) return [];
      const workspaceId = quiz.workspaceId;
      const questionById = new Map(quiz.questions.map((q) => [q.id, q]));

      const wrong = grades.filter((g) => {
        const question = questionById.get(g.questionId);
        return (
          question !== undefined &&
          question.misconceptionId === undefined &&
          g.normalizedScore < PROPOSAL_SCORE_THRESHOLD
        );
      });

      const records: MisconceptionRecord[] = [];
      for (const grade of wrong.slice(0, MAX_PROPOSALS_PER_SUBMISSION)) {
        const question = questionById.get(grade.questionId)!;
        const concept = repos.materials.getConcept(question.conceptId);
        if (!concept) continue;
        const answer = answersById.get(question.id);
        if (!answer) continue;

        try {
          const payload = await provider.proposeMisconception(
            {
              conceptName: concept.name,
              stem: question.stem,
              options: question.options ?? [],
              correctOptionIds: question.correctOptionIds ?? [],
              expectedAnswer: question.expectedAnswer ?? null,
              learnerSelectedOptionIds: answer.selectedOptionIds ?? [],
              learnerText: answer.text ?? null,
              sourceQuote: question.grounding.quote,
              blockId: question.grounding.blockId,
            },
            {
              ...opts,
              telemetry: {
                workspaceId,
                operationType: 'propose_misconception',
                assessmentId: quiz.id,
              },
            },
          );
          if (!payload.applicable) continue;

          // Validate evidence against the blocks of the question's documents.
          const materialIds = new Set<string>([concept.materialId]);
          for (const extra of question.supplementaryEvidence ?? []) {
            const block = repos.materials.getBlock(extra.blockId);
            if (block) materialIds.add(block.materialId);
          }
          const blocks = [...materialIds].flatMap((id) => repos.materials.getBlocks(id));
          const evidence: VerifiedGrounding[] = [];
          for (const proposed of payload.evidence.slice(0, 2)) {
            const verification = verifyGrounding(blocks, proposed);
            if (verification.ok) evidence.push(verification.grounding);
          }

          records.push({
            id: newId('mc'),
            workspaceId,
            conceptId: concept.id,
            conceptName: concept.name,
            originBlueprintId: question.blueprintId ?? null,
            originQuestionId: question.id,
            originQuizId: quiz.id,
            learnerAnswer: answer,
            evidence,
            category: payload.category,
            hypothesis: payload.hypothesis,
            provider: provider.name,
            status: 'proposed',
            decidedByQuizId: null,
            createdAt: at,
            updatedAt: at,
          });
        } catch (error) {
          if (
            opts?.signal?.aborted ||
            (error instanceof ProviderError && error.code === ApiErrorCode.RequestCancelled)
          ) {
            throw error;
          }
          // Proposal is best-effort; grading already succeeded.
          continue;
        }
      }
      return records;
    },
  };
}

export type MisconceptionsService = ReturnType<typeof createMisconceptionsService>;
