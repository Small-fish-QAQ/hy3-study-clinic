import type { Question, Quiz, QuizConfig } from '@hy3-clinic/shared';
import { ApiErrorCode } from '@hy3-clinic/shared';
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

/** At most three currently-open concepts are targeted per remediation round. */
const MAX_TARGETS = 3;
const QUESTIONS_PER_CONCEPT = 2;
const REQUIRED_QUESTION_TYPES = ['single_choice', 'short_answer'] as const;

export function createRemediationService({ repos, provider, clock }: RemediationServiceDeps) {
  return {
    /**
     * Generate a remediation quiz only from concepts with currently open
     * mistakes (most mistakes first). Every generated question is linked
     * back to the open mistakes it re-tests via sourceMistakeIds, so a
     * correct answer later resolves exactly those mistakes.
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

      // Concepts with open mistakes, most open mistakes first. The id
      // tie-breaker keeps selection deterministic across runs.
      const targetIds: string[] = [...mistakesByConcept.keys()]
        .filter((id) => conceptById.has(id))
        .sort((a, b) => {
          const diff = mistakesByConcept.get(b)!.length - mistakesByConcept.get(a)!.length;
          return diff !== 0 ? diff : a.localeCompare(b);
        });

      const limited = targetIds.slice(0, MAX_TARGETS);
      if (limited.length === 0) {
        throw new AppError(ApiErrorCode.ValidationError, '当前没有未解决的错题,无需生成康复练习。');
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
      const { questions: assembledQuestions, rejected } = assembleQuestions(payload.questions, {
        quizId,
        blocks,
        concepts,
        allowedTypes: REQUIRED_QUESTION_TYPES,
        allowedConceptIds: limited,
      });

      // Provider schema validation guarantees valid individual question
      // shapes, while this service enforces the remediation product rule:
      // exactly the first grounded question of each required type per target.
      const selectedQuestions: Question[] = [];
      const missing: Array<{ conceptId: string; type: (typeof REQUIRED_QUESTION_TYPES)[number] }> =
        [];
      for (const conceptId of limited) {
        for (const type of REQUIRED_QUESTION_TYPES) {
          const question = assembledQuestions.find(
            (candidate) => candidate.conceptId === conceptId && candidate.type === type,
          );
          if (question) selectedQuestions.push(question);
          else missing.push({ conceptId, type });
        }
      }
      if (missing.length > 0) {
        throw new AppError(
          ApiErrorCode.GroundingFailed,
          '康复练习未能为每个未解决概念生成完整的单选题和简答题,请重试。',
          { missing, rejected },
        );
      }
      const questions = selectedQuestions.map((question, index) => ({ ...question, index }));

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
        types: [...REQUIRED_QUESTION_TYPES],
        countPerType: limited.length,
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
