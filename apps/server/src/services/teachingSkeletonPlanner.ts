import { createHash } from 'node:crypto';
import {
  DesiredDepthSchema,
  TeachingSkeletonSchema,
  type DesiredDepth,
  type FormalAssessmentConstruct,
  type TeachingActivityBudget,
  type TeachingPracticePlanSlot,
  type TeachingRelationKind,
  type TeachingSkeleton,
  type TeachingSkeletonAuthorityMode,
  type TeachingSkeletonObjective,
  type TeachingSkeletonQualityContract,
  type TeachingSkeletonSlot,
} from '@hy3-clinic/shared';

export const TEACHING_SKELETON_PLANNER_VERSION = 'teaching-skeleton-planner-v2';

export type TeachingSkeletonPlanningErrorCode =
  | 'invalid_planning_input'
  | 'objective_authority_unavailable'
  | 'construct_authority_incompatible'
  | 'lesson_slot_limit_exceeded'
  | 'practice_slot_limit_exceeded'
  | 'protected_budget_exceeds_agenda'
  | 'planned_budget_exceeds_agenda'
  | 'agenda_budget_underfilled'
  | 'required_quality_contract_missing';

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
  /**
   * Accepted StudyPlan depth for this teaching item. Depth decides WHICH quality
   * obligations are required; `targetMinutes` only decides whether they fit.
   */
  targetDepth: DesiredDepth;
  objectives: TeachingSkeletonPlanningObjective[];
  maxLessonSlots?: number;
  maxPracticeSlots?: number;
}

/**
 * The only contracts depth may add. `worked_process` is deliberately absent: it
 * stays construct-derived, so no depth can make an `identify` objective claim a
 * procedure its source never states.
 */
type DepthAddedContract = Extract<
  TeachingSkeletonQualityContract,
  'boundary_work' | 'semantic_relation'
>;

/** Total over DesiredDepth. Filtered against the construct core before use. */
const DEPTH_CONTRACTS: Record<DesiredDepth, readonly DepthAddedContract[]> = {
  pass_oriented: [],
  working_fluency: ['boundary_work'],
  high_performance: ['boundary_work'],
  deep_transfer: ['boundary_work', 'semantic_relation'],
};

/**
 * Contracts each construct's core slots already carry. Depth adds an obligation
 * only where the core does not already supply it, so `explain` never receives a
 * redundant second `semantic_relation`. Kept in step with `constructCoreSlots`
 * by a drift test rather than by comment.
 */
const CORE_CONTRACTS: Record<
  FormalAssessmentConstruct,
  readonly TeachingSkeletonQualityContract[]
> = {
  identify: ['discrimination'],
  explain: ['semantic_relation', 'learner_action'],
  apply: ['worked_process'],
  design: ['worked_process'],
  evaluate: ['worked_process'],
};

/** Pure and total over DesiredDepth x FormalAssessmentConstruct. */
export function requiredDepthContracts(
  targetDepth: DesiredDepth,
  construct: FormalAssessmentConstruct,
): DepthAddedContract[] {
  const core = CORE_CONTRACTS[construct];
  return DEPTH_CONTRACTS[targetDepth].filter((contract) => !core.includes(contract));
}

export interface RequiredQualityContractPair {
  objectiveRef: string;
  qualityContract: TeachingSkeletonQualityContract;
}

