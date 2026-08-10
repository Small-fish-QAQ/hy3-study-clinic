import {
  ApiErrorCode,
  CourseActionLaunchResultSchema,
  CreateAssessmentRequestSchema,
  LaunchCourseActionRequestSchema,
  type CourseActionLaunchResult,
  type LaunchCourseActionRequest,
} from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import type { ProviderCallOptions } from '../llm/provider.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import type { AssessmentService } from './assessment.js';
import type { CourseCommandService } from './courseCommands.js';
import { toPublicQuiz } from './quizzes.js';
import { resolveLaunchForPlanItem } from './studyPlanValidation.js';

interface CourseActionLaunchDeps {
  repos: Repositories;
  clock: Clock;
  commands: CourseCommandService;
  assessment: AssessmentService;
}

export function createCourseActionLaunchService({
  repos,
  clock,
  commands,
  assessment,
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
      const item = agenda.items.find((candidate) => candidate.id === parsed.agendaItemId);
      if (!item) throw notFound('SessionAgenda item not found.');
      const plan = repos.studyPlans.get(parsed.expectedStudyPlanId);
      const curriculum = state.activeCurriculumId
        ? repos.curricula.get(state.activeCurriculumId)
        : undefined;
      const planItem = item.linkedPlanItemId
        ? plan?.items.find((candidate) => candidate.id === item.linkedPlanItemId)
        : undefined;
      if (!plan || !curriculum || !planItem) {
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
      const currentLaunch = resolveLaunchForPlanItem(
        repos,
        clock,
        parsed.command.workspaceId,
        curriculum,
        planItem,
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
        const resource = JSON.parse(currentLaunch.resourceId ?? '{}') as { conceptId?: unknown };
        if (typeof resource.conceptId !== 'string') {
          throw new AppError(ApiErrorCode.ValidationError, 'Lesson launch resource is invalid.');
        }
        const lesson = repos.lessons.getByConcept(resource.conceptId);
        if (!item.learningUnitId) {
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
        const response = CourseActionLaunchResultSchema.parse({
          kind: 'lesson',
          agendaItemId: item.id,
          learningUnitId: item.learningUnitId,
          conceptId: resource.conceptId,
          lessonId: lesson?.id ?? null,
        });
        return commands.complete(claim, () => response);
      }

      if (currentLaunch.capability === 'assessment') {
        const request = CreateAssessmentRequestSchema.parse(
          JSON.parse(currentLaunch.resourceId ?? '{}') as unknown,
        );
        const creation = await assessment.create(parsed.command.workspaceId, request, opts);
        const assessmentKind =
          item.kind === 'due_review'
            ? 'due_review'
            : item.kind === 'targeted_repair'
              ? 'targeted_repair'
              : 'formal_checkpoint';
        const response = CourseActionLaunchResultSchema.parse({
          kind: 'assessment',
          agendaItemId: item.id,
          quiz: toPublicQuiz(creation.quiz),
          assessmentKind,
        });
        return commands.complete(claim, () => response);
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
