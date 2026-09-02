import {
  ApiErrorCode,
  CourseActionLaunchResultSchema,
  CreateAssessmentRequestSchema,
  LaunchCourseActionRequestSchema,
  type CourseActionLaunchResult,
  type Curriculum,
  type CurriculumNode,
  type CurriculumObjective,
  type FormalAssessmentKind,
  type LaunchCourseActionRequest,
  type SessionAgendaItem,
  type StudyPlan,
  type StudyPlanItem,
  type StudyPlanItemKind,
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
import { resolveLaunchForPlanItem } from './studyPlanValidation.js';
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

const AGENDA_KIND_BY_PLAN_KIND: Record<StudyPlanItemKind, SessionAgendaItem['kind']> = {
  teach_unit: 'learning_unit_teaching',
  informal_check: 'informal_check',
  formal_checkpoint: 'formal_checkpoint',
  synthesis: 'synthesis',
  targeted_repair: 'targeted_repair',
  due_review: 'due_review',
  adversarial_readiness: 'adversarial_readiness',
};

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

function agendaBoundPlanItem(
  repos: Repositories,
  plan: StudyPlan,
  item: SessionAgendaItem,
): { ok: true; planItem: StudyPlanItem } | { ok: false; reason: string } {
  if (item.state !== 'queued' && item.state !== 'active') {
    return { ok: false, reason: `Agenda item state ${item.state} is not launchable.` };
  }
  if (!item.linkedPlanItemId) {
    return { ok: false, reason: 'Agenda item is not linked to an accepted Plan item.' };
  }
  const planItem = plan.items.find((candidate) => candidate.id === item.linkedPlanItemId);
  if (!planItem) return { ok: false, reason: 'The accepted Plan no longer contains this item.' };
  if (item.learningUnitId !== planItem.curriculumLearningUnitId) {
    return { ok: false, reason: 'Agenda and Plan LearningUnit identity do not match.' };
  }

  if (item.kind === 'due_review') {
    try {
      const request = CreateAssessmentRequestSchema.parse(JSON.parse(item.launch.resourceId ?? ''));
      const targetId = request.mode === 'review' ? request.conceptIds?.[0] : undefined;
      const target = targetId ? repos.reviewSuccessor.getTarget(targetId) : undefined;
      const binding =
        target?.currentBindingVersion !== null && target?.currentBindingVersion !== undefined
          ? repos.reviewSuccessor.getBinding(target.id, target.currentBindingVersion)
          : undefined;
      if (
        request.conceptIds?.length !== 1 ||
        !target ||
        target.status !== 'active' ||
        !binding ||
        binding.learningUnitId !== planItem.curriculumLearningUnitId ||
        !planItem.objectiveIds.includes(binding.objectiveId)
      ) {
        return { ok: false, reason: 'The due Review target no longer matches this Plan item.' };
      }
      return {
        ok: true,
        planItem: { ...planItem, kind: 'due_review', objectiveIds: [binding.objectiveId] },
      };
    } catch {
      return { ok: false, reason: 'The due Review launch binding is invalid.' };
    }
  }

  if (item.kind === 'targeted_repair' && planItem.kind !== 'targeted_repair') {
    const progress = repos.studyPlans
      .listProgress(plan.id)
      .find((entry) => entry.planItemId === planItem.id);
    if (progress?.state !== 'repair_needed') {
      return { ok: false, reason: 'The linked Plan item no longer requires targeted repair.' };
    }
    return { ok: true, planItem: { ...planItem, kind: 'targeted_repair' } };
  }

  if (item.kind !== AGENDA_KIND_BY_PLAN_KIND[planItem.kind]) {
    return { ok: false, reason: 'Agenda item kind is inconsistent with its accepted Plan item.' };
  }
  return { ok: true, planItem };
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
      const bound = agendaBoundPlanItem(repos, plan, item);
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
      const currentLaunch = resolveLaunchForPlanItem(
        repos,
        clock,
        parsed.command.workspaceId,
        curriculum,
        bound.planItem,
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
          assessmentKind === 'due_review';
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
          const currentBound = agendaBoundPlanItem(repos, currentPlan, currentItem);
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
            currentBound.planItem,
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
        if (assessmentKind === 'due_review') {
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
            }),
        });
        return commands.complete(claim, () => {
          assertFormalContextCurrent();
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
          const finalBound = agendaBoundPlanItem(repos, currentPlan, currentItem);
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
            finalBound.planItem,
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
          assessment.persist(creation);
          let formalAssessmentVersionId: string | null = null;
          if (
            assessmentKind === 'formal_checkpoint' ||
            assessmentKind === 'targeted_repair' ||
            assessmentKind === 'due_review'
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
          formalProgression.registerAssessmentContracts({
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

  return { launch };
}

export type CourseActionLaunchService = ReturnType<typeof createCourseActionLaunchService>;
