import { unitTransferPrompt, TransferTaskSchema } from '@hy3-clinic/shared';
import { PracticeRecoveryStateSchema } from '@hy3-clinic/shared';
import { lessonExecutionPresentedPrompts, recoveryExposurePrompts } from './formalAssessments.js';
import {
  ApiErrorCode,
  CourseActionLaunchResultSchema,
  CreateAssessmentRequestSchema,
  LaunchCourseActionRequestSchema,
  isStateCreditingAdmissibility,
  type CourseActionLaunchResult,
  type CourseExecutionCommandEnvelope,
  type Curriculum,
  type CurriculumNode,
  type CurriculumObjective,
  type FormalAssessmentKind,
  type LaunchCourseActionRequest,
  type StudyPlan,
  type StudyPlanItem,
} from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import { ProviderError } from '../llm/errors.js';
import {
  MAX_STRUCTURED_OUTPUT_ATTEMPTS_PER_LOGICAL_CALL,
  type LlmProvider,
  type ProviderCallOptions,
} from '../llm/provider.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import type { AssessmentService } from './assessment.js';
import {
  qualifyingAssessmentIntentEvidence,
  selectAssessmentDiversityIntent,
} from './assessmentDiversityPolicy.js';
import {
  enforceAgentCostPolicies,
  runTrackedAgentProviderOperation,
} from './agentProviderRuntime.js';
import { CURRICULUM_PROVIDER_TIMEOUT_MS, buildCurriculumExecutionContext } from './curriculum.js';
import { buildCurriculumEvidenceCatalog } from './curriculumEvidence.js';
import type { CourseCommandService } from './courseCommands.js';
import {
  buildFormalAssessmentProposalCatalogue,
  type FormalProgressionService,
} from './formalProgression.js';
import type { FormalAssessmentsService } from './formalAssessments.js';
import { toPublicQuiz } from './quizzes.js';
import type { ReviewSuccessorService } from './reviewSuccessor.js';
import { resolveAgendaBoundPlanItem, resolveLaunchForPlanItem } from './studyPlanValidation.js';
import { createTelemetryProvider } from './providerTelemetry.js';
import {
  OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_BATCH,
  OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_OBJECTIVES,
  assertCurrentFormalObjectiveAuthoritySemanticSupport,
  buildObjectiveAuthoritySemanticEvaluationScopes,
  materializeObjectiveAuthoritySemanticSupport,
  objectiveAuthoritySemanticEvaluationSourceFingerprint,
  partitionObjectiveAuthoritySemanticEvaluationScopes,
  validateObjectiveAuthoritySemanticEvaluationProposal,
} from './objectiveAuthoritySemanticSupport.js';

interface CourseActionLaunchDeps {
  repos: Repositories;
  clock: Clock;
  commands: CourseCommandService;
  assessment: AssessmentService;
  formalProgression: FormalProgressionService;
  provider: LlmProvider;
  providerModel?: string | null;
  formalAssessments: FormalAssessmentsService;
  reviewSuccessor: ReviewSuccessorService;
}

const FORMAL_ON_DEMAND_MAX_BATCHES =
  OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_OBJECTIVES /
  OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_BATCH;
const COURSE_ACTION_OPERATION_LEASE_MS =
  CURRICULUM_PROVIDER_TIMEOUT_MS *
    (FORMAL_ON_DEMAND_MAX_BATCHES + 1) *
    MAX_STRUCTURED_OUTPUT_ATTEMPTS_PER_LOGICAL_CALL +
  120_000;

interface FormalObjectiveTarget {
  node: CurriculumNode;
  objective: CurriculumObjective;
}

function formalObjectiveTargets(
  curriculum: Curriculum,
  planItem: StudyPlanItem,
): FormalObjectiveTarget[] {
  if (planItem.objectiveIds.length === 0) {
    throw new AppError(
      ApiErrorCode.ValidationError,
      'Formal assessment requires an exact Curriculum objective.',
    );
  }
  if (new Set(planItem.objectiveIds).size !== planItem.objectiveIds.length) {
    throw new AppError(
      ApiErrorCode.ValidationError,
      'Formal assessment objective scope contains duplicate identities.',
    );
  }
  return planItem.objectiveIds.map((objectiveId) => {
    const matches = curriculum.nodes.flatMap((node) =>
      (node.learningUnit?.objectives ?? [])
        .filter((objective) => objective.id === objectiveId)
        .map((objective) => ({ node, objective })),
    );
    if (matches.length !== 1) {
      throw new AppError(
        ApiErrorCode.VersionConflict,
        'Formal assessment objective ownership is stale.',
        { objectiveId },
      );
    }
    return matches[0]!;
  });
}

function evaluationNodes(targets: readonly FormalObjectiveTarget[]): CurriculumNode[] {
  const objectivesByNodeId = new Map<string, CurriculumObjective[]>();
  for (const target of targets) {
    objectivesByNodeId.set(target.node.id, [
      ...(objectivesByNodeId.get(target.node.id) ?? []),
      target.objective,
    ]);
  }
  return [...objectivesByNodeId].map(([nodeId, objectives]) => {
    const node = targets.find((target) => target.node.id === nodeId)!.node;
    return {
      ...node,
      learningUnit: node.learningUnit ? { ...node.learningUnit, objectives } : null,
    };
  });
}

function contextHasExactExecutionSourceRevisions(
  curriculum: Curriculum,
  context: ReturnType<typeof buildCurriculumExecutionContext>,
): boolean {
  return (
    JSON.stringify(curriculum.executionSourceManifest.revisions) ===
    JSON.stringify(context.manifest.revisions)
  );
}

function assessmentDiversityForRoute(input: {
  repos: Repositories;
  workspaceId: string;
  assessmentKind: FormalAssessmentKind;
  curriculum: Curriculum;
  plan: StudyPlan;
  learningUnitId: string | null;
  objectiveId: string | undefined;
}) {
  const objective = input.curriculum.nodes
    .find((node) => node.id === input.learningUnitId)
    ?.learningUnit?.objectives.find((candidate) => candidate.id === input.objectiveId);
  const priorEvidence = objective
    ? qualifyingAssessmentIntentEvidence({
        repos: input.repos,
        workspaceId: input.workspaceId,
        objectiveId: objective.id,
        contractVersionId: input.plan.contractVersionId,
        curriculumVersionId: input.curriculum.id,
        studyPlanVersionId: input.plan.id,
        executionSourceManifestFingerprint: input.plan.executionSourceManifestFingerprint,
      })
    : [];
  return selectAssessmentDiversityIntent({
    assessmentKind: input.assessmentKind,
    objectiveConstruct: objective?.formalAssessmentConstruct ?? null,
    priorEvidence,
  });
}

