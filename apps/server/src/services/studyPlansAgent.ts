import {
  ApiErrorCode,
  ApplyStudyPlanDraftEditRequestSchema,
  ProposeStudyPlanRequestSchema,
  StudyPlanHistoryResponseSchema,
  StudyPlanProposalResponseSchema,
  type ApplyStudyPlanDraftEditRequest,
  type CoverageRiskEntry,
  type Curriculum,
  type LearningContract,
  type ProposeStudyPlanRequest,
  type StudyPlan,
  type StudyPlanHistoryResponse,
  type StudyPlanItem,
  type StudyPlanProposalResponse,
} from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import type { LlmProvider, ProviderCallOptions, StudyPlanProposalInput } from '../llm/provider.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import type { CourseCommandService } from './courseCommands.js';
import { computeContractFeasibility } from './feasibility.js';
import {
  PACE_BASELINE_POLICY_VERSION,
  buildUnitLaunchProfiles,
  diffStudyPlans,
  materializeDeferralRisk,
  planFeasibilityFromContract,
  resolveLaunchForPlanItem,
  validateAndMaterializeStudyPlanProposal,
  validateStudyPlanScopeAccounting,
} from './studyPlanValidation.js';
import {
  enforceAgentCostPolicies,
  runTrackedAgentProviderOperation,
} from './agentProviderRuntime.js';

interface StudyPlanAgentDeps {
  repos: Repositories;
  provider: LlmProvider;
  clock: Clock;
  commands: CourseCommandService;
  providerModel?: string | null;
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

function studyPlanFeasibilityInput(availableMinutes: number | null) {
  return planFeasibilityFromContract(availableMinutes, 0, 'unknown', [
    'Projected effort will be computed locally after the semantic proposal.',
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
          ? ('formally_supported' as const)
          : states.includes('started')
            ? ('in_progress' as const)
            : states.includes('deferred')
              ? ('deferred' as const)
              : ('unassessed' as const),
      observedMinutes: null,
      openMistakes: 0,
    };
  });
  const availableMinutes =
    repos.learningContracts.getLatestFeasibility(contract.id)?.availableMinutes ?? null;
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
        deadline: contract.deadline,
        studyBudget: {
          minutesPerDay: contract.studyBudget.minutesPerDay,
          minutesPerWeek: contract.studyBudget.minutesPerWeek,
          preferredSessionMinutes: contract.studyBudget.preferredSessionMinutes,
        },
        desiredDepth: contract.desiredDepth,
        subjectBoundaries: contract.courseScope.subjectBoundaries,
        materials: contract.courseScope.materials.map((scope) => ({
          materialId: scope.materialId,
          title: repos.materials.get(scope.materialId)?.title ?? scope.materialId,
          materialRoleAssignmentId: scope.materialRoleAssignmentId,
          materialRoleAssignmentVersion: scope.materialRoleAssignmentVersion,
          role: scope.role,
          disposition: scope.disposition,
        })),
        includedTopics: contract.courseScope.includedTopics,
        excludedTopics: contract.courseScope.excludedTopics,
        allowExplicitDeferral: contract.riskTolerance?.allowExplicitDeferral ?? false,
      },
      curriculumVersionId: curriculum.id,
      executionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
      units,
      synthesisGroups: curriculum.synthesisGroups,
      learnerState,
      requiredLearningUnitIds: units.map((unit) => unit.id),
      allowedItemKinds: [...new Set(profiles.flatMap((profile) => profile.allowedItemKinds))],
      allowedDepths: ['pass_oriented', 'working_fluency', 'high_performance', 'deep_transfer'],
      launchCapabilities: profiles.map((profile) => ({
        curriculumLearningUnitId: profile.curriculumLearningUnitId,
        allowedItemKinds: profile.allowedItemKinds,
        launchableAssessmentModes: profile.launchableAssessmentModes,
      })),
      feasibility: studyPlanFeasibilityInput(availableMinutes),
    },
  };
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

