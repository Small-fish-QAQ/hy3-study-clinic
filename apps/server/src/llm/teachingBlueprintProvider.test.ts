import { describe, it, expect, vi } from 'vitest';
import { planTeachingSkeleton } from '../services/teachingSkeletonPlanner.js';
import { Hy3Provider } from './hy3Provider.js';
import { validateTeachingCapsule, usesComputedTeachingCases } from './teachingCapsule.js';
import { TeachingBlueprintSchema } from './teachingBlueprint.js';
import { TeachingCapsulePayloadSchema } from '@hy3-clinic/shared';
import type { TeachingCapsuleGenerationInput } from './provider.js';

const blueprint = TeachingBlueprintSchema.parse({
  explanation:
    '角色把权限授予用户；当用户同时拥有多个角色时，有效权限是各角色提供权限的并集。撤销一个角色的权限后，另一角色仍可能提供相同权限，因此必须先合并所有来源，再判断能否执行具体操作。',
  whyUseful: '撤销一个角色后用户是否还能写入，需要查看其他授权来源。',
  boundary: '本模型假定权限立即生效且无显式拒绝；加入会话上限时需要继续求交集。',
  context: '一个用户拥有两个角色。下面给出各角色的权限及待执行变更，请推导具体操作结果。',
  inputs: [
    { key: 'a', label: '角色甲权限', values: [['read'], ['write'], ['read', 'write']] },
    { key: 'b', label: '角色乙权限', values: [[], ['read'], ['write']] },
    { key: 'read', label: '读取操作', values: ['read'] },
    { key: 'write', label: '写入操作', values: ['write'] },
  ],
  rules: [
    { key: 'combined', label: '合并权限', op: 'union', args: ['a', 'b'] },
    { key: 'can_read', label: '允许读取', op: 'includes', args: ['combined', 'read'] },
    { key: 'can_write', label: '允许写入', op: 'includes', args: ['combined', 'write'] },
  ],
  goals: ['can_read', 'can_write'],
  extension: {
    inputs: [
      { key: 'limit', label: '会话权限上限', values: [['read'], ['write'], ['read', 'write']] },
    ],
    rules: [
      { key: 'effective', label: '受限权限', op: 'intersection', args: ['combined', 'limit'] },
      { key: 'bounded_read', label: '受限允许读取', op: 'includes', args: ['effective', 'read'] },
      { key: 'bounded_write', label: '受限允许写入', op: 'includes', args: ['effective', 'write'] },
    ],
    goals: ['bounded_read', 'bounded_write'],
    description: '明确假设：会话权限上限独立于角色配置，有效权限必须同时属于角色并集与会话上限。',
  },
});
function input(): TeachingCapsuleGenerationInput {
  const skeleton = planTeachingSkeleton({
    learningUnitTitle: '角色权限',
    targetDepth: 'working_fluency',
    targetMinutes: 22,
    objectives: [
      {
        objectiveRef: 'O1',
        title: '解释角色权限',
        description: '解释通过角色获得权限并推断变更结果。',
        priority: 'required',
        construct: 'explain',
        authorityMode: 'exact_source',
        allowedSourceRefs: ['S1'],
        allowedVisualRefs: [],
      },
    ],
  });
  return {
    lesson: {
      workspaceName: 'Course',
      learnerLocale: 'zh-CN',
      courseDesign: { desiredDepth: 'working_fluency', unitFocus: 'focused' },
      skeleton,
      workedInteractionSlotId: skeleton.lessonSlots.find((s) => s.learnerActionRequired)!.slotId,
      sourceContext: {
        blockCount: 1,
        offerCount: 1,
        serializedBytes: 20,
        materialCount: 1,
        sectionCount: 1,
        offers: [
          {
            sourceRef: 'S1',
            materialTitle: 'Notes',
            headingPath: [],
            pageNumber: null,
            slideNumber: null,
            text: '用户通过角色获得权限。',
            authorizedObjectiveRefs: ['O1'],
          },
        ],
      },
      learningContext: {
        concepts: [],
        canonicalConcepts: [],
        prerequisites: [],
        nextConnection: null,
      },
    },
    practiceSlots: skeleton.practicePlan.slots,
    priorLesson: [],
    includeNarrative: true,
  };
}
const response = (content: string, finish_reason = 'stop') =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
describe('compact teaching generation', () => {
  it('preserves Global Depth and treats Focus as investment, never a depth increment', () => {
    for (const desiredDepth of [
      'pass_oriented',
      'working_fluency',
      'high_performance',
      'deep_transfer',
    ] as const)
      for (const unitFocus of ['normal', 'focused'] as const) {
        const fixture = input();
        fixture.lesson.courseDesign = { desiredDepth, unitFocus };
        expect(usesComputedTeachingCases(fixture)).toBe(desiredDepth === 'working_fluency');
        expect(fixture.lesson.courseDesign).toEqual({ desiredDepth, unitFocus });
      }
  });
  it('cleanly regenerates a truncated mechanism once and compiles full Lesson/Practice without increasing its request budget', async () => {
    const fixture = input();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response('{"explanation":"PARTIAL_DO_NOT_REPLAY', 'length'))
      .mockResolvedValueOnce(response(JSON.stringify(blueprint)));
    const provider = new Hy3Provider({
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-key',
      model: 'test-model',
      timeoutMs: 30_000,
      fetchImpl: fetchImpl as typeof fetch,
    });
    const recoveries: string[] = [];
    const result = await provider.generateTeachingCapsule(fixture, {
      validateCandidate: (c) => validateTeachingCapsule(c, fixture),
      onRepairAttempt: (_r, _c, a) => recoveries.push(a ?? 'none'),
    });
    expect(TeachingCapsulePayloadSchema.safeParse(result).success).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(recoveries).toEqual(['clean_regeneration']);
    const body = JSON.parse(String(fetchImpl.mock.calls[1]![1].body));
    const prompt = body.messages.map((m: { content: string }) => m.content).join('\n');
    expect(body.max_tokens).toBe(16000);
    expect(prompt).not.toContain('PARTIAL_DO_NOT_REPLAY');
    expect(prompt).toContain('working_fluency');
    expect(prompt).toContain('focused');
    expect(result.lesson.slots.map((s) => s.slotId)).toEqual(
      fixture.lesson.skeleton.lessonSlots.map((s) => s.slotId),
    );
    expect(result.practice.items).toHaveLength(fixture.practiceSlots.length);
  });
});