function samePair(left: RequiredQualityContractPair, right: RequiredQualityContractPair): boolean {
  return left.objectiveRef === right.objectiveRef && left.qualityContract === right.qualityContract;
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
const BOUNDARY_WORK_BUDGET: TeachingActivityBudget = { minMinutes: 2, maxMinutes: 4 };
const DEPTH_RELATION_BUDGET: TeachingActivityBudget = { minMinutes: 3, maxMinutes: 5 };

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
    !DesiredDepthSchema.safeParse(input.targetDepth).success ||
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

type UnnumberedSlot = Omit<TeachingSkeletonSlot, 'slotId'>;

/**
 * A slot decided by arithmetic alone. Authority decorates a slot; it never
 * participates in slot counts or budgets, so the shared feasibility core works in
 * blueprints and the planner alone attaches the authority envelope.
 */
type TeachingSlotBlueprint = Omit<
  UnnumberedSlot,
  'authorityMode' | 'allowedSourceRefs' | 'allowedVisualRefs'
>;

/** The arithmetic-relevant projection of an objective. No authority, no prose. */
export interface TeachingSlotArithmeticObjective {
  objectiveRef: string;
  construct: FormalAssessmentConstruct;
  priority: 'required' | 'high' | 'normal' | 'optional';
}

function constructCoreSlots(objective: TeachingSlotArithmeticObjective): TeachingSlotBlueprint[] {
  const protectedSlot = objective.priority !== 'optional';
  if (objective.construct === 'identify') {
    return [
      {
        objectiveRefs: [objective.objectiveRef],
        construct: objective.construct,
        role: 'guided_practice',
        purpose:
          'Make the objective observable through meaningful identification or discrimination, not source-location recall.',
        protected: protectedSlot,
        activityBudget: IDENTIFY_ACTION_BUDGET,
        learnerActionRequired: true,
        qualityContract: 'discrimination',
        allowedRelations: relationKinds(objective.construct),
      },
    ];
  }
  if (objective.construct === 'explain') {
    return [
      {
        objectiveRefs: [objective.objectiveRef],
        construct: objective.construct,
        role: 'mechanism',
        purpose:
          'Teach a source-compatible mechanism, relation, reason, or consequence with two meaningful propositions.',
        protected: protectedSlot,
        activityBudget: EXPLAIN_RELATION_BUDGET,
        learnerActionRequired: false,
        qualityContract: 'semantic_relation',
        allowedRelations: relationKinds(objective.construct),
      },
      {
        objectiveRefs: [objective.objectiveRef],
        construct: objective.construct,
        role: 'guided_practice',
        purpose:
          'Require the learner to commit to a mechanism or relation before guidance is revealed.',
        protected: protectedSlot,
        activityBudget: EXPLAIN_ACTION_BUDGET,
        learnerActionRequired: true,
        qualityContract: 'learner_action',
        allowedRelations: relationKinds(objective.construct),
      },
    ];
  }
  return [
    {
      objectiveRefs: [objective.objectiveRef],
      construct: objective.construct,
      role: 'worked_example',
      purpose:
        'Work from a concrete starting state through the exact source rule and visible transitions, require a bounded learner decision or judgment before guidance, then show the result and why it follows.',
      protected: protectedSlot,
      activityBudget: WORKED_PROCESS_BUDGET,
      learnerActionRequired: true,
      qualityContract: 'worked_process',
      allowedRelations: relationKinds(objective.construct),
    },
  ];
}

/**
 * Depth-required obligations, emitted in the required planning phase so they take
 * part in the protected budget instead of depending on leftover minutes. Reuses
 * the existing `contrast` and `explanation` roles; introduces no new vocabulary.
 */
function depthRequiredSlots(
  objective: TeachingSlotArithmeticObjective,
  targetDepth: DesiredDepth,
): TeachingSlotBlueprint[] {
  const protectedSlot = objective.priority !== 'optional';
  return requiredDepthContracts(targetDepth, objective.construct).map((contract) => {
    if (contract === 'boundary_work') {
      return {
        objectiveRefs: [objective.objectiveRef],
        construct: objective.construct,
        role: 'contrast' as const,
        purpose:
          'Establish the source-compatible boundary of the objective: what it excludes, or the misconception it corrects.',
        protected: protectedSlot,
        activityBudget: BOUNDARY_WORK_BUDGET,
        learnerActionRequired: false,
        qualityContract: contract,
        allowedRelations: ['difference_discrimination'] as TeachingRelationKind[],
      };
    }
    return {
      objectiveRefs: [objective.objectiveRef],
      construct: objective.construct,
      role: 'explanation' as const,
      purpose:
        'Teach one typed source-compatible relation the objective depends on, so transfer does not rest on restatement.',
      protected: protectedSlot,
      activityBudget: DEPTH_RELATION_BUDGET,
      learnerActionRequired: false,
      qualityContract: contract,
      allowedRelations: relationKinds(objective.construct),
    };
  });
}

function requiredSlots(
  objectives: TeachingSlotArithmeticObjective[],
  targetDepth: DesiredDepth,
): TeachingSlotBlueprint[] {
  const slots: TeachingSlotBlueprint[] = [];
  slots.push({
    objectiveRefs: objectives.map((objective) => objective.objectiveRef),
    construct: null,
    role: 'objective_orientation',
    purpose:
      'Orient the learner to the locally selected capabilities and their place in the current route.',
    protected: true,
    activityBudget: ORIENTATION_BUDGET,
    learnerActionRequired: false,
    qualityContract: 'orientation',
    allowedRelations: [],
  });
  for (const objective of objectives) {
    for (const slot of constructCoreSlots(objective)) slots.push(slot);
    for (const slot of depthRequiredSlots(objective, targetDepth)) slots.push(slot);
  }
  return slots;
}

/** The deterministic depth obligation set the final skeleton must satisfy. */
function requiredDepthPairs(
  objectives: TeachingSlotArithmeticObjective[],
  targetDepth: DesiredDepth,
): RequiredQualityContractPair[] {
  return objectives.flatMap((objective) =>
    requiredDepthContracts(targetDepth, objective.construct).map((qualityContract) => ({
      objectiveRef: objective.objectiveRef,
      qualityContract: qualityContract as TeachingSkeletonQualityContract,
    })),
  );
}

/**
 * Guards slot assembly, not planning arithmetic: a future refactor that computes a
 * depth obligation and then loses it during assembly must fail loudly here rather
 * than ship a silently thinner Lesson.
 */
export function assertRequiredPairsPlanned(
  lessonSlots: TeachingSkeletonSlot[],
  requiredPairs: RequiredQualityContractPair[],
): void {
  const planned = lessonSlots.flatMap((slot) =>
    slot.objectiveRefs.map((objectiveRef) => ({
      objectiveRef,
      qualityContract: slot.qualityContract,
    })),
  );
  const missing = requiredPairs.filter(
    (required) => !planned.some((candidate) => samePair(candidate, required)),
  );
  if (missing.length > 0) {
    throw new TeachingSkeletonPlanningError(
      'required_quality_contract_missing',
      'The planned Lesson skeleton is missing a depth-required quality contract.',
      { missing },
    );
  }
}

function practiceTargets<T extends TeachingSlotArithmeticObjective>(objectives: T[]): T[] {
  const required = objectives.filter(
    (objective) => objective.priority === 'required' || objective.priority === 'high',
  );
  if (required.length > 0) return required;
  return [objectives.find((objective) => objective.priority === 'normal') ?? objectives[0]!];
}

/** Driven by the shared core's selection, so target choice has one implementation. */
function practiceSlots(
  practiceObjectiveRefs: string[],
  objectivesByRef: Map<string, TeachingSkeletonObjective>,
): TeachingPracticePlanSlot[] {
  return practiceObjectiveRefs.map((practiceObjectiveRef, index) => {
    const objective = objectivesByRef.get(practiceObjectiveRef)!;
    return {
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
    };
  });
}

/**
 * Attaches the authority envelope to an arithmetic blueprint. Field order matches the
 * pre-extraction slot literals exactly, because the skeleton fingerprint hashes this
 * object's JSON serialization.
 */
function decorateSlot(
  blueprint: TeachingSlotBlueprint,
  slotIndex: number,
  objectivesByRef: Map<string, TeachingSkeletonObjective>,
  orientationAuthority: ReturnType<typeof slotAuthority>,
): TeachingSkeletonSlot {
  const objective =
    blueprint.construct === null ? undefined : objectivesByRef.get(blueprint.objectiveRefs[0]!);
  const authority = objective ? slotAuthority(objective) : orientationAuthority;
  return {
    objectiveRefs: blueprint.objectiveRefs,
    construct: blueprint.construct,
    role: blueprint.role,
    purpose: blueprint.purpose,
    authorityMode: authority.authorityMode,
    allowedSourceRefs: authority.allowedSourceRefs,
    allowedVisualRefs: authority.allowedVisualRefs,
    protected: blueprint.protected,
    activityBudget: blueprint.activityBudget,
    learnerActionRequired: blueprint.learnerActionRequired,
    qualityContract: blueprint.qualityContract,
    allowedRelations: blueprint.allowedRelations,
    slotId: `L${slotIndex + 1}`,
  };
}

function withOptionalDurationSupport(
  initialSlots: TeachingSlotBlueprint[],
  objectives: TeachingSlotArithmeticObjective[],
  practiceBudget: TeachingActivityBudget,
  acceptable: TeachingActivityBudget,
  maxLessonSlots: number,
  requiredPairs: RequiredQualityContractPair[],
): TeachingSlotBlueprint[] {
  const slots = [...initialSlots];
  const candidates = objectives.flatMap((objective) => [
    {
      objectiveRefs: [objective.objectiveRef],
      construct: objective.construct,
      role: 'contrast' as const,
      purpose:
        'Clarify a useful source-compatible boundary or discrimination only when the Agenda has room.',
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
      protected: false,
      activityBudget: { minMinutes: 3, maxMinutes: 5 },
      learnerActionRequired: false,
      qualityContract: 'semantic_relation' as const,
      allowedRelations: relationKinds(objective.construct),
    },
  ]);
  const plannedBudget = () =>
    sumBudgets([...slots.map((slot) => slot.activityBudget), practiceBudget, SYNTHESIS_BUDGET]);
  for (const candidate of candidates) {
    if (plannedBudget().maxMinutes >= acceptable.minMinutes) break;
    if (slots.length >= maxLessonSlots) break;
    // Depth already required this obligation; a second same-contract slot would be
    // redundant enrichment, not added support.
    if (
      requiredPairs.some((required) =>
        samePair(required, {
          objectiveRef: candidate.objectiveRefs[0]!,
          qualityContract: candidate.qualityContract,
        }),
      )
    ) {
      continue;
    }
    const nextMinimum = plannedBudget().minMinutes + candidate.activityBudget.minMinutes;
    if (nextMinimum > acceptable.maxMinutes) continue;
    slots.push(candidate);
  }
  return slots;
}

/**
 * Everything the arithmetic class needs and nothing more. Deliberately no
 * `authorityMode`, `allowedSourceRefs`, `allowedVisualRefs`, `title` or
 * `description`: those decide the authority class, which is a different question
 * that cannot be answered before Lesson-preparation source context exists.
 */
export interface TeachingSlotArithmeticInput {
  targetMinutes: number;
  targetDepth: DesiredDepth;
  objectives: TeachingSlotArithmeticObjective[];
  maxLessonSlots?: number;
  maxPracticeSlots?: number;
}

/** The arithmetic plan a feasible input yields. Decorated by the planner. */
interface TeachingSlotArithmeticPlan {
  lessonSlots: TeachingSlotBlueprint[];
  practiceObjectiveRefs: string[];
  practiceBudget: TeachingActivityBudget;
  acceptableActiveMinutes: TeachingActivityBudget;
  protectedActivityBudget: TeachingActivityBudget;
  plannedActivityBudget: TeachingActivityBudget;
  requiredPairs: RequiredQualityContractPair[];
}

/**
 * The single slot/budget implementation. `planTeachingSkeleton` calls it, and so does
 * the pre-acceptance StudyPlan plannability gate, so the two cannot drift apart.
 *
 * Throws `TeachingSkeletonPlanningError` with the same codes, in the same order, with
 * the same `details` the planner has always thrown. Callers wanting a verdict rather
 * than an exception use `resolveTeachingSlotFeasibility`.
 */
function planTeachingSlotArithmetic(
  input: TeachingSlotArithmeticInput,
): TeachingSlotArithmeticPlan {
  const maxLessonSlots = input.maxLessonSlots ?? 12;
  const maxPracticeSlots = input.maxPracticeSlots ?? 8;
  const plannedPracticeTargets = practiceTargets(input.objectives);
  if (plannedPracticeTargets.length > maxPracticeSlots) {
    throw new TeachingSkeletonPlanningError(
      'practice_slot_limit_exceeded',
      'Required/high objectives exceed the bounded Practice slot limit.',
      { requiredSlots: plannedPracticeTargets.length, maxPracticeSlots },
    );
  }
  const practiceBudget = sumBudgets(plannedPracticeTargets.map(() => PRACTICE_BUDGET));
  const acceptableActiveMinutes = {
    minMinutes: Math.max(1, input.targetMinutes - 8),
    maxMinutes: input.targetMinutes + 3,
  };
  const requiredPairs = requiredDepthPairs(input.objectives, input.targetDepth);
  const initialSlots = requiredSlots(input.objectives, input.targetDepth);
  if (initialSlots.length > maxLessonSlots) {
    throw new TeachingSkeletonPlanningError(
      'lesson_slot_limit_exceeded',
      'Construct-required and depth-required Lesson slots exceed the bounded slot limit.',
      { requiredSlots: initialSlots.length, maxLessonSlots, targetDepth: input.targetDepth },
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
        targetDepth: input.targetDepth,
        acceptableActiveMinutes,
        protectedActivityBudget: protectedBudget,
        requiredDepthContracts: requiredPairs,
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
        targetDepth: input.targetDepth,
        acceptableActiveMinutes,
        plannedActivityBudget: initialPlannedBudget,
        requiredDepthContracts: requiredPairs,
      },
    );
  }
  const lessonSlots = withOptionalDurationSupport(
    initialSlots,
    input.objectives,
    practiceBudget,
    acceptableActiveMinutes,
    maxLessonSlots,
    requiredPairs,
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
        targetDepth: input.targetDepth,
        acceptableActiveMinutes,
        plannedActivityBudget,
      },
    );
  }
  return {
    lessonSlots,
    practiceObjectiveRefs: plannedPracticeTargets.map((objective) => objective.objectiveRef),
    practiceBudget,
    acceptableActiveMinutes,
    protectedActivityBudget: protectedBudget,
    plannedActivityBudget,
    requiredPairs,
  };
}

