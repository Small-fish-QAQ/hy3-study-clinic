import {
  ActiveCourseRouteSchema,
  ApiErrorCode,
  DecideStudyPlanRequestSchema,
  StudyPlanDecisionResponseSchema,
  type ActiveCourseRoute,
  type DecideStudyPlanRequest,
  type StudyPlan,
  type StudyPlanDecisionResponse,
} from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import type { CourseCommandService } from './courseCommands.js';
import type { SessionAgendaAgentService } from './sessionAgendasAgent.js';

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
          const rejected = repos.studyPlans.reject(plan.id, {
            id: newId('plan_evt'),
            eventType: 'learner_rejected',
            actor: 'learner',
            payload: { reason: parsed.reason },
            createdAt: clock.now().toISOString(),
          });
          return StudyPlanDecisionResponseSchema.parse({
            decision: 'rejected',
            decidedPlan: rejected,
            activeRoute: null,
            retainedRoute: readActiveRoute(repos, parsed.command.workspaceId),
          });
        });
        return StudyPlanDecisionResponseSchema.parse(response);
      }

      const contract = repos.learningContracts.get(plan.contractVersionId);
      const curriculum = repos.curricula.get(plan.curriculumVersionId);
      if (!contract || !curriculum) {
        throw new AppError(ApiErrorCode.VersionConflict, 'StudyPlan route is incomplete.');
      }
      if (
        (contract.status !== 'learner_confirmed' && contract.status !== 'active') ||
        curriculum.status !== 'accepted' ||
        curriculum.contractVersionId !== contract.id ||
        curriculum.executionSourceManifest.fingerprint !== plan.executionSourceManifestFingerprint
      ) {
        throw new AppError(
          ApiErrorCode.VersionConflict,
          'StudyPlan route is stale or incompatible.',
        );
      }
      const response = commands.complete(claim, () => {
        const draftAgenda = agendas.composeDraft(contract, curriculum, plan);
        const storedAgenda = repos.sessionAgendas.create(draftAgenda, {
          id: newId('agenda_evt'),
          eventType: 'composed_for_route_activation',
          actor: 'local',
          payload: { studyPlanId: plan.id },
          createdAt: draftAgenda.createdAt,
        });
        repos.courseExecution.activateRoute({
          workspaceId: parsed.command.workspaceId,
          contractId: contract.id,
          curriculumId: curriculum.id,
          planId: plan.id,
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
