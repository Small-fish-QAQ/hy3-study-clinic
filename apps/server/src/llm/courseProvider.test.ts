import { describe, it, expect } from 'vitest';
import { HttpCourseProvider } from './courseProvider.js';
import { planRequestBudget } from './requestBudget.js';
import type { CourseTutorInput, QuestionsInput } from './courseContract.js';
import { COURSE_POLICY } from '@hy3-clinic/shared';
const input: CourseTutorInput = {
  lesson: { title: '概念', segments: [], teachingCoverage: [] },
  question: '什么是概念？',
  recentTurns: [],
  sources: [],
};
const good = () =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              text: '解释概念。',
              sourceRefs: [],
              includesExtension: false,
            }),
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 20,
        completion_tokens: 10,
        completion_tokens_details: { reasoning_tokens: 3 },
      },
    }),
    { status: 200 },
  );
const config = {
  provider: 'moma' as const,
  baseUrl: 'https://model.test/v1',
  apiKey: 'offline-private-key',
  model: 'glm-5.3',
  timeoutMs: 30000,
  longTaskTimeoutMs: 600000,
  maxOutputTokens: 1000,
};
describe('单请求预算与完整body deadline A11/A12', () => {
  it('主观判分仍用high，正文反馈直接来自判分理由，不请求另一份总结', async () => {
    let sent: { reasoning_effort?: string; messages: { content: string }[] } | undefined;
    const provider = new HttpCourseProvider({
      ...config,
      fetchImpl: async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    criteria: [{ criterionId: 'r1', met: true, reason: '结果和推导正确。' }],
                    confidence: 0.95,
                    uncertain: false,
                    evidenceFlags: [],
                  }),
                },
                finish_reason: 'stop',
              },
            ],
          }),
        );
      },
    });
    const graded = await provider.gradeShortAnswer({
      question: { id: 'q', type: 'short_answer', prompt: '计算1+1', options: [] },
      response: '2',
      answer: ['2'],
      rubric: [
        {
          id: 'r1',
          description: '结果2',
          knowledgeIds: [],
          required: true,
          weight: 1,
          acceptableAlternatives: [],
        },
      ],
      sources: [],
    });
    expect(sent!.reasoning_effort).toBe('high');
    expect(graded.feedback).toBe('达成：结果和推导正确。');
    expect(graded.criteria[0]!.met).toBe(true);
  });
  it('同一单元cell的多个目标需要更多输出空间，真实模型cap仍限制发送预算', async () => {
    const requests: { max_tokens: number }[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: JSON.stringify({ questions: [{}] }) }, finish_reason: 'stop' },
          ],
        }),
      );
    };
    const questions: QuestionsInput = {
      purpose: 'formal',
      slots: [{ id: 'slot', knowledgeIds: ['k'], cellIds: ['cell'] }],
      knowledge: [],
      sources: [],
      learnerVisibleContext: [],
      previousQuestions: [],
      blueprint: {
        id: 'bp',
        curriculumId: 'course',
        sourceScopeHash: 'source',
        policyVersion: COURSE_POLICY,
        passThreshold: 0.6,
        domains: [],
        requiredCellIds: ['cell'],
        cells: [
          {
            id: 'cell',
            domainId: 'domain',
            objectiveIds: ['a'],
            demand: 'apply',
            difficultyBand: 'standard',
            mandatoryKnowledgeIds: ['k'],
            representativeSets: [],
            weight: 1,
            rationale: '综合能力',
          },
        ],
        objectiveRequirements: [
          { id: 'a', title: '运用资料', knowledgeIds: ['k'], demand: 'apply' },
        ],
      },
    };
    const provider = new HttpCourseProvider({ ...config, maxOutputTokens: 32000, fetchImpl });
    await provider.generateQuestions(questions);
    const combined = structuredClone(questions);
    combined.blueprint!.objectiveRequirements = Array.from({ length: 6 }, (_, i) => ({
      id: `goal${i}`,
      title: `实际能力${i}`,
      knowledgeIds: ['k'],
      demand: 'apply' as const,
    }));
    combined.blueprint!.cells[0]!.objectiveIds = combined.blueprint!.objectiveRequirements.map(
      (o) => o.id,
    );
    await provider.generateQuestions(combined);
    expect(requests[1]!.max_tokens).toBeGreaterThan(requests[0]!.max_tokens);
    expect(requests[1]!.max_tokens).toBeLessThanOrEqual(32000);
    const capped = new HttpCourseProvider({ ...config, maxOutputTokens: 1000, fetchImpl });
    await capped.generateQuestions(combined);
    expect(requests[2]!.max_tokens).toBe(1000); // No new soft-estimate refusal or cap bypass.
  });
  it('MoMA作者与Tutor使用已验证low，其他已有身份不被连带更改', async () => {
    const requests: { reasoning_effort: string }[] = [];
    const provider = new HttpCourseProvider({
      ...config,
      maxOutputTokens: 32000,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        requests.push(body);
        return requests.length === 1
          ? new Response(
              JSON.stringify({
                choices: [
                  {
                    message: { content: JSON.stringify({ questions: [{ slotId: 'slot' }] }) },
                    finish_reason: 'stop',
                  },
                ],
              }),
            )
          : good();
      },
    });
    const questions: QuestionsInput = {
      purpose: 'formal',
      slots: [{ id: 'slot', knowledgeIds: [], cellIds: [] }],
      knowledge: [],
      sources: [],
      learnerVisibleContext: [],
      blueprint: null,
      previousQuestions: [],
    };
    await provider.generateQuestions(questions);
    await provider.respondToTutorTurn(input);
    expect(requests.map((r) => r.reasoning_effort)).toEqual(['low', 'low']);
    expect(provider.runtimeIdentityFor('generateQuestions')).not.toBe(provider.runtimeIdentity);
    for (const method of ['solveQuestion', 'generateLesson'])
      expect(provider.runtimeIdentityFor(method)).toBe(provider.runtimeIdentity);
    for (const method of ['reviewKnowledgeScope', 'reviewQuestionRubric', 'gradeShortAnswer'])
      expect(provider.runtimeIdentityFor(method)).not.toBe(provider.runtimeIdentity);
  });
  it('旧隐式自动与显式auto身份一致，保存偏好不会丢弃有效候选', () => {
    const legacy = new HttpCourseProvider({ ...config, reasoningEffort: undefined });
    const automatic = new HttpCourseProvider({ ...config, reasoningEffort: 'auto' });
    for (const method of [
      'extractCourseKnowledge',
      'generateCoursePlan',
      'reviseCoursePlan',
      'generateLesson',
      'verifyLessonParts',
      'generateQuestions',
      'solveQuestion',
      'reviewQuestionRubric',
      'gradeShortAnswer',
      'generateRepairRound',
      'respondToTutorTurn',
    ])
      expect(automatic.runtimeIdentityFor(method)).toBe(legacy.runtimeIdentityFor(method));
    const defaulted = new HttpCourseProvider({ ...config, reasoningEffort: 'provider-default' });
    expect(defaulted.runtimeIdentity).not.toBe(automatic.runtimeIdentity);
    expect(automatic.runtimeIdentityFor('respondToTutorTurn')).not.toBe(automatic.runtimeIdentity);
  });
  it.each(['auto', 'provider-default', 'low', 'high', 'max'] as const)(
    '用户%s覆盖遵从配置，未知模型自动不发送档位',
    async (preference) => {
      const requests: { model: string; reasoning_effort?: string }[] = [];
      const provider = new HttpCourseProvider({
        ...config,
        reasoningEffort: preference,
        fetchImpl: async (_url, init) => {
          requests.push(JSON.parse(String(init?.body)));
          return good();
        },
      });
      await provider.respondToTutorTurn(input);
      expect(requests[0]!.reasoning_effort).toBe(
        preference === 'auto' ? 'low' : preference === 'provider-default' ? undefined : preference,
      );
      const unknown = new HttpCourseProvider({
        ...config,
        model: 'other-model',
        reasoningEffort: 'auto',
        fetchImpl: async (_url, init) => {
          requests.push(JSON.parse(String(init?.body)));
          return good();
        },
      });
      await unknown.respondToTutorTurn(input);
      expect(requests[1]).toMatchObject({ model: 'other-model' });
      expect(requests[1]!.reasoning_effort).toBeUndefined();
    },
  );
  it('已知拒绝reasoning参数仅兼容回退一次，不换模型；后续请求保留该结论', async () => {
    const requests: { model: string; reasoning_effort?: string }[] = [],
      diagnostics: unknown[] = [];
    const provider = new HttpCourseProvider({
      ...config,
      reasoningEffort: 'high',
      fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return requests.length === 1
          ? new Response('reasoning_effort is unsupported', { status: 400 })
          : good();
      },
    });
    await provider.respondToTutorTurn(input, { onRequestDiagnostic: (d) => diagnostics.push(d) });
    await provider.respondToTutorTurn(input);
    expect(requests.map((r) => r.reasoning_effort)).toEqual(['high', undefined, undefined]);
    expect(requests.every((r) => r.model === 'glm-5.3')).toBe(true);
    expect(diagnostics).toHaveLength(2);
  });
  it('显式推理配置保持优先级，不能被任务默认值覆盖', async () => {
    let effort: string | undefined;
    const provider = new HttpCourseProvider({
      ...config,
      reasoningEffort: 'high',
      fetchImpl: async (_url, init) => {
        effort = JSON.parse(String(init?.body)).reasoning_effort;
        return new Response(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify({ questions: [{}] }) }, finish_reason: 'stop' },
            ],
          }),
        );
      },
    });
    await provider.generateQuestions({
      purpose: 'formal',
      slots: [],
      knowledge: [],
      sources: [],
      learnerVisibleContext: [],
      blueprint: null,
      previousQuestions: [],
    });
    expect(effort).toBe('high');
    expect(provider.runtimeIdentityFor('generateQuestions')).not.toBe(provider.runtimeIdentity);
    expect(provider.runtimeIdentityFor('generateLesson')).toBe(provider.runtimeIdentity);
  });
  it('20k是软估计，真实cap内有界发送，小响应无4096门，保持模型与配置', async () => {
    let sent: Record<string, unknown> = {};
    const provider = new HttpCourseProvider({
      ...config,
      fetchImpl: async (_url, init) => {
        sent = JSON.parse(init!.body as string) as Record<string, unknown>;
        return good();
      },
    });
    const response = await provider.respondToTutorTurn(input);
    expect(response.text).toBe('解释概念。');
    expect(sent.model).toBe('glm-5.3');
    expect(sent.max_tokens).toBe(1000);
    const budget = planRequestBudget({
      messages: [],
      schema: {},
      visibleTokens: 10,
      outputCap: 50,
      reasoningEstimate: 20000,
    });
    expect(budget.softEstimateExceeded).toBe(true);
    expect(budget.maxTokens).toBe(50);
  });
  it.each(['reasoning-only', 'truncated', '500', 'timeout'] as const)(
    '遇到%s不自动购买重试',
    async (mode) => {
      let count = 0;
      const provider = new HttpCourseProvider({
        ...config,
        timeoutMs: 10,
        fetchImpl: async (_url, init) => {
          count++;
          if (mode === 'timeout')
            return new Promise((_resolve, reject) =>
              init!.signal!.addEventListener('abort', () => reject(new Error('timeout'))),
            );
          if (mode === '500') return new Response('unknown', { status: 500 });
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content:
                      mode === 'truncated'
                        ? '{"text":"looks complete","sourceRefs":[],"includesExtension":false}'
                        : '',
                  },
                  finish_reason: mode === 'truncated' ? 'length' : 'stop',
                },
              ],
              usage: {
                completion_tokens: 16096,
                completion_tokens_details: { reasoning_tokens: 16096 },
              },
            }),
            { status: 200 },
          );
        },
      });
      await expect(provider.respondToTutorTurn(input)).rejects.toBeInstanceOf(Error);
      expect(count).toBe(1);
    },
  );
  it('JSON兼容与429共享一次重发，不静默换模型', async () => {
    let count = 0;
    const provider = new HttpCourseProvider({
      ...config,
      fetchImpl: async () => {
        count++;
        return count === 1
          ? new Response('response_format unsupported', { status: 400 })
          : new Response('limited', { status: 429 });
      },
    });
    await expect(provider.respondToTutorTurn(input)).rejects.toMatchObject({
      technicalHttpStatus: 429,
    });
    expect(count).toBe(2);
  });
  it('cap下降后重新预算，预算不构成最低能力拒绝', async () => {
    const sent: number[] = [];
    const provider = new HttpCourseProvider({
      ...config,
      fetchImpl: async (_url, init) => {
        const data = JSON.parse(init!.body as string) as { max_tokens: number };
        sent.push(data.max_tokens);
        return sent.length === 1
          ? new Response('max_tokens maximum is 40', { status: 400 })
          : good();
      },
    });
    await provider.respondToTutorTurn(input);
    expect(sent).toEqual([1000, 40]);
  });
  it('deadline覆盖header之后的body读取，600秒合法配置可用', async () => {
    const provider = new HttpCourseProvider({
      ...config,
      timeoutMs: 15,
      fetchImpl: async (_url, init) =>
        ({
          ok: true,
          status: 200,
          headers: new Headers(),
          text: () =>
            new Promise((_resolve, reject) =>
              init!.signal!.addEventListener('abort', () => reject(new Error('aborted'))),
            ),
        }) as Response,
    });
    await expect(provider.respondToTutorTurn(input)).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
    });
    expect(provider.longTaskTimeoutMs).toBe(600000);
  });
  it('凭据反射拒绝且observer不应破坏已完成调用', async () => {
    const provider = new HttpCourseProvider({
      ...config,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: config.apiKey }, finish_reason: 'stop' }],
          }),
          { status: 200 },
        ),
    });
    await expect(provider.respondToTutorTurn(input)).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_OUTPUT',
    });
  });
  it('非秘密诊断记录正文/推理/有效预算，observer throw不改变结果', async () => {
    let metadata: unknown;
    const provider = new HttpCourseProvider({ ...config, fetchImpl: async () => good() });
    const value = await provider.respondToTutorTurn(input, {
      onUsage: () => {
        throw new Error('observer');
      },
      onRequestDiagnostic: (diagnostic) => {
        metadata = diagnostic;
        throw new Error('observer');
      },
    });
    expect(value.text).toBe('解释概念。');
    expect(metadata).toMatchObject({
      visibleBodyBytes: expect.any(Number),
      reasoningReserve: 2000,
      effectiveCap: 1000,
      softEstimateExceeded: true,
      bodyReadCompleted: true,
    });
    expect(JSON.stringify(metadata)).not.toContain(config.apiKey);
  });
});