/** Arithmetic-class codes only. The authority class is not decidable from arithmetic. */
export type TeachingSlotArithmeticErrorCode = Extract<
  TeachingSkeletonPlanningErrorCode,
  | 'lesson_slot_limit_exceeded'
  | 'practice_slot_limit_exceeded'
  | 'protected_budget_exceeds_agenda'
  | 'planned_budget_exceeds_agenda'
  | 'agenda_budget_underfilled'
>;

export type TeachingSlotFeasibility =
  | { feasible: true }
  | {
      feasible: false;
      code: TeachingSlotArithmeticErrorCode;
      message: string;
      details: Record<string, unknown>;
    };

/**
 * Non-throwing slot/budget verdict, over the same core the real planner uses.
 *
 * `feasible` means no arithmetic-class planning failure. It does **not** prove the
 * Lesson will plan: `objective_authority_unavailable` and
 * `construct_authority_incompatible` depend on retrieval-derived authority that does
 * not exist before Lesson preparation, and remain reachable there.
 */
export function resolveTeachingSlotFeasibility(
  input: TeachingSlotArithmeticInput,
): TeachingSlotFeasibility {
  try {
    planTeachingSlotArithmetic(input);
    return { feasible: true };
  } catch (error) {
    if (error instanceof TeachingSkeletonPlanningError) {
      return {
        feasible: false,
        code: error.code as TeachingSlotArithmeticErrorCode,
        message: error.message,
        details: error.details,
      };
    }
    throw error;
  }
}

