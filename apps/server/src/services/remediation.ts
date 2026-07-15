import type { Quiz, QuizConfig, QuestionType } from '@hy3-clinic/shared';
import { ApiErrorCode, WEAK_MASTERY_THRESHOLD } from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import type { LlmProvider, ProviderCallOptions, RemediationTarget } from '../llm/provider.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import { assembleQuestions } from './quizzes.js';

export interface RemediationServiceDeps {
  repos: Repositories;
  provider: LlmProvider;
  clock: Clock;
}

/** Max weak concepts targeted per remediation round. */
const MAX_TARGETS = 4;
const QUESTIONS_PER_CONCEPT = 2;

export function createRemediationService({ repos, provider, clock }: RemediationServiceDeps) {
  return {
    /**
     * Generate a remediation quiz from the learner's ACTUAL weaknesses:
     * concepts with open mistakes first (most mistakes first), topped up
     * with low-mastery concepts. Every generated question is linked back to
     * the open mistakes it re-tests via sourceMistakeIds, so a correct
     * answer later resolves exactly those mistakes.
     */
    async generate(materialId: string, opts?: ProviderCallOptions): Promise<Quiz> {
      const material = repos.materials.get(materialId);
      if (!material) throw notFound(`学习资料不存在:${materialId}`);
      const blocks = repos.materials.getBlocks(materialId);
      const concepts = repos.materials.getConcepts(materialId);
      const conceptById = new Map(concepts.map((c) => [c.id, c]));

      const openMistakes = repos.mistakes.listOpenByMaterial(materialId);
      const mistakesByConcept = new Map<string, typeof openMistakes>();
      for (const mistake of openMistakes) {
        const list = mistakesByConcept.get(mistake.conceptId) ?? [];
        list.push(mistake);
        mistakesByConcept.set(mistake.conceptId, list);
      }

      // Priority 1: concepts with open mistakes (most open mistakes first).
      const targetIds: string[] = [...mistakesByConcept.keys()]
        .filter((id) => conceptById.has(id))
        .sort((a, b) => {
          const diff = mistakesByConcept.get(b)!.length - mistakesByConcept.get(a)!.length;
          return diff !== 0 ? diff : a.localeCompare(b);
        });

      // Priority 2: low-mastery concepts without open mistakes.
      for (const state of repos.mastery.listByMaterial(materialId)) {
        if (targetIds.length >= MAX_TARGETS) break;
        if (state.mastery < WEAK_MASTERY_THRESHOLD && !targetIds.includes(state.conceptId)) {
          if (conceptById.has(state.conceptId)) targetIds.push(state.conceptId);
        }
      }

      const limited = targetIds.slice(0, MAX_TARGETS);
      if (limited.length === 0) {
        throw new AppError(
          ApiErrorCode.ValidationError,
          '当前没有未解决的错题或薄弱概念,无需生成康复练习。先完成一次测验吧。',
        );
      }

      const targets: RemediationTarget[] = limited.map((conceptId) => {
        const mistakes = mistakesByConcept.get(conceptId) ?? [];
        return {
          concept: conceptById.get(conceptId)!,
          missedStems: mistakes.slice(0, 5).map((m) => m.question.stem),
          openMistakeCount: mistakes.length,
        };
      });

      const payload = await provider.generateRemediation(
        {
          materialTitle: material.title,
          blocks,
          targets,
          questionsPerConcept: QUESTIONS_PER_CONCEPT,
        },
        opts,
      );

      const quizId = newId('qz');
      const { questions, rejected } = assembleQuestions(payload.questions, {
        quizId,
        blocks,
        concepts,
        allowedTypes: ['single_choice', 'short_answer'],
        allowedConceptIds: limited,
      });
      if (questions.length === 0) {
        throw new AppError(
          ApiErrorCode.GroundingFailed,
          '康复练习题目均未通过原文引证校验,请重试。',
          { rejected },
        );
      }

      // Link each question to the open mistakes of its concept and count the
      // remediation attempt on those mistakes.
      const linkedMistakeIds = new Set<string>();
      const questionsWithSources = questions.map((q) => {
        const mistakes = mistakesByConcept.get(q.conceptId) ?? [];
        const ids = mistakes.slice(0, 10).map((m) => m.id);
        ids.forEach((id) => linkedMistakeIds.add(id));
        return ids.length > 0 ? { ...q, sourceMistakeIds: ids } : q;
      });
      repos.mistakes.incrementRemediation([...linkedMistakeIds]);

      const config: QuizConfig = {
        difficulty: 'medium',
        types: [...new Set<QuestionType>(questionsWithSources.map((q) => q.type))],
        countPerType: Math.min(
          5,
          Math.max(
            1,
            Math.ceil(
              questionsWithSources.length / new Set(questionsWithSources.map((q) => q.type)).size,
            ),
          ),
        ),
      };

      const quiz: Quiz = {
        id: quizId,
        materialId,
        kind: 'remediation',
        config,
        questions: questionsWithSources,
        targetConceptIds: limited,
        createdAt: clock.now().toISOString(),
      };
      repos.quizzes.insert(quiz);
      return quiz;
    },
  };
}

export type RemediationService = ReturnType<typeof createRemediationService>;
