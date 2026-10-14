import { describe, it, expect, vi } from 'vitest';
import type { CourseKnowledge, CoursePlan } from '@hy3-clinic/shared';
import type {
  KnowledgeInput,
  KnowledgeReviewInput,
  PlanInput,
  PlanOutput,
  PlanRevisionInput,
} from '../llm/courseContract.js';
import { CourseFakeProvider } from '../llm/courseFakeProvider.js';
import { fixture, cmd } from '../testing/clinicFixture.js';
import { constraintNeedsReview, planningReviewLessons } from './courseCorrectnessScopes.js';
import { sha256 } from '../util/canonical.js';

describe('Semantic authority boundaries', () => {
  it.each(['legacy', 'changed'])(
    'a %s review context resumes the necessary check before buying a content revision',
    async (context) => {
      class PreviousReview extends CourseFakeProvider {
        reject = true;
        override async extractCourseKnowledge(input: KnowledgeInput) {
          const value = await super.extractCourseKnowledge(input);
          value.knowledge.forEach((k) => {
            k.kind = 'condition';
          });
          return value;
        }
        override async reviewKnowledgeScope(input: KnowledgeReviewInput) {
          const value = await super.reviewKnowledgeScope(input);
          const lesson = input.lessons?.[0];
          return this.reject && lesson
            ? {
                ...value,
                accepted: false,
                findings: ['旧核查上下文不完整'],
                issues: [
                  {
                    code: 'missing_content' as const,
                    knowledgeIds: lesson.knowledgeIds,
                    lessonIds: [lesson.id],
                    message: '旧核查上下文不完整',
                  },
                ],
              }
            : value;
        }
      }
      const provider = new PreviousReview(),
        f = fixture(provider);
      try {
        await f.c.sources.import(f.workspace.id, { content: '# 条件\n\n仅用工具甲完成测量。' });
        const operation = f.c.operations.start(
          f.workspace.id,
          cmd(),
          'preparePlan',
          'old-scope',
          'curriculum',
          { sourceScopeHash: f.c.sources.scopeHash(f.workspace.id) },
        );
        await f.c.operations.idle(operation.id);
        const failed = f.c.operations.get(f.workspace.id, operation.id);
        expect(failed.status).toBe('failed');
        const saved = f.c.repo.payloads<{
          id: string;
          value: PlanOutput;
          findings: { reviewContextHash?: string }[];
        }>('SELECT payload FROM course_plan_candidates ORDER BY rowid DESC')[0]!;
        const contentHash = sha256(saved.value);
        expect(saved.findings[0]!.reviewContextHash).toBeTruthy();
        if (context === 'legacy') delete saved.findings[0]!.reviewContextHash;
        else saved.findings[0]!.reviewContextHash = 'old-narrow-input';
        f.c.repo.run(
          'INSERT INTO course_plan_candidates SELECT ?,workspace_id,inventory_id,request_key,id,candidate_hash,?,? FROM course_plan_candidates WHERE id=?',
          `${saved.id}_historical_context`,
          JSON.stringify({ ...saved, id: `${saved.id}_historical_context`, parentId: saved.id }),
          f.c.repo.now(),
          saved.id,
        );
        provider.reject = false;
        await f.settle(f.c.operations.retry(f.workspace.id, failed.id, cmd(), failed.version));
        expect(provider.calls.generateCoursePlan).toBe(1);
        expect(provider.calls.extractCourseKnowledge).toBe(1);
        expect(provider.calls.reviseCoursePlan ?? 0).toBe(0);
        expect(provider.calls.reviewKnowledgeScope).toBe(2);
        expect(
          sha256(
            f.c.repo.payloads<{ value: PlanOutput }>(
              'SELECT payload FROM course_plan_candidates ORDER BY rowid DESC',
            )[0]!.value,
          ),
        ).toBe(contentHash);
        expect(f.c.planning.get(f.workspace.id)!.status).toBe('draft');
      } finally {
        await f.close();
      }
    },
  );
  it('a local objective check carries sibling knowledge supporting the visible whole-lesson summary', async () => {
    const f = fixture();
    try {
      const plan = await f.prepare();
      const inventory = f.c.planning.inventory(plan);
      const first = inventory.knowledge[0]!,
        sibling = inventory.knowledge[1]!;
      const lesson = {
        ...plan.lessons[0]!,
        summary: '两个来源例题一起讲解',
        knowledgeIds: [first.id, sibling.id],
        objectives: [
          { id: 'risk', title: '证明新情境', demand: 'apply' as const, knowledgeIds: [first.id] },
          {
            id: 'healthy',
            title: sibling.title,
            demand: 'understand' as const,
            knowledgeIds: [sibling.id],
          },
        ],
      };
      const scopes = planningReviewLessons({ ...plan, lessons: [lesson] }, inventory.knowledge);
      expect(scopes).toHaveLength(1);
      expect(scopes[0]!.knowledgeIds).toEqual(expect.arrayContaining([first.id, sibling.id]));
      expect(scopes[0]!.summary).toBe(lesson.summary);
      expect(scopes[0]!.objectives.map((o) => o.id)).toContain('risk');
    } finally {
      await f.close();
    }
  });
  it('a recast condition retaining keywords still uses the existing source check and local correction', async () => {
    const source = '如果时间间隔非零，平均速度等于位移除以时间；时间间隔为零时不能使用该公式。';
    const incorrect = '如果时间间隔非零，平均速度等于位移除以时间；时间间隔为零时也能使用该公式。';
    class Recast extends CourseFakeProvider {
      reviews: KnowledgeReviewInput[] = [];
      override async extractCourseKnowledge(input: KnowledgeInput) {
        const output = await super.extractCourseKnowledge(input);
        return {
          ...output,
          knowledge: output.knowledge.map((k) => ({
            ...k,
            statement: input.revision ? source : incorrect,
          })),
        };
      }
      override async reviewKnowledgeScope(input: KnowledgeReviewInput) {
        this.reviews.push(input);
        const value = await super.reviewKnowledgeScope(input);
        const wrong = input.knowledge.find((k) => k.statement === incorrect);
        return wrong
          ? {
              ...value,
              accepted: false,
              findings: ['除数为零的条件被反转'],
              issues: [
                {
                  code: 'false_statement' as const,
                  knowledgeIds: [wrong.id],
                  lessonIds: [],
                  message: '除数为零的条件被反转',
                },
              ],
            }
          : value;
      }
    }
    const provider = new Recast(),
      f = fixture(provider);
    try {
      await f.c.sources.import(f.workspace.id, { content: `# 条件\n\n${source}` });
      await f.settle(
        f.c.operations.start(f.workspace.id, cmd(), 'preparePlan', 'plan', 'curriculum', {
          sourceScopeHash: f.c.sources.scopeHash(f.workspace.id),
        }),
      );
      const inventory = f.c.planning.inventory(f.c.planning.get(f.workspace.id)!);
      expect(inventory.knowledge[0]!.statement).toBe(source);
      expect(provider.calls.extractCourseKnowledge).toBe(2);
      expect(provider.reviews[0]!.blocks[0]!.text).toContain(source);
      expect(provider.reviews[0]!.findings.join(' ')).toContain('改述');
      // Source quotation itself has no additional extraction check; only the
      // existing single objective scope check remains after correction.
      expect(provider.reviews).toHaveLength(2);
      expect(provider.reviews[1]!.lessons).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it('one problematic binding and reverse related restrictions enter the local objective scope', () => {
    const k = (id: string, kind: CourseKnowledge['kind'], title: string): CourseKnowledge => ({
      id,
      kind,
      title,
      statement: title,
      origin: 'textbook',
      sourceSpans: [],
      prerequisiteKnowledgeIds: [],
      relatedKnowledgeIds: [],
      uncertaintyCodes: [],
    });
    const algebra = k('algebra', 'concept', '代数形式'),
      proof = k('proof', 'procedure', '证明步骤');
    const restriction = {
      ...k('limit', 'condition', '仅用已规定方法'),
      relatedKnowledgeIds: ['algebra'],
    };
    const lesson = (id: string, title: string, ids: string[]) => ({
      id,
      moduleId: 'module',
      title,
      summary: title,
      knowledgeIds: ids,
      objectives: [{ id: `o_${id}`, title, knowledgeIds: ids, demand: 'apply' as const }],
      prerequisiteLessonIds: [],
      selectedDepth: 'standard' as const,
      recommendedDepth: 'standard' as const,
      estimatedMinutes: 20,
    });
    const plan = {
      lessons: [
        lesson('mixed', '解释代数形式', ['algebra', 'proof']),
        lesson('healthy', '解释普通定义', ['ordinary']),
      ],
    } as CoursePlan;
    const ordinary = k('ordinary', 'concept', '普通定义');
    const scopes = planningReviewLessons(plan, [algebra, proof, restriction, ordinary]);
    expect(scopes).toHaveLength(1);
    expect(scopes[0]!.id).toBe('mixed');
    expect(scopes[0]!.knowledgeIds).toContain('limit');
    expect(scopes[0]!.objectives).toEqual(plan.lessons[0]!.objectives);
    // Without a restriction, one mismatching knowledge item still cannot be
    // hidden by the other, matching item.
    expect(planningReviewLessons(plan, [algebra, proof, ordinary])).toHaveLength(1);
    expect(constraintNeedsReview(restriction, '# 范围\n\n仅用已规定方法')).toBe(false);
    expect(
      constraintNeedsReview({ ...restriction, statement: '仅用另一方法' }, '仅用已规定方法'),
    ).toBe(true);
    expect(
      constraintNeedsReview({ ...restriction, statement: '仅用方法甲' }, '仅用方法甲或方法乙'),
    ).toBe(true);
  });

  it('a constraint mismatch persists and retries only the affected lesson, retaining its healthy sibling', async () => {
    class RestrictedPlan extends CourseFakeProvider {
      patches: PlanRevisionInput[] = [];
      override async extractCourseKnowledge(input: KnowledgeInput) {
        const value = await super.extractCourseKnowledge(input);
        const condition = value.knowledge[0]!;
        condition.kind = 'condition';
        condition.relatedKnowledgeIds = [value.knowledge[1]!.localRef];
        return value;
      }
      override async generateCoursePlan(input: PlanInput) {
        const value = (await super.generateCoursePlan(input)) as PlanOutput;
        value.lessons[0]!.objectives[0]!.title = '使用仪器乙测量长度';
        return value;
      }
      override async reviewKnowledgeScope(input: KnowledgeReviewInput) {
        const value = await super.reviewKnowledgeScope(input);
        const lesson = input.lessons?.find((l) =>
          l.objectives.some((o) => o.title.includes('仪器乙')),
        );
        if (!lesson) return value;
        const constraint = input.knowledge.find((k) => k.kind === 'condition')!;
        return {
          ...value,
          accepted: false,
          findings: ['目标替换了真实使用限制'],
          issues: [
            {
              code: 'objective_mismatch' as const,
              knowledgeIds: [constraint.id],
              lessonIds: [lesson.id],
              message: '目标替换了真实使用限制',
            },
          ],
        };
      }
      override async reviseCoursePlan(input: PlanRevisionInput) {
        this.patches.push(input);
        const patch = await super.reviseCoursePlan(input);
        patch.lessons[0]!.objectives[0]!.title = '遵守条件，使用仪器甲测量长度';
        return patch;
      }
    }
    const provider = new RestrictedPlan(),
      f = fixture(provider);
    try {
      await f.c.sources.import(f.workspace.id, {
        content:
          '# 条件\n\n测量只允许使用仪器甲，不得使用仪器乙。\n\n# 步骤\n\n步骤：使用仪器甲测量长度。\n\n# 定义\n\n长度是两点之间的距离。\n\n# 常识\n\n温度表示冷热程度。',
      });
      const op = f.c.operations.start(
        f.workspace.id,
        cmd(),
        'preparePlan',
        'restricted',
        'curriculum',
        { sourceScopeHash: f.c.sources.scopeHash(f.workspace.id) },
      );
      await f.c.operations.idle(op.id);
      const failed = f.c.operations.get(f.workspace.id, op.id);
      expect(failed.status).toBe('failed');
      expect(f.c.planning.get(f.workspace.id)).toBeNull();
      const raw = f.c.repo.payloads<{ value: PlanOutput }>(
        'SELECT payload FROM course_plan_candidates ORDER BY rowid DESC',
      )[0]!.value;
      const sibling = sha256(raw.lessons[1]);
      await f.settle(f.c.operations.retry(f.workspace.id, op.id, cmd(), failed.version));
      expect(provider.patches).toHaveLength(1);
      expect(provider.patches[0]!.draft.lessons.map((l) => l.id)).toEqual([raw.lessons[0]!.id]);
      expect(provider.calls.generateCoursePlan).toBe(1);
      expect(provider.calls.extractCourseKnowledge).toBe(1);
      const ready = f.c.repo.payloads<{ value: PlanOutput }>(
        'SELECT payload FROM course_plan_candidates ORDER BY rowid DESC',
      )[0]!.value;
      expect(sha256(ready.lessons[1])).toBe(sibling);
      expect(f.c.planning.get(f.workspace.id)!.status).toBe('draft');
    } finally {
      await f.close();
    }
  });

  it('all necessary local checks locate two bad lessons before one retry, without reauthoring a healthy sibling', async () => {
    class Multiple extends CourseFakeProvider {
      patches: PlanRevisionInput[] = [];
      checked: string[] = [];
      override async extractCourseKnowledge(input: KnowledgeInput) {
        const value = await super.extractCourseKnowledge(input);
        value.knowledge.forEach((k) => {
          k.kind = 'condition';
        });
        return value;
      }
      override async generateCoursePlan(input: PlanInput) {
        const value = (await super.generateCoursePlan(input)) as PlanOutput;
        value.lessons.slice(0, 2).forEach((l) => {
          l.objectives[0]!.title = '错误方法';
        });
        return value;
      }
      override async reviewKnowledgeScope(input: KnowledgeReviewInput) {
        const base = await super.reviewKnowledgeScope(input);
        const lesson = input.lessons?.[0];
        if (!lesson) return base;
        this.checked.push(lesson.id);
        return lesson.objectives.some((o) => o.title === '错误方法')
          ? {
              ...base,
              accepted: false,
              findings: ['指定方法被替换'],
              issues: [
                {
                  code: 'objective_mismatch' as const,
                  knowledgeIds: lesson.knowledgeIds,
                  lessonIds: [lesson.id],
                  message: '指定方法被替换',
                },
              ],
            }
          : base;
      }
      override async reviseCoursePlan(input: PlanRevisionInput) {
        this.patches.push(input);
        const patch = await super.reviseCoursePlan(input);
        patch.lessons.forEach((l) => {
          l.objectives[0]!.title = '遵守限制使用工具甲';
        });
        return patch;
      }
    }
    const provider = new Multiple(),
      f = fixture(provider);
    try {
      await f.c.sources.import(f.workspace.id, {
        content: Array.from(
          { length: 9 },
          (_, i) => `# 条件${i}\n\n仅用工具甲完成第${i}种测量。`,
        ).join('\n\n'),
      });
      const op = f.c.operations.start(
        f.workspace.id,
        cmd(),
        'preparePlan',
        'multiple',
        'curriculum',
        { sourceScopeHash: f.c.sources.scopeHash(f.workspace.id) },
      );
      await f.c.operations.idle(op.id);
      const failed = f.c.operations.get(f.workspace.id, op.id);
      expect(failed.status).toBe('failed');
      expect(provider.checked).toHaveLength(3);
      const saved = f.c.repo.payloads<{ value: PlanOutput; findings: unknown[] }>(
        'SELECT payload FROM course_plan_candidates ORDER BY rowid DESC',
      )[0]!;
      expect(saved.findings).toHaveLength(2);
      await f.settle(f.c.operations.retry(f.workspace.id, op.id, cmd(), failed.version));
      expect(provider.patches).toHaveLength(1);
      expect(provider.patches[0]!.draft.lessons).toHaveLength(2);
      expect(provider.calls.generateCoursePlan).toBe(1);
      const ready = f.c.repo.payloads<{ value: PlanOutput }>(
        'SELECT payload FROM course_plan_candidates ORDER BY rowid DESC',
      )[0]!.value;
      expect(sha256(ready.lessons[2])).toBe(sha256(saved.value.lessons[2]));
    } finally {
      await f.close();
    }
  });

  it('accepted short-answer key and grading use the independently checked solution, not author prose', async () => {
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
          prompt: '解释公开定义的命题与条件。',
          answer: ['作者的过强陈述，不作为评分依据'],
          rubric: [
            {
              id: 'criterion',
              description: '保留命题与条件',
              knowledgeIds: q.knowledgeIds,
              required: true,
              weight: 1,
              acceptableAlternatives: [],
            },
          ],
        })),
      }));
      // Fake rubric review accepts the old author prose, reproducing the
      // observed reviewer omission. The key authority must still be the solve.
      vi.spyOn(provider, 'solveQuestion').mockImplementation(async (input) => {
        provider.calls.solveQuestion = (provider.calls.solveQuestion ?? 0) + 1;
        return {
          solvable: true,
          answer: ['独立解题的完整正确答案'],
          explanation: '来源支持完整答案。',
          missingConditions: [],
          ambiguities: [],
          sourceSupported: true,
          uncertain: false,
          exposureCheck: { novel: true, reason: '新问题' },
          assessedKnowledgeIds: [input.requestedKnowledge[0]!.id],
          coverage: [],
        };
      });
      const rubric = vi.spyOn(provider, 'reviewQuestionRubric');
      const grade = vi.spyOn(provider, 'gradeShortAnswer');
      const quiz = await f.practice(plan, content);
      expect(quiz.items[0]!.answer).toEqual(['独立解题的完整正确答案']);
      expect(rubric.mock.calls[0]![0].authorAnswer).toEqual(['独立解题的完整正确答案']);
      const submission = await f.submit(quiz);
      expect(submission.score).toBe(1);
      expect(grade.mock.calls[0]![0].answer).toEqual(quiz.items[0]!.answer);
      expect(provider.calls.generateQuestions).toBe(1);
      expect(provider.calls.solveQuestion).toBe(1);
      expect(provider.calls.reviewQuestionRubric).toBe(1);
      f.c.admission.validateAccepted(quiz.items[0]!);
    } finally {
      await f.close();
    }
  });
});
