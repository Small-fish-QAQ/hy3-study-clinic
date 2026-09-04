import {
  ApiErrorCode,
  ApplyStudyPlanDraftEditRequestSchema,
  ProposeStudyPlanRequestSchema,
  StudyPlanHistoryResponseSchema,
  StudyPlanPreflightSchema,
  StudyPlanProposalResponseSchema,
  type ApplyStudyPlanDraftEditRequest,
  type CoverageRiskEntry,
  type Curriculum,
  type LearningContract,
  type ProposeStudyPlanRequest,
  type StudyPlan,
  type StudyPlanHistoryResponse,
  type StudyPlanItem,
  type StudyPlanItemKind,
  type StudyPlanPreflight,
  type StudyPlanProposalResponse,
} from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import type { LlmProvider, ProviderCallOptions, StudyPlanProposalInput } from '../llm/provider.js';
import { groupedStudyPlanProposalMessages, studyPlanProposalMessages } from '../llm/prompts.js';
import type { CourseExecutionState } from '../repositories/courseExecution.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import type { CourseCommandService } from './courseCommands.js';
import {
  PACE_BASELINE_POLICY_VERSION,
  buildUnitLaunchProfiles,
  deriveTeachUnitDurationsOrThrow,
  diffStudyPlans,
  materializeDeferralRisk,
  planFeasibilityFromContract,
  plannabilityWarningText,
  resolveLaunchForPlanItem,
  resolveStudyPlanPlannability,
  validateAndMaterializeStudyPlanProposal,
  validateStudyPlanScopeAccounting,
} from './studyPlanValidation.js';
import {
  enforceAgentCostPolicies,
  runTrackedAgentProviderOperation,
} from './agentProviderRuntime.js';
import { createTelemetryProvider } from './providerTelemetry.js';
import { assertLearningContractScopeCurrent } from './learningContractScope.js';
import { buildPlanningRecommendations } from './planningRecommendations.js';
import { validateCurriculumObjectiveAuthoritySemanticSupport } from './objectiveAuthoritySemanticSupport.js';

interface StudyPlanAgentDeps {
  repos: Repositories;
  provider: LlmProvider;
  clock: Clock;
  commands: CourseCommandService;
  providerModel?: string | null;
}

interface StudyPlanProposalPersistenceOptions {
  beforePersist?: () => void;
}

interface StudyPlanDraftEditPersistenceOptions {
  beforePersist?: () => void;
}

export const STUDY_PLAN_PROVIDER_TIMEOUT_MS = 240_000;
export const STUDY_PLAN_OPERATION_LEASE_MS = STUDY_PLAN_PROVIDER_TIMEOUT_MS * 2 + 120_000;

type StudyPlanRouteStateIdentity = Pick<
  CourseExecutionState,
  'version' | 'activeContractId' | 'activeCurriculumId' | 'acceptedPlanId' | 'activeAgendaId'
>;

function assertStudyPlanRouteStateUnchanged(
  repos: Repositories,
  workspaceId: string,
  expected: StudyPlanRouteStateIdentity,
): CourseExecutionState {
  const current = repos.courseExecution.get(workspaceId);
  if (
    current.version !== expected.version ||
    current.activeContractId !== expected.activeContractId ||
    current.activeCurriculumId !== expected.activeCurriculumId ||
    current.acceptedPlanId !== expected.acceptedPlanId ||
    current.activeAgendaId !== expected.activeAgendaId
  ) {
    throw new AppError(ApiErrorCode.VersionConflict, 'StudyPlan current route changed.', {
      kind: 'study_plan_route_state_changed',
      expected: {
        version: expected.version,
        activeContractId: expected.activeContractId,
        activeCurriculumId: expected.activeCurriculumId,
        acceptedPlanId: expected.acceptedPlanId,
        activeAgendaId: expected.activeAgendaId,
      },
      current: {
        version: current.version,
        activeContractId: current.activeContractId,
        activeCurriculumId: current.activeCurriculumId,
        acceptedPlanId: current.acceptedPlanId,
        activeAgendaId: current.activeAgendaId,
      },
    });
  }
  return current;
}

function requireContract(
  repos: Repositories,
  workspaceId: string,
  contractId: string,
  expectedVersion: number,
): LearningContract {
  const contract = repos.learningContracts.get(contractId);
  if (!contract || contract.workspaceId !== workspaceId)
    throw notFound('Learning Contract not found.');
  if (contract.version !== expectedVersion) {
    throw new AppError(ApiErrorCode.VersionConflict, 'Learning Contract version is stale.');
  }
  if (contract.status !== 'learner_confirmed' && contract.status !== 'active') {
    throw new AppError(
      ApiErrorCode.ValidationError,
      'StudyPlan requires a learner-confirmed Contract.',
    );
  }
  return contract;
}

function requireCurriculum(
  repos: Repositories,
  workspaceId: string,
  curriculumId: string,
  expectedVersion: number,
  contractId: string,
  manifestFingerprint: string,
): Curriculum {
  const curriculum = repos.curricula.get(curriculumId);
  if (!curriculum || curriculum.workspaceId !== workspaceId)
    throw notFound('Curriculum not found.');
  if (curriculum.version !== expectedVersion) {
    throw new AppError(ApiErrorCode.VersionConflict, 'Curriculum version is stale.');
  }
  if (
    curriculum.status !== 'accepted' ||
    curriculum.contractVersionId !== contractId ||
    curriculum.executionSourceManifest.fingerprint !== manifestFingerprint
  ) {
    throw new AppError(
      ApiErrorCode.VersionConflict,
      'Curriculum route identity is stale or incompatible.',
    );
  }
  return curriculum;
}

