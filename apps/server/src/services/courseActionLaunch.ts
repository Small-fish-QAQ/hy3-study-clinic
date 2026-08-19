import {
  ApiErrorCode,
  CourseActionLaunchResultSchema,
  CreateAssessmentRequestSchema,
  LaunchCourseActionRequestSchema,
  type CourseActionLaunchResult,
  type LaunchCourseActionRequest,
  type SessionAgendaItem,
  type StudyPlan,
  type StudyPlanItem,
  type StudyPlanItemKind,
} from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import type { LlmProvider, ProviderCallOptions } from '../llm/provider.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import type { AssessmentService } from './assessment.js';
import {
  enforceAgentCostPolicies,
  runTrackedAgentProviderOperation,
} from './agentProviderRuntime.js';
import type { CourseCommandService } from './courseCommands.js';
import type { FormalProgressionService } from './formalProgression.js';
import type { FormalAssessmentsService } from './formalAssessments.js';
import { toPublicQuiz } from './quizzes.js';
import { resolveLaunchForPlanItem } from './studyPlanValidation.js';

interface CourseActionLaunchDeps {
  repos: Repositories;
  clock: Clock;
  commands: CourseCommandService;
  assessment: AssessmentService;
  formalProgression: FormalProgressionService;
  provider: LlmProvider;
  providerModel?: string | null;
  formalAssessments: FormalAssessmentsService;
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

export function createCourseActionLaunchService({
  repos,
  clock,
  commands,
  assessment,
  formalProgression,
  provider,
  providerModel = null,
  formalAssessments,
}: CourseActionLaunchDeps) {
  async function launch(
    input: LaunchCourseActionRequest,
    opts?: ProviderCallOptions,
  ): Promise<CourseActionLaunchResult> {
    const parsed = LaunchCourseActionRequestSchema.parse(input);
    const claim = commands.begin(parsed.command, 'launch_course_action', {
      agendaId: parsed.agendaId,
      expectedAgendaVersion: parsed.expectedAgendaVersion,
      agendaItemId: parsed.agendaItemId,
      expectedContractId: parsed.expectedContractId,
      expectedStudyPlanId: parsed.expectedStudyPlanId,
      expectedExecutionSourceManifestFingerprint: parsed.expectedExecutionSourceManifestFingerprint,
      studySessionId: parsed.studySessionId ?? null,
      confirmedCostPolicyIds: parsed.confirmedCostPolicyIds ?? [],
    });
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
      const curriculum = state.activeCurriculumId
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
          assessmentKind === 'formal_checkpoint' || assessmentKind === 'targeted_repair';
        const assessmentRequest = { ...request, ...(formalOnly ? { formalOnly: true } : {}) };
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
          schemaFingerprint: 'formal-assessment-proposal-v1',
          policyFingerprint,
          sourceFingerprint: parsed.expectedExecutionSourceManifestFingerprint,
          providerOptions: opts,
          invoke: (options) =>
            assessment.prepare(parsed.command.workspaceId, assessmentRequest, options),
        });
        const response = CourseActionLaunchResultSchema.parse({
          kind: 'assessment',
          agendaItemId: item.id,
          quiz: toPublicQuiz(creation.quiz),
          assessmentKind,
          formalAssessmentVersionId: null,
        });
        return commands.complete(claim, () => {
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
          assessment.persist(creation);
          let formalAssessmentVersionId: string | null = null;
          if (assessmentKind === 'formal_checkpoint' || assessmentKind === 'targeted_repair') {
            const targetLearningUnitId = item.learningUnitId;
            const targetObjectiveId = currentPlanItem.objectiveIds[0];
            if (targetLearningUnitId && targetObjectiveId) {
              const formalVersion = formalAssessments.createAcceptedFromQuiz({
                workspaceId: parsed.command.workspaceId,
                quiz: creation.quiz,
                logicalKey: `agenda:${currentAgenda.id}:${currentItem.id}`,
                title: currentPlanItem.rationale || '理解检查',
                targetLearningUnitId,
                targetObjectiveId,
              });
              formalAssessmentVersionId = formalVersion.id;
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
          });
          return { ...response, formalAssessmentVersionId };
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
      commands.fail(claim, error);
      throw error;
    }
  }

  return { launch };
}

export type CourseActionLaunchService = ReturnType<typeof createCourseActionLaunchService>;
