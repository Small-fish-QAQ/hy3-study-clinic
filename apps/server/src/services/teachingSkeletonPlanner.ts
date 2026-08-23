import { createHash } from 'node:crypto';
import {
  TeachingSkeletonSchema,
  type FormalAssessmentConstruct,
  type TeachingActivityBudget,
  type TeachingPracticePlanSlot,
  type TeachingRelationKind,
  type TeachingSkeleton,
  type TeachingSkeletonAuthorityMode,
  type TeachingSkeletonObjective,
  type TeachingSkeletonSlot,
} from '@hy3-clinic/shared';

export const TEACHING_SKELETON_PLANNER_VERSION = 'teaching-skeleton-planner-v1';

export type TeachingSkeletonPlanningErrorCode =
  | 'invalid_planning_input'
  | 'objective_authority_unavailable'
  | 'construct_authority_incompatible'
  | 'lesson_slot_limit_exceeded'
  | 'practice_slot_limit_exceeded'
  | 'protected_budget_exceeds_agenda'
  | 'planned_budget_exceeds_agenda'
  | 'agenda_budget_underfilled';

export class TeachingSkeletonPlanningError extends Error {
  constructor(
    readonly code: TeachingSkeletonPlanningErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'TeachingSkeletonPlanningError';
  }
}

export interface TeachingSkeletonPlanningObjective {
  objectiveRef: string;
  title: string;
  description: string;
  priority: 'required' | 'high' | 'normal' | 'optional';
  construct: FormalAssessmentConstruct;
  authorityMode: 'exact_source' | 'advisory_visual' | 'unavailable';
  allowedSourceRefs: string[];
  allowedVisualRefs: string[];
}

export interface TeachingSkeletonPlanningInput {
  learningUnitTitle: string;
  targetMinutes: number;
  objectives: TeachingSkeletonPlanningObjective[];
  maxLessonSlots?: number;
  maxPracticeSlots?: number;
}

const STRONGER_CONSTRUCTS: Record<FormalAssessmentConstruct, FormalAssessmentConstruct[]> = {
  identify: ['explain', 'apply', 'design', 'evaluate'],
  explain: ['apply', 'design', 'evaluate'],
  apply: ['design', 'evaluate'],
  design: ['evaluate'],
  evaluate: [],
};

const PRACTICE_CAPABILITIES: Record<FormalAssessmentConstruct, string> = {
  identify:
    'Meaningfully identify, distinguish, or classify a source-supported entity or component.',
  explain:
    'Express a source-compatible mechanism, relation, reason, consequence, or conceptual connection.',
  apply:
    'Use the exact source-stated rule or procedure to choose an action, next step, ordering, or bounded diagnosis.',
  design: 'Construct a bounded response using only the exact source-authorized design constraints.',
  evaluate:
    'Judge a bounded case against the exact source-authorized criteria and justify the conclusion.',
};

const ORIENTATION_BUDGET: TeachingActivityBudget = { minMinutes: 2, maxMinutes: 3 };
const IDENTIFY_ACTION_BUDGET: TeachingActivityBudget = { minMinutes: 3, maxMinutes: 5 };
const EXPLAIN_RELATION_BUDGET: TeachingActivityBudget = { minMinutes: 4, maxMinutes: 6 };
const EXPLAIN_ACTION_BUDGET: TeachingActivityBudget = { minMinutes: 3, maxMinutes: 4 };
const WORKED_PROCESS_BUDGET: TeachingActivityBudget = { minMinutes: 5, maxMinutes: 7 };
const PRACTICE_BUDGET: TeachingActivityBudget = { minMinutes: 3, maxMinutes: 5 };
const SYNTHESIS_BUDGET: TeachingActivityBudget = { minMinutes: 2, maxMinutes: 3 };