function systemDerivedPlanFeasibility(projectedMinutes: number) {
  return planFeasibilityFromContract(null, projectedMinutes, 'unknown', [
    projectedMinutes === 0
      ? 'Projected effort will be computed locally after the semantic proposal.'
      : 'Teaching-unit time is derived locally from the selected depth and objectives.',
  ]);
}

function buildProviderInput(
  repos: Repositories,
  clock: Clock,
  contract: LearningContract,
  curriculum: Curriculum,
  workspaceName: string,
): { input: StudyPlanProposalInput; profiles: ReturnType<typeof buildUnitLaunchProfiles> } {
  const profiles = buildUnitLaunchProfiles(repos, clock, contract.workspaceId, curriculum);
  const units = curriculum.nodes
    .filter((node) => node.kind === 'learning_unit' && node.learningUnit)
    .map((node) => ({
      id: node.id,
      title: node.title,
      objectiveIds: node.learningUnit!.objectives.map((objective) => objective.id),
      objectiveSummaries: node.learningUnit!.objectives.map((objective) => ({
        id: objective.id,
        title: objective.title,
        description: objective.description,
        ...(objective.priority ? { priority: objective.priority } : {}),
        ...(objective.priorityRationale ? { priorityRationale: objective.priorityRationale } : {}),
      })),
      prerequisiteUnitIds: node.learningUnit!.prerequisiteUnitIds,
      blockingEligibleObjectiveIds: node
        .learningUnit!.objectives.filter(
          (objective) => objective.truthPremiseStatus === 'independently_verified',
        )
        .map((objective) => objective.id),
      synthesisGroupIds: curriculum.synthesisGroups
        .filter((group) => group.learningUnitIds.includes(node.id))
        .map((group) => group.id),
    }));
  const activeState = repos.courseExecution.get(contract.workspaceId);
  const acceptedPlan = activeState.acceptedPlanId
    ? repos.studyPlans.get(activeState.acceptedPlanId)
    : undefined;
  const progress = acceptedPlan ? repos.studyPlans.listProgress(acceptedPlan.id) : [];
  const progressByItem = new Map(progress.map((item) => [item.planItemId, item.state]));
  const learnerState = units.map((unit) => {
    const acceptedItems =
      acceptedPlan?.items.filter((item) => item.curriculumLearningUnitId === unit.id) ?? [];
    const states = acceptedItems.map((item) => progressByItem.get(item.id));
    return {
      curriculumLearningUnitId: unit.id,
      state: states.includes('repair_needed')
        ? ('repair_needed' as const)
        : states.includes('completed')
          ? // StudyPlan progress is execution bookkeeping: Lesson completion can
            // reach it. Formal standing lives in learning_unit_progress.
            ('route_completed' as const)
          : states.includes('started')
            ? ('in_progress' as const)
            : states.includes('deferred')
              ? ('deferred' as const)
              : ('unassessed' as const),
      observedMinutes: null,
      openMistakes: 0,
    };
  });
  return {
    profiles,
    input: {
      workspaceName,
      contract: {
        contractVersionId: contract.id,
        intent: contract.intent,
        targetOutcome: {
          description: contract.targetOutcome.description,
          targetScore: contract.targetOutcome.targetScore,
        },
        deadline: null,
        studyBudget: {
          minutesPerDay: null,
          minutesPerWeek: null,
          preferredSessionMinutes: null,
          availabilityPolicy: 'estimate',
        },
        desiredDepth: contract.desiredDepth,
        subjectBoundaries: contract.courseScope.subjectBoundaries,
        materials: contract.courseScope.materials.map((scope) => ({
          materialId: scope.materialId,
          title: repos.materials.getRouteIdentity(scope.materialId)?.title ?? scope.materialId,
          materialRoleAssignmentId: scope.materialRoleAssignmentId,
          materialRoleAssignmentVersion: scope.materialRoleAssignmentVersion,
          role: scope.role,
          disposition: scope.disposition,
        })),
        includedTopics: contract.courseScope.includedTopics,
        excludedTopics: contract.courseScope.excludedTopics,
        // Soft time estimates never authorize autonomous scope reduction.
        allowExplicitDeferral:
          (contract.riskTolerance?.allowExplicitDeferral ?? false) &&
          contract.studyBudget.availabilityPolicy !== 'estimate',
      },
      curriculumVersionId: curriculum.id,
      executionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
      units,
      synthesisGroups: curriculum.synthesisGroups,
      learnerState,
      requiredLearningUnitIds: units.map((unit) => unit.id),
      allowedItemKinds: [...new Set(profiles.flatMap((profile) => profile.allowedItemKinds))],
      allowedDepths: Object.prototype.hasOwnProperty.call(contract, 'focusRequest')
        ? [contract.desiredDepth]
        : ['pass_oriented', 'working_fluency', 'high_performance', 'deep_transfer'],
      launchCapabilities: profiles.map((profile) => ({
        curriculumLearningUnitId: profile.curriculumLearningUnitId,
        allowedItemKinds: profile.allowedItemKinds,
        launchableAssessmentModes: profile.launchableAssessmentModes,
      })),
      feasibility: systemDerivedPlanFeasibility(0),
    },
  };
}