export function createStudyPlanAgentService({
  repos,
  provider,
  clock,
  commands,
  providerModel = null,
}: StudyPlanAgentDeps) {
  async function propose(
    input: ProposeStudyPlanRequest,
    opts?: ProviderCallOptions,
  ): Promise<StudyPlanProposalResponse> {
    const parsed = ProposeStudyPlanRequestSchema.parse(input);
    const workspace = repos.workspaces.get(parsed.command.workspaceId);
    if (!workspace) throw notFound('Course not found.');
    const claim = commands.begin(parsed.command, 'propose_study_plan', {
      contractId: parsed.contractId,
      contractVersion: parsed.expectedContractVersion,
      curriculumId: parsed.curriculumId,
      curriculumVersion: parsed.expectedCurriculumVersion,
      manifestFingerprint: parsed.expectedExecutionSourceManifestFingerprint,
      predecessorStudyPlanId: parsed.predecessorStudyPlanId,
      acceptedStudyPlanId: parsed.expectedAcceptedStudyPlanId,
      proposalTrigger: parsed.proposalTrigger,
      confirmedCostPolicyIds: parsed.confirmedCostPolicyIds ?? [],
    });
    if (claim.replayPayload !== undefined) {
      return StudyPlanProposalResponseSchema.parse(claim.replayPayload);
    }
    try {
      const contract = requireContract(
        repos,
        parsed.command.workspaceId,
        parsed.contractId,
        parsed.expectedContractVersion,
      );
      const curriculum = requireCurriculum(
        repos,
        parsed.command.workspaceId,
        parsed.curriculumId,
        parsed.expectedCurriculumVersion,
        contract.id,
        parsed.expectedExecutionSourceManifestFingerprint,
      );
      const predecessor = assertPlanRequestPointers(repos, parsed);
      const providerContext = buildProviderInput(
        repos,
        clock,
        contract,
        curriculum,
        workspace.name,
      );
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
        providerOptions: opts,
        invoke: (options) => provider.proposeStudyPlan(providerContext.input, options),
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
      const planId = newId('study_plan');
      const projectedMinutes = materialized.items.reduce(
        (sum, item) => sum + item.estimatedMinutes,
        0,
      );
      const contractFeasibility = computeContractFeasibility(
        contract,
        projectedMinutes,
        clock.now(),
      );
      const feasibility = planFeasibilityFromContract(
        contractFeasibility.availableMinutes,
        projectedMinutes,
        contractFeasibility.state,
        contractFeasibility.assumptions,
      );
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
        items: materialized.items,
        deferrals: materialized.deferrals,
        feasibility,
        paceBaseline: paceBaseline(contract, planId, projectedMinutes, feasibility.slackMinutes),
        diff: diffStudyPlans(predecessor, materialized.items),
        provider: provider.name,
        providerModel: provider.name === 'hy3' ? (provider.model ?? providerModel ?? null) : null,
        learnerAcceptedAt: null,
        createdAt: now,
      };
      const response = commands.complete(claim, () => {
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
          validationWarnings: materialized.warnings,
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
    const proposed = [...plans].reverse().find((plan) => plan.status === 'proposed');
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

  function applyDraftEdit(input: ApplyStudyPlanDraftEditRequest): StudyPlanProposalResponse {
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
      const current = get(parsed.command.workspaceId, parsed.studyPlanId);
      if (
        current.status !== 'proposed' ||
        current.version !== parsed.expectedVersion ||
        current.contractVersionId !== parsed.expectedContractId ||
        current.curriculumVersionId !== parsed.expectedCurriculumId ||
        current.executionSourceManifestFingerprint !==
          parsed.expectedExecutionSourceManifestFingerprint
      ) {
        throw new AppError(ApiErrorCode.VersionConflict, 'StudyPlan proposal is stale.');
      }
      const contract = repos.learningContracts.get(current.contractVersionId)!;
      const curriculum = repos.curricula.get(current.curriculumVersionId)!;
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
          { id: riskIds[0], learnerDecisionId: parsed.command.commandId },
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
      const launches = items.map((item) => ({
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
      const projectedMinutes = items.reduce((sum, item) => sum + item.estimatedMinutes, 0);
      const contractFeasibility = computeContractFeasibility(
        contract,
        projectedMinutes,
        clock.now(),
      );
      const feasibility = planFeasibilityFromContract(
        contractFeasibility.availableMinutes,
        projectedMinutes,
        contractFeasibility.state,
        contractFeasibility.assumptions,
      );
      const successorId = newId('study_plan');
      const successor: StudyPlan = {
        ...current,
        id: successorId,
        version: current.version + 1,
        predecessorId: current.id,
        items,
        deferrals,
        feasibility,
        paceBaseline: paceBaseline(
          contract,
          successorId,
          projectedMinutes,
          feasibility.slackMinutes,
        ),
        diff: diffStudyPlans(current, items),
        provider: 'local',
        providerModel: null,
        learnerAcceptedAt: null,
        createdAt: now,
      };
      const response = commands.complete(claim, () => {
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
          retainedAcceptedStudyPlanId: repos.courseExecution.get(current.workspaceId)
            .acceptedPlanId,
          knownScopeAccounted: true,
          launchabilityValid: true,
          validationErrors: [],
          validationWarnings: [],
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
