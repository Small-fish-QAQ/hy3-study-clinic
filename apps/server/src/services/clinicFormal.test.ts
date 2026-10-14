import { describe, it, expect, vi } from 'vitest';
import { fixture, cmd } from '../testing/clinicFixture.js';
import { CourseFakeProvider } from '../llm/courseFakeProvider.js';
import type {
  QuestionsInput,
  SolveInput,
  RubricReviewInput,
  ShortAnswerInput,
} from '../llm/courseContract.js';
import { ProviderError } from '../llm/errors.js';
import { questionHash } from './questionAdmission.js';
import { checkPaperCoverage } from './courseQuestions.js';
import type { CourseQuiz, CourseSubmission } from '@hy3-clinic/shared';
import { sha256 } from '../util/canonical.js';

describe('逐题可信Formal与代表性 A06/A08/A09/A11', () => {
  it('修订作者超时后的技术恢复保持代表知识、来源与原一次替换额度', async () => {
    const provider = new CourseFakeProvider(),
      f = fixture(provider);
    try {
      const plan = f.accept(await f.prepare());
      const original = provider.generateQuestions.bind(provider);
      const revisions: QuestionsInput[] = [];
      vi.spyOn(provider, 'generateQuestions').mockImplementation(async (input, options) => {
        if (input.revision) {
          revisions.push(structuredClone(input));
          throw ProviderError.timeout();
        }
        const result = await original(input, options);
        result.questions[0] = { ...result.questions[0], answer: ['B'] };
        return result;
      });
      const op = f.c.operations.start(
        f.workspace.id,
        cmd(),
        'prepareFormal',
        'formal:revision-timeout',
        'formal',
        {
          curriculumId: plan.id,
          blueprintId: plan.assessmentBlueprint.id,
          paperRequestId: 'revision-timeout',
          moduleId: plan.modules[0]!.id,
        },
      );
      await f.c.operations.idle(op.id);
      const failed = f.c.operations.get(f.workspace.id, op.id);
      expect(failed.error?.code).toBe('PROVIDER_TIMEOUT');
      const paper = f.c.repo.payloads<CourseQuiz>('SELECT payload FROM quizzes')[0]!;
      expect(paper.candidateStates[0]!.rejectedCount).toBe(1);
      expect(paper.paperCoverageSelection[0]!.replacements).toHaveLength(1);
      const before = structuredClone(paper.paperCoverageSelection);
      const retry = f.c.operations.retry(f.workspace.id, op.id, cmd(), failed.version);
      await f.c.operations.idle(retry.id);
      expect(f.c.operations.get(f.workspace.id, retry.id).error?.code).toBe('PROVIDER_TIMEOUT');
      const retained = f.c.questions.get(f.workspace.id, paper.id);
      expect(revisions).toHaveLength(2);
      expect(revisions[1]).toEqual(revisions[0]);
      expect(retained.paperCoverageSelection).toEqual(before);
      expect(retained.candidateStates[0]!.rejectedCount).toBe(1);
      expect(retained.candidateStates[0]!.candidates).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
  it('实测成员已获独立支持时，本地补全遗漏的代表集合ID，不重复购买有效题目', async () => {
    const provider = new CourseFakeProvider();
    const f = fixture(provider);
    try {
      const plan = f.accept(await f.prepare());
      const solve = provider.solveQuestion.bind(provider);
      let first = true;
      vi.spyOn(provider, 'solveQuestion').mockImplementation(async (input, options) => {
        const value = await solve(input, options);
        if (first) {
          first = false;
          value.coverage.forEach((c) => {
            c.representativeSetIds = [];
          });
        }
        return value;
      });
      const op = await f.settle(
        f.c.operations.start(
          f.workspace.id,
          cmd(),
          'prepareFormal',
          'formal:missing-representative',
          'formal',
          {
            curriculumId: plan.id,
            blueprintId: plan.assessmentBlueprint.id,
            paperRequestId: 'missing-representative',
          },
        ),
      );
      const paper = f.c.questions.get(f.workspace.id, op.resourceId!);
      expect(paper.status).toBe('ready');
      expect(checkPaperCoverage(paper)).toEqual([]);
      expect(provider.calls.generateQuestions).toBe(1);
      expect(paper.candidateStates[0]!.rejectedCount).toBe(0);
      expect(paper.items[0]!.admission.coverage[0]!.representativeSetIds.length).toBeGreaterThan(0);
      expect(paper.discarded).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
  it('历史仅缺集合标签的耗尽候选从原核查缓存恢复，不重置额度；缓存缺失禁止新模型调用', async () => {
    const provider = new CourseFakeProvider(),
      f = fixture(provider);
    try {
      const plan = f.accept(await f.prepare());
      const admit = f.c.admission.admit.bind(f.c.admission);
      // Reproduce the previous admission behavior without altering model results.
      const legacy = vi.spyOn(f.c.admission, 'admit').mockImplementation(async (...args) => {
        const question = await admit(...args);
        question.coverage.forEach((c) => {
          c.representativeSetIds = [];
        });
        question.admission.coverage.forEach((c) => {
          c.representativeSetIds = [];
        });
        return question;
      });
      const op = f.c.operations.start(
        f.workspace.id,
        cmd(),
        'prepareFormal',
        'formal:metadata',
        'formal',
        {
          curriculumId: plan.id,
          blueprintId: plan.assessmentBlueprint.id,
          paperRequestId: 'metadata',
        },
      );
      await f.c.operations.idle(op.id);
      const failed = f.c.operations.get(f.workspace.id, op.id);
      expect(failed.status).toBe('failed');
      const before = f.c.repo.payloads<CourseQuiz>('SELECT payload FROM quizzes')[0]!;
      expect(before.candidateStates.every((s) => s.rejectedCount === 2)).toBe(true);
      const candidateHash = sha256(before.candidateStates);
      const calls = { ...provider.calls };
      legacy.mockRestore();
      const missingCache = vi.spyOn(f.c.generation, 'retainedStage').mockReturnValue(null);
      const retry = f.c.operations.retry(f.workspace.id, op.id, cmd(), failed.version);
      await f.c.operations.idle(retry.id);
      const blocked = f.c.operations.get(f.workspace.id, retry.id);
      expect(blocked.error?.code).toBe('VERSION_CONFLICT');
      expect(provider.calls).toEqual(calls);
      expect(f.c.questions.get(f.workspace.id, before.id).status).toBe('draft');
      missingCache.mockRestore();
      await f.settle(f.c.operations.retry(f.workspace.id, retry.id, cmd(), blocked.version));
      const ready = f.c.questions.get(f.workspace.id, before.id);
      expect(ready.status).toBe('ready');
      expect(checkPaperCoverage(ready)).toEqual([]);
      expect(sha256(ready.candidateStates)).toBe(candidateHash);
      expect(ready.discarded).toEqual(before.discarded); // The original rejection audit remains.
      expect(provider.calls).toEqual(calls);
      ready.items.forEach((q) => f.c.admission.validateAccepted(q));
    } finally {
      await f.close();
    }
  });
  it.each(['unknown', 'unassessed'])(
    '本地集合归属计算仍拒绝%s代表声明，不把背景知识广播成实测',
    async (claim) => {
      const provider = new CourseFakeProvider(),
        f = fixture(provider);
      try {
        const authorPlan = provider.generateCoursePlan.bind(provider);
        vi.spyOn(provider, 'generateCoursePlan').mockImplementation(async (input, options) => {
          const output = await authorPlan(input, options);
          if ('lessons' in output) {
            const keys = output.lessons[0]!.knowledgeIds;
            output.assessmentDesign.cells[0]!.representativeSets = [
              { id: 'first', candidateKnowledgeIds: [keys[0]!] },
              { id: 'second', candidateKnowledgeIds: [keys[1]!] },
            ];
          }
          return output;
        });
        const solve = provider.solveQuestion.bind(provider);
        vi.spyOn(provider, 'solveQuestion').mockImplementation(async (input, options) => {
          const value = await solve(input, options);
          value.coverage.forEach((c) => {
            c.representativeSetIds = [claim === 'unknown' ? 'foreign-set' : 'second'];
          });
          return value;
        });
        const plan = f.accept(await f.prepare());
        const op = f.c.operations.start(
          f.workspace.id,
          cmd(),
          'prepareFormal',
          `formal:bad-set:${claim}`,
          'formal',
          {
            curriculumId: plan.id,
            blueprintId: plan.assessmentBlueprint.id,
            paperRequestId: `bad-set:${claim}`,
          },
        );
        await f.c.operations.idle(op.id);
        const failed = f.c.operations.get(f.workspace.id, op.id);
        expect(failed.status).toBe('failed');
        const paper = f.c.repo.payloads<CourseQuiz>('SELECT payload FROM quizzes')[0]!;
        expect(
          paper.discarded[0]!.reasons.some((r) => r.startsWith('代表集合没有实际考查成员:')),
        ).toBe(true);
        const calls = { ...provider.calls };
        const retry = f.c.operations.retry(f.workspace.id, op.id, cmd(), failed.version);
        await f.c.operations.idle(retry.id);
        expect(provider.calls).toEqual(calls);
        expect(f.c.questions.get(f.workspace.id, paper.id).status).toBe('draft');
        expect(f.c.repo.rows('SELECT * FROM evidence')).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );
  it('坏题只替换原slot一次，已准入兄弟hash/调用不变，必考缺口不能开考', async () => {
    class Bad extends CourseFakeProvider {
      authored: QuestionsInput[] = [];
      solved: SolveInput[] = [];
      override async generateQuestions(input: QuestionsInput) {
        this.authored.push(input);
        const result = await super.generateQuestions(input);
        return {
          questions: result.questions.map((q, i) =>
            input.revision || i === 0 ? { ...q, answer: ['B'] } : q,
          ),
        };
      }
      override async solveQuestion(input: SolveInput) {
        this.solved.push(input);
        return super.solveQuestion(input);
      }
    }
    const provider = new Bad();
    const f = fixture(provider);
    try {
      const plan = f.accept(await f.prepare());
      const op = f.c.operations.start(
        f.workspace.id,
        cmd(),
        'prepareFormal',
        'formal:bad',
        'formal',
        { curriculumId: plan.id, blueprintId: plan.assessmentBlueprint.id, paperRequestId: 'bad' },
      );
      await f.c.operations.idle();
      const failed = f.c.operations.get(f.workspace.id, op.id);
      expect(failed.status).toBe('failed');
      const paper = f.c.repo.payloads<CourseQuiz>('SELECT payload FROM quizzes')[0]!;
      expect(paper.items).toHaveLength(1);
      expect(paper.discarded).toHaveLength(1);
      expect(checkPaperCoverage(paper).length).toBeGreaterThan(0);
      expect(provider.calls.generateQuestions).toBe(2);
      expect(provider.authored[1]!.slots).toHaveLength(1);
      const revised = provider.authored[1]!;
      expect(revised.knowledge.map((k) => k.id).sort()).toEqual(
        [...new Set(revised.slots.flatMap((s) => s.knowledgeIds))].sort(),
      );
      expect(revised.blueprint!.cells).toHaveLength(1);
      expect(
        revised.sources.every((source) =>
          revised.knowledge.some((k) => k.sourceSpans.some((span) => span.blockId === source.id)),
        ),
      ).toBe(true);
      expect(paper.paperCoverageSelection[0]!.replacements.length).toBeLessThanOrEqual(1);
      const hash = questionHash(paper.items[0]!);
      const count = { ...provider.calls };
      const next = f.c.operations.retry(f.workspace.id, op.id, cmd(), failed.version);
      await f.c.operations.idle(next.id);
      const retained = f.c.questions.get(f.workspace.id, paper.id);
      expect(questionHash(retained.items[0]!)).toBe(hash);
      expect(provider.calls).toEqual(count);
      expect(f.c.repo.row<{ n: number }>('SELECT COUNT(*) AS n FROM assessment_attempts')!.n).toBe(
        0,
      );
    } finally {
      await f.close();
    }
  });
  it('显式补题保留好题和原slot耗尽记录，固定同一蓝图；并发与技术恢复不再次购买或重置旧额度', async () => {
    class Partial extends CourseFakeProvider {
      bad = true;
      authored: QuestionsInput[] = [];
      override async generateQuestions(input: QuestionsInput) {
        this.authored.push(input);
        const result = await super.generateQuestions(input);
        return {
          questions: result.questions.map((q, i) =>
            this.bad && (input.revision || i === 0) ? { ...q, answer: ['B'] } : q,
          ),
        };
      }
    }
    const provider = new Partial(),
      f = fixture(provider);
    try {
      const plan = f.accept(await f.prepare());
      const request = {
        curriculumId: plan.id,
        blueprintId: plan.assessmentBlueprint.id,
        paperRequestId: 'supplement',
      };
      const op = f.c.operations.start(
        f.workspace.id,
        cmd(),
        'prepareFormal',
        'formal:supplement',
        'formal',
        request,
      );
      await f.c.operations.idle(op.id);
      const failed = f.c.operations.get(f.workspace.id, op.id);
      const prior = f.c.repo.payloads<CourseQuiz>('SELECT payload FROM quizzes')[0]!;
      const good = prior.items[0]!,
        goodHash = questionHash(good),
        blueprint = prior.blueprint;
      const exhausted = prior.candidateStates.find((s) => s.rejectedCount === 2)!;
      provider.bad = false;
      const firstCommand = cmd();
      const response = await f.app.inject({
        method: 'POST',
        url: `/api/workspaces/${f.workspace.id}/operations/${failed.id}/supplement-formal`,
        payload: { command: firstCommand, expectedVersion: failed.version },
      });
      expect(response.statusCode).toBe(202);
      const next = response.json();
      const duplicate = await f.app.inject({
        method: 'POST',
        url: `/api/workspaces/${f.workspace.id}/operations/${failed.id}/supplement-formal`,
        payload: { command: firstCommand, expectedVersion: failed.version },
      });
      expect(duplicate.json().id).toBe(next.id);
      await f.settle(next);
      const ready = f.c.questions.get(f.workspace.id, prior.id);
      expect(ready.status).toBe('ready');
      expect(ready.blueprint).toEqual(blueprint);
      expect(questionHash(ready.items.find((q) => q.id === good.id)!)).toBe(goodHash);
      expect(ready.candidateStates.find((s) => s.slotId === exhausted.slotId)!.rejectedCount).toBe(
        2,
      );
      expect(ready.supplementActions).toHaveLength(1);
      expect(ready.supplementActions[0]!.slots[0]!.previousSlotId).toBe(exhausted.slotId);
      expect(provider.calls.generateQuestions).toBe(3);
      expect(provider.authored[2]!.slots).toHaveLength(1);
      expect(provider.authored[2]!.previousRejections).toEqual([
        {
          slotId: ready.supplementActions[0]!.slots[0]!.slotId,
          previous: exhausted.candidates.at(-1),
          findings: exhausted.findings,
        },
      ]);
      expect(f.c.repo.row<{ n: number }>('SELECT COUNT(*) AS n FROM assessment_attempts')!.n).toBe(
        0,
      );
      const stale = await f.app.inject({
        method: 'POST',
        url: `/api/workspaces/${f.workspace.id}/operations/${failed.id}/supplement-formal`,
        payload: { command: cmd(), expectedVersion: failed.version },
      });
      expect(stale.statusCode).toBe(409);
      expect(provider.calls.generateQuestions).toBe(3);
    } finally {
      await f.close();
    }
  });
  it('客观/主观混卷按criterion准入和判分，评分失败恢复只补缺项，固定cell权重不被题数稀释', async () => {
    class Mixed extends CourseFakeProvider {
      fail = true;
      override async generateQuestions(input: QuestionsInput) {
        const result = await super.generateQuestions(input);
        return {
          questions: result.questions.map((q, i) =>
            i === 0
              ? q
              : {
                  ...q,
                  type: 'short_answer' as const,
                  prompt: `请解释${input.knowledge.find((k) => q.knowledgeIds.includes(k.id))!.title}的命题与适用条件。`,
                  options: [],
                  answer: [input.knowledge.find((k) => q.knowledgeIds.includes(k.id))!.statement],
                  rubric: [
                    {
                      id: 'criterion',
                      description: '保留实质命题与条件',
                      knowledgeIds: q.knowledgeIds,
                      required: true,
                      weight: 1,
                      acceptableAlternatives: [],
                    },
                  ],
                  coverage: q.coverage.map((c) => ({ ...c, criterionIds: ['criterion'] })),
                },
          ),
        };
      }
      override async solveQuestion(input: SolveInput) {
        if (input.question.type !== 'short_answer') return super.solveQuestion(input);
        const knowledgeId = input.requestedKnowledge[0]!.id;
        return {
          solvable: true,
          answer: [input.requestedKnowledge[0]!.statement],
          explanation: '命题与条件可以独立解释。',
          missingConditions: [],
          ambiguities: [],
          sourceSupported: true,
          uncertain: false,
          exposureCheck: { novel: true, reason: '新情境夹具' },
          assessedKnowledgeIds: [knowledgeId],
          coverage: input.expectedCells.map((c) => ({
            cellId: c.id,
            criterionIds: ['pending_rubric'],
            assessedKnowledgeIds: [knowledgeId],
            representativeSetIds: c.representativeSets
              .filter((s) => s.candidateKnowledgeIds.includes(knowledgeId))
              .map((s) => s.id),
            demand: c.demand,
          })),
        };
      }
      override async reviewQuestionRubric(input: RubricReviewInput) {
        const result = await super.reviewQuestionRubric(input);
        return {
          ...result,
          coverage: input.independentSolution.coverage.map((c) => ({
            ...c,
            criterionIds: input.rubric.map((c) => c.id),
          })),
        };
      }
      override async gradeShortAnswer(input: ShortAnswerInput) {
        if (this.fail) throw ProviderError.timeout(1);
        return super.gradeShortAnswer(input);
      }
    }
    const provider = new Mixed();
    const f = fixture(provider);
    try {
      const plan = f.accept(await f.prepare());
      const paperOp = await f.settle(
        f.c.operations.start(f.workspace.id, cmd(), 'prepareFormal', 'formal:mixed', 'formal', {
          curriculumId: plan.id,
          blueprintId: plan.assessmentBlueprint.id,
          paperRequestId: 'mixed',
        }),
      );
      const paper = f.c.questions.get(f.workspace.id, paperOp.resourceId!);
      expect(paper.items.map((q) => q.type)).toEqual(['single_choice', 'short_answer']);
      f.c.grading.startFormal(f.workspace.id, paper.id, cmd());
      const result = f.c.grading.submit(
        f.workspace.id,
        paper.id,
        cmd(),
        paper.items.map((q) => ({
          questionId: q.id,
          response: q.type === 'short_answer' ? q.answer[0]! : q.answer,
          assistance: 'none',
        })),
        paper.version,
      );
      await f.c.operations.idle();
      const failed = f.c.operations.get(f.workspace.id, result.operation!.id);
      expect(failed.status).toBe('failed');
      expect(
        f.c.repo.row<{ n: number }>('SELECT COUNT(*) AS n FROM assessment_item_grades')!.n,
      ).toBe(1);
      expect(
        f.c.repo.row<{ n: number }>('SELECT COUNT(*) AS n FROM assessment_grade_records')!.n,
      ).toBe(0);
      provider.fail = false;
      const retry = f.c.operations.retry(f.workspace.id, failed.id, cmd(), failed.version);
      await f.settle(retry);
      expect(provider.calls.gradeShortAnswer).toBe(1);
      expect(
        f.c.repo.row<{ n: number }>('SELECT COUNT(*) AS n FROM assessment_item_grades')!.n,
      ).toBe(2);
      expect(f.c.records(f.workspace.id).formalGrades).toHaveLength(1);
      expect(
        f.c.repo.row<{ n: number }>('SELECT COUNT(*) AS n FROM successor_review_events')!.n,
      ).toBe(2);
      expect(f.c.repo.row<{ n: number }>('SELECT COUNT(*) AS n FROM evidence')!.n).toBe(2);
      const submission = f.c.repo.owned<CourseSubmission>('submissions', result.submission.id);
      expect(submission.score).toBe(1);
      f.c.outcomes.record(submission.id);
      expect(
        f.c.repo.row<{ n: number }>('SELECT COUNT(*) AS n FROM successor_review_events')!.n,
      ).toBe(2);
      const gradeBytes = f.c.repo.row<{ payload: string }>(
        'SELECT payload FROM assessment_grade_records',
      )!.payload;
      expect(f.c.records(f.workspace.id).formalGrades[0]!.currentSource).toBe(true);
      await f.c.sources.import(f.workspace.id, {
        content: '新增教材命题说明当前来源范围已经改变。',
      });
      expect(f.c.records(f.workspace.id).formalGrades[0]!.currentSource).toBe(false);
      expect(
        f.c.repo.row<{ payload: string }>('SELECT payload FROM assessment_grade_records')!.payload,
      ).toBe(gradeBytes);
    } finally {
      await f.close();
    }
  });
});