const GROUPED_MODEL_ITEM_KINDS = [
  'teach_unit',
  'informal_check',
  'formal_checkpoint',
  'targeted_repair',
  'due_review',
] as const;

const DETAILED_MODEL_ITEM_KINDS = [...GROUPED_MODEL_ITEM_KINDS, 'synthesis'] as const;

function studyPlanPreflightFromContext(
  contract: LearningContract,
  input: StudyPlanProposalInput,
  profiles: ReturnType<typeof buildUnitLaunchProfiles>,
): StudyPlanPreflight {
  const grouped = input.units.length >= 80;
  const modelFacingKinds = new Set<StudyPlanItemKind>(
    grouped ? GROUPED_MODEL_ITEM_KINDS : DETAILED_MODEL_ITEM_KINDS,
  );
  const requiredIds = new Set(input.requiredLearningUnitIds);
  const requiredProfiles = profiles.filter((profile) =>
    requiredIds.has(profile.curriculumLearningUnitId),
  );
  const unavailable = requiredProfiles.filter(
    (profile) => !profile.allowedItemKinds.some((kind) => modelFacingKinds.has(kind)),
  );
  const launchableCount = requiredProfiles.length - unavailable.length;
  const blockers: StudyPlanPreflight['blockers'] = [];
  if (launchableCount === 0) {
    blockers.push({
      code: 'no_launchable_learning_unit',
      message: 'No accepted Curriculum LearningUnit has a currently launchable capability.',
      affectedLearningUnitCount: unavailable.length,
    });
  } else if (unavailable.length > 0 && !contract.riskTolerance?.allowExplicitDeferral) {
    blockers.push({
      code: 'unlaunchable_unit_deferral_forbidden',
      message: 'The Contract forbids deferring LearningUnits without an executable capability.',
      affectedLearningUnitCount: unavailable.length,
    });
  }
  const canGenerate = blockers.length === 0;
  const planningInputCharacters = JSON.stringify(input).length;
  const messages = canGenerate
    ? grouped
      ? groupedStudyPlanProposalMessages(input)
      : studyPlanProposalMessages(input)
    : null;
  const providerPromptCharacters = messages ? JSON.stringify({ messages }).length : null;
  const allowedItemKindCounts: StudyPlanPreflight['allowedItemKindCounts'] = [
    ...DETAILED_MODEL_ITEM_KINDS.map((kind) => ({
      kind,
      learningUnitCount: requiredProfiles.filter((profile) =>
        profile.allowedItemKinds.includes(kind),
      ).length,
    })),
    { kind: 'none' as const, learningUnitCount: unavailable.length },
  ];
  return StudyPlanPreflightSchema.parse({
    curriculumVersionId: input.curriculumVersionId,
    totalLearningUnitCount: requiredProfiles.length,
    executableLearningUnitCount: launchableCount,
    nonExecutableLearningUnitCount: unavailable.length,
    planningRepresentationCount: input.units.length,
    deferredOrUnplannableCount: unavailable.length,
    allowedItemKindCounts,
    promptStrategy: canGenerate ? (grouped ? 'grouped_units' : 'detailed_units') : 'blocked',
    planningInputCharacters,
    providerPromptCharacters,
    approximatePromptTokens:
      providerPromptCharacters === null ? null : Math.ceil(providerPromptCharacters / 4),
    canGenerate,
    blockers,
  });
}

export function preflightStudyPlan(
  repos: Repositories,
  clock: Clock,
  contract: LearningContract,
  curriculum: Curriculum,
  workspaceName: string,
  options: { requireObjectiveAuthoritySemanticSupport?: boolean } = {},
): StudyPlanPreflight {
  const context = buildProviderInput(repos, clock, contract, curriculum, workspaceName);
  const preflight = studyPlanPreflightFromContext(contract, context.input, context.profiles);
  if (options.requireObjectiveAuthoritySemanticSupport !== true) return preflight;
  const semanticAuthority = validateCurriculumObjectiveAuthoritySemanticSupport(curriculum, {
    isBlockingEligible: (authorityRecordId) =>
      repos.sourceAuthority.isBlockingEligible(authorityRecordId),
  });
  if (semanticAuthority.valid) return preflight;
  return StudyPlanPreflightSchema.parse({
    ...preflight,
    promptStrategy: 'blocked',
    providerPromptCharacters: null,
    approximatePromptTokens: null,
    canGenerate: false,
    blockers: [
      ...preflight.blockers,
      {
        code: 'objective_authority_semantic_support_invalid',
        message:
          'The Curriculum has no current passing objective-authority semantic-support contract.',
        affectedLearningUnitCount: context.input.units.length,
      },
    ],
  });
}

function assertExecutableProviderScope(preflight: StudyPlanPreflight): void {
  const blocker = preflight.blockers[0];
  if (!blocker) return;
  if (blocker.code === 'no_launchable_learning_unit') {
    throw new AppError(
      ApiErrorCode.ValidationError,
      'StudyPlan generation requires at least one currently launchable LearningUnit.',
      {
        reason: blocker.code,
        requiredLearningUnitCount: preflight.totalLearningUnitCount,
        launchableLearningUnitCount: preflight.executableLearningUnitCount,
        guidance:
          'Create a successor Curriculum with validated Concept mappings or another supported launch capability before generating the route.',
      },
    );
  }
  if (blocker.code === 'unlaunchable_unit_deferral_forbidden') {
    throw new AppError(
      ApiErrorCode.ValidationError,
      'StudyPlan generation cannot account for every required LearningUnit under the current no-deferral policy.',
      {
        reason: blocker.code,
        requiredLearningUnitCount: preflight.totalLearningUnitCount,
        launchableLearningUnitCount: preflight.executableLearningUnitCount,
        unlaunchableLearningUnitCount: preflight.nonExecutableLearningUnitCount,
      },
    );
  }
  throw new AppError(
    ApiErrorCode.ValidationError,
    'StudyPlan generation requires current passing objective-authority semantic support.',
    { reason: blocker.code },
  );
}