function sumBudgets(budgets: TeachingActivityBudget[]): TeachingActivityBudget {
  return budgets.reduce(
    (total, budget) => ({
      minMinutes: total.minMinutes + budget.minMinutes,
      maxMinutes: total.maxMinutes + budget.maxMinutes,
    }),
    { minMinutes: 0, maxMinutes: 0 },
  );
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, 'en-US'));
}

function validatePlanningInput(input: TeachingSkeletonPlanningInput): void {
  const maxLessonSlots = input.maxLessonSlots ?? 12;
  const maxPracticeSlots = input.maxPracticeSlots ?? 8;
  const refs = input.objectives.map((objective) => objective.objectiveRef);
  if (
    !input.learningUnitTitle.trim() ||
    !Number.isInteger(input.targetMinutes) ||
    input.targetMinutes <= 0 ||
    input.targetMinutes > 480 ||
    input.objectives.length === 0 ||
    input.objectives.length > 30 ||
    !Number.isInteger(maxLessonSlots) ||
    maxLessonSlots < 1 ||
    maxLessonSlots > 12 ||
    !Number.isInteger(maxPracticeSlots) ||
    maxPracticeSlots < 1 ||
    maxPracticeSlots > 8 ||
    new Set(refs).size !== refs.length ||
    refs.some((ref) => !/^O[1-9][0-9]*$/u.test(ref))
  ) {
    throw new TeachingSkeletonPlanningError(
      'invalid_planning_input',
      'Teaching Skeleton planning input is incomplete, duplicated, or outside local limits.',
    );
  }
  for (const objective of input.objectives) {
    if (
      !objective.title.trim() ||
      !objective.description.trim() ||
      objective.allowedSourceRefs.some((ref) => !/^S[1-9][0-9]*$/u.test(ref)) ||
      objective.allowedVisualRefs.some((ref) => !/^V[1-9][0-9]*$/u.test(ref))
    ) {
      throw new TeachingSkeletonPlanningError(
        'invalid_planning_input',
        `Objective ${objective.objectiveRef} has invalid planning metadata.`,
        { objectiveRef: objective.objectiveRef },
      );
    }
    if (objective.authorityMode === 'unavailable') {
      throw new TeachingSkeletonPlanningError(
        'objective_authority_unavailable',
        `Objective ${objective.objectiveRef} has no bounded teaching authority.`,
        { objectiveRef: objective.objectiveRef, construct: objective.construct },
      );
    }
    if (objective.authorityMode === 'exact_source' && objective.allowedSourceRefs.length === 0) {
      throw new TeachingSkeletonPlanningError(
        'objective_authority_unavailable',
        `Objective ${objective.objectiveRef} has no exact source alias.`,
        { objectiveRef: objective.objectiveRef, construct: objective.construct },
      );
    }
    if (objective.authorityMode === 'advisory_visual' && objective.allowedVisualRefs.length === 0) {
      throw new TeachingSkeletonPlanningError(
        'objective_authority_unavailable',
        `Objective ${objective.objectiveRef} has no advisory visual alias.`,
        { objectiveRef: objective.objectiveRef, construct: objective.construct },
      );
    }
    if (
      objective.authorityMode !== 'exact_source' &&
      objective.construct !== 'identify' &&
      objective.construct !== 'explain'
    ) {
      throw new TeachingSkeletonPlanningError(
        'construct_authority_incompatible',
        `Objective ${objective.objectiveRef} cannot be planned as ${objective.construct} without exact construct authority.`,
        {
          objectiveRef: objective.objectiveRef,
          construct: objective.construct,
          authorityMode: objective.authorityMode,
        },
      );
    }
  }
}

function plannedObjective(objective: TeachingSkeletonPlanningObjective): TeachingSkeletonObjective {
  return {
    objectiveRef: objective.objectiveRef,
    title: objective.title.trim(),
    description: objective.description.trim(),
    priority: objective.priority,
    construct: objective.construct,
    authorityMode: objective.authorityMode as Exclude<
      TeachingSkeletonPlanningObjective['authorityMode'],
      'unavailable'
    >,
    allowedSourceRefs: sortedUnique(objective.allowedSourceRefs),
    allowedVisualRefs: sortedUnique(objective.allowedVisualRefs),
  };
}

