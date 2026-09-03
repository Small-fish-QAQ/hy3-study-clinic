import {
  ActiveCourseRouteSchema,
  ApiErrorCode,
  DecideStudyPlanRequestSchema,
  StudyPlanDecisionResponseSchema,
  type ActiveCourseRoute,
  type DecideStudyPlanRequest,
  type StudyPlan,
  type StudyPlanProgressState,
  type StudyPlanDecisionResponse,
} from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import type { CourseCommandService } from './courseCommands.js';
import type { SessionAgendaAgentService } from './sessionAgendasAgent.js';
import { buildCurriculumExecutionContext } from './curriculum.js';
import { isHardAvailability, isHardDeadline } from './feasibility.js';
import {
  deriveTeachUnitDurationsOrThrow,
  plannabilityWarningText,
  resolveStudyPlanPlannability,
} from './studyPlanValidation.js';

interface CourseExecutionServiceDeps {
  repos: Repositories;
  clock: Clock;
  commands: CourseCommandService;
  agendas: SessionAgendaAgentService;
}

function readActiveRoute(repos: Repositories, workspaceId: string): ActiveCourseRoute | null {
  const state = repos.courseExecution.get(workspaceId);
  const pointers = [
    state.activeContractId,
    state.activeCurriculumId,
    state.acceptedPlanId,
    state.activeAgendaId,
  ];
  if (pointers.every((pointer) => pointer === null)) return null;
  if (pointers.some((pointer) => pointer === null) || state.updatedAt === null) {
    throw new Error('Course execution route has incomplete active pointers.');
  }
  const contract = repos.learningContracts.get(state.activeContractId!);
  const curriculum = repos.curricula.get(state.activeCurriculumId!);
  const studyPlan = repos.studyPlans.get(state.acceptedPlanId!);
  const agenda = repos.sessionAgendas.get(state.activeAgendaId!);
  if (!contract || !curriculum || !studyPlan || !agenda) {
    throw new Error('Course execution route references missing versioned state.');
  }
  return ActiveCourseRouteSchema.parse({
    contract,
    curriculum,
    studyPlan,
    agenda,
    activatedAt: state.updatedAt,
  });
}

function requireProposedPlan(repos: Repositories, request: DecideStudyPlanRequest): StudyPlan {
  const plan = repos.studyPlans.get(request.studyPlanId);
  if (!plan || plan.workspaceId !== request.command.workspaceId) {
    throw notFound('StudyPlan not found.');
  }
  if (
    plan.status !== 'proposed' ||
    plan.version !== request.expectedVersion ||
    plan.contractVersionId !== request.expectedContractId ||
    plan.curriculumVersionId !== request.expectedCurriculumId ||
    plan.executionSourceManifestFingerprint !== request.expectedExecutionSourceManifestFingerprint
  ) {
    throw new AppError(ApiErrorCode.VersionConflict, 'StudyPlan decision is stale.');
  }
  return plan;
}

function requireCurrentPlanRouteAuthority(
  repos: Repositories,
  workspaceId: string,
  planId: string,
): {
  plan: StudyPlan;
  contract: NonNullable<ReturnType<Repositories['learningContracts']['get']>>;
  curriculum: NonNullable<ReturnType<Repositories['curricula']['get']>>;
} {
  const plan = repos.studyPlans.get(planId);
  if (!plan || plan.workspaceId !== workspaceId || plan.status !== 'proposed') {
    throw new AppError(ApiErrorCode.VersionConflict, 'StudyPlan decision is stale.');
  }
  const contract = repos.learningContracts.get(plan.contractVersionId);
  const curriculum = repos.curricula.get(plan.curriculumVersionId);
  const currentAcceptedCurriculum = repos.curricula
    .list(workspaceId)
    .filter((candidate) => candidate.status === 'accepted')
    .at(-1);
  if (
    !contract ||
    !curriculum ||
    currentAcceptedCurriculum?.id !== curriculum.id ||
    (contract.status !== 'learner_confirmed' && contract.status !== 'active') ||
    curriculum.status !== 'accepted' ||
    curriculum.contractVersionId !== contract.id ||
    curriculum.executionSourceManifest.fingerprint !== plan.executionSourceManifestFingerprint
  ) {
    throw new AppError(ApiErrorCode.VersionConflict, 'StudyPlan route is stale or incompatible.');
  }
  const currentExecutionContext = buildCurriculumExecutionContext(repos, contract);
  if (
    JSON.stringify(currentExecutionContext.manifest.revisions) !==
    JSON.stringify(curriculum.executionSourceManifest.revisions)
  ) {
    throw new AppError(ApiErrorCode.VersionConflict, 'StudyPlan source manifest is stale.');
  }
  return { plan, contract, curriculum };
}