function paceBaseline(
  contract: LearningContract,
  planId: string,
  projectedMinutes: number,
  slackMinutes: number | null,
) {
  const preferred = contract.studyBudget.preferredSessionMinutes;
  const weekly = contract.studyBudget.minutesPerWeek;
  const daily = contract.studyBudget.minutesPerDay;
  const weeklyCapacity = weekly ?? (daily === null ? null : daily * 7);
  const cadence = preferred && weeklyCapacity ? Math.max(1, weeklyCapacity / preferred) : null;
  return {
    id: newId('pace'),
    policyVersion: PACE_BASELINE_POLICY_VERSION,
    contractVersionId: contract.id,
    studyPlanVersionId: planId,
    timeZone: contract.deadline?.timeZone ?? 'UTC',
    expectedSessionCadencePerWeek: cadence,
    explicitSlackMinutes: Math.max(0, slackMinutes ?? 0),
    estimateConfidence: 'medium' as const,
    estimateSource: 'local' as const,
    paceAdjustment: 1,
    paceConfidence: 'unknown' as const,
    measuredObservationCount: 0,
    measuredActualMinutes: 0,
    measuredPlannedMinutes: 0,
    remainingProjectedMinutes: projectedMinutes,
    milestones: contract.deadline
      ? [
          {
            at: contract.deadline.at,
            cumulativeMinutes: projectedMinutes,
            throughPlanItemId: null,
          },
        ]
      : [],
  };
}

function assertPlanRequestPointers(
  repos: Repositories,
  request: ProposeStudyPlanRequest,
): StudyPlan | undefined {
  const plans = repos.studyPlans.list(request.command.workspaceId);
  const latest = plans.at(-1);
  const state = repos.courseExecution.get(request.command.workspaceId);
  if (
    (latest?.id ?? null) !== request.predecessorStudyPlanId ||
    state.acceptedPlanId !== request.expectedAcceptedStudyPlanId
  ) {
    throw new AppError(ApiErrorCode.VersionConflict, 'StudyPlan pointers are stale.', {
      latestStudyPlanId: latest?.id ?? null,
      acceptedStudyPlanId: state.acceptedPlanId,
    });
  }
  return latest;
}

function assertPlanProposalAuthorityCurrent(
  repos: Repositories,
  request: ProposeStudyPlanRequest,
): {
  contract: LearningContract;
  curriculum: Curriculum;
  predecessor: StudyPlan | undefined;
} {
  const contract = requireContract(
    repos,
    request.command.workspaceId,
    request.contractId,
    request.expectedContractVersion,
  );
  assertLearningContractScopeCurrent(repos, contract);
  const curriculum = requireCurriculum(
    repos,
    request.command.workspaceId,
    request.curriculumId,
    request.expectedCurriculumVersion,
    contract.id,
    request.expectedExecutionSourceManifestFingerprint,
  );
  return {
    contract,
    curriculum,
    predecessor: assertPlanRequestPointers(repos, request),
  };
}

function assertDraftEditAuthorityCurrent(
  repos: Repositories,
  request: ApplyStudyPlanDraftEditRequest,
): {
  plan: StudyPlan;
  contract: LearningContract;
  curriculum: Curriculum;
} {
  const plan = repos.studyPlans.get(request.studyPlanId);
  const latestPlan = repos.studyPlans.list(request.command.workspaceId).at(-1);
  if (
    !plan ||
    plan.workspaceId !== request.command.workspaceId ||
    latestPlan?.id !== plan.id ||
    plan.status !== 'proposed' ||
    plan.version !== request.expectedVersion ||
    plan.contractVersionId !== request.expectedContractId ||
    plan.curriculumVersionId !== request.expectedCurriculumId ||
    plan.executionSourceManifestFingerprint !== request.expectedExecutionSourceManifestFingerprint
  ) {
    throw new AppError(ApiErrorCode.VersionConflict, 'StudyPlan proposal is stale.');
  }

  const contract = repos.learningContracts.get(plan.contractVersionId);
  if (
    !contract ||
    contract.workspaceId !== request.command.workspaceId ||
    (contract.status !== 'learner_confirmed' && contract.status !== 'active')
  ) {
    throw new AppError(
      ApiErrorCode.VersionConflict,
      'StudyPlan Contract route is stale or incompatible.',
    );
  }
  assertLearningContractScopeCurrent(repos, contract);

  const curriculum = repos.curricula.get(plan.curriculumVersionId);
  const currentAcceptedCurriculum = repos.curricula
    .list(request.command.workspaceId)
    .filter((candidate) => candidate.status === 'accepted')
    .at(-1);
  if (
    !curriculum ||
    curriculum.workspaceId !== request.command.workspaceId ||
    currentAcceptedCurriculum?.id !== curriculum.id ||
    curriculum.status !== 'accepted' ||
    curriculum.contractVersionId !== contract.id ||
    curriculum.executionSourceManifest.fingerprint !== plan.executionSourceManifestFingerprint
  ) {
    throw new AppError(
      ApiErrorCode.VersionConflict,
      'StudyPlan Curriculum route is stale or incompatible.',
    );
  }
  return { plan, contract, curriculum };
}

