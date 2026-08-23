import { describe, expect, it } from 'vitest';
import {
  planTeachingSkeleton,
  TeachingSkeletonPlanningError,
  type TeachingSkeletonPlanningInput,
} from './teachingSkeletonPlanner.js';

function objective(
  construct: TeachingSkeletonPlanningInput['objectives'][number]['construct'],
  overrides: Partial<TeachingSkeletonPlanningInput['objectives'][number]> = {},
): TeachingSkeletonPlanningInput['objectives'][number] {
  return {
    objectiveRef: 'O1',
    title: `${construct} grounded retrieval`,
    description: `${construct} the bounded source-supported retrieval procedure.`,
    priority: 'required',
    construct,
    authorityMode: 'exact_source',
    allowedSourceRefs: ['S1', 'S2'],
    allowedVisualRefs: [],
    ...overrides,
  };
}

function input(
  construct: TeachingSkeletonPlanningInput['objectives'][number]['construct'],
  overrides: Partial<TeachingSkeletonPlanningInput> = {},
): TeachingSkeletonPlanningInput {
  return {
    learningUnitTitle: 'Grounded retrieval',
    targetMinutes: 30,
    objectives: [objective(construct)],
    ...overrides,
  };
}

function expectPlanningCode(callback: () => unknown, code: string): void {
  try {
    callback();
    throw new Error(`Expected planning error ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(TeachingSkeletonPlanningError);
    expect(error).toMatchObject({ code });
  }
}

describe('deterministic Teaching Skeleton planning', () => {
  it('plans identify as discrimination plus learner action without inventing a worked procedure', () => {
    const skeleton = planTeachingSkeleton(input('identify'));

    expect(skeleton.lessonSlots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          construct: 'identify',
          qualityContract: 'discrimination',
          learnerActionRequired: true,
        }),
      ]),
    );
    expect(skeleton.lessonSlots.some((slot) => slot.role === 'worked_example')).toBe(false);
    expect(skeleton.practicePlan.slots).toEqual([
      expect.objectContaining({
        practiceSlotId: 'PR1',
        objectiveRef: 'O1',
        construct: 'identify',
      }),
    ]);
  });

  it('plans explain with a protected semantic relation and learner cognition move', () => {
    const skeleton = planTeachingSkeleton(input('explain'));

    expect(skeleton.lessonSlots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          construct: 'explain',
          role: 'mechanism',
          qualityContract: 'semantic_relation',
          protected: true,
        }),
        expect.objectContaining({
          construct: 'explain',
          qualityContract: 'learner_action',
          learnerActionRequired: true,
        }),
      ]),
    );
    expect(
      skeleton.lessonSlots.find((slot) => slot.qualityContract === 'semantic_relation')
        ?.allowedRelations,
    ).toContain('mechanism_effect');
  });

  it('plans apply only under exact authority, with a worked process and observable decision', () => {
    const skeleton = planTeachingSkeleton(input('apply'));

    expect(
      skeleton.lessonSlots.filter(
        (slot) => slot.construct === 'apply' && slot.qualityContract === 'worked_process',
      ),
    ).toEqual([
      expect.objectContaining({
        role: 'worked_example',
        protected: true,
        authorityMode: 'exact_source',
        allowedSourceRefs: ['S1', 'S2'],
        learnerActionRequired: true,
      }),
    ]);
    expect(
      skeleton.lessonSlots.some(
        (slot) => slot.construct === 'apply' && slot.qualityContract === 'learner_action',
      ),
    ).toBe(false);
    expect(skeleton.practicePlan.slots[0]).toMatchObject({
      construct: 'apply',
      authorityMode: 'exact_source',
      prohibitedStrongerConstructs: ['design', 'evaluate'],
      retryPermitted: true,
    });
    expect(skeleton.practicePlan.slots[0]!.capabilityToObserve).toContain(
      'source-stated rule or procedure',
    );
  });

  it('fits the live explain plus two apply route into its accepted 30-minute Agenda', () => {
    const skeleton = planTeachingSkeleton({
      learningUnitTitle: 'WeKnora 综合系统与 RAG 流程',
      targetMinutes: 30,
      objectives: [
        objective('explain', {
          objectiveRef: 'O1',
          title: '解释 WeKnora 综合系统定位',
          description:
            '解释 WeKnora 是集文档系统、搜索系统、大模型、权限系统、工具调用系统于一体的综合系统，而非单纯大模型或搜索引擎。',
          allowedSourceRefs: ['S4'],
        }),
        objective('apply', {
          objectiveRef: 'O2',
          title: 'Apply: 入库：上传 → 解析 → 切 chunk → embedding → 写入向量库',
          description: '入库：上传 → 解析 → 切 chunk → embedding → 写入向量库',
          allowedSourceRefs: ['S4'],
        }),
        objective('apply', {
          objectiveRef: 'O3',
          title:
            'Apply: 查询：提问 → embedding → 向量检索 → （rerank）→ 拼 prompt → LLM生成 → 引用',
          description: '查询：提问 → embedding → 向量检索 → （rerank）→ 拼 prompt → LLM生成 → 引用',
          allowedSourceRefs: ['S5'],
        }),
      ],
    });

    expect(skeleton.objectives.map((planned) => planned.objectiveRef)).toEqual(['O1', 'O2', 'O3']);
    expect(skeleton.lessonSlots.map((slot) => slot.slotId)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5']);
    expect(skeleton.protectedActivityBudget).toEqual({ minMinutes: 30, maxMinutes: 45 });
    expect(skeleton.protectedActivityBudget.minMinutes).toBeLessThanOrEqual(
      skeleton.acceptableActiveMinutes.maxMinutes,
    );
    expect(skeleton.plannedActivityBudget).toEqual({ minMinutes: 30, maxMinutes: 45 });

    const applySlots = skeleton.lessonSlots.filter((slot) => slot.construct === 'apply');
    expect(applySlots).toHaveLength(2);
    expect(applySlots).toEqual([
      expect.objectContaining({
        objectiveRefs: ['O2'],
        role: 'worked_example',
        protected: true,
        qualityContract: 'worked_process',
        learnerActionRequired: true,
        allowedSourceRefs: ['S4'],
      }),
      expect.objectContaining({
        objectiveRefs: ['O3'],
        role: 'worked_example',
        protected: true,
        qualityContract: 'worked_process',
        learnerActionRequired: true,
        allowedSourceRefs: ['S5'],
      }),
    ]);
    expect(
      skeleton.practicePlan.slots.map(({ practiceSlotId, objectiveRef }) => ({
        practiceSlotId,
        objectiveRef,
      })),
    ).toEqual([
      { practiceSlotId: 'PR1', objectiveRef: 'O1' },
      { practiceSlotId: 'PR2', objectiveRef: 'O2' },
      { practiceSlotId: 'PR3', objectiveRef: 'O3' },
    ]);
  });

  it('rejects apply instead of promoting advisory visual authority', () => {
    expectPlanningCode(
      () =>
        planTeachingSkeleton(
          input('apply', {
            objectives: [
              objective('apply', {
                authorityMode: 'advisory_visual',
                allowedSourceRefs: [],
                allowedVisualRefs: ['V1'],
              }),
            ],
          }),
        ),
      'construct_authority_incompatible',
    );
  });

  it('uses the Agenda target before generation and creates a plausible 30-minute budget', () => {
    const skeleton = planTeachingSkeleton(input('apply'));

    expect(skeleton.targetMinutes).toBe(30);
    expect(skeleton.acceptableActiveMinutes).toEqual({ minMinutes: 22, maxMinutes: 33 });
    expect(skeleton.protectedActivityBudget.minMinutes).toBeLessThanOrEqual(33);
    expect(skeleton.plannedActivityBudget.minMinutes).toBeLessThanOrEqual(33);
    expect(skeleton.plannedActivityBudget.maxMinutes).toBeGreaterThanOrEqual(22);
    expect(skeleton.lessonSlots.every((slot) => slot.activityBudget.minMinutes > 0)).toBe(true);
  });

  it('fails an impossible protected skeleton before any provider boundary exists', () => {
    expectPlanningCode(
      () => planTeachingSkeleton(input('apply', { targetMinutes: 8 })),
      'protected_budget_exceeds_agenda',
    );
  });

  it('fails when required pedagogical roles exceed the local Lesson slot budget', () => {
    expectPlanningCode(
      () => planTeachingSkeleton(input('explain', { maxLessonSlots: 2 })),
      'lesson_slot_limit_exceeded',
    );
  });

  it('fails when required objective coverage exceeds the bounded Practice plan', () => {
    expectPlanningCode(
      () =>
        planTeachingSkeleton(
          input('identify', {
            maxPracticeSlots: 1,
            objectives: [
              objective('identify'),
              objective('explain', {
                objectiveRef: 'O2',
                title: 'Explain grounded retrieval',
              }),
            ],
          }),
        ),
      'practice_slot_limit_exceeded',
    );
  });

  it('does not support a long displayed duration by changing only the claimed minutes', () => {
    expectPlanningCode(
      () => planTeachingSkeleton(input('identify', { targetMinutes: 60 })),
      'agenda_budget_underfilled',
    );
  });

  it('is deterministic and normalizes alias order before fingerprinting', () => {
    const left = planTeachingSkeleton(input('explain'));
    const right = planTeachingSkeleton(
      input('explain', {
        objectives: [objective('explain', { allowedSourceRefs: ['S2', 'S1', 'S2'] })],
      }),
    );

    expect(right.objectives[0]!.allowedSourceRefs).toEqual(['S1', 'S2']);
    expect(right).toEqual(left);
  });

  it('keeps objective, construct, authority, and stable slot identity locally owned', () => {
    const skeleton = planTeachingSkeleton(input('explain'));

    expect(skeleton.objectives[0]).toMatchObject({
      objectiveRef: 'O1',
      construct: 'explain',
      authorityMode: 'exact_source',
    });
    expect(skeleton.lessonSlots.map((slot) => slot.slotId)).toEqual(['L1', 'L2', 'L3', 'L4']);
    expect(skeleton.practicePlan.slots.map((slot) => slot.practiceSlotId)).toEqual(['PR1']);
    expect(skeleton.id).toMatch(/^teaching_skeleton_[0-9a-f]{40}$/u);
    expect(skeleton.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });
});