function slotAuthority(objective: TeachingSkeletonObjective): {
  authorityMode: TeachingSkeletonAuthorityMode;
  allowedSourceRefs: string[];
  allowedVisualRefs: string[];
} {
  return {
    authorityMode: objective.authorityMode,
    allowedSourceRefs: objective.allowedSourceRefs,
    allowedVisualRefs: objective.allowedVisualRefs,
  };
}

function relationKinds(construct: FormalAssessmentConstruct): TeachingRelationKind[] {
  switch (construct) {
    case 'identify':
      return ['difference_discrimination'];
    case 'explain':
      return ['mechanism_effect', 'cause_consequence', 'condition_action'];
    case 'apply':
      return ['step_purpose', 'condition_action', 'omission_failure'];
    case 'design':
      return ['condition_action', 'step_purpose'];
    case 'evaluate':
      return ['evidence_conclusion', 'condition_action'];
  }
}

function coreSlots(objectives: TeachingSkeletonObjective[]): TeachingSkeletonSlot[] {
  const slots: TeachingSkeletonSlot[] = [];
  const push = (slot: Omit<TeachingSkeletonSlot, 'slotId'>): void => {
    slots.push({ ...slot, slotId: `L${slots.length + 1}` });
  };
  push({
    objectiveRefs: objectives.map((objective) => objective.objectiveRef),
    construct: null,
    role: 'objective_orientation',
    purpose:
      'Orient the learner to the locally selected capabilities and their place in the current route.',
    authorityMode: 'bounded_synthesis',
    allowedSourceRefs: sortedUnique(objectives.flatMap((objective) => objective.allowedSourceRefs)),
    allowedVisualRefs: sortedUnique(objectives.flatMap((objective) => objective.allowedVisualRefs)),
    protected: true,
    activityBudget: ORIENTATION_BUDGET,
    learnerActionRequired: false,
    qualityContract: 'orientation',
    allowedRelations: [],
  });
  for (const objective of objectives) {
    const protectedSlot = objective.priority !== 'optional';
    const authority = slotAuthority(objective);
    if (objective.construct === 'identify') {
      push({
        objectiveRefs: [objective.objectiveRef],
        construct: objective.construct,
        role: 'guided_practice',
        purpose:
          'Make the objective observable through meaningful identification or discrimination, not source-location recall.',
        ...authority,
        protected: protectedSlot,
        activityBudget: IDENTIFY_ACTION_BUDGET,
        learnerActionRequired: true,
        qualityContract: 'discrimination',
        allowedRelations: relationKinds(objective.construct),
      });
      continue;
    }
    if (objective.construct === 'explain') {
      push({
        objectiveRefs: [objective.objectiveRef],
        construct: objective.construct,
        role: 'mechanism',
        purpose:
          'Teach a source-compatible mechanism, relation, reason, or consequence with two meaningful propositions.',
        ...authority,
        protected: protectedSlot,
        activityBudget: EXPLAIN_RELATION_BUDGET,
        learnerActionRequired: false,
        qualityContract: 'semantic_relation',
        allowedRelations: relationKinds(objective.construct),
      });
      push({
        objectiveRefs: [objective.objectiveRef],
        construct: objective.construct,
        role: 'guided_practice',
        purpose:
          'Require the learner to commit to a mechanism or relation before guidance is revealed.',
        ...authority,
        protected: protectedSlot,
        activityBudget: EXPLAIN_ACTION_BUDGET,
        learnerActionRequired: true,
        qualityContract: 'learner_action',
        allowedRelations: relationKinds(objective.construct),
      });
      continue;
    }
    push({
      objectiveRefs: [objective.objectiveRef],
      construct: objective.construct,
      role: 'worked_example',
      purpose:
        'Work from a concrete starting state through the exact source rule and visible transitions, require a bounded learner decision or judgment before guidance, then show the result and why it follows.',
      ...authority,
      protected: protectedSlot,
      activityBudget: WORKED_PROCESS_BUDGET,
      learnerActionRequired: true,
      qualityContract: 'worked_process',
      allowedRelations: relationKinds(objective.construct),
    });
  }
  return slots;
}