function compatiblePlanItem(
  before: StudyPlan['items'][number],
  after: StudyPlan['items'][number],
): boolean {
  return (
    before.id === after.id &&
    before.kind === after.kind &&
    before.curriculumLearningUnitId === after.curriculumLearningUnitId &&
    before.targetDepth === after.targetDepth &&
    JSON.stringify([...before.objectiveIds].sort()) ===
      JSON.stringify([...after.objectiveIds].sort()) &&
    JSON.stringify(before.completionPolicy) === JSON.stringify(after.completionPolicy) &&
    JSON.stringify(before.completionRequirements) === JSON.stringify(after.completionRequirements)
  );
}

function carryCompatiblePlanProgress(
  repos: Repositories,
  predecessor: StudyPlan | null,
  successor: StudyPlan,
  at: string,
): void {
  if (
    !predecessor ||
    successor.predecessorId !== predecessor.id ||
    successor.contractVersionId !== predecessor.contractVersionId ||
    successor.curriculumVersionId !== predecessor.curriculumVersionId ||
    successor.executionSourceManifestFingerprint !== predecessor.executionSourceManifestFingerprint
  ) {
    return;
  }
  const priorProgress = new Map(
    repos.studyPlans.listProgress(predecessor.id).map((item) => [item.planItemId, item]),
  );
  const priorItems = new Map(predecessor.items.map((item) => [item.id, item]));
  for (const item of successor.items) {
    const priorItem = priorItems.get(item.id);
    const prior = priorProgress.get(item.id);
    if (!prior || !priorItem || !compatiblePlanItem(priorItem, item)) continue;
    const state = prior.state as StudyPlanProgressState;
    if (state !== 'completed' || !item.curriculumLearningUnitId) continue;
    const hasStateCreditingEvidence = repos.formalProgression
      .listEvidenceForPlanUnit(
        predecessor.workspaceId,
        predecessor.curriculumVersionId,
        predecessor.id,
        item.curriculumLearningUnitId,
      )
      .some((record) => record.stateCreditable);
    if (!hasStateCreditingEvidence) continue;
    const current = repos.studyPlans
      .listProgress(successor.id)
      .find((entry) => entry.planItemId === item.id);
    if (!current || current.state === state) continue;
    repos.studyPlans.updateProgress(
      successor.id,
      item.id,
      current.version,
      state,
      newId('plan_progress_carry'),
      `Carried compatible progress from predecessor StudyPlan ${predecessor.id}.`,
      at,
    );
  }
}