export function createCourseActionLaunchService({
  repos,
  clock,
  commands,
  assessment,
  formalProgression,
  provider,
  providerModel = null,
  formalAssessments,
  reviewSuccessor,
}: CourseActionLaunchDeps) {
  const inferenceProvider = createTelemetryProvider({
    repos,
    clock,
    provider,
    providerGeneration: () => 1,
  });

  async function ensureFormalObjectiveSemanticAuthority(input: {
    curriculum: Curriculum;
    plan: StudyPlan;
    planItem: StudyPlanItem;
    assessmentKind: FormalAssessmentKind;
    operationId: string;
    fencingToken: number;
    studySessionId: string | null;
    confirmedCostPolicyIds: string[];
    assertCurrent: () => Curriculum;
    providerOptions?: ProviderCallOptions;
  }): Promise<Curriculum> {
    const assertRequestCurrent = (): Curriculum => {
      if (input.providerOptions?.signal?.aborted) throw ProviderError.cancelled();
      return input.assertCurrent();
    };
    let current = input.curriculum;
    let targets = formalObjectiveTargets(current, input.planItem);
    const evaluatedTargets = targets.filter((target) => target.objective.semanticSupport);
    if (evaluatedTargets.length > 0) {
      assertCurrentFormalObjectiveAuthoritySemanticSupport(
        current,
        evaluatedTargets.map((target) => target.objective),
        {
          boundary: 'formal_provider',
          isBlockingEligible: (authorityRecordId) =>
            repos.sourceAuthority.isBlockingEligible(authorityRecordId),
        },
      );
    }
    const missingTargets = targets.filter((target) => !target.objective.semanticSupport);
    if (missingTargets.length > 0) {
      if (missingTargets.length > OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_OBJECTIVES) {
        throw new AppError(
          ApiErrorCode.ValidationError,
          'Formal semantic-authority evaluation exceeds the fixed objective budget.',
          {
            kind: 'formal_objective_authority_semantic_support_budget_exceeded',
            objectiveCount: missingTargets.length,
            maxObjectives: OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_OBJECTIVES,
          },
        );
      }
      assertRequestCurrent();
      const contract = repos.learningContracts.get(input.plan.contractVersionId);
      if (
        !contract ||
        contract.workspaceId !== current.workspaceId ||
        (contract.status !== 'learner_confirmed' && contract.status !== 'active')
      ) {
        throw new AppError(
          ApiErrorCode.VersionConflict,
          'Formal semantic-authority Contract ownership is stale.',
        );
      }
      const context = buildCurriculumExecutionContext(repos, contract);
      if (!contextHasExactExecutionSourceRevisions(current, context)) {
        throw new AppError(
          ApiErrorCode.VersionConflict,
          'Formal semantic-authority source ownership is stale.',
        );
      }
      const evidenceCatalog = buildCurriculumEvidenceCatalog({
        workspaceId: current.workspaceId,
        manifest: current.executionSourceManifest,
        blocks: context.blocks,
        preferredGroundings: context.authorityBundles.flatMap((bundle) =>
          bundle.claims.map((claim) => ({
            blockId: claim.sourceBlockId,
            quote: claim.quote,
            startOffset: claim.startOffset,
            endOffset: claim.endOffset,
            occurrenceCount: claim.occurrenceCount,
            reanchored: false,
          })),
        ),
      });
      let batches: ReturnType<typeof partitionObjectiveAuthoritySemanticEvaluationScopes>;
      try {
        batches = partitionObjectiveAuthoritySemanticEvaluationScopes(
          buildObjectiveAuthoritySemanticEvaluationScopes({
            nodes: evaluationNodes(missingTargets),
            sourceBlocks: context.blocks,
            authorityBundles: context.authorityBundles,
            evidenceCatalog,
            isBlockingEligible: (authorityRecordId) =>
              repos.sourceAuthority.isBlockingEligible(authorityRecordId),
          }),
          OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_BATCH,
        );
      } catch (error) {
        throw new AppError(
          ApiErrorCode.ValidationError,
          'Formal semantic-authority evaluation scope is invalid.',
          {
            kind: 'formal_objective_authority_semantic_scope_invalid',
            reason: error instanceof Error ? error.message : 'unknown',
          },
        );
      }
      const supportByObjectiveId = new Map<
        string,
        NonNullable<CurriculumObjective['semanticSupport']>
      >();
      const operationType =
        input.assessmentKind === 'synthesis'
          ? 'propose_synthesis_assessment'
          : 'propose_formal_assessment';
      for (const batch of batches) {
        assertRequestCurrent();
        const policyFingerprint = enforceAgentCostPolicies(repos, {
          workspaceId: current.workspaceId,
          operationType,
          studySessionId: input.studySessionId,
          at: clock.now().toISOString(),
          confirmedPolicyIds: input.confirmedCostPolicyIds,
        });
        const proposal = await runTrackedAgentProviderOperation({
          repos,
          clock,
          provider,
          providerModel: provider.name === 'hy3' ? (provider.model ?? providerModel ?? null) : null,
          operationId: input.operationId,
          fencingToken: input.fencingToken,
          workspaceId: current.workspaceId,
          studySessionId: input.studySessionId,
          learningUnitId:
            new Set(missingTargets.map((target) => target.node.id)).size === 1
              ? missingTargets[0]!.node.id
              : null,
          assessmentId: null,
          operationType,
          schemaFingerprint: 'objective-authority-semantic-evaluation-v4-formal-on-demand',
          policyFingerprint,
          sourceFingerprint: objectiveAuthoritySemanticEvaluationSourceFingerprint(batch),
          providerOptions: input.providerOptions,
          invoke: (options) =>
            inferenceProvider.evaluateObjectiveAuthoritySupport(structuredClone(batch.input), {
              ...options,
              timeoutMs: input.providerOptions?.timeoutMs ?? CURRICULUM_PROVIDER_TIMEOUT_MS,
              onRepairAttempt: (reason, category) => {
                assertRequestCurrent();
                if (category) options?.onRepairAttempt?.(reason, category);
                else options?.onRepairAttempt?.(reason);
              },
              validateCandidate: (candidate) => {
                assertRequestCurrent();
                return validateObjectiveAuthoritySemanticEvaluationProposal(batch, candidate);
              },
            }),
        });
        assertRequestCurrent();
        const evaluated = materializeObjectiveAuthoritySemanticSupport(batch, proposal, {
          evaluator: 'independent-objective-authority-semantic-evaluator-v3',
          provider: provider.name,
          providerModel: provider.name === 'hy3' ? (provider.model ?? providerModel ?? null) : null,
          evaluatedAt: clock.now().toISOString(),
        });
        for (const [objectiveId, support] of evaluated) {
          if (supportByObjectiveId.has(objectiveId)) {
            throw new AppError(
              ApiErrorCode.ValidationError,
              'Formal semantic-authority evaluation returned a duplicate objective.',
              { objectiveId },
            );
          }
          supportByObjectiveId.set(objectiveId, support);
        }
      }
      const authoritative = assertRequestCurrent();
      const authoritativeTargetIds = new Set(
        formalObjectiveTargets(authoritative, input.planItem).map((target) => target.objective.id),
      );
      if (
        supportByObjectiveId.size !== missingTargets.length ||
        [...supportByObjectiveId.keys()].some(
          (objectiveId) => !authoritativeTargetIds.has(objectiveId),
        )
      ) {
        throw new AppError(
          ApiErrorCode.VersionConflict,
          'Formal semantic-authority objective scope changed before persistence.',
        );
      }
      current = repos.curricula.insertObjectiveSemanticSupportsIfAbsent(authoritative.id, [
        ...supportByObjectiveId.values(),
      ]);
    }

    current = assertRequestCurrent();
    targets = formalObjectiveTargets(current, input.planItem);
    assertCurrentFormalObjectiveAuthoritySemanticSupport(
      current,
      targets.map((target) => target.objective),
      {
        boundary: 'formal_provider',
        isBlockingEligible: (authorityRecordId) =>
          repos.sourceAuthority.isBlockingEligible(authorityRecordId),
      },
    );
    return current;
  }

  async function launch(
    input: LaunchCourseActionRequest,
    opts?: ProviderCallOptions,
    verificationEpisodeId?: string,
  ): Promise<CourseActionLaunchResult> {
    let reviewExecutionId: string | null = null;
    const parsed = LaunchCourseActionRequestSchema.parse(input);
    const operationStudySession = parsed.studySessionId
      ? repos.studySessions.get(parsed.studySessionId)
      : undefined;
    const operationStudySessionId =
      operationStudySession?.workspaceId === parsed.command.workspaceId
        ? operationStudySession.id
        : null;
    const claim = commands.begin(
      parsed.command,
      'launch_course_action',
      {
        agendaId: parsed.agendaId,
        expectedAgendaVersion: parsed.expectedAgendaVersion,
        agendaItemId: parsed.agendaItemId,
        expectedContractId: parsed.expectedContractId,
        expectedStudyPlanId: parsed.expectedStudyPlanId,
        expectedExecutionSourceManifestFingerprint:
          parsed.expectedExecutionSourceManifestFingerprint,
        studySessionId: parsed.studySessionId ?? null,
        confirmedCostPolicyIds: parsed.confirmedCostPolicyIds ?? [],
        verificationEpisodeId: verificationEpisodeId ?? null,
      },
      {
        studySessionId: operationStudySessionId,
        leaseMs: COURSE_ACTION_OPERATION_LEASE_MS,
      },
    );
    if (claim.replayPayload !== undefined) {
      return CourseActionLaunchResultSchema.parse(claim.replayPayload);
    }
    try {
      const state = repos.courseExecution.get(parsed.command.workspaceId);
      const agenda = repos.sessionAgendas.get(parsed.agendaId);
      if (!agenda || agenda.workspaceId !== parsed.command.workspaceId) {
        throw notFound('SessionAgenda not found.');
      }
      if (
        state.executionStatus !== 'active' ||
        state.routeValidationStatus !== 'valid' ||
        state.activeAgendaId !== agenda.id ||
        state.activeContractId !== parsed.expectedContractId ||
        state.acceptedPlanId !== parsed.expectedStudyPlanId ||
        agenda.version !== parsed.expectedAgendaVersion ||
        agenda.executionSourceManifestFingerprint !==
          parsed.expectedExecutionSourceManifestFingerprint
      ) {
        throw new AppError(ApiErrorCode.VersionConflict, 'Course action context is stale.', {
          currentState: state,
        });
      }
      const studySession = parsed.studySessionId
        ? repos.studySessions.get(parsed.studySessionId)
        : undefined;
      if (
        parsed.studySessionId &&
        (!studySession ||
          studySession.workspaceId !== parsed.command.workspaceId ||
          studySession.contractVersionId !== parsed.expectedContractId ||
          studySession.studyPlanVersionId !== parsed.expectedStudyPlanId ||
          studySession.sessionAgendaId !== parsed.agendaId ||
          studySession.executionSourceManifestFingerprint !==
            parsed.expectedExecutionSourceManifestFingerprint)
      ) {
        throw new AppError(ApiErrorCode.VersionConflict, 'StudySession launch context is stale.');
      }
      const item = agenda.items.find((candidate) => candidate.id === parsed.agendaItemId);
      if (!item) throw notFound('SessionAgenda item not found.');
      const plan = repos.studyPlans.get(parsed.expectedStudyPlanId);
      let curriculum = state.activeCurriculumId
        ? repos.curricula.get(state.activeCurriculumId)
        : undefined;
      const planItem = item.linkedPlanItemId
        ? plan?.items.find((candidate) => candidate.id === item.linkedPlanItemId)
        : undefined;
      if (
        !plan ||
        plan.status !== 'accepted' ||
        !curriculum ||
        curriculum.id !== plan.curriculumVersionId ||
        agenda.curriculumVersionId !== curriculum.id ||
        !planItem
      ) {
        return commands.complete(claim, () =>
          CourseActionLaunchResultSchema.parse({
            kind: 'blocked',
            agendaItemId: item.id,
            reason: 'The accepted route no longer contains this action.',
            stale: true,
            recomposedAgenda: null,
          }),
        );
      }
      const bound = resolveAgendaBoundPlanItem(repos, plan, item);
      if (!bound.ok) {
        return commands.complete(claim, () =>
          CourseActionLaunchResultSchema.parse({
            kind: 'blocked',
            agendaItemId: item.id,
            reason: bound.reason,
            stale: true,
            recomposedAgenda: null,
          }),
        );
      }
      if (item.kind === 'formal_checkpoint') {
        const progress = new Map(
          repos.studyPlans.listProgress(plan.id).map((entry) => [entry.planItemId, entry.state]),
        );
        if (!bound.planItem.prerequisitePlanItemIds.every((id) => progress.get(id) === 'completed'))
          return commands.complete(claim, () =>
            CourseActionLaunchResultSchema.parse({
              kind: 'blocked',
              agendaItemId: item.id,
              reason: '请先完成这项检查对应的讲解与练习。',
              stale: false,
              recomposedAgenda: null,
            }),
          );
      }
      const currentLaunch = resolveLaunchForPlanItem(
        repos,
        clock,
        parsed.command.workspaceId,
        curriculum,
        // A failed Review has already consumed its due event. Its linked Repair
        // generates another formal check of the same objective, without consuming
        // a second scheduled Review.
        verificationEpisodeId && bound.planItem.kind === 'due_review'
          ? { ...bound.planItem, kind: 'formal_checkpoint' }
          : bound.planItem,
      );
      if (
        currentLaunch.status !== 'launchable' ||
        currentLaunch.capability !== item.launch.capability
      ) {
        return commands.complete(claim, () =>
          CourseActionLaunchResultSchema.parse({
            kind: 'blocked',
            agendaItemId: item.id,
            reason: currentLaunch.reason ?? 'This action is no longer launchable.',
            stale: currentLaunch.status !== item.launch.status,
            recomposedAgenda: null,
          }),
        );
      }

      if (currentLaunch.capability === 'lesson') {
        const resource = JSON.parse(currentLaunch.resourceId ?? '{}') as {
          learningUnitId?: unknown;
          conceptId?: unknown;
        };
        if (
          typeof resource.learningUnitId !== 'string' ||
          (resource.conceptId !== null && typeof resource.conceptId !== 'string')
        ) {
          throw new AppError(ApiErrorCode.ValidationError, 'Lesson launch resource is invalid.');
        }
        if (!item.learningUnitId || resource.learningUnitId !== item.learningUnitId) {
          return commands.complete(claim, () =>
            CourseActionLaunchResultSchema.parse({
              kind: 'blocked',
              agendaItemId: item.id,
              reason: 'This action is not linked to a LearningUnit.',
              stale: false,
              recomposedAgenda: null,
            }),
          );
        }
        const conceptId = typeof resource.conceptId === 'string' ? resource.conceptId : null;
        const lesson = conceptId ? repos.lessons.getByConcept(conceptId) : null;
        const response = CourseActionLaunchResultSchema.parse({
          kind: 'lesson',
          agendaItemId: item.id,
          learningUnitId: item.learningUnitId,
          conceptId,
          lessonId: lesson?.id ?? null,
        });
        return commands.complete(claim, () => response);
      }

      if (currentLaunch.capability === 'assessment') {
        const verificationEpisode = verificationEpisodeId
          ? repos.repair.getEpisode(verificationEpisodeId)
          : undefined;
        const priorVersion = verificationEpisode
          ? repos.formalAssessments.getVersion(verificationEpisode.assessmentVersionId)
          : undefined;
        if (
          verificationEpisodeId &&
          (!verificationEpisode ||
            verificationEpisode.workspaceId !== parsed.command.workspaceId ||
            !['ACTIVE', 'AWAITING_VERIFICATION'].includes(verificationEpisode.status) ||
            priorVersion?.progressionContext?.agendaId !== agenda.id ||
            priorVersion.progressionContext.agendaItemId !== item.id)
        )
          throw new AppError(
            ApiErrorCode.VersionConflict,
            'Repair verification no longer matches this active Course action.',
          );
        const previousPrompts = priorVersion
          ? repos.formalAssessments
              .listVersions(priorVersion.definitionId)
              .flatMap((version) => version.items.map((item) => item.prompt))
              .slice(-12)
          : undefined;
        const request = CreateAssessmentRequestSchema.parse(
          JSON.parse(currentLaunch.resourceId ?? '{}') as unknown,
        );
        const assessmentKind =
          bound.planItem.kind === 'due_review'
            ? 'due_review'
            : bound.planItem.kind === 'targeted_repair'
              ? 'targeted_repair'
              : bound.planItem.kind === 'synthesis'
                ? 'synthesis'
                : 'formal_checkpoint';
        const formalOnly =
          assessmentKind === 'formal_checkpoint' ||
          assessmentKind === 'targeted_repair' ||
          assessmentKind === 'due_review' ||
          assessmentKind === 'synthesis';
        const unitTransfer = bound.planItem.synthesisMode === 'unit_transfer';
        const assertFormalContextCurrent = (): Curriculum => {
          const currentState = repos.courseExecution.get(parsed.command.workspaceId);
          const currentAgenda = repos.sessionAgendas.get(parsed.agendaId);
          const currentPlan = repos.studyPlans.get(parsed.expectedStudyPlanId);
          const currentCurriculum = currentState.activeCurriculumId
            ? repos.curricula.get(currentState.activeCurriculumId)
            : undefined;
          const currentItem = currentAgenda?.items.find(
            (candidate) => candidate.id === parsed.agendaItemId,
          );
          if (
            currentState.executionStatus !== 'active' ||
            currentState.routeValidationStatus !== 'valid' ||
            currentState.activeAgendaId !== parsed.agendaId ||
            currentState.activeContractId !== parsed.expectedContractId ||
            currentState.acceptedPlanId !== parsed.expectedStudyPlanId ||
            !currentAgenda ||
            currentAgenda.version !== parsed.expectedAgendaVersion ||
            currentAgenda.executionSourceManifestFingerprint !==
              parsed.expectedExecutionSourceManifestFingerprint ||
            !currentPlan ||
            currentPlan.status !== 'accepted' ||
            currentPlan.contractVersionId !== parsed.expectedContractId ||
            !currentCurriculum ||
            currentCurriculum.status !== 'accepted' ||
            currentCurriculum.contractVersionId !== parsed.expectedContractId ||
            currentCurriculum.id !== currentPlan.curriculumVersionId ||
            currentCurriculum.executionSourceManifest.fingerprint !==
              parsed.expectedExecutionSourceManifestFingerprint ||
            currentPlan.executionSourceManifestFingerprint !==
              parsed.expectedExecutionSourceManifestFingerprint ||
            currentAgenda.contractVersionId !== parsed.expectedContractId ||
            currentAgenda.studyPlanVersionId !== currentPlan.id ||
            currentAgenda.curriculumVersionId !== currentCurriculum.id ||
            !currentItem
          ) {
            throw new AppError(
              ApiErrorCode.VersionConflict,
              'Formal assessment context changed during semantic-authority evaluation.',
            );
          }
          const currentBound = resolveAgendaBoundPlanItem(repos, currentPlan, currentItem);
          if (
            !currentBound.ok ||
            currentBound.planItem.id !== bound.planItem.id ||
            currentBound.planItem.kind !== bound.planItem.kind ||
            currentBound.planItem.curriculumLearningUnitId !==
              bound.planItem.curriculumLearningUnitId ||
            JSON.stringify(currentBound.planItem.objectiveIds) !==
              JSON.stringify(bound.planItem.objectiveIds)
          ) {
            throw new AppError(
              ApiErrorCode.VersionConflict,
              'Formal assessment objective scope changed during semantic-authority evaluation.',
            );
          }
          const currentLaunch = resolveLaunchForPlanItem(
            repos,
            clock,
            parsed.command.workspaceId,
            currentCurriculum,
            verificationEpisodeId && currentBound.planItem.kind === 'due_review'
              ? { ...currentBound.planItem, kind: 'formal_checkpoint' }
              : currentBound.planItem,
          );
          if (
            currentLaunch.status !== 'launchable' ||
            currentLaunch.capability !== 'assessment' ||
            currentLaunch.capability !== currentItem.launch.capability
          ) {
            throw new AppError(
              ApiErrorCode.VersionConflict,
              'Formal assessment is no longer launchable.',
            );
          }
          const currentContract = repos.learningContracts.get(currentPlan.contractVersionId);
          if (
            !currentContract ||
            currentContract.workspaceId !== parsed.command.workspaceId ||
            (currentContract.status !== 'learner_confirmed' && currentContract.status !== 'active')
          ) {
            throw new AppError(
              ApiErrorCode.VersionConflict,
              'Formal assessment Contract is no longer current.',
            );
          }
          const currentContext = buildCurriculumExecutionContext(repos, currentContract);
          if (!contextHasExactExecutionSourceRevisions(currentCurriculum, currentContext)) {
            throw new AppError(
              ApiErrorCode.VersionConflict,
              'Formal assessment source ownership changed during semantic-authority evaluation.',
            );
          }
          return currentCurriculum;
        };
        curriculum = await ensureFormalObjectiveSemanticAuthority({
          curriculum,
          plan,
          planItem: bound.planItem,
          assessmentKind,
          operationId: claim.operationId,
          fencingToken: claim.fencingToken,
          studySessionId: parsed.studySessionId ?? null,
          confirmedCostPolicyIds: parsed.confirmedCostPolicyIds ?? [],
          assertCurrent: assertFormalContextCurrent,
          providerOptions: opts,
        });
        const assessmentRequest = { ...request, ...(formalOnly ? { formalOnly: true } : {}) };
        const existingCheckpoint = () => {
          if (verificationEpisodeId || !formalOnly || assessmentKind === 'due_review') return null;
          const accepted = formalAssessments.getAcceptedForAgenda(
            parsed.command.workspaceId,
            agenda.id,
            item.id,
          );
          const quiz = accepted?.progressionContext?.quizId
            ? repos.quizzes.get(accepted.progressionContext.quizId)
            : undefined;
          return accepted && quiz
            ? CourseActionLaunchResultSchema.parse({
                kind: 'assessment',
                agendaItemId: item.id,
                quiz: toPublicQuiz(quiz),
                assessmentKind,
                formalAssessmentVersionId: accepted.id,
              })
            : null;
        };
        const existing = existingCheckpoint();
        if (existing) return commands.complete(claim, () => existing);
        const proposalCatalogue = buildFormalAssessmentProposalCatalogue({
          repos,
          workspaceId: parsed.command.workspaceId,
          curriculum,
          plan,
          planItemId: bound.planItem.id,
          learningUnitId: bound.planItem.curriculumLearningUnitId!,
        });
        const assessmentDiversity = assessmentDiversityForRoute({
          repos,
          workspaceId: parsed.command.workspaceId,
          assessmentKind,
          curriculum,
          plan,
          learningUnitId: bound.planItem.curriculumLearningUnitId,
          objectiveId: bound.planItem.objectiveIds[0],
        });
        if (assessmentKind === 'due_review' && !verificationEpisodeId) {
          const targetId = request.mode === 'review' ? request.conceptIds?.[0] : undefined;
          if (!targetId || request.conceptIds?.length !== 1) {
            throw new AppError(
              ApiErrorCode.ValidationError,
              'Due Review launch requires one exact objective target.',
            );
          }
          const execution = reviewSuccessor.beginExecution({
            targetId,
            workspaceId: parsed.command.workspaceId,
            courseId: parsed.command.workspaceId,
            agendaId: agenda.id,
            agendaItemId: item.id,
            contractVersionId: plan.contractVersionId,
            curriculumVersionId: plan.curriculumVersionId,
            studyPlanVersionId: plan.id,
            manifestFingerprint: plan.executionSourceManifestFingerprint,
          });
          reviewExecutionId = execution.id;
          if (execution.assessmentVersionId) {
            const formalVersion = formalAssessments.getVersion(execution.assessmentVersionId);
            const quizId = formalVersion.progressionContext?.quizId;
            const quiz = quizId ? repos.quizzes.get(quizId) : undefined;
            if (!quiz) {
              throw new AppError(
                ApiErrorCode.VersionConflict,
                'The active Review assessment binding is incomplete.',
              );
            }
            return commands.complete(claim, () =>
              CourseActionLaunchResultSchema.parse({
                kind: 'assessment',
                agendaItemId: item.id,
                quiz: toPublicQuiz(quiz),
                assessmentKind,
                formalAssessmentVersionId: formalVersion.id,
              }),
            );
          }
        }
        const operationType =
          assessmentKind === 'synthesis'
            ? 'propose_synthesis_assessment'
            : 'propose_formal_assessment';
        const policyFingerprint = enforceAgentCostPolicies(repos, {
          workspaceId: parsed.command.workspaceId,
          operationType,
          studySessionId: parsed.studySessionId ?? null,
          at: clock.now().toISOString(),
          confirmedPolicyIds: parsed.confirmedCostPolicyIds ?? [],
        });
        const creation = await runTrackedAgentProviderOperation({
          repos,
          clock,
          provider,
          providerModel: provider.name === 'hy3' ? (provider.model ?? providerModel ?? null) : null,
          operationId: claim.operationId,
          fencingToken: claim.fencingToken,
          workspaceId: parsed.command.workspaceId,
          studySessionId: parsed.studySessionId ?? null,
          learningUnitId: item.learningUnitId,
          assessmentId: null,
          operationType,
          schemaFingerprint: 'formal-assessment-proposal-v2-taught-premises-objectives',
          policyFingerprint,
          sourceFingerprint: parsed.expectedExecutionSourceManifestFingerprint,
          providerOptions: opts,
          invoke: (options) =>
            assessment.prepare(parsed.command.workspaceId, assessmentRequest, options, {
              requiredRepresentation: assessmentDiversity.selection.requestedRepresentation,
              requestedChallengeFamily: assessmentDiversity.selection.requestedChallengeFamily,
              objectiveCatalogue: proposalCatalogue?.objectiveCatalogue,
              teachingSurfaceCatalogue: proposalCatalogue?.teachingSurfaceCatalogue,
              previousPrompts: unitTransfer ? undefined : previousPrompts,
              learnerGeneratedTransfer: unitTransfer,
            }),
        });
        if (previousPrompts && !unitTransfer) {
          const normalize = (value: string) => value.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
          if (
            creation.quiz.questions.some((question) =>
              previousPrompts.some((prompt) =>
                normalize(question.stem).includes(normalize(prompt)),
              ),
            )
          )
            throw new AppError(
              ApiErrorCode.GroundingFailed,
              '验证题重复了已经见过的问题，请重新准备。',
            );
        }
        if (unitTransfer) {
          const objective = proposalCatalogue.objectiveCatalogue[0];
          if (
            !objective ||
            creation.quiz.questions.some(
              (question) => question.formalProposal?.objectiveRef !== objective.objectiveRef,
            )
          )
            throw new AppError(
              ApiErrorCode.GroundingFailed,
              '综合迁移题未绑定当前目标，请重新准备。',
            );
          const priorResponses = repos.formalAssessments
            .listAttemptsForWorkspace(parsed.command.workspaceId)
            .filter((attempt) => attempt.status === 'submitted')
            .flatMap((attempt) => {
              const version = repos.formalAssessments.getVersion(attempt.assessmentVersionId);
              return (
                version?.items
                  .filter(
                    (item) =>
                      item.transferTask &&
                      item.targetObjectiveId === bound.planItem.objectiveIds[0],
                  )
                  .map((item) => attempt.responses[item.id] ?? '') ?? []
              );
            })
            .slice(-100);
          const task = TransferTaskSchema.parse({
            version: 'unit-transfer-v1',
            presentedExamples: [
              ...proposalCatalogue.teachingSurfaceCatalogue.map((surface) => surface.text),
              ...repos.lessonExecution
                .listForWorkspace(parsed.command.workspaceId)
                .filter(
                  (state) =>
                    state.studyPlanVersionId === plan.id &&
                    state.learningUnitId === bound.planItem.curriculumLearningUnitId,
                )
                .flatMap((state) => {
                  const brief = state.teachingBriefId
                    ? repos.teachingBriefs.get(state.teachingBriefId)
                    : undefined;
                  return [
                    ...(brief ? lessonExecutionPresentedPrompts(brief, state) : []),
                    ...repos.lessonExecution.listEvents(state.id).flatMap((event) => {
                      const archived =
                        event.kind === 'practice_repair_prepared' && event.payload.archivedRound
                          ? PracticeRecoveryStateSchema.shape.rounds.element.safeParse(
                              event.payload.archivedRound,
                            )
                          : null;
                      return archived?.success ? recoveryExposurePrompts(archived.data) : [];
                    }),
                  ];
                }),
              ...repos.repair
                .listByWorkspace(parsed.command.workspaceId)
                .filter(
                  (episode) =>
                    episode.targetLearningUnitId === bound.planItem.curriculumLearningUnitId,
                )
                .flatMap((episode) =>
                  repos.repair.listPackets(episode.id).map((packet) => packet.practicePrompt),
                ),
            ].slice(-100),
            priorResponses,
          });
          // The provider supplies only source-bound grading content. Local policy
          // authors the learner's generative task and separately grades its performance.
          creation.quiz.questions = creation.quiz.questions.slice(0, 1).map((question) => ({
            ...question,
            stem: unitTransferPrompt(objective.title, priorResponses.length),
            transferTask: task,
          }));
          creation.blueprints = creation.blueprints.filter((blueprint) =>
            creation.quiz.questions.some((question) => question.blueprintId === blueprint.id),
          );
        }
        return commands.complete(claim, () => {
          assertFormalContextCurrent();
          if (verificationEpisode) {
            const currentEpisode = repos.repair.getEpisode(verificationEpisode.id);
            if (
              currentEpisode?.status !== 'AWAITING_VERIFICATION' ||
              currentEpisode.verificationAttemptId !== verificationEpisode.verificationAttemptId
            )
              throw new AppError(
                ApiErrorCode.VersionConflict,
                '修复状态已改变，请刷新后继续复测。',
              );
          }
          const currentState = repos.courseExecution.get(parsed.command.workspaceId);
          const currentAgenda = repos.sessionAgendas.get(parsed.agendaId);
          const currentPlan = repos.studyPlans.get(parsed.expectedStudyPlanId);
          const currentCurriculum = currentState.activeCurriculumId
            ? repos.curricula.get(currentState.activeCurriculumId)
            : undefined;
          const currentItem = currentAgenda?.items.find(
            (candidate) => candidate.id === parsed.agendaItemId,
          );
          const currentPlanItem = currentItem?.linkedPlanItemId
            ? currentPlan?.items.find((candidate) => candidate.id === currentItem.linkedPlanItemId)
            : undefined;
          if (
            currentState.executionStatus !== 'active' ||
            currentState.routeValidationStatus !== 'valid' ||
            currentState.activeAgendaId !== parsed.agendaId ||
            currentState.activeContractId !== parsed.expectedContractId ||
            currentState.acceptedPlanId !== parsed.expectedStudyPlanId ||
            !currentAgenda ||
            currentAgenda.version !== parsed.expectedAgendaVersion ||
            currentAgenda.executionSourceManifestFingerprint !==
              parsed.expectedExecutionSourceManifestFingerprint ||
            !currentPlan ||
            currentPlan.status !== 'accepted' ||
            !currentCurriculum ||
            currentCurriculum.id !== currentPlan.curriculumVersionId ||
            currentAgenda.curriculumVersionId !== currentCurriculum.id ||
            !currentItem ||
            !currentPlanItem
          ) {
            throw new AppError(
              ApiErrorCode.VersionConflict,
              'Course action context changed while the assessment was generated.',
            );
          }
          const finalBound = resolveAgendaBoundPlanItem(repos, currentPlan, currentItem);
          if (!finalBound.ok) {
            throw new AppError(
              ApiErrorCode.VersionConflict,
              `Assessment action is no longer semantically launchable: ${finalBound.reason}`,
            );
          }
          const finalLaunch = resolveLaunchForPlanItem(
            repos,
            clock,
            parsed.command.workspaceId,
            currentCurriculum,
            verificationEpisodeId && finalBound.planItem.kind === 'due_review'
              ? { ...finalBound.planItem, kind: 'formal_checkpoint' }
              : finalBound.planItem,
          );
          if (
            finalLaunch.status !== 'launchable' ||
            finalLaunch.capability !== 'assessment' ||
            finalLaunch.capability !== currentItem.launch.capability
          ) {
            throw new AppError(
              ApiErrorCode.VersionConflict,
              'Assessment action is no longer launchable.',
            );
          }
          assertCurrentFormalObjectiveAuthoritySemanticSupport(
            currentCurriculum,
            formalObjectiveTargets(currentCurriculum, finalBound.planItem).map(
              (target) => target.objective,
            ),
            {
              boundary: 'formal_admission',
              isBlockingEligible: (authorityRecordId) =>
                repos.sourceAuthority.isBlockingEligible(authorityRecordId),
            },
          );
          const currentAssessmentDiversity = assessmentDiversityForRoute({
            repos,
            workspaceId: parsed.command.workspaceId,
            assessmentKind,
            curriculum: currentCurriculum,
            plan: currentPlan,
            learningUnitId: finalBound.planItem.curriculumLearningUnitId,
            objectiveId: finalBound.planItem.objectiveIds[0],
          });
          if (JSON.stringify(currentAssessmentDiversity) !== JSON.stringify(assessmentDiversity)) {
            throw new AppError(
              ApiErrorCode.VersionConflict,
              'Assessment evidence changed while the question was generated.',
            );
          }
          if (assessmentKind === 'due_review' && reviewExecutionId) {
            const execution = repos.reviewSuccessor.getExecution(reviewExecutionId);
            if (execution?.assessmentVersionId) {
              const formalVersion = formalAssessments.getVersion(execution.assessmentVersionId);
              const quizId = formalVersion.progressionContext?.quizId;
              const quiz = quizId ? repos.quizzes.get(quizId) : undefined;
              if (!quiz) {
                throw new AppError(
                  ApiErrorCode.VersionConflict,
                  'The active Review assessment binding is incomplete.',
                );
              }
              return CourseActionLaunchResultSchema.parse({
                kind: 'assessment',
                agendaItemId: currentItem.id,
                quiz: toPublicQuiz(quiz),
                assessmentKind,
                formalAssessmentVersionId: formalVersion.id,
              });
            }
          }
          const existing = existingCheckpoint();
          if (existing) return existing;
          assessment.persist(creation);
          const questionContracts = formalProgression.registerAssessmentContracts({
            workspaceId: parsed.command.workspaceId,
            quizId: creation.quiz.id,
            studySessionId: parsed.studySessionId ?? null,
            agendaId: currentAgenda.id,
            agendaItemId: currentItem.id,
            assessmentKind,
            contractVersionId: currentPlan.contractVersionId,
            curriculumVersionId: currentPlan.curriculumVersionId,
            studyPlanVersionId: currentPlan.id,
            executionSourceManifestFingerprint: currentPlan.executionSourceManifestFingerprint,
            proposalCatalogue,
          });
          if (
            formalOnly &&
            creation.quiz.questions.some(
              (question) =>
                !questionContracts.some(
                  (contract) =>
                    contract.questionId === question.id &&
                    isStateCreditingAdmissibility(contract.admissibilityTier),
                ),
            )
          ) {
            throw new AppError(
              ApiErrorCode.GroundingFailed,
              '评分依据未通过正式准入，请重新准备检查。已有学习记录不变。',
              {
                kind: 'formal_question_admission_failed',
                limitations: questionContracts
                  .filter((contract) => !isStateCreditingAdmissibility(contract.admissibilityTier))
                  .flatMap((contract) => contract.limitations),
              },
            );
          }
          let formalAssessmentVersionId: string | null = null;
          if (
            assessmentKind === 'formal_checkpoint' ||
            assessmentKind === 'targeted_repair' ||
            assessmentKind === 'due_review' ||
            assessmentKind === 'synthesis'
          ) {
            const targetLearningUnitId = item.learningUnitId;
            const targetObjectiveId = finalBound.planItem.objectiveIds[0];
            if (targetLearningUnitId && targetObjectiveId) {
              const objectiveTitle = currentCurriculum.nodes
                .find((node) => node.id === targetLearningUnitId && node.learningUnit !== null)
                ?.learningUnit?.objectives.find(
                  (objective) => objective.id === targetObjectiveId,
                )?.title;
              const formalVersion = formalAssessments.createAcceptedFromQuiz({
                workspaceId: parsed.command.workspaceId,
                quiz: creation.quiz,
                logicalKey: `agenda:${currentAgenda.id}:${currentItem.id}`,
                title:
                  assessmentKind === 'due_review' && objectiveTitle
                    ? `到期复习：${objectiveTitle}`
                    : currentPlanItem.rationale || '理解检查',
                targetLearningUnitId,
                targetObjectiveId,
                representation: assessmentDiversity.evidenceRepresentation,
                predecessorVersionId: priorVersion
                  ? repos.formalAssessments.listVersions(priorVersion.definitionId).at(-1)?.id
                  : undefined,
                assessmentIntent: assessmentDiversity.selection,
                progressionContext: {
                  quizId: creation.quiz.id,
                  contractVersionId: currentPlan.contractVersionId,
                  curriculumVersionId: currentPlan.curriculumVersionId,
                  studyPlanVersionId: currentPlan.id,
                  agendaId: currentAgenda.id,
                  agendaItemId: currentItem.id,
                  assessmentKind,
                  executionSourceManifestFingerprint:
                    currentPlan.executionSourceManifestFingerprint,
                },
              });
              formalAssessmentVersionId = formalVersion.id;
              if (assessmentKind === 'due_review' && reviewExecutionId) {
                reviewSuccessor.bindAssessment(reviewExecutionId, formalVersion);
              }
            }
          }
          return CourseActionLaunchResultSchema.parse({
            kind: 'assessment',
            agendaItemId: currentItem.id,
            quiz: toPublicQuiz(creation.quiz),
            assessmentKind,
            formalAssessmentVersionId,
          });
        });
      }

      return commands.complete(claim, () =>
        CourseActionLaunchResultSchema.parse({
          kind: 'blocked',
          agendaItemId: item.id,
          reason: 'This capability is not available in the current implementation phase.',
          stale: false,
          recomposedAgenda: null,
        }),
      );
    } catch (error) {
      if (reviewExecutionId) reviewSuccessor.markExecutionFailure(reviewExecutionId, error);
      commands.fail(claim, error);
      throw error;
    }
  }

  async function launchReview(
    input: {
      command: CourseExecutionCommandEnvelope;
      targetId: string;
      expectedCourseExecutionVersion: number;
    },
    opts?: ProviderCallOptions,
  ) {
    const workspaceId = input.command.workspaceId;
    const state = repos.courseExecution.get(workspaceId);
    const target = repos.reviewSuccessor.getTarget(input.targetId);
    if (!target || target.workspaceId !== workspaceId) throw notFound('Review target not found.');
    if (state.version !== input.expectedCourseExecutionVersion)
      throw new AppError(
        ApiErrorCode.VersionConflict,
        'Course route changed. Refresh before starting Review.',
      );
    const agenda = reviewSuccessor.reconcileDueAgenda(workspaceId);
    const item = agenda?.items.find((item) => {
      if (item.kind !== 'due_review' || !['queued', 'active'].includes(item.state)) return false;
      try {
        return CreateAssessmentRequestSchema.safeParse(
          JSON.parse(item.launch.resourceId ?? '{}'),
        ).data?.conceptIds?.includes(input.targetId);
      } catch {
        return false;
      }
    });
    if (!agenda || !item || !state.activeContractId || !state.acceptedPlanId)
      throw new AppError(
        ApiErrorCode.ValidationError,
        'This Review is not due or no longer belongs to the active Course route.',
      );
    return launch(
      {
        command: input.command,
        agendaId: agenda.id,
        expectedAgendaVersion: agenda.version,
        agendaItemId: item.id,
        expectedContractId: state.activeContractId,
        expectedStudyPlanId: state.acceptedPlanId,
        expectedExecutionSourceManifestFingerprint: agenda.executionSourceManifestFingerprint,
      },
      opts,
    );
  }
  async function prepareRepairVerification(episodeId: string, opts?: ProviderCallOptions) {
    const episode = repos.repair.getEpisode(episodeId);
    const original = episode
      ? repos.formalAssessments.getVersion(episode.assessmentVersionId)
      : undefined;
    const context = original?.progressionContext;
    const agenda = context ? repos.sessionAgendas.get(context.agendaId) : undefined;
    if (!episode || !context || !agenda) throw notFound('Repair has no formal Course route.');
    const commandId = newId('repair_verification');
    const result = await launch(
      {
        command: {
          commandId,
          idempotencyKey: commandId,
          workspaceId: episode.workspaceId,
          actor: 'learner',
        },
        agendaId: agenda.id,
        expectedAgendaVersion: agenda.version,
        agendaItemId: context.agendaItemId,
        expectedContractId: context.contractVersionId,
        expectedStudyPlanId: context.studyPlanVersionId,
        expectedExecutionSourceManifestFingerprint: context.executionSourceManifestFingerprint,
      },
      opts,
      episodeId,
    );
    if (result.kind !== 'assessment' || !result.formalAssessmentVersionId)
      throw new AppError(
        ApiErrorCode.ValidationError,
        result.kind === 'blocked' ? result.reason : 'Fresh verification is unavailable.',
      );
    return formalAssessments.getVersion(result.formalAssessmentVersionId);
  }
  return { launch, launchReview, prepareRepairVerification };
}

export type CourseActionLaunchService = ReturnType<typeof createCourseActionLaunchService>;