function practiceTargets(objectives: TeachingSkeletonObjective[]): TeachingSkeletonObjective[] {
  const required = objectives.filter(
    (objective) => objective.priority === 'required' || objective.priority === 'high',
  );
  if (required.length > 0) return required;
  return [objectives.find((objective) => objective.priority === 'normal') ?? objectives[0]!];
}

function practiceSlots(objectives: TeachingSkeletonObjective[]): TeachingPracticePlanSlot[] {
  return practiceTargets(objectives).map((objective, index) => ({
    practiceSlotId: `PR${index + 1}`,
    objectiveRef: objective.objectiveRef,
    construct: objective.construct,
    authorityMode: objective.authorityMode,
    allowedSourceRefs: objective.allowedSourceRefs,
    allowedVisualRefs: objective.allowedVisualRefs,
    capabilityToObserve: PRACTICE_CAPABILITIES[objective.construct],
    prohibitedStrongerConstructs: STRONGER_CONSTRUCTS[objective.construct],
    retryPermitted: true,
    activityBudget: PRACTICE_BUDGET,
  }));
}

function withOptionalDurationSupport(
  initialSlots: TeachingSkeletonSlot[],
  objectives: TeachingSkeletonObjective[],
  practiceBudget: TeachingActivityBudget,
  acceptable: TeachingActivityBudget,
  maxLessonSlots: number,
): TeachingSkeletonSlot[] {
  const slots = [...initialSlots];
  const candidates = objectives.flatMap((objective) => {
    const authority = slotAuthority(objective);
    return [
      {
        objectiveRefs: [objective.objectiveRef],
        construct: objective.construct,
        role: 'contrast' as const,
        purpose:
          'Clarify a useful source-compatible boundary or discrimination only when the Agenda has room.',
        ...authority,
        protected: false,
        activityBudget: { minMinutes: 2, maxMinutes: 4 },
        learnerActionRequired: false,
        qualityContract: 'boundary_work' as const,
        allowedRelations: ['difference_discrimination'] as TeachingRelationKind[],
      },
      {
        objectiveRefs: [objective.objectiveRef],
        construct: objective.construct,
        role: 'explanation' as const,
        purpose:
          'Deepen one source-compatible relation only after required instruction and Practice fit.',
        ...authority,
        protected: false,
        activityBudget: { minMinutes: 3, maxMinutes: 5 },
        learnerActionRequired: false,
        qualityContract: 'semantic_relation' as const,
        allowedRelations: relationKinds(objective.construct),
      },
    ];
  });
  const plannedBudget = () =>
    sumBudgets([...slots.map((slot) => slot.activityBudget), practiceBudget, SYNTHESIS_BUDGET]);
  for (const candidate of candidates) {
    if (plannedBudget().maxMinutes >= acceptable.minMinutes) break;
    if (slots.length >= maxLessonSlots) break;
    const nextMinimum = plannedBudget().minMinutes + candidate.activityBudget.minMinutes;
    if (nextMinimum > acceptable.maxMinutes) continue;
    slots.push({ ...candidate, slotId: `L${slots.length + 1}` });
  }
  return slots;
}