export function createCourseExecutionService({
  repos,
  clock,
  commands,
  agendas,
}: CourseExecutionServiceDeps) {
  function activeRoute(workspaceId: string): ActiveCourseRoute | null {
    if (!repos.workspaces.get(workspaceId)) throw notFound('Course not found.');
    return readActiveRoute(repos, workspaceId);
  }

  function decideStudyPlan(input: DecideStudyPlanRequest): StudyPlanDecisionResponse {
    const parsed = DecideStudyPlanRequestSchema.parse(input);
    if (!repos.workspaces.get(parsed.command.workspaceId)) throw notFound('Course not found.');
    const claim = commands.begin(parsed.command, 'decide_study_plan', {
      studyPlanId: parsed.studyPlanId,
      expectedVersion: parsed.expectedVersion,
      expectedContractId: parsed.expectedContractId,
      expectedCurriculumId: parsed.expectedCurriculumId,
      expectedExecutionSourceManifestFingerprint: parsed.expectedExecutionSourceManifestFingerprint,
      decision: parsed.decision,
      reason: parsed.reason,
    });
    if (claim.replayPayload !== undefined) {
      return StudyPlanDecisionResponseSchema.parse(claim.replayPayload);
    }

    try {
      const plan = requireProposedPlan(repos, parsed);
      const before = repos.courseExecution.get(parsed.command.workspaceId);
      if (parsed.decision === 'reject') {
        const response = commands.complete(claim, () => {
          for (const deferral of plan.deferrals) {
            for (const riskId of deferral.riskIds) {
              const risk = repos.coverageRisks.get(riskId);
              if (risk?.facets.includes('planning_recommendation')) {
                repos.coverageRisks.rejectRecommendation(riskId, clock.now().toISOString(), {
                  id: newId('risk_evt'),
                  eventType: 'learner_rejected_recommendation',
                  actor: 'learner',
                  payload: { studyPlanId: plan.id, reason: parsed.reason },
                  createdAt: clock.now().toISOString(),
                });
              }
            }
          }
          const rejected = repos.studyPlans.reject(plan.id, {
            id: newId('plan_evt'),
            eventType: 'learner_rejected',
            actor: 'learner',
            payload: { reason: parsed.reason },
            createdAt: clock.now().toISOString(),
          });
          const replanTrigger = repos.formalProgression.findReplanTriggerByProposedPlan(plan.id);
          if (replanTrigger) {
            repos.formalProgression.updateReplanTrigger({
              ...replanTrigger,
              status: 'resolved',
              updatedAt: clock.now().toISOString(),
            });
          }
          return StudyPlanDecisionResponseSchema.parse({
            decision: 'rejected',
            decidedPlan: rejected,
            activeRoute: null,
            retainedRoute: readActiveRoute(repos, parsed.command.workspaceId),
          });
        });
        return StudyPlanDecisionResponseSchema.parse(response);
      }

      const plannedContract = repos.learningContracts.get(plan.contractVersionId);
      if (
        plannedContract &&
        (isHardAvailability(plannedContract) || isHardDeadline(plannedContract)) &&
        plan.feasibility.state === 'infeasible'
      ) {
        throw new AppError(
          ApiErrorCode.ValidationError,
          'This StudyPlan exceeds an explicit hard Contract constraint. Accept a compressed proposal or change the Contract first.',
          { reason: 'hard_availability_cap_exceeded', recommendationRequired: true },
        );
      }

      const response = commands.complete(claim, () => {
        const {
          plan: authoritativePlan,
          contract,
          curriculum,
        } = requireCurrentPlanRouteAuthority(repos, parsed.command.workspaceId, plan.id);

        // Defense in depth only: proposal creation owns derivation. Calling the same
        // bounded derivation here detects structural impossibility, but its result is
        // deliberately discarded so acceptance cannot rewrite learner-visible content.
        deriveTeachUnitDurationsOrThrow(curriculum, authoritativePlan.items);
        const unplannable = resolveStudyPlanPlannability(curriculum, authoritativePlan.items);
        if (unplannable.length > 0) {
          throw new AppError(
            ApiErrorCode.ValidationError,
            'This StudyPlan contains a teaching item whose persisted system estimate cannot be planned as a Lesson at its current depth. Generate a corrected proposal before acceptance.',
            {
              reason: 'lesson_plannability_infeasible',
              recommendationRequired: true,
              items: unplannable.map((entry) => ({
                planItemId: entry.plannability.planItemId,
                planningCode: entry.plannability.planningCode,
                targetDepth: entry.plannability.targetDepth,
                estimatedMinutes: entry.plannability.estimatedMinutes,
                remedies: entry.plannability.remedies,
                details: entry.details,
              })),
              plannability: unplannable.map((entry) => entry.plannability),
              warnings: unplannable.map((entry) => plannabilityWarningText(entry.plannability)),
            },
          );
        }

        const predecessor = before.acceptedPlanId
          ? (repos.studyPlans.get(before.acceptedPlanId) ?? null)
          : null;
        carryCompatiblePlanProgress(
          repos,
          predecessor,
          authoritativePlan,
          clock.now().toISOString(),
        );
        for (const deferral of authoritativePlan.deferrals) {
          for (const riskId of deferral.riskIds) {
            const risk = repos.coverageRisks.get(riskId);
            if (risk?.facets.includes('planning_recommendation')) {
              repos.coverageRisks.acceptDeferral(
                riskId,
                parsed.command.commandId,
                clock.now().toISOString(),
                {
                  id: newId('risk_evt'),
                  eventType: 'learner_accepted_deferral',
                  actor: 'learner',
                  payload: { studyPlanId: authoritativePlan.id },
                  createdAt: clock.now().toISOString(),
                },
              );
            }
          }
        }
        const draftAgenda = agendas.composeDraft(contract, curriculum, authoritativePlan);
        const storedAgenda = repos.sessionAgendas.create(draftAgenda, {
          id: newId('agenda_evt'),
          eventType: 'composed_for_route_activation',
          actor: 'local',
          payload: { studyPlanId: authoritativePlan.id },
          createdAt: draftAgenda.createdAt,
        });
        repos.courseExecution.activateRoute({
          workspaceId: parsed.command.workspaceId,
          contractId: contract.id,
          curriculumId: curriculum.id,
          planId: authoritativePlan.id,
          agendaId: storedAgenda.id,
          expectedStateVersion: before.version,
          expectedActiveContractId: before.activeContractId,
          expectedActiveCurriculumId: before.activeCurriculumId,
          expectedAcceptedPlanId: before.acceptedPlanId,
          expectedActiveAgendaId: before.activeAgendaId,
          eventId: newId('course_evt'),
          actor: 'learner',
          acceptedAt: clock.now().toISOString(),
        });
        const replanTrigger = repos.formalProgression.findReplanTriggerByProposedPlan(
          authoritativePlan.id,
        );
        if (replanTrigger) {
          repos.formalProgression.updateReplanTrigger({
            ...replanTrigger,
            status: 'resolved',
            updatedAt: clock.now().toISOString(),
          });
        }
        const installed = readActiveRoute(repos, parsed.command.workspaceId);
        if (!installed) throw new Error('Accepted Course route was not installed.');
        return StudyPlanDecisionResponseSchema.parse({
          decision: 'accepted',
          decidedPlan: installed.studyPlan,
          activeRoute: installed,
          retainedRoute: null,
        });
      });
      return StudyPlanDecisionResponseSchema.parse(response);
    } catch (error) {
      commands.fail(claim, error);
      throw error;
    }
  }

  return { activeRoute, decideStudyPlan };
}

export type CourseExecutionService = ReturnType<typeof createCourseExecutionService>;