export function createStudyPlanAgentService({
  repos,
  provider,
  clock,
  commands,
  providerModel = null,
}: StudyPlanAgentDeps) {
  const inferenceProvider = createTelemetryProvider({
    repos,
    clock,
    provider,
    providerGeneration: () => 1,
  });
  async function propose(
    input: ProposeStudyPlanRequest,
    opts?: ProviderCallOptions,
    persistenceOptions?: StudyPlanProposalPersistenceOptions,
  ): Promise<StudyPlanProposalResponse> {
    const parsed = ProposeStudyPlanRequestSchema.parse(input);
    const workspace = repos.workspaces.get(parsed.command.workspaceId);
    if (!workspace) throw notFound('Course not found.');
    const claim = commands.begin(
      parsed.command,
      'propose_study_plan',
      {
        contractId: parsed.contractId,
        contractVersion: parsed.expectedContractVersion,
        curriculumId: parsed.curriculumId,
        curriculumVersion: parsed.expectedCurriculumVersion,
        manifestFingerprint: parsed.expectedExecutionSourceManifestFingerprint,
        predecessorStudyPlanId: parsed.predecessorStudyPlanId,
        acceptedStudyPlanId: parsed.expectedAcceptedStudyPlanId,
        proposalTrigger: parsed.proposalTrigger,
        confirmedCostPolicyIds: parsed.confirmedCostPolicyIds ?? [],
      },
      { leaseMs: STUDY_PLAN_OPERATION_LEASE_MS },
    );
    if (claim.replayPayload !== undefined) {
      return StudyPlanProposalResponseSchema.parse(claim.replayPayload);
    }
    try {
      const { contract, curriculum, predecessor } = assertPlanProposalAuthorityCurrent(
        repos,
        parsed,
      );
      const initialRouteState = repos.courseExecution.get(parsed.command.workspaceId);
      const providerContext = buildProviderInput(
        repos,
        clock,
        contract,
        curriculum,
        workspace.name,
      );
      const preflight = studyPlanPreflightFromContext(
        contract,
        providerContext.input,
        providerContext.profiles,
      );
      assertExecutableProviderScope(preflight);
      const policyFingerprint = enforceAgentCostPolicies(repos, {
        workspaceId: parsed.command.workspaceId,
        operationType: 'propose_study_plan',
        studySessionId: null,
        at: clock.now().toISOString(),
        confirmedPolicyIds: parsed.confirmedCostPolicyIds ?? [],
      });
      const proposal = await runTrackedAgentProviderOperation({
        repos,
        clock,
        provider,
        providerModel: provider.name === 'hy3' ? (provider.model ?? providerModel ?? null) : null,
        operationId: claim.operationId,
        fencingToken: claim.fencingToken,
        workspaceId: parsed.command.workspaceId,
        studySessionId: null,
        learningUnitId: null,
        assessmentId: null,
        operationType: 'propose_study_plan',
        schemaFingerprint: 'study-plan-proposal-v1',
        policyFingerprint,
        sourceFingerprint: curriculum.executionSourceManifest.fingerprint,
        providerOptions: {
          ...opts,
          timeoutMs: opts?.timeoutMs ?? STUDY_PLAN_PROVIDER_TIMEOUT_MS,
        },
        invoke: (options) => inferenceProvider.proposeStudyPlan(providerContext.input, options),
      });
      const now = clock.now().toISOString();
      const materialized = validateAndMaterializeStudyPlanProposal({
        repos,
        clock,
        contract,
        curriculum,
        proposal,
        profiles: providerContext.profiles,
        manifestFingerprint: curriculum.executionSourceManifest.fingerprint,
        createdAt: now,
      });
      if (materialized.errors.length > 0) {
        throw new AppError(
          ApiErrorCode.ValidationError,
          'StudyPlan proposal failed local validation.',
          {
            errors: materialized.errors,
          },
        );
      }
      // Time is proposal output. Derive it before the proposal identity/version is
      // persisted so the learner confirms the exact content that can be accepted.
      const derivedItems = deriveTeachUnitDurationsOrThrow(curriculum, materialized.items);
      const plannability = resolveStudyPlanPlannability(curriculum, derivedItems);
      const planId = newId('study_plan');
      const projectedMinutes = derivedItems.reduce((sum, item) => sum + item.estimatedMinutes, 0);
      const feasibility = systemDerivedPlanFeasibility(projectedMinutes);
      const plan: StudyPlan = {
        id: planId,
        workspaceId: contract.workspaceId,
        contractVersionId: contract.id,
        curriculumVersionId: curriculum.id,
        executionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
        version: (predecessor?.version ?? 0) + 1,
        predecessorId: predecessor?.id ?? null,
        proposalTrigger: parsed.proposalTrigger,
        status: 'proposed',
        rationale: proposal.rationale,
        items: derivedItems,
        deferrals: materialized.deferrals,
        feasibility,
        recommendations: buildPlanningRecommendations(contract, curriculum, feasibility),
        paceBaseline: paceBaseline(contract, planId, projectedMinutes, feasibility.slackMinutes),
        diff: diffStudyPlans(predecessor, derivedItems),
        provider: provider.name,
        providerModel: provider.name === 'hy3' ? (provider.model ?? providerModel ?? null) : null,
        learnerAcceptedAt: null,
        createdAt: now,
      };
      const response = commands.complete(claim, () => {
        persistenceOptions?.beforePersist?.();
        assertStudyPlanRouteStateUnchanged(repos, parsed.command.workspaceId, initialRouteState);
        assertPlanProposalAuthorityCurrent(repos, parsed);
        for (const risk of materialized.risks) {
          if (repos.coverageRisks.get(risk.id)) continue;
          repos.coverageRisks.create(risk, {
            id: newId('risk_evt'),
            eventType: 'plan_deferral_proposed',
            actor: 'local',
            payload: { studyPlanId: plan.id },
            createdAt: now,
          });
        }
        const stored = repos.studyPlans.createVersion(plan, materialized.launches, {
          id: newId('plan_evt'),
          eventType: 'proposed',
          actor: parsed.command.actor,
          payload: { proposalTrigger: parsed.proposalTrigger },
          createdAt: now,
        });
        return StudyPlanProposalResponseSchema.parse({
          studyPlan: stored,
          retainedAcceptedStudyPlanId: parsed.expectedAcceptedStudyPlanId,
          knownScopeAccounted: materialized.knownScopeAccounted,
          launchabilityValid: materialized.launchabilityValid,
          validationErrors: materialized.errors,
          validationWarnings: [
            ...materialized.warnings,
            ...plannability.map((entry) => plannabilityWarningText(entry.plannability)),
          ].slice(0, 100),
          plannability: plannability.map((entry) => entry.plannability),
        });
      });
      return StudyPlanProposalResponseSchema.parse(response);
    } catch (error) {
      commands.fail(claim, error);
      throw error;
    }
  }

  function history(workspaceId: string): StudyPlanHistoryResponse {
    if (!repos.workspaces.get(workspaceId)) throw notFound('Course not found.');
    const plans = repos.studyPlans.list(workspaceId);
    const state = repos.courseExecution.get(workspaceId);
    const latest = plans.at(-1);
    const proposed = latest?.status === 'proposed' ? latest : undefined;
    return StudyPlanHistoryResponseSchema.parse({
      workspaceId,
      acceptedStudyPlanId: state.acceptedPlanId,
      proposedStudyPlanId: proposed?.id ?? null,
      items: plans.map((plan) => ({
        id: plan.id,
        version: plan.version,
        predecessorId: plan.predecessorId,
        contractVersionId: plan.contractVersionId,
        curriculumVersionId: plan.curriculumVersionId,
        status: plan.status,
        proposalTrigger: plan.proposalTrigger,
        itemCount: plan.items.length,
        deferredUnitCount: plan.deferrals.length,
        projectedMinutes: plan.feasibility.projectedMinutes,
        feasibilityState: plan.feasibility.state,
        executionSourceManifestFingerprint: plan.executionSourceManifestFingerprint,
        learnerAcceptedAt: plan.learnerAcceptedAt,
        createdAt: plan.createdAt,
      })),
    });
  }

  function get(workspaceId: string, planId: string): StudyPlan {
    const plan = repos.studyPlans.get(planId);
    if (!plan || plan.workspaceId !== workspaceId) throw notFound('StudyPlan not found.');
    return plan;
  }

  function applyDraftEdit(
    input: ApplyStudyPlanDraftEditRequest,
    persistenceOptions?: StudyPlanDraftEditPersistenceOptions,
  ): StudyPlanProposalResponse {
    const parsed = ApplyStudyPlanDraftEditRequestSchema.parse(input);
    const claim = commands.begin(parsed.command, 'edit_study_plan', {
      studyPlanId: parsed.studyPlanId,
      version: parsed.expectedVersion,
      contractId: parsed.expectedContractId,
      curriculumId: parsed.expectedCurriculumId,
      manifestFingerprint: parsed.expectedExecutionSourceManifestFingerprint,
      edit: parsed.edit,
    });
    if (claim.replayPayload !== undefined) {
      return StudyPlanProposalResponseSchema.parse(claim.replayPayload);
    }
    try {
      const {
        plan: current,
        contract,
        curriculum,
      } = assertDraftEditAuthorityCurrent(repos, parsed);
      const initialRouteState = repos.courseExecution.get(parsed.command.workspaceId);
      const items = current.items.map((item) => ({
        ...item,
        objectiveIds: [...item.objectiveIds],
        prerequisitePlanItemIds: [...item.prerequisitePlanItemIds],
        completionRequirements: item.completionRequirements.map((requirement) => ({
          ...requirement,
          objectiveIds: [...requirement.objectiveIds],
        })),
      }));
      const deferrals = current.deferrals.map((entry) => ({
        ...entry,
        objectiveIds: [...entry.objectiveIds],
        riskIds: [...entry.riskIds],
      }));
      const newRisks: CoverageRiskEntry[] = [];
      const now = clock.now().toISOString();

      const insertAfter = (item: StudyPlanItem, afterId: string | null) => {
        const anchorIndex =
          afterId === null ? -1 : items.findIndex((candidate) => candidate.id === afterId);
        if (afterId !== null && anchorIndex < 0) {
          throw new AppError(ApiErrorCode.ValidationError, 'Edit anchor Plan item not found.');
        }
        const index = anchorIndex + 1;
        items.splice(index, 0, item);
      };
      const createOrValidateDeferralRisk = (
        unitId: string,
        objectiveIds: string[],
        reason: string,
        riskIds: string[],
      ) => {
        if (riskIds.length !== 1) {
          throw new AppError(
            ApiErrorCode.ValidationError,
            'A learner deferral requires exactly one stable risk identity.',
          );
        }
        const risk = materializeDeferralRisk(
          contract,
          curriculum,
          { curriculumLearningUnitId: unitId, objectiveIds, reason },
          now,
          { id: riskIds[0], learnerDecisionId: parsed.command.commandId, learnerAccepted: true },
        );
        const existing = repos.coverageRisks.get(risk.id);
        if (
          existing &&
          (existing.contractVersionId !== risk.contractVersionId ||
            existing.stableScopeFingerprint !== risk.stableScopeFingerprint ||
            existing.origin !== 'deterministic' ||
            existing.status !== 'deferred' ||
            !existing.facets.includes('intentionally_deferred') ||
            !existing.referencedCurriculumNodeIds.includes(unitId))
        ) {
          throw new AppError(
            ApiErrorCode.ValidationError,
            'The supplied risk identity belongs to a different deferral.',
          );
        }
        if (!existing) newRisks.push(risk);
        return risk.id;
      };
      const replaceDeferral = (
        unitId: string,
        objectiveIds: string[],
        reason: string,
        riskIds: string[],
      ) => {
        if (!contract.riskTolerance?.allowExplicitDeferral) {
          throw new AppError(
            ApiErrorCode.ValidationError,
            'Contract policy does not allow deferral.',
          );
        }
        const riskId = createOrValidateDeferralRisk(unitId, objectiveIds, reason, riskIds);
        deferrals.splice(
          0,
          deferrals.length,
          ...deferrals.filter((entry) => entry.curriculumLearningUnitId !== unitId),
          { curriculumLearningUnitId: unitId, objectiveIds, reason, riskIds: [riskId] },
        );
      };
      const edit = parsed.edit;
      if (edit.kind === 'resize_time') {
        const item = items.find((candidate) => candidate.id === edit.planItemId);
        if (!item) throw notFound('StudyPlan item not found.');
        item.estimatedMinutes = edit.estimatedMinutes;
      } else if (edit.kind === 'change_depth') {
        const item = items.find((candidate) => candidate.id === edit.planItemId);
        if (!item) throw notFound('StudyPlan item not found.');
        item.targetDepth = edit.targetDepth;
      } else if (edit.kind === 'reorder') {
        const index = items.findIndex((candidate) => candidate.id === edit.planItemId);
        if (index < 0) throw notFound('StudyPlan item not found.');
        const [item] = items.splice(index, 1);
        insertAfter(item!, edit.afterPlanItemId);
      } else if (edit.kind === 'defer' || edit.kind === 'remove_with_reason') {
        const targetItem =
          edit.kind === 'remove_with_reason'
            ? items.find((candidate) => candidate.id === edit.planItemId)
            : undefined;
        if (edit.kind === 'remove_with_reason' && !targetItem) {
          throw notFound('StudyPlan item not found.');
        }
        const unitId =
          edit.kind === 'defer'
            ? edit.curriculumLearningUnitId
            : targetItem?.curriculumLearningUnitId;
        if (!unitId)
          throw new AppError(
            ApiErrorCode.ValidationError,
            'A LearningUnit is required for deferral.',
          );
        const unit = curriculum.nodes.find((node) => node.id === unitId && node.learningUnit);
        if (!unit?.learningUnit) throw notFound('Curriculum LearningUnit not found.');
        const existingDeferred = deferrals
          .filter((entry) => entry.curriculumLearningUnitId === unitId)
          .flatMap((entry) => entry.objectiveIds);
        const requestedObjectiveIds =
          edit.kind === 'defer'
            ? edit.objectiveIds
            : unit.learningUnit.objectives.map((objective) => objective.id);
        const objectiveIds = [...new Set([...existingDeferred, ...requestedObjectiveIds])];
        if (objectiveIds.length === 0) {
          throw new AppError(
            ApiErrorCode.ValidationError,
            'A deferral must identify an objective.',
          );
        }
        const deferredSet = new Set(objectiveIds);
        for (let index = items.length - 1; index >= 0; index -= 1) {
          const item = items[index]!;
          if (item.curriculumLearningUnitId !== unitId) continue;
          item.objectiveIds = item.objectiveIds.filter((id) => !deferredSet.has(id));
          item.completionRequirements = item.completionRequirements
            .map((requirement) => ({
              ...requirement,
              objectiveIds: requirement.objectiveIds.filter((id) => !deferredSet.has(id)),
            }))
            .filter((requirement) => requirement.objectiveIds.length > 0);
          if (item.objectiveIds.length === 0) items.splice(index, 1);
        }
        replaceDeferral(unitId, objectiveIds, edit.reason, edit.riskIds);
      } else if (edit.kind === 'add_unit' || edit.kind === 'restore_deferral') {
        const unit = curriculum.nodes.find(
          (node) => node.id === edit.curriculumLearningUnitId && node.learningUnit,
        );
        if (!unit?.learningUnit) throw notFound('Curriculum LearningUnit not found.');
        const matchingDeferrals = deferrals.filter(
          (entry) => entry.curriculumLearningUnitId === unit.id,
        );
        if (matchingDeferrals.length === 0) {
          throw new AppError(
            ApiErrorCode.ValidationError,
            'This LearningUnit is already represented in the proposed route.',
          );
        }
        const restoredObjectiveIds = [
          ...new Set(matchingDeferrals.flatMap((entry) => entry.objectiveIds)),
        ];
        const added: StudyPlanItem = {
          id: newId('plan_item'),
          index: 0,
          phase: 'Learner edit',
          kind: 'teach_unit',
          curriculumLearningUnitId: unit.id,
          rationale: edit.kind === 'add_unit' ? edit.reason : 'Restored from explicit deferral.',
          estimatedMinutes: edit.kind === 'add_unit' ? edit.estimatedMinutes : 25,
          targetDepth: edit.kind === 'add_unit' ? edit.targetDepth : contract.desiredDepth,
          objectiveIds: restoredObjectiveIds,
          prerequisitePlanItemIds: [],
          completionPolicy: null,
          completionRequirements: [],
        };
        insertAfter(added, edit.afterPlanItemId);
        deferrals.splice(
          0,
          deferrals.length,
          ...deferrals.filter((entry) => entry.curriculumLearningUnitId !== unit.id),
        );
      }
      items.forEach((item, index) => {
        item.index = index;
      });
      const retainedItemIds = new Set(items.map((item) => item.id));
      for (const item of items) {
        item.prerequisitePlanItemIds = item.prerequisitePlanItemIds.filter((id) =>
          retainedItemIds.has(id),
        );
      }
      if (items.length === 0) {
        throw new AppError(
          ApiErrorCode.ValidationError,
          'A StudyPlan must retain an executable item.',
        );
      }
      const accountingErrors = validateStudyPlanScopeAccounting(curriculum, items, deferrals);
      if (accountingErrors.length > 0) {
        throw new AppError(
          ApiErrorCode.ValidationError,
          'Edited StudyPlan is incomplete or unsafe.',
          {
            errors: accountingErrors,
          },
        );
      }
      // Every edited successor is a new proposal. Legacy resize_time/add-unit minute
      // fields remain parseable, but the persisted teaching estimate is planner-owned.
      const derivedItems = deriveTeachUnitDurationsOrThrow(curriculum, items);
      const launches = derivedItems.map((item) => ({
        planItemId: item.id,
        launch: resolveLaunchForPlanItem(
          repos,
          clock,
          parsed.command.workspaceId,
          curriculum,
          item,
        ),
        sourceFingerprint: current.executionSourceManifestFingerprint,
        validatedAt: now,
      }));
      if (launches.some((entry) => entry.launch.status !== 'launchable')) {
        throw new AppError(
          ApiErrorCode.ValidationError,
          'Edited StudyPlan contains an unlaunchable item.',
        );
      }
      const projectedMinutes = derivedItems.reduce((sum, item) => sum + item.estimatedMinutes, 0);
      const feasibility = systemDerivedPlanFeasibility(projectedMinutes);
      const plannability = resolveStudyPlanPlannability(curriculum, derivedItems);
      const successorId = newId('study_plan');
      const successor: StudyPlan = {
        ...current,
        id: successorId,
        version: current.version + 1,
        predecessorId: current.id,
        items: derivedItems,
        deferrals,
        feasibility,
        paceBaseline: paceBaseline(
          contract,
          successorId,
          projectedMinutes,
          feasibility.slackMinutes,
        ),
        diff: diffStudyPlans(current, derivedItems),
        provider: 'local',
        providerModel: null,
        learnerAcceptedAt: null,
        createdAt: now,
      };
      const response = commands.complete(claim, () => {
        persistenceOptions?.beforePersist?.();
        const authoritativeRouteState = assertStudyPlanRouteStateUnchanged(
          repos,
          parsed.command.workspaceId,
          initialRouteState,
        );
        const authoritative = assertDraftEditAuthorityCurrent(repos, parsed);
        if (JSON.stringify(authoritative.plan) !== JSON.stringify(current)) {
          throw new AppError(
            ApiErrorCode.VersionConflict,
            'StudyPlan proposal changed before edit persistence.',
          );
        }
        for (const risk of newRisks) {
          repos.coverageRisks.create(risk, {
            id: newId('risk_evt'),
            eventType: 'learner_deferral_recorded',
            actor: 'local',
            payload: { commandId: parsed.command.commandId, predecessorPlanId: current.id },
            createdAt: now,
          });
        }
        repos.studyPlans.reject(current.id, {
          id: newId('plan_evt'),
          eventType: 'replaced_by_edit',
          actor: parsed.command.actor,
          payload: { successorId },
          createdAt: now,
        });
        const stored = repos.studyPlans.createVersion(successor, launches, {
          id: newId('plan_evt'),
          eventType: 'edited_successor_proposed',
          actor: parsed.command.actor,
          payload: { predecessorId: current.id, edit: parsed.edit },
          createdAt: now,
        });
        return StudyPlanProposalResponseSchema.parse({
          studyPlan: stored,
          retainedAcceptedStudyPlanId: authoritativeRouteState.acceptedPlanId,
          knownScopeAccounted: true,
          launchabilityValid: true,
          validationErrors: [],
          // Recomputed for the successor. An edit is the learner's repair operation, so
          // discarding the diagnostic here would hide whether the repair worked.
          validationWarnings: plannability
            .map((entry) => plannabilityWarningText(entry.plannability))
            .slice(0, 100),
          plannability: plannability.map((entry) => entry.plannability),
        });
      });
      return StudyPlanProposalResponseSchema.parse(response);
    } catch (error) {
      commands.fail(claim, error);
      throw error;
    }
  }

  return { propose, get, history, applyDraftEdit };
}

export type StudyPlanAgentService = ReturnType<typeof createStudyPlanAgentService>;