/** Pure deterministic planning: no provider, repository, clock, or learner-state access. */
export function planTeachingSkeleton(input: TeachingSkeletonPlanningInput): TeachingSkeleton {
  validatePlanningInput(input);
  const maxLessonSlots = input.maxLessonSlots ?? 12;
  const maxPracticeSlots = input.maxPracticeSlots ?? 8;
  const objectives = input.objectives.map(plannedObjective);
  const plannedPracticeSlots = practiceSlots(objectives);
  if (plannedPracticeSlots.length > maxPracticeSlots) {
    throw new TeachingSkeletonPlanningError(
      'practice_slot_limit_exceeded',
      'Required/high objectives exceed the bounded Practice slot limit.',
      { requiredSlots: plannedPracticeSlots.length, maxPracticeSlots },
    );
  }
  const practiceBudget = sumBudgets(plannedPracticeSlots.map((slot) => slot.activityBudget));
  const acceptableActiveMinutes = {
    minMinutes: Math.max(1, input.targetMinutes - 8),
    maxMinutes: input.targetMinutes + 3,
  };
  const initialSlots = coreSlots(objectives);
  if (initialSlots.length > maxLessonSlots) {
    throw new TeachingSkeletonPlanningError(
      'lesson_slot_limit_exceeded',
      'Construct-required Lesson slots exceed the bounded slot limit.',
      { requiredSlots: initialSlots.length, maxLessonSlots },
    );
  }
  const protectedBudget = sumBudgets([
    ...initialSlots.filter((slot) => slot.protected).map((slot) => slot.activityBudget),
    practiceBudget,
    SYNTHESIS_BUDGET,
  ]);
  if (protectedBudget.minMinutes > acceptableActiveMinutes.maxMinutes) {
    throw new TeachingSkeletonPlanningError(
      'protected_budget_exceeds_agenda',
      'Protected instructional actions cannot plausibly fit the accepted Agenda duration.',
      {
        targetMinutes: input.targetMinutes,
        acceptableActiveMinutes,
        protectedActivityBudget: protectedBudget,
      },
    );
  }
  const initialPlannedBudget = sumBudgets([
    ...initialSlots.map((slot) => slot.activityBudget),
    practiceBudget,
    SYNTHESIS_BUDGET,
  ]);
  if (initialPlannedBudget.minMinutes > acceptableActiveMinutes.maxMinutes) {
    throw new TeachingSkeletonPlanningError(
      'planned_budget_exceeds_agenda',
      'The selected objective set cannot plausibly fit the accepted Agenda duration.',
      {
        targetMinutes: input.targetMinutes,
        acceptableActiveMinutes,
        plannedActivityBudget: initialPlannedBudget,
      },
    );
  }
  const lessonSlots = withOptionalDurationSupport(
    initialSlots,
    objectives,
    practiceBudget,
    acceptableActiveMinutes,
    maxLessonSlots,
  );
  const plannedActivityBudget = sumBudgets([
    ...lessonSlots.map((slot) => slot.activityBudget),
    practiceBudget,
    SYNTHESIS_BUDGET,
  ]);
  if (plannedActivityBudget.maxMinutes < acceptableActiveMinutes.minMinutes) {
    throw new TeachingSkeletonPlanningError(
      'agenda_budget_underfilled',
      'The bounded instructional plan cannot honestly support the accepted Agenda duration.',
      {
        targetMinutes: input.targetMinutes,
        acceptableActiveMinutes,
        plannedActivityBudget,
      },
    );
  }
  const draft = {
    schemaVersion: 1 as const,
    plannerVersion: TEACHING_SKELETON_PLANNER_VERSION,
    learningUnitTitle: input.learningUnitTitle.trim(),
    objectives,
    targetMinutes: input.targetMinutes,
    acceptableActiveMinutes,
    lessonSlots,
    practicePlan: {
      schemaVersion: 1 as const,
      slots: plannedPracticeSlots,
      activityBudget: practiceBudget,
    },
    synthesisActivityBudget: SYNTHESIS_BUDGET,
    protectedActivityBudget: protectedBudget,
    plannedActivityBudget,
  };
  const digest = createHash('sha256').update(JSON.stringify(draft)).digest('hex');
  return TeachingSkeletonSchema.parse({
    id: `teaching_skeleton_${digest.slice(0, 40)}`,
    fingerprint: `sha256:${digest}`,
    ...draft,
  });
}
