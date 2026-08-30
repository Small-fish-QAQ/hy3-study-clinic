import type { DesiredDepth, FormalAssessmentConstruct, TeachingSkeleton } from '@hy3-clinic/shared';
import { describe, expect, it } from 'vitest';
import {
  assertRequiredPairsPlanned,
  planTeachingSkeleton,
  requiredDepthContracts,
  TEACHING_SKELETON_PLANNER_VERSION,
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
    targetDepth: 'pass_oriented',
    objectives: [objective(construct)],
    ...overrides,
  };
}

function contractsFor(skeleton: TeachingSkeleton, objectiveRef: string): string[] {
  return skeleton.lessonSlots
    .filter((slot) => slot.objectiveRefs.includes(objectiveRef))
    .map((slot) => slot.qualityContract);
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
      targetDepth: 'pass_oriented',
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

  it('carries the bumped planner version', () => {
    expect(TEACHING_SKELETON_PLANNER_VERSION).toBe('teaching-skeleton-planner-v2');
    expect(planTeachingSkeleton(input('explain')).plannerVersion).toBe(
      'teaching-skeleton-planner-v2',
    );
  });

  it('rejects a planning input whose targetDepth is not accepted StudyPlan depth vocabulary', () => {
    expectPlanningCode(
      () =>
        planTeachingSkeleton({
          ...input('identify'),
          targetDepth: 'very_deep' as unknown as DesiredDepth,
        }),
      'invalid_planning_input',
    );
  });
});

