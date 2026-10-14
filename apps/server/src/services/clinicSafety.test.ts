import { describe, it, expect, vi } from 'vitest';
import { fixture, cmd } from '../testing/clinicFixture.js';
import { CourseFakeProvider } from '../llm/courseFakeProvider.js';
import type {
  LessonInput,
  LessonVerificationInput,
  QuestionsInput,
  SolveInput,
  ShortAnswerInput,
} from '../llm/courseContract.js';
import { validateLessonDelivery, selectLessonVerificationScopes } from './lessonDelivery.js';
import { sha256 } from '../util/canonical.js';
import { ProviderError } from '../llm/errors.js';
import { canonical } from '../util/canonical.js';
import type { CourseQuiz } from '@hy3-clinic/shared';

describe('正确性反例与调用合同', () => {
  it('核查通过但证据ID越界属于核查合同失败，恢复时复用作者与盲解，不消耗题目替换', async () => {
    const provider = new CourseFakeProvider(),
      f = fixture(provider);
    try {
      const plan = f.accept(await f.prepare());
      const { content, session } = await f.open(plan);
      f.complete(content, session);
      const generate = provider.generateQuestions.bind(provider);
      vi.spyOn(provider, 'generateQuestions').mockImplementation(async (input, options) => ({
        questions: (await generate(input, options)).questions.map((q) => ({
          ...q,
          type: 'short_answer' as const,
          options: [],
          coverage: [],
          answer: [input.knowledge[0]!.statement],
          rubric: [
            {
              id: 'criterion',
              description: '解释命题与条件',
              knowledgeIds: q.knowledgeIds,
              required: true,
              weight: 1,
              acceptableAlternatives: [],
            },
          ],
        })),
      }));
      vi.spyOn(provider, 'solveQuestion').mockImplementation(async (input) => {
        provider.calls.solveQuestion = (provider.calls.solveQuestion ?? 0) + 1;
        return {
          solvable: true,
          answer: [input.requestedKnowledge[0]!.statement],
          explanation: '完整命题',
          missingConditions: [],
          ambiguities: [],
          sourceSupported: true,
          uncertain: false,
          exposureCheck: { novel: true, reason: '新情境' },
          assessedKnowledgeIds: input.requestedKnowledge.map((k) => k.id),
          coverage: [],
        };
      });
      let malformed = true;
      const review = provider.reviewQuestionRubric.bind(provider);
      vi.spyOn(provider, 'reviewQuestionRubric').mockImplementation(async (input, options) => {
        const value = await review(input, options);
        return {
          ...value,
          criteria: value.criteria.map((c) => ({
            ...c,
            assessedKnowledgeIds: malformed ? ['mistyped_evidence_id'] : c.assessedKnowledgeIds,
          })),
        };
      });
      const op = f.c.operations.start(
        f.workspace.id,
        cmd(),
        'preparePractice',
        'review-id',
        'quiz',
        { curriculumId: plan.id, lessonVersionId: content.id, requestId: 'review-id' },
      );
      await f.c.operations.idle(op.id);
      const failed = f.c.operations.get(f.workspace.id, op.id);
      expect(failed.error?.code).toBe('PROVIDER_INVALID_OUTPUT');
      const before = f.c.repo.payload<{ candidateStates: { rejectedCount: number }[] }>(
        'SELECT payload FROM quizzes',
      )!;
      expect(before.candidateStates[0]!.rejectedCount).toBe(0);
      malformed = false;
      await f.settle(f.c.operations.retry(f.workspace.id, failed.id, cmd(), failed.version));
      expect(provider.calls.generateQuestions).toBe(1);
      expect(provider.calls.solveQuestion).toBe(1);
      expect(provider.calls.reviewQuestionRubric).toBe(2);
    } finally {
      await f.close();
    }
  });
  it('历史错误核查误耗尽的slot凭匹配物理核查恢复，不重置作者额度或覆盖拒绝记录', async () => {
    const provider = new CourseFakeProvider(),
      f = fixture(provider);
    try {
      const plan = f.accept(await f.prepare());
      const { content, session } = await f.open(plan);
      f.complete(content, session);
      const author = provider.generateQuestions.bind(provider);
      vi.spyOn(provider, 'generateQuestions').mockImplementation(async (input, options) => ({
        questions: (await author(input, options)).questions.map((q) => ({
          ...q,
          type: 'short_answer' as const,
          options: [],
          coverage: [],
          answer: [input.knowledge[0]!.statement],
          rubric: [
            {
              id: 'criterion',
              description: '解释命题',
              knowledgeIds: q.knowledgeIds,
              required: true,
              weight: 1,
              acceptableAlternatives: [],
            },
          ],
        })),
      }));
      const solve = provider.solveQuestion.bind(provider);
      vi.spyOn(provider, 'solveQuestion').mockImplementation(async (input, options) => ({
        ...(await solve(input, options)),
        solvable: true,
        answer: [input.requestedKnowledge[0]!.statement],
        assessedKnowledgeIds: input.requestedKnowledge.map((k) => k.id),
        coverage: [],
      }));
      let invocation = 0;
      const review = provider.reviewQuestionRubric.bind(provider);
      vi.spyOn(provider, 'reviewQuestionRubric').mockImplementation(async (input, options) => {
        const value = await review(input, options);
        invocation++;
        if (invocation === 1)
          return { ...value, accepted: false, findings: ['原候选评分描述错误'] };
        return invocation === 2
          ? {
              ...value,
              criteria: value.criteria.map((c) => ({
                ...c,
                assessedKnowledgeIds: ['mistyped_id'],
              })),
            }
          : value;
      });
      const op = f.c.operations.start(
        f.workspace.id,
        cmd(),
        'preparePractice',
        'legacy-review',
        'quiz',
        { curriculumId: plan.id, lessonVersionId: content.id, requestId: 'legacy-review' },
      );
      await f.c.operations.idle();
      const failed = f.c.operations.get(f.workspace.id, op.id);
      expect(failed.error?.code).toBe('PROVIDER_INVALID_OUTPUT');
      const quiz = f.c.repo.payload<CourseQuiz>('SELECT payload FROM quizzes')!;
      const state = quiz.candidateStates[0]!;
      expect(state.rejectedCount).toBe(1);
      state.rejectedCount = 2;
      state.findings = ['rubric准入遗漏、隐藏要求或知识覆盖错误'];
      quiz.discarded = [{ slotId: state.slotId, reasons: state.findings }];
      f.c.repo.run('UPDATE quizzes SET payload=? WHERE id=?', canonical(quiz), quiz.id);
      const history = structuredClone(quiz.candidateStates);
      await f.settle(f.c.operations.retry(f.workspace.id, failed.id, cmd(), failed.version));
      const ready = f.c.questions.get(f.workspace.id, quiz.id);
      expect(ready.status).toBe('ready');
      expect(ready.candidateStates).toEqual(history);
      expect(ready.discarded).toEqual(quiz.discarded);
      expect(provider.calls.generateQuestions).toBe(2);
      expect(provider.calls.solveQuestion).toBe(2);
      expect(provider.calls.reviewQuestionRubric).toBe(3);
    } finally {
      await f.close();
    }
  });
  it('同次rubric核查剔除不等价替代答案，保留正确题目，不买作者或审核新轮次', async () => {
    const provider = new CourseFakeProvider(),
      f = fixture(provider);
    try {
      const plan = f.accept(await f.prepare());
      const { content, session } = await f.open(plan);
      f.complete(content, session);
      const generate = provider.generateQuestions.bind(provider);
      vi.spyOn(provider, 'generateQuestions').mockImplementation(async (input, options) => ({
        questions: (await generate(input, options)).questions.map((q) => ({
          ...q,
          type: 'short_answer' as const,
          options: [],
          coverage: [],
          prompt: `写出${input.knowledge[0]!.title}的完整命题与条件。`,
          answer: [input.knowledge[0]!.statement],
          rubric: [
            {
              id: 'criterion',
              description: '准确写出命题与条件',
              knowledgeIds: q.knowledgeIds,
              required: true,
              weight: 1,
              acceptableAlternatives: ['非零时间间隔和零时间间隔可互换'],
            },
          ],
        })),
      }));
      vi.spyOn(provider, 'solveQuestion').mockImplementation(async (input) => {
        provider.calls.solveQuestion = (provider.calls.solveQuestion ?? 0) + 1;
        return {
          solvable: true,
          answer: [input.requestedKnowledge[0]!.statement],
          explanation: '原命题与条件保持',
          missingConditions: [],
          ambiguities: [],
          sourceSupported: true,
          uncertain: false,
          exposureCheck: { novel: true, reason: '新情境' },
          assessedKnowledgeIds: input.requestedKnowledge.map((k) => k.id),
          coverage: [],
        };
      });
      const review = provider.reviewQuestionRubric.bind(provider);
      vi.spyOn(provider, 'reviewQuestionRubric').mockImplementation(async (input, options) => {
        const value = await review(input, options);
        return {
          ...value,
          criteria: value.criteria.map((c) => ({
            ...c,
            alternativeChecks: c.alternativeChecks.map((a) => ({
              ...a,
              equivalent: false,
              reason: '改变了除数非零这一必要条件',
            })),
          })),
        };
      });
      const quiz = await f.practice(plan, content);
      expect(quiz.items[0]!.rubric[0]!.acceptableAlternatives).toEqual([]);
      expect(quiz.candidateStates[0]!.rejectedCount).toBe(0);
      expect(provider.calls.generateQuestions).toBe(1);
      expect(provider.calls.solveQuestion).toBe(1);
      expect(provider.calls.reviewQuestionRubric).toBe(1);
      expect(
        (
          quiz.candidateStates[0]!.candidates[0] as {
            rubric: { acceptableAlternatives: string[] }[];
          }
        ).rubric[0]!.acceptableAlternatives,
      ).toEqual(['非零时间间隔和零时间间隔可互换']);
      expect((await f.submit(quiz)).score).toBe(1);
    } finally {
      await f.close();
    }
  });
  it.each([true, false])(
    '题面未要求的计分项不能扣分，即使其required=%s；仅替换坏题后正确作答得满分',
    async (hiddenRequired) => {
      const provider = new CourseFakeProvider(),
        f = fixture(provider);
      try {
        const plan = f.accept(await f.prepare());
        const { content, session } = await f.open(plan);
        f.complete(content, session);
        const generate = provider.generateQuestions.bind(provider);
        vi.spyOn(provider, 'generateQuestions').mockImplementation(async (input, options) => ({
          questions: (await generate(input, options)).questions.map((q) => ({
            ...q,
            type: 'short_answer' as const,
            options: [],
            prompt: `写出${input.knowledge[0]!.title}的命题与条件。`,
            answer: [input.knowledge[0]!.statement],
            coverage: [],
            rubric: [
              {
                id: 'requested',
                description: '完整写出命题与条件',
                knowledgeIds: q.knowledgeIds,
                required: true,
                weight: 1,
                acceptableAlternatives: [],
              },
              ...(input.revision
                ? []
                : [
                    {
                      id: 'hidden',
                      description: '额外解释教材采用这个概念的历史原因',
                      knowledgeIds: q.knowledgeIds,
                      required: hiddenRequired,
                      weight: 1,
                      acceptableAlternatives: [],
                    },
                  ]),
            ],
          })),
        }));
        vi.spyOn(provider, 'solveQuestion').mockImplementation(async (input) => {
          provider.calls.solveQuestion = (provider.calls.solveQuestion ?? 0) + 1;
          return {
            solvable: true,
            answer: [input.requestedKnowledge[0]!.statement],
            explanation: '公开要求是命题与条件，未要求历史原因。',
            missingConditions: [],
            ambiguities: [],
            sourceSupported: true,
            uncertain: false,
            exposureCheck: { novel: true, reason: '新题面' },
            assessedKnowledgeIds: input.requestedKnowledge.map((k) => k.id),
            coverage: [],
          };
        });
        const review = provider.reviewQuestionRubric.bind(provider);
        vi.spyOn(provider, 'reviewQuestionRubric').mockImplementation(async (input, options) => {
          const value = await review(input, options);
          return {
            ...value,
            criteria: value.criteria.map((c) => ({
              ...c,
              requiredByQuestion: c.criterionId !== 'hidden',
            })),
          };
        });
        const grade = provider.gradeShortAnswer.bind(provider);
        vi.spyOn(provider, 'gradeShortAnswer').mockImplementation(async (input, options) => {
          const value = await grade(input, options);
          return {
            ...value,
            criteria: value.criteria.map((c) => ({ ...c, met: c.criterionId !== 'hidden' })),
            feedback: '与逐项评分理由矛盾的重复总结',
          };
        });
        const quiz = await f.practice(plan, content);
        expect(quiz.candidateStates[0]!.rejectedCount).toBe(1);
        expect(quiz.items[0]!.rubric.map((c) => c.id)).toEqual(['requested']);
        expect(provider.calls.generateQuestions).toBe(2);
        const submitted = await f.submit(quiz);
        expect(submitted.score).toBe(1);
        expect(submitted.itemGrades.every((g) => !g.feedback.includes('矛盾的重复总结'))).toBe(
          true,
        );
        for (const g of submitted.itemGrades)
          expect(g.criteria.every((c) => g.feedback.includes(c.reason))).toBe(true);
        expect(provider.calls.gradeShortAnswer).toBe(1);
        expect(f.c.repo.rows('SELECT * FROM evidence')).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );
  it('低风险Lesson一次作者零核查，本地精确算式可证明；错误推导、漏讲、泛泛共用锚点不能冒充已教', async () => {
    const f = fixture();
    try {
      await f.c.sources.import(f.workspace.id, { content: '# 定义\n\n速度具有大小和方向。' });
      const op = f.c.operations.start(f.workspace.id, cmd(), 'preparePlan', 'plan', 'curriculum', {
        sourceScopeHash: f.c.sources.scopeHash(f.workspace.id),
      });
      await f.settle(op);
      const plan = f.accept(f.c.planning.get(f.workspace.id)!);
      const { content } = await f.open(plan);
      const provider = f.provider as CourseFakeProvider;
      expect(provider.calls.generateLesson).toBe(1);
      expect(provider.calls.verifyLessonParts ?? 0).toBe(0);
      expect(content.deliveryCheck.targetedReceipts).toHaveLength(0);
      const k = f.c.planning.inventory(plan).knowledge;
      const lesson = plan.lessons[0]!;
      expect(() => validateLessonDelivery(lesson, k, { ...content, teachingCoverage: [] })).toThrow(
        '正文漏讲',
      );
      expect(() =>
        validateLessonDelivery(lesson, k, {
          ...content,
          teachingCoverage: content.teachingCoverage.map((c) => ({
            ...c,
            teachingQuote: k[0]!.title,
          })),
        }),
      ).toThrow('标题');
      const calculation = {
        ...content,
        segments: content.segments.map((s) => ({
          ...s,
          kind: 'calculation' as const,
          text: '2 + 3 = 5',
        })),
        teachingCoverage: content.teachingCoverage.map((c) => ({
          ...c,
          teachingQuote: '2 + 3 = 5',
        })),
      };
      const checked = validateLessonDelivery(lesson, k, calculation);
      expect(
        selectLessonVerificationScopes(
          k.map((item) => ({ ...item, statement: '2 + 3 = 5' })),
          calculation,
          [{ text: '2 + 3 = 5' }],
          checked,
        ),
      ).toHaveLength(0);
      expect(() =>
        selectLessonVerificationScopes(
          k,
          {
            ...calculation,
            segments: calculation.segments.map((s) => ({ ...s, text: '2 + 3 = 7' })),
          },
          [{ text: '2 + 3 = 5' }],
          checked,
        ),
      ).toThrow('错误算式');
      for (const text of [
        'x=6×4−4²=24−16=8 m。',
        'v=6−2×4=6−8=−2 m/s。',
        'x=6×4+(1/2)×(−2)×4²=24+(−1)×16=24−16=8 m。',
        't²=9，t=3 s。',
      ]) {
        const author = {
          ...calculation,
          segments: calculation.segments.map((s) => ({ ...s, text })),
        };
        expect(() => selectLessonVerificationScopes(k, author, [], checked)).not.toThrow();
        expect(
          selectLessonVerificationScopes(k, author, [], checked).some((s) =>
            s.reasons.includes('computation_mapping'),
          ),
        ).toBe(true);
      }
      expect(() =>
        selectLessonVerificationScopes(
          k,
          {
            ...calculation,
            segments: calculation.segments.map((s) => ({ ...s, text: '6−2×4=6−7。' })),
          },
          [],
          checked,
        ),
      ).toThrow('错误算式');
    } finally {
      await f.close();
    }
  });
  it('必要证明只传风险段，失败局部修改一次，安全兄弟段hash保持', async () => {
    class RiskProvider extends CourseFakeProvider {
      submitted: LessonVerificationInput[] = [];
      originalSegmentIds: string[] = [];
      override async generateLesson(input: LessonInput) {
        const value = await super.generateLesson(input);
        if (!input.revision) {
          this.originalSegmentIds = value.segments.map((s) => s.id);
          value.segments[0]!.kind = 'proof';
          value.segments[0]!.text += '\n错误推导';
        }
        return value;
      }
      override async verifyLessonParts(input: LessonVerificationInput) {
        this.submitted.push(input);
        const base = await super.verifyLessonParts(input);
        return {
          results: base.results.map((r) => ({
            ...r,
            accepted: !input.segments.some((s) => s.text.includes('错误推导')),
            findings: input.segments.some((s) => s.text.includes('错误推导'))
              ? [`错误推导:${input.segments[0]!.id}`]
              : [],
          })),
        };
      }
    }
    const provider = new RiskProvider();
    const f = fixture(provider);
    try {
      const plan = f.accept(await f.prepare());
      const { content } = await f.open(plan);
      expect(provider.calls.generateLesson).toBe(2);
      expect(content.segments.map((s) => s.id)).toEqual(provider.originalSegmentIds);
      expect(provider.submitted).toHaveLength(1);
      expect(provider.submitted[0]!.segments).toHaveLength(1);
      expect(provider.submitted[0]!.scopes[0]!.reasons).toContain('derivation_or_answered_example');
    } finally {
      await f.close();
    }
  });
  it('例题必要核查含已接受的直接先修事实，不新增模型审核或教学覆盖', async () => {
    const provider = new CourseFakeProvider(),
      f = fixture(provider);
    try {
      const extract = provider.extractCourseKnowledge.bind(provider);
      vi.spyOn(provider, 'extractCourseKnowledge').mockImplementation(async (input, options) => {
        const value = await extract(input, options);
        value.knowledge[3]!.prerequisiteKnowledgeIds = ['k0'];
        return value;
      });
      const plan = f.accept(await f.prepare()),
        inventory = f.c.planning.inventory(plan);
      const lesson = plan.lessons.find((l) =>
        inventory.knowledge.some(
          (k) =>
            l.knowledgeIds.includes(k.id) &&
            k.prerequisiteKnowledgeIds.some((id) => !l.knowledgeIds.includes(id)),
        ),
      );
      expect(lesson).toBeDefined();
      const generate = provider.generateLesson.bind(provider);
      vi.spyOn(provider, 'generateLesson').mockImplementation(async (input, options) => {
        const value = await generate(input, options);
        value.segments.forEach((s) => {
          s.kind = 'worked_example';
        });
        return value;
      });
      const verify = vi.spyOn(provider, 'verifyLessonParts');
      const { content } = await f.open(plan, lesson!.id);
      expect(verify).toHaveBeenCalledTimes(1);
      const input = verify.mock.calls[0]![0];
      const prerequisite = inventory.knowledge
        .filter((k) => lesson!.knowledgeIds.includes(k.id))
        .flatMap((k) => k.prerequisiteKnowledgeIds)
        .find((id) => !lesson!.knowledgeIds.includes(id))!;
      expect(input.knowledge.some((k) => k.id === prerequisite)).toBe(true);
      expect(content.teachingCoverage.some((c) => c.knowledgeId === prerequisite)).toBe(false);
      expect(input.scopes.every((s) => !s.knowledgeIds.includes(prerequisite))).toBe(true);
    } finally {
      await f.close();
    }
  });
  it.each(['missing', 'range', 'foreign'])(
    'Lesson的%s来源引用只修定位段落，同知识的健康段落与coverage保持',
    async (failure) => {
      const provider = new CourseFakeProvider(),
        f = fixture(provider);
      const generate = provider.generateLesson.bind(provider);
      const inputs: LessonInput[] = [];
      let healthy: Awaited<ReturnType<typeof generate>>['segments'][number];
      let healthyCoverage: Awaited<ReturnType<typeof generate>>['teachingCoverage'][number];
      vi.spyOn(provider, 'generateLesson').mockImplementation(async (input, options) => {
        inputs.push(input);
        const value = await generate(input, options);
        if (!input.revision) {
          healthy = structuredClone({ ...value.segments[0]!, id: 'healthy_same_knowledge' });
          healthyCoverage = { ...value.teachingCoverage[0]!, segmentId: healthy.id };
          value.segments.push(healthy);
          value.teachingCoverage.push(healthyCoverage);
          value.segments[0]!.sourceRefs = value.segments[0]!.sourceRefs.map((ref) => ({
            ...ref,
            ...(failure === 'missing'
              ? { blockId: 'fabricated_block' }
              : failure === 'range'
                ? { end: ref.end + 100000 }
                : { revisionId: 'foreign_revision' }),
          }));
        }
        return value;
      });
      try {
        const plan = f.accept(await f.prepare());
        const { content } = await f.open(plan);
        expect(provider.calls.generateLesson).toBe(2);
        expect(inputs[1]!.revision!.segmentIds).toEqual(['segment_0']);
        expect(inputs[1]!.revision!.draft.segments).toHaveLength(1);
        expect(inputs[1]!.revision!.findings[0]).toContain('segment_0:引文不存在');
        expect(content.segments.find((s) => s.id === healthy.id)).toEqual(healthy);
        expect(content.teachingCoverage.find((c) => c.segmentId === healthy.id)).toEqual(
          healthyCoverage,
        );
        for (const ref of content.segments.flatMap((s) => s.sourceRefs))
          expect(() => f.c.sources.validateSpan(f.workspace.id, ref)).not.toThrow();
      } finally {
        await f.close();
      }
    },
  );
  it('错key两候选后丢弃，盲解输入没有key，技术失败不消耗候选额度', async () => {
    class WrongKey extends CourseFakeProvider {
      blind: SolveInput[] = [];
      override async generateQuestions(input: QuestionsInput) {
        const result = await super.generateQuestions(input);
        return { questions: result.questions.map((q) => ({ ...q, answer: ['B'] })) };
      }
      override async solveQuestion(input: SolveInput) {
        this.blind.push(input);
        return super.solveQuestion(input);
      }
    }
    const provider = new WrongKey();
    const f = fixture(provider);
    try {
      const plan = f.accept(await f.prepare());
      const { content, session } = await f.open(plan);
      f.complete(content, session);
      const op = f.c.operations.start(
        f.workspace.id,
        cmd(),
        'preparePractice',
        'practice:bad',
        'quiz',
        { curriculumId: plan.id, lessonVersionId: content.id, requestId: 'bad' },
      );
      await f.c.operations.idle();
      expect(f.c.operations.get(f.workspace.id, op.id).status).toBe('failed');
      expect(provider.calls.generateQuestions).toBe(2);
      expect(provider.blind).toHaveLength(2);
      expect(JSON.stringify(provider.blind)).not.toMatch(/authorAnswer|"rubric"|"answer"/u);
      const quiz = f.c.repo.payloads<{ status: string; discarded: unknown[] }>(
        'SELECT payload FROM quizzes',
      )[0]!;
      expect(quiz.status).toBe('draft');
      expect(quiz.discarded).toHaveLength(1);
      const retry = f.c.operations.retry(f.workspace.id, op.id, cmd(), 3);
      await f.c.operations.idle(retry.id);
      expect(provider.calls.generateQuestions).toBe(2);
    } finally {
      await f.close();
    }
  });
  it('结构损坏的候选仍进入一次带具体错误的局部修订，不能把缓存原候选当成第二次修订', async () => {
    class Malformed extends CourseFakeProvider {
      inputs: QuestionsInput[] = [];
      override async generateQuestions(input: QuestionsInput) {
        this.inputs.push(input);
        const result = await super.generateQuestions(input);
        return input.revision
          ? result
          : {
              questions: result.questions.map((q) => ({
                ...q,
                rubric: [{ description: '缺少评分点标识' }],
              })),
            };
      }
    }
    const provider = new Malformed();
    const f = fixture(provider);
    try {
      const plan = f.accept(await f.prepare());
      const { content, session } = await f.open(plan);
      f.complete(content, session);
      const quiz = await f.practice(plan, content);
      expect(quiz.status).toBe('ready');
      expect(provider.calls.generateQuestions).toBe(2);
      expect(provider.inputs[1]!.revision?.findings).toContain(
        '题目结构无效:rubric.0.id:invalid_type',
      );
      expect(provider.inputs[1]!.revision?.previous).toEqual(
        quiz.candidateStates[0]!.candidates[0],
      );
      expect(quiz.candidateStates[0]!.rejectedCount).toBe(1);
      expect(quiz.discarded).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
  it('模型虚构引文ID属于候选内容错误，在唯一一次局部替换内修复，不能把404当成服务故障', async () => {
    const provider = new CourseFakeProvider();
    const f = fixture(provider);
    try {
      const generate = provider.generateQuestions.bind(provider);
      const inputs: QuestionsInput[] = [];
      vi.spyOn(provider, 'generateQuestions').mockImplementation(async (input, options) => {
        inputs.push(input);
        const value = await generate(input, options);
        return input.revision
          ? value
          : {
              questions: value.questions.map((q) => ({
                ...q,
                sourceRefs: q.sourceRefs.map((ref) => ({ ...ref, blockId: 'fabricated_block' })),
              })),
            };
      });
      const plan = f.accept(await f.prepare());
      const { content, session } = await f.open(plan);
      f.complete(content, session);
      const quiz = await f.practice(plan, content);
      expect(quiz.status).toBe('ready');
      expect(provider.calls.generateQuestions).toBe(2);
      expect(inputs[1]!.revision?.findings).toContain(
        '题目引文不存在、越界或不属于当前来源:fabricated_block',
      );
      expect(quiz.candidateStates[0]!.rejectedCount).toBe(1);
    } finally {
      await f.close();
    }
  });
  it('主观评分逐题保存：技术失败恢复不重判好题；uncertain不写Again/正式成绩', async () => {
    class Subjective extends CourseFakeProvider {
      uncertain = false;
      fail = false;
      override async generateQuestions(input: QuestionsInput) {
        const result = await super.generateQuestions(input);
        return {
          questions: result.questions.map((q) => ({
            ...q,
            type: 'short_answer' as const,
            prompt: `解释${input.knowledge[0]!.title}的完整命题与条件。`,
            options: [],
            answer: [input.knowledge[0]!.statement],
            rubric: [
              {
                id: 'criterion',
                description: '准确描述命题与条件',
                knowledgeIds: q.knowledgeIds,
                required: true,
                weight: 1,
                acceptableAlternatives: [],
              },
            ],
            coverage: [],
          })),
        };
      }
      override async solveQuestion(input: SolveInput) {
        return {
          solvable: true,
          answer: input.requestedKnowledge.map((k) => k.statement),
          explanation: '可根据已学知识解释命题。',
          missingConditions: [],
          ambiguities: [],
          sourceSupported: true,
          uncertain: false,
          exposureCheck: { novel: true, reason: '新情境夹具' },
          assessedKnowledgeIds: [input.requestedKnowledge[0]!.id],
          coverage: [],
        };
      }
      override async gradeShortAnswer(input: ShortAnswerInput) {
        if (this.fail) throw ProviderError.timeout(1);
        const result = await super.gradeShortAnswer(input);
        return { ...result, uncertain: this.uncertain };
      }
    }
    const provider = new Subjective();
    const f = fixture(provider);
    try {
      const plan = f.accept(await f.prepare());
      const { content, session } = await f.open(plan);
      f.complete(content, session);
      const quiz = await f.practice(plan, content);
      expect(quiz.items[0]!.type).toBe('short_answer');
      provider.uncertain = true;
      const result = f.c.grading.submit(
        f.workspace.id,
        quiz.id,
        cmd(),
        quiz.items.map((q) => ({ questionId: q.id, response: q.answer[0]!, assistance: 'none' })),
        quiz.version,
      );
      await f.c.operations.idle();
      expect(provider.calls.gradeShortAnswer).toBe(2);
      expect(
        f.c.repo.row<{ n: number }>('SELECT COUNT(*) AS n FROM successor_review_events')!.n,
      ).toBe(0);
      expect(f.c.repo.owned<{ status: string }>('submissions', result.submission.id).status).toBe(
        'pending',
      );
      expect(
        f.c.repo.row<{ n: number }>('SELECT COUNT(*) AS n FROM assessment_grade_records')!.n,
      ).toBe(0);
    } finally {
      await f.close();
    }
  });
  it('通过标志与非空问题列表冲突时只恢复rubric核查，不耗内容额度、不重买题目或盲解', async () => {
    const provider = new CourseFakeProvider();
    const f = fixture(provider);
    try {
      const plan = f.accept(await f.prepare());
      const { content, session } = await f.open(plan);
      f.complete(content, session);
      const generate = provider.generateQuestions.bind(provider);
      vi.spyOn(provider, 'generateQuestions').mockImplementation(async (input, options) => ({
        questions: (await generate(input, options)).questions.map((q) => ({
          ...q,
          type: 'short_answer' as const,
          options: [],
          prompt: `解释${input.knowledge[0]!.title}。`,
          answer: [input.knowledge[0]!.statement],
          rubric: [
            {
              id: 'criterion',
              description: '解释命题',
              knowledgeIds: q.knowledgeIds,
              required: true,
              weight: 1,
              acceptableAlternatives: [],
            },
          ],
        })),
      }));
      vi.spyOn(provider, 'solveQuestion').mockImplementation(async (input) => {
        provider.calls.solveQuestion = (provider.calls.solveQuestion ?? 0) + 1;
        return {
          solvable: true,
          answer: [input.requestedKnowledge[0]!.statement],
          explanation: '依据公开题面可答。',
          missingConditions: [],
          ambiguities: [],
          sourceSupported: true,
          uncertain: false,
          exposureCheck: { novel: true, reason: '本机夹具' },
          assessedKnowledgeIds: [input.requestedKnowledge[0]!.id],
          coverage: [],
        };
      });
      let conflict = true;
      const review = provider.reviewQuestionRubric.bind(provider);
      vi.spyOn(provider, 'reviewQuestionRubric').mockImplementation(async (input, options) => ({
        ...(await review(input, options)),
        findings: conflict ? ['通过说明或冲突问题'] : [],
      }));
      const op = f.c.operations.start(
        f.workspace.id,
        cmd(),
        'preparePractice',
        'practice:review-conflict',
        'quiz',
        {
          curriculumId: plan.id,
          lessonVersionId: content.id,
          requestId: 'review-conflict',
        },
      );
      await f.c.operations.idle(op.id);
      const failed = f.c.operations.get(f.workspace.id, op.id);
      expect(failed.error?.code).toBe('PROVIDER_INVALID_OUTPUT');
      const before = f.c.repo.payload<{ candidateStates: { rejectedCount: number }[] }>(
        'SELECT payload FROM quizzes',
      )!;
      expect(before.candidateStates[0]!.rejectedCount).toBe(0);
      conflict = false;
      const retried = f.c.operations.retry(f.workspace.id, op.id, cmd(), failed.version);
      await f.settle(retried);
      expect(provider.calls.generateQuestions).toBe(1);
      expect(provider.calls.solveQuestion).toBe(1);
      expect(provider.calls.reviewQuestionRubric).toBe(2);
      expect(f.c.repo.row<{ n: number }>('SELECT COUNT(*) AS n FROM evidence')!.n).toBe(0);
    } finally {
      await f.close();
    }
  });
  it('已有提示观察不改变FSRS数值/到期，Formal没有从诊断授信', async () => {
    const f = fixture();
    try {
      const plan = f.accept(await f.prepare());
      const { content, session } = await f.open(plan);
      f.complete(content, session);
      const q1 = await f.practice(plan, content);
      await f.submit(q1, true);
      const before = f.c.outcomes.list(f.workspace.id)[0]!.schedule;
      const q2 = await f.practice(plan, content);
      const result = f.c.grading.submit(
        f.workspace.id,
        q2.id,
        cmd(),
        q2.items.map((q) => ({ questionId: q.id, response: q.answer, assistance: 'hint' })),
        q2.version,
      );
      await f.settle(result.operation!);
      expect(f.c.outcomes.list(f.workspace.id)[0]!.schedule).toEqual(before);
      expect(f.c.repo.row<{ n: number }>('SELECT COUNT(*) AS n FROM evidence')!.n).toBe(0);
      const event = f.c.repo.row<{ kind: string; rating: null }>(
        'SELECT kind,rating FROM successor_review_events ORDER BY rowid DESC LIMIT 1',
      )!;
      expect(event).toEqual({ kind: 'diagnostic_observation', rating: null });
      const state = sha256(f.db.serialize());
      f.c.outcomes.record(result.submission.id);
      expect(sha256(f.db.serialize())).toBe(state);
    } finally {
      await f.close();
    }
  });
  it('Retest和练习的新情境也须经过曝光核查，不能只给Formal阻止实质重复', async () => {
    const provider = new CourseFakeProvider();
    const f = fixture(provider);
    try {
      const plan = f.accept(await f.prepare());
      const { content, session } = await f.open(plan);
      f.complete(content, session);
      const oldQuiz = await f.practice(plan, content);
      const original = provider.solveQuestion.bind(provider);
      vi.spyOn(provider, 'solveQuestion').mockImplementation(async (input, options) => ({
        ...(await original(input, options)),
        exposureCheck: { novel: false, reason: '只换标签，推理情境完全相同' },
      }));
      const failed = f.c.operations.start(
        f.workspace.id,
        cmd(),
        'preparePractice',
        'practice:duplicate',
        'quiz',
        {
          curriculumId: plan.id,
          lessonVersionId: content.id,
          requestId: 'duplicate',
        },
      );
      await f.c.operations.idle();
      expect(f.c.operations.get(f.workspace.id, failed.id).status).toBe('failed');
      expect(f.c.questions.get(f.workspace.id, oldQuiz.id).status).toBe('ready');
      expect(provider.calls.generateQuestions).toBe(3);
      expect(
        f.c.repo.payload<{ discarded: { reasons: string[] }[] }>(
          "SELECT payload FROM quizzes WHERE request_id='duplicate'",
        )!.discarded[0]!.reasons,
      ).toContain('题目与已曝光题实质重复');
    } finally {
      await f.close();
    }
  });
  it('晚到可靠评分按冻结作答时间与持久配置重放，旧事件字节不改', async () => {
    const f = fixture();
    try {
      const plan = f.accept(await f.prepare());
      const { content, session } = await f.open(plan);
      f.complete(content, session);
      const quiz1 = await f.practice(plan, content);
      const quiz2 = await f.practice(plan, content);
      const one = f.c.grading.submit(
        f.workspace.id,
        quiz1.id,
        cmd(),
        quiz1.items.map((q) => ({ questionId: q.id, response: ['B'], assistance: 'none' })),
        quiz1.version,
      );
      const two = f.c.grading.submit(
        f.workspace.id,
        quiz2.id,
        cmd(),
        quiz2.items.map((q) => ({ questionId: q.id, response: q.answer, assistance: 'none' })),
        quiz2.version,
      );
      const originalRecord = f.c.outcomes.record.bind(f.c.outcomes);
      let held = true;
      f.c.outcomes.record = (id: string) => {
        if (id === one.submission.id && held) throw new Error('injected-local-projection-failure');
        return originalRecord(id);
      };
      await f.c.operations.idle();
      const before = f.c.repo.rows<{ id: string; payload: string }>(
        'SELECT id,payload FROM successor_review_events ORDER BY rowid',
      );
      expect(before).toHaveLength(1);
      expect(f.c.progress(f.workspace.id).pendingStudyOutcomes).toEqual([one.submission.id]);
      held = false;
      const { GradedStudyOutcomes } = await import('./gradedStudyOutcomes.js');
      const { DEFAULT_CONFIGURATION, replayFsrs } = await import('../review/fsrsAdapter.js');
      const custom = {
        ...DEFAULT_CONFIGURATION,
        requestedRetention: 0.8,
        maximumDueHorizonDays: 100,
        configHash: 'late-custom',
      };
      const daily = new GradedStudyOutcomes(f.c.repo, f.c.planning, custom);
      daily.record(one.submission.id);
      daily.record(two.submission.id);
      const current = daily.list(f.workspace.id)[0]!;
      const expectedOrder = [one.submission, two.submission]
        .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.id.localeCompare(b.id))
        .map((submission) => submission.id);
      expect(current.events.map((event) => event.sourceRecordId)).toEqual(expectedOrder);
      expect(current.diagnostic?.sourceRecordId).toBe(expectedOrder.at(-1));
      const serialized = sha256(current.events);
      daily.record(one.submission.id);
      expect(sha256(daily.list(f.workspace.id)[0]!.events)).toBe(serialized);
      const replay = replayFsrs(
        [
          {
            outcome: 'Again',
            occurredAt: one.submission.submittedAt,
            configuration: custom,
            sourceRecordId: one.submission.id,
          },
          {
            outcome: 'Good',
            occurredAt: two.submission.submittedAt,
            configuration: DEFAULT_CONFIGURATION,
            sourceRecordId: two.submission.id,
          },
        ].sort(
          (a, b) =>
            a.occurredAt.localeCompare(b.occurredAt) ||
            a.sourceRecordId.localeCompare(b.sourceRecordId),
        ) as Parameters<typeof replayFsrs>[0],
        current.id,
        custom,
      );
      expect(current.schedule?.dueAt).toBe(replay.dueAt);
      expect(
        f.c.repo.rows('SELECT id,payload FROM successor_review_events WHERE id=?', before[0]!.id),
      ).toEqual(before);
    } finally {
      await f.close();
    }
  });
  it('同毫秒原错题和Retest仍按前件Again→Good回放，画像与调度同序且重放幂等', async () => {
    const f = fixture();
    const clock = vi.spyOn(f.c.repo, 'now').mockReturnValue('2026-10-12T00:00:00.000Z');
    try {
      const plan = f.accept(await f.prepare());
      const { content, session } = await f.open(plan);
      f.complete(content, session);
      const wrong = await f.submit(await f.practice(plan, content), false);
      const round = f.c.repairs.start(f.workspace.id, cmd(), {
        originKind: 'submission',
        originId: wrong.id,
        targetItemIds: wrong.itemGrades.map((grade) => grade.questionId),
      });
      await f.settle(f.c.operations.get(f.workspace.id, round.operationId));
      const ready = f.c.repairs.get(f.workspace.id, round.id);
      const quiz = f.c.questions.get(f.workspace.id, ready.retestQuizId!);
      const result = f.c.repairs.submit(
        f.workspace.id,
        ready.id,
        cmd(),
        quiz.items.map((q) => ({ questionId: q.id, response: q.answer, assistance: 'none' })),
        ready.version,
      );
      await f.settle(result.operation!);
      const current = f.c.outcomes.list(f.workspace.id)[0]!;
      expect(current.events.map((event) => event.rating)).toEqual(['Again', 'Good']);
      expect(current.events[1]!.predecessorSourceRecordId).toBe(wrong.id);
      expect(current.diagnostic?.sourceRecordId).toBe(result.submission.id);
      expect(current.schedule?.repetitions).toBe(2);
      const before = sha256(f.db.serialize());
      f.c.outcomes.record(result.submission.id);
      expect(sha256(f.db.serialize())).toBe(before);
    } finally {
      clock.mockRestore();
      await f.close();
    }
  });
});