/** Pure deterministic planning: no provider, repository, clock, or learner-state access. */
export function planTeachingSkeleton(input: TeachingSkeletonPlanningInput): TeachingSkeleton {
  validatePlanningInput(input);
  const objectives = input.objectives.map(plannedObjective);
  const objectivesByRef = new Map(
    objectives.map((objective) => [objective.objectiveRef, objective] as const),
  );
  const arithmetic = planTeachingSlotArithmetic({
    targetMinutes: input.targetMinutes,
    targetDepth: input.targetDepth,
    objectives: objectives.map((objective) => ({
      objectiveRef: objective.objectiveRef,
      construct: objective.construct,
      priority: objective.priority,
    })),
    ...(input.maxLessonSlots === undefined ? {} : { maxLessonSlots: input.maxLessonSlots }),
    ...(input.maxPracticeSlots === undefined ? {} : { maxPracticeSlots: input.maxPracticeSlots }),
  });
  const { acceptableActiveMinutes, practiceBudget, plannedActivityBudget } = arithmetic;
  const orientationAuthority = {
    authorityMode: 'bounded_synthesis' as const,
    allowedSourceRefs: sortedUnique(objectives.flatMap((objective) => objective.allowedSourceRefs)),
    allowedVisualRefs: sortedUnique(objectives.flatMap((objective) => objective.allowedVisualRefs)),
  };
  const lessonSlots = arithmetic.lessonSlots.map((blueprint, index) =>
    decorateSlot(blueprint, index, objectivesByRef, orientationAuthority),
  );
  const plannedPracticeSlots = practiceSlots(arithmetic.practiceObjectiveRefs, objectivesByRef);
  assertRequiredPairsPlanned(lessonSlots, arithmetic.requiredPairs);
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
    protectedActivityBudget: arithmetic.protectedActivityBudget,
    plannedActivityBudget,
  };
  const digest = createHash('sha256').update(JSON.stringify(draft)).digest('hex');
  return TeachingSkeletonSchema.parse({
    id: `teaching_skeleton_${digest.slice(0, 40)}`,
    fingerprint: `sha256:${digest}`,
    ...draft,
  });
}