describe('depth-required Lesson obligations', () => {
  const DEPTHS: DesiredDepth[] = [
    'pass_oriented',
    'working_fluency',
    'high_performance',
    'deep_transfer',
  ];
  const CONSTRUCTS: FormalAssessmentConstruct[] = [
    'identify',
    'explain',
    'apply',
    'design',
    'evaluate',
  ];

  it('is total over every depth and construct, and never adds a worked process', () => {
    for (const depth of DEPTHS) {
      for (const construct of CONSTRUCTS) {
        const contracts = requiredDepthContracts(depth, construct);
        expect(Array.isArray(contracts)).toBe(true);
        expect(contracts).not.toContain('worked_process');
        expect(new Set(contracts).size).toBe(contracts.length);
      }
    }
  });

  it('T1: pass_oriented requires no depth contract and plans only the construct core', () => {
    for (const construct of CONSTRUCTS) {
      expect(requiredDepthContracts('pass_oriented', construct)).toEqual([]);
    }

    // 14 minutes leaves no leftover budget, so nothing optional is added either.
    const skeleton = planTeachingSkeleton(input('identify', { targetMinutes: 14 }));
    expect(contractsFor(skeleton, 'O1')).toEqual(['orientation', 'discrimination']);
  });

  it('T2/T3: working_fluency and high_performance both require boundary work', () => {
    for (const construct of CONSTRUCTS) {
      expect(requiredDepthContracts('working_fluency', construct)).toEqual(['boundary_work']);
      expect(requiredDepthContracts('high_performance', construct)).toEqual(['boundary_work']);
    }

    for (const depth of ['working_fluency', 'high_performance'] as DesiredDepth[]) {
      const skeleton = planTeachingSkeleton(
        input('identify', { targetMinutes: 14, targetDepth: depth }),
      );
      expect(contractsFor(skeleton, 'O1')).toEqual([
        'orientation',
        'discrimination',
        'boundary_work',
      ]);
      expect(
        skeleton.lessonSlots.find((slot) => slot.qualityContract === 'boundary_work'),
      ).toMatchObject({ role: 'contrast', protected: true });
    }
  });

  it('T4: deep_transfer identify adds boundary work and a typed relation, never a worked process', () => {
    const skeleton = planTeachingSkeleton(
      input('identify', { targetMinutes: 14, targetDepth: 'deep_transfer' }),
    );

    expect(contractsFor(skeleton, 'O1')).toEqual([
      'orientation',
      'discrimination',
      'boundary_work',
      'semantic_relation',
    ]);
    expect(skeleton.lessonSlots.some((slot) => slot.qualityContract === 'worked_process')).toBe(
      false,
    );
    expect(skeleton.lessonSlots.some((slot) => slot.role === 'worked_example')).toBe(false);
  });

  it('T5: deep_transfer apply keeps its worked process and gains both depth contracts', () => {
    const skeleton = planTeachingSkeleton(
      input('apply', { targetMinutes: 20, targetDepth: 'deep_transfer' }),
    );

    expect(contractsFor(skeleton, 'O1')).toEqual([
      'orientation',
      'worked_process',
      'boundary_work',
      'semantic_relation',
    ]);
    expect(
      skeleton.lessonSlots.find((slot) => slot.qualityContract === 'worked_process'),
    ).toMatchObject({ role: 'worked_example', protected: true, learnerActionRequired: true });
  });

  it('T6: deep_transfer explain reuses its core relation instead of planning a second one', () => {
    expect(requiredDepthContracts('deep_transfer', 'explain')).toEqual(['boundary_work']);

    const skeleton = planTeachingSkeleton(
      input('explain', { targetMinutes: 18, targetDepth: 'deep_transfer' }),
    );

    expect(contractsFor(skeleton, 'O1')).toEqual([
      'orientation',
      'semantic_relation',
      'learner_action',
      'boundary_work',
    ]);
    expect(
      skeleton.lessonSlots.filter((slot) => slot.qualityContract === 'semantic_relation'),
    ).toHaveLength(1);
    expect(
      skeleton.lessonSlots.find((slot) => slot.qualityContract === 'semantic_relation'),
    ).toMatchObject({ role: 'mechanism' });
  });

  it('T7: required boundary work survives when no leftover enrichment budget exists', () => {
    const shallow = planTeachingSkeleton(input('identify', { targetMinutes: 14 }));
    expect(shallow.lessonSlots.some((slot) => slot.qualityContract === 'boundary_work')).toBe(
      false,
    );

    const deep = planTeachingSkeleton(
      input('identify', { targetMinutes: 14, targetDepth: 'working_fluency' }),
    );
    const boundary = deep.lessonSlots.filter((slot) => slot.qualityContract === 'boundary_work');
    expect(boundary).toHaveLength(1);
    expect(boundary[0]).toMatchObject({ protected: true });
    // Proves it is required rather than leftover-driven: the same target adds no
    // optional enrichment at all.
    expect(deep.lessonSlots.every((slot) => slot.protected)).toBe(true);
  });

  it('T8: optional enrichment never duplicates a required pair', () => {
    // 30 minutes does leave leftover budget, so enrichment runs in both cases.
    const shallow = planTeachingSkeleton(input('identify', { targetMinutes: 30 }));
    expect(
      shallow.lessonSlots.filter((slot) => slot.qualityContract === 'boundary_work'),
    ).toMatchObject([{ protected: false }]);

    const required = planTeachingSkeleton(
      input('identify', { targetMinutes: 30, targetDepth: 'working_fluency' }),
    );
    const boundary = required.lessonSlots.filter(
      (slot) => slot.qualityContract === 'boundary_work',
    );
    expect(boundary).toHaveLength(1);
    expect(boundary[0]).toMatchObject({ protected: true });
    // Enrichment still contributes what depth did not require.
    expect(
      required.lessonSlots.filter(
        (slot) => slot.qualityContract === 'semantic_relation' && !slot.protected,
      ),
    ).toHaveLength(1);
  });

  it('T9: identical targetMinutes with different depth produces different required contracts', () => {
    const shallow = planTeachingSkeleton(input('identify', { targetMinutes: 14 }));
    const fluent = planTeachingSkeleton(
      input('identify', { targetMinutes: 14, targetDepth: 'working_fluency' }),
    );

    expect(shallow.targetMinutes).toBe(fluent.targetMinutes);
    expect(contractsFor(shallow, 'O1')).not.toEqual(contractsFor(fluent, 'O1'));
    expect(shallow.fingerprint).not.toBe(fingerprintOf(fluent));
  });

  it('T10: raising targetMinutes alone never changes the required depth contract set', () => {
    const short = planTeachingSkeleton(input('identify', { targetMinutes: 14 }));
    const long = planTeachingSkeleton(input('identify', { targetMinutes: 30 }));

    const protectedContracts = (skeleton: TeachingSkeleton): string[] =>
      skeleton.lessonSlots.filter((slot) => slot.protected).map((slot) => slot.qualityContract);

    expect(protectedContracts(short)).toEqual(protectedContracts(long));
    expect(short.protectedActivityBudget).toEqual(long.protectedActivityBudget);
    // Only optional enrichment differs.
    expect(long.lessonSlots.length).toBeGreaterThan(short.lessonSlots.length);
    expect(long.lessonSlots.filter((slot) => !slot.protected).length).toBeGreaterThan(0);
  });

  it('T11: an infeasible depth fails through the existing budget path with no silent downgrade', () => {
    // 11 minutes plans at every shallower depth.
    for (const depth of [
      'pass_oriented',
      'working_fluency',
      'high_performance',
    ] as DesiredDepth[]) {
      expect(
        planTeachingSkeleton(input('identify', { targetMinutes: 11, targetDepth: depth }))
          .plannerVersion,
      ).toBe('teaching-skeleton-planner-v2');
    }

    let thrown: unknown;
    try {
      planTeachingSkeleton(input('identify', { targetMinutes: 11, targetDepth: 'deep_transfer' }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TeachingSkeletonPlanningError);
    expect(thrown).toMatchObject({
      code: 'protected_budget_exceeds_agenda',
      details: {
        targetDepth: 'deep_transfer',
        requiredDepthContracts: [
          { objectiveRef: 'O1', qualityContract: 'boundary_work' },
          { objectiveRef: 'O1', qualityContract: 'semantic_relation' },
        ],
      },
    });
  });

  it('T12: every depth-required pair is present in the assembled skeleton', () => {
    const minutes: Record<string, number> = { identify: 25, explain: 25, apply: 25 };
    for (const depth of DEPTHS) {
      for (const construct of ['identify', 'explain', 'apply'] as const) {
        const skeleton = planTeachingSkeleton(
          input(construct, { targetMinutes: minutes[construct]!, targetDepth: depth }),
        );
        for (const contract of requiredDepthContracts(depth, construct)) {
          expect(
            skeleton.lessonSlots.some(
              (slot) => slot.objectiveRefs.includes('O1') && slot.qualityContract === contract,
            ),
          ).toBe(true);
        }
      }
    }
  });

  it('T12: the completeness assertion rejects a skeleton that lost a required pair', () => {
    const skeleton = planTeachingSkeleton(
      input('identify', { targetMinutes: 14, targetDepth: 'deep_transfer' }),
    );
    const required = [
      { objectiveRef: 'O1', qualityContract: 'boundary_work' as const },
      { objectiveRef: 'O1', qualityContract: 'semantic_relation' as const },
    ];

    expect(() => assertRequiredPairsPlanned(skeleton.lessonSlots, required)).not.toThrow();

    const withoutBoundary = skeleton.lessonSlots.filter(
      (slot) => slot.qualityContract !== 'boundary_work',
    );
    expectPlanningCode(
      () => assertRequiredPairsPlanned(withoutBoundary, required),
      'required_quality_contract_missing',
    );
  });

  it('keeps the construct-core table in step with the slots the planner actually emits', () => {
    // pass_oriented adds nothing, and each target below leaves no enrichment budget,
    // so the non-orientation contracts are exactly the construct core.
    const core = (construct: 'identify' | 'explain' | 'apply', targetMinutes: number): string[] =>
      contractsFor(planTeachingSkeleton(input(construct, { targetMinutes })), 'O1').filter(
        (contract) => contract !== 'orientation',
      );

    expect(core('identify', 14)).toEqual(['discrimination']);
    expect(core('explain', 18)).toEqual(['semantic_relation', 'learner_action']);
    expect(core('apply', 20)).toEqual(['worked_process']);
  });

  it('applies existing protected semantics to depth-required slots', () => {
    const skeleton = planTeachingSkeleton(
      input('identify', {
        targetMinutes: 14,
        targetDepth: 'working_fluency',
        objectives: [objective('identify', { priority: 'optional' })],
      }),
    );

    const boundary = skeleton.lessonSlots.filter(
      (slot) => slot.qualityContract === 'boundary_work',
    );
    // An optional objective's depth slot still exists; only budget protection differs.
    expect(boundary).toHaveLength(1);
    expect(boundary[0]).toMatchObject({ protected: false });
  });
});

function fingerprintOf(skeleton: TeachingSkeleton): string {
  return skeleton.fingerprint;
}
