/**
 * A real Teaching Skeleton produced by `teaching-skeleton-planner-v1`, captured
 * verbatim before the Slice 2 planner bump.
 *
 * This is a frozen historical artifact, not a fixture builder. Do NOT regenerate it
 * from the current planner: its whole value is that it is shaped the way stored rows
 * were shaped under v1. Every accepted Lesson checkpoint in an existing database is
 * re-parsed through the strict `TeachingSkeletonSchema` on hydration, so this literal
 * is what proves that a planner-version bump does not strand historical rows.
 */
export const HISTORICAL_TEACHING_SKELETON_V1 = {
  id: 'teaching_skeleton_cfd7ecd712271a94edeedf81057766fd7363e7b2',
  schemaVersion: 1,
  plannerVersion: 'teaching-skeleton-planner-v1',
  fingerprint: 'sha256:cfd7ecd712271a94edeedf81057766fd7363e7b2302e7d8ad2513ad7bc658ffa',
  learningUnitTitle: 'Bounded retrieval',
  objectives: [
    {
      objectiveRef: 'O1',
      title: 'Explain bounded retrieval',
      description:
        'Explain how a retrieval condition controls candidate eligibility and the returned result.',
      priority: 'required',
      construct: 'explain',
      authorityMode: 'exact_source',
      allowedSourceRefs: ['S1'],
      allowedVisualRefs: [],
    },
  ],
  targetMinutes: 18,
  acceptableActiveMinutes: { minMinutes: 10, maxMinutes: 21 },
  lessonSlots: [
    {
      slotId: 'L1',
      objectiveRefs: ['O1'],
      construct: null,
      role: 'objective_orientation',
      purpose:
        'Orient the learner to the locally selected capabilities and their place in the current route.',
      authorityMode: 'bounded_synthesis',
      allowedSourceRefs: ['S1'],
      allowedVisualRefs: [],
      protected: true,
      activityBudget: { minMinutes: 2, maxMinutes: 3 },
      learnerActionRequired: false,
      qualityContract: 'orientation',
      allowedRelations: [],
    },
    {
      slotId: 'L2',
      objectiveRefs: ['O1'],
      construct: 'explain',
      role: 'mechanism',
      purpose:
        'Teach a source-compatible mechanism, relation, reason, or consequence with two meaningful propositions.',
      authorityMode: 'exact_source',
      allowedSourceRefs: ['S1'],
      allowedVisualRefs: [],
      protected: true,
      activityBudget: { minMinutes: 4, maxMinutes: 6 },
      learnerActionRequired: false,
      qualityContract: 'semantic_relation',
      allowedRelations: ['mechanism_effect', 'cause_consequence', 'condition_action'],
    },
    {
      slotId: 'L3',
      objectiveRefs: ['O1'],
      construct: 'explain',
      role: 'guided_practice',
      purpose:
        'Require the learner to commit to a mechanism or relation before guidance is revealed.',
      authorityMode: 'exact_source',
      allowedSourceRefs: ['S1'],
      allowedVisualRefs: [],
      protected: true,
      activityBudget: { minMinutes: 3, maxMinutes: 4 },
      learnerActionRequired: true,
      qualityContract: 'learner_action',
      allowedRelations: ['mechanism_effect', 'cause_consequence', 'condition_action'],
    },
  ],
  practicePlan: {
    schemaVersion: 1,
    slots: [
      {
        practiceSlotId: 'PR1',
        objectiveRef: 'O1',
        construct: 'explain',
        authorityMode: 'exact_source',
        allowedSourceRefs: ['S1'],
        allowedVisualRefs: [],
        capabilityToObserve:
          'Express a source-compatible mechanism, relation, reason, consequence, or conceptual connection.',
        prohibitedStrongerConstructs: ['apply', 'design', 'evaluate'],
        retryPermitted: true,
        activityBudget: { minMinutes: 3, maxMinutes: 5 },
      },
    ],
    activityBudget: { minMinutes: 3, maxMinutes: 5 },
  },
  synthesisActivityBudget: { minMinutes: 2, maxMinutes: 3 },
  protectedActivityBudget: { minMinutes: 14, maxMinutes: 21 },
  plannedActivityBudget: { minMinutes: 14, maxMinutes: 21 },
} as const;
