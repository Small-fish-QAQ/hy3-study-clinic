import { it, expect } from 'vitest';
import { HttpCourseProvider } from './courseProvider.js';
import { CourseFakeProvider } from './courseFakeProvider.js';
import { fixture, cmd } from '../testing/clinicFixture.js';
import type { KnowledgeReviewInput, PlanInput, PlanOutput } from './courseContract.js';
const knowledge = {
  id: 'k',
  title: '有效结论',
  statement: '前提全真时结论为真。',
  kind: 'principle' as const,
  origin: 'textbook' as const,
  sourceSpans: [],
  prerequisiteKnowledgeIds: [],
  relatedKnowledgeIds: [],
  uncertaintyCodes: [],
};
const input = { blocks: [], knowledge: [knowledge], findings: ['核对条件'] };
it('核查由实际问题集合得出结果，没有相互矛盾的全局布尔/自由说明', async () => {
  const provider = new HttpCourseProvider({
    provider: 'moma',
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'offline-secret',
    model: 'glm-5.3',
    timeoutMs: 1000,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: JSON.stringify({ issues: [], checkedKnowledgeIds: ['k'] }) },
              finish_reason: 'stop',
            },
          ],
        }),
      ),
  });
  expect(await provider.reviewKnowledgeScope(input)).toEqual({
    accepted: true,
    findings: [],
    issues: [],
    checkedKnowledgeIds: ['k'],
  });
});
it('核查问题不能指向范围外对象', async () => {
  const provider = new HttpCourseProvider({
    provider: 'moma',
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'offline-secret',
    model: 'glm-5.3',
    timeoutMs: 1000,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  issues: [
                    {
                      code: 'false_statement',
                      target: 'knowledge',
                      knowledgeIds: ['foreign'],
                      lessonIds: [],
                      message: '假命题',
                    },
                  ],
                  checkedKnowledgeIds: ['k'],
                }),
              },
              finish_reason: 'stop',
            },
          ],
        }),
      ),
  });
  await expect(provider.reviewKnowledgeScope(input)).rejects.toMatchObject({
    code: 'PROVIDER_INVALID_OUTPUT',
  });
});
it('已知规划语义错误在显式retry只修Lesson，复用结构兄弟与原物理候选', async () => {
  class Semantic extends CourseFakeProvider {
    reviews = 0;
    override async generateCoursePlan(input: PlanInput) {
      const value = (await super.generateCoursePlan(input)) as PlanOutput;
      value.lessons[0]!.objectives[0]!.title = '计算平均速度（错误不带方向）';
      return value;
    }
    override async reviewKnowledgeScope(input: KnowledgeReviewInput) {
      const result = await super.reviewKnowledgeScope(input);
      if (input.lessons && this.reviews++ === 0)
        return {
          ...result,
          accepted: false,
          findings: ['目标将速度说成只有大小'],
          issues: [
            {
              code: 'objective_mismatch' as const,
              knowledgeIds: input.knowledge[0] ? [input.knowledge[0].id] : [],
              lessonIds: [input.lessons[0]!.id],
              message: '目标将速度说成只有大小',
            },
          ],
        };
      return result;
    }
  }
  const provider = new Semantic();
  const f = fixture(provider);
  try {
    await f.c.sources.import(f.workspace.id, {
      content:
        '# 概念\n\n速度是单位时间内位置的变化量。\n\n# 条件\n\n如果时间不为零，平均速度为位移除以时间。',
    });
    const req = { sourceScopeHash: f.c.sources.scopeHash(f.workspace.id) };
    const op = f.c.operations.start(
      f.workspace.id,
      cmd(),
      'preparePlan',
      'plan',
      'curriculum',
      req,
    );
    await f.c.operations.idle(op.id);
    const failed = f.c.operations.get(f.workspace.id, op.id);
    expect(failed.status).toBe('failed');
    await f.settle(f.c.operations.retry(f.workspace.id, failed.id, cmd(), failed.version));
    expect(provider.calls.generateCoursePlan).toBe(1);
    expect(provider.calls.reviseCoursePlan).toBe(1);
    expect(f.c.planning.get(f.workspace.id)?.status).toBe('draft');
  } finally {
    await f.close();
  }
});
