import type {
  Concept,
  ProposedQuestion,
  PublicQuiz,
  Question,
  QuestionType,
  Quiz,
  QuizConfig,
  SourceBlock,
} from '@hy3-clinic/shared';
import { ApiErrorCode } from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import { verifyGrounding } from '../grounding/verify.js';
import { POINTS_BY_TYPE } from '../grading/score.js';
import type { LlmProvider, ProviderCallOptions } from '../llm/provider.js';
import type { AnalysisService } from './analysis.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';

export interface QuizServiceDeps {
  repos: Repositories;
  provider: LlmProvider;
  clock: Clock;
  analysis: AnalysisService;
}

export interface AssembleContext {
  quizId: string;
  blocks: SourceBlock[];
  concepts: Concept[];
  allowedTypes?: readonly QuestionType[];
  allowedConceptIds?: readonly string[];
}

export interface AssembleResult {
  questions: Question[];
  rejected: Array<{ stem: string; reason: string }>;
}

/**
 * Convert provider-proposed questions into verified, persisted-shape
 * questions. Each question must reference a known concept and pass
 * deterministic grounding verification; anything else is dropped and
 * reported in `rejected`.
 */
export function assembleQuestions(
  proposed: ProposedQuestion[],
  ctx: AssembleContext,
): AssembleResult {
  const questions: Question[] = [];
  const rejected: AssembleResult['rejected'] = [];
  const conceptById = new Map(ctx.concepts.map((c) => [c.id, c]));

  for (const p of proposed) {
    if (ctx.allowedTypes && !ctx.allowedTypes.includes(p.type)) {
      rejected.push({ stem: p.stem, reason: `未请求的题型:${p.type}` });
      continue;
    }
    if (ctx.allowedConceptIds && !ctx.allowedConceptIds.includes(p.conceptId)) {
      rejected.push({ stem: p.stem, reason: `非目标概念:${p.conceptId}` });
      continue;
    }
    const concept = conceptById.get(p.conceptId);
    if (!concept) {
      rejected.push({ stem: p.stem, reason: `未知概念:${p.conceptId}` });
      continue;
    }
    const verification = verifyGrounding(ctx.blocks, { blockId: p.blockId, quote: p.quote });
    if (!verification.ok) {
      rejected.push({ stem: p.stem, reason: verification.message });
      continue;
    }
    const question: Question = {
      id: newId('que'),
      quizId: ctx.quizId,
      index: questions.length,
      type: p.type,
      stem: p.stem,
      conceptId: concept.id,
      conceptName: concept.name,
      grounding: verification.grounding,
      explanation: p.explanation,
      points: POINTS_BY_TYPE[p.type],
      ...(p.options ? { options: p.options } : {}),
      ...(p.correctOptionIds ? { correctOptionIds: p.correctOptionIds } : {}),
      ...(p.expectedAnswer ? { expectedAnswer: p.expectedAnswer } : {}),
      ...(p.rubricKeyPoints ? { rubric: { keyPoints: p.rubricKeyPoints } } : {}),
    };
    questions.push(question);
  }
  return { questions, rejected };
}

/** Strip server-side secrets (answers/rubrics) for client delivery. */
export function toPublicQuiz(quiz: Quiz): PublicQuiz {
  return {
    id: quiz.id,
    materialId: quiz.materialId,
    kind: quiz.kind,
    config: quiz.config,
    ...(quiz.targetConceptIds ? { targetConceptIds: quiz.targetConceptIds } : {}),
    createdAt: quiz.createdAt,
    questions: quiz.questions.map((q) => ({
      id: q.id,
      index: q.index,
      type: q.type,
      stem: q.stem,
      ...(q.options ? { options: q.options } : {}),
      conceptId: q.conceptId,
      conceptName: q.conceptName,
      grounding: q.grounding,
      points: q.points,
    })),
  };
}

export function createQuizService({ repos, provider, clock, analysis }: QuizServiceDeps) {
  return {
    /**
     * Generate a quiz for a material. Runs concept analysis automatically if
     * it has not been done yet. All questions are grounding-verified before
     * persistence; a quiz with zero surviving questions fails structured.
     *
     * `options.targetConceptIds` (used when launching focused practice from
     * an accepted remediation plan) restricts both the concepts offered to
     * the provider and the concepts accepted back.
     */
    async generate(
      materialId: string,
      config: QuizConfig,
      opts?: ProviderCallOptions,
      options?: { targetConceptIds?: readonly string[] },
    ): Promise<Quiz> {
      const material = repos.materials.get(materialId);
      if (!material) throw notFound(`学习资料不存在:${materialId}`);
      const blocks = repos.materials.getBlocks(materialId);

      let concepts = repos.materials.getConcepts(materialId);
      if (concepts.length === 0) {
        concepts = await analysis.analyze(materialId, opts);
      }

      const targetIds = options?.targetConceptIds;
      const offeredConcepts = targetIds
        ? concepts.filter((c) => targetIds.includes(c.id))
        : concepts;
      if (offeredConcepts.length === 0) {
        throw new AppError(ApiErrorCode.ValidationError, '目标概念不属于该资料,无法出题。');
      }

      const payload = await provider.generateQuiz(
        { materialTitle: material.title, blocks, concepts: offeredConcepts, config },
        opts,
      );

      const quizId = newId('qz');
      const { questions, rejected } = assembleQuestions(payload.questions, {
        quizId,
        blocks,
        concepts,
        allowedTypes: config.types,
        ...(targetIds ? { allowedConceptIds: targetIds } : {}),
      });

      if (questions.length === 0) {
        throw new AppError(
          ApiErrorCode.GroundingFailed,
          '生成的题目均未通过原文引证校验,请重试或调整题目配置。',
          { rejected },
        );
      }

      const quiz: Quiz = {
        id: quizId,
        materialId,
        kind: 'standard',
        config,
        questions,
        ...(targetIds ? { targetConceptIds: [...targetIds] } : {}),
        createdAt: clock.now().toISOString(),
      };
      repos.quizzes.insert(quiz);
      return quiz;
    },

    get(quizId: string): Quiz {
      const quiz = repos.quizzes.get(quizId);
      if (!quiz) throw notFound(`测验不存在:${quizId}`);
      return quiz;
    },
  };
}

export type QuizService = ReturnType<typeof createQuizService>;
