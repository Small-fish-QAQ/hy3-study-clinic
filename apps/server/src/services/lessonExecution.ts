import {
  ApiErrorCode,
  EnsureLessonExecutionRequestSchema,
  LessonExecutionCommandRequestSchema,
  LessonExecutionProjectionSchema,
  LessonTutorContextSchema,
  type LessonExecutionProjection,
  type LessonExecutionState,
  type LearnerPracticeProjection,
  type LessonSegmentProjection,
  type LessonSourceProjection,
  type LessonTutorContext,
  type StudySession,
  type TeachingBrief,
} from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import { ProviderError } from '../llm/errors.js';
import type { ProviderCallOptions } from '../llm/provider.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import type { AgendaWindowRolloverService } from './agendaWindowRollover.js';
import type { CourseCommandService } from './courseCommands.js';
import {
  COMPOSITIONAL_PREPARATION_LEASE_MS,
  type AcceptedLessonPreview,
  type TeachingBriefPreparationService,
} from './teachingBriefPreparation.js';

interface LessonExecutionDeps {
  repos: Repositories;
  clock: Clock;
  commands: CourseCommandService;
  teachingBriefPreparation: Pick<
    TeachingBriefPreparationService,
    'prepare' | 'getCurrent' | 'getAcceptedLessonPreview'
  >;
  agendaWindow: AgendaWindowRolloverService;
}

interface RouteContext {
  session: StudySession;
  agenda: NonNullable<ReturnType<Repositories['sessionAgendas']['get']>>;
  item: NonNullable<ReturnType<Repositories['sessionAgendas']['get']>>['items'][number];
  curriculum: NonNullable<ReturnType<Repositories['curricula']['get']>>;
  plan: NonNullable<ReturnType<Repositories['studyPlans']['get']>>;
  planItem: NonNullable<ReturnType<Repositories['studyPlans']['get']>>['items'][number];
  courseTitle: string;
}

// The outer command owns the complete child composition. Keeping two full
// child lease windows prevents a later-claimed Teaching Brief operation from
// remaining live after the outer command is eligible for recovery.
const LESSON_EXECUTION_PREPARATION_LEASE_MS = COMPOSITIONAL_PREPARATION_LEASE_MS * 2;

function sourceProjection(
  brief: Pick<TeachingBrief, 'sourceReferences'>,
  repos: Repositories,
): LessonSourceProjection[] {
  return brief.sourceReferences.map((reference) => {
    const material = repos.materials.get(reference.materialId);
    return {
      referenceKey: reference.refId,
      materialTitle: material?.title ?? 'Course source',
      headingPath: reference.headingPath,
      pageNumber: reference.pageNumber,
      slideNumber: reference.slideNumber,
      locationLabel: reference.pageNumber
        ? `Page ${reference.pageNumber}`
        : reference.slideNumber
          ? `Slide ${reference.slideNumber}`
          : reference.headingPath.join(' › ') || 'Source excerpt',
      exactExcerpt: reference.quote,
      classification: 'exact_source_excerpt' as const,
    };
  });
}

function authority(
  value: 'source_backed_teaching' | 'ai_teaching_synthesis',
): 'source_grounded' | 'hy3_synthesis' {
  return value === 'source_backed_teaching' ? 'source_grounded' : 'hy3_synthesis';
}

function purpose(
  value: TeachingBrief['segments'][number]['purpose'],
): LessonSegmentProjection['purpose'] {
  if (value === 'contrast') return 'comparison';
  if (value === 'misconception') return 'common_pitfall';
  if (value === 'objective_orientation') return 'orientation';
  return value;
}

function informalKind(
  value: 'own_words' | 'predict_next' | 'choose_alternative' | 'apply_simple_example',
): 'explain_in_your_words' | 'predict' | 'choose' | 'apply' {
  switch (value) {
    case 'own_words':
      return 'explain_in_your_words';
    case 'predict_next':
      return 'predict';
    case 'choose_alternative':
      return 'choose';
    default:
      return 'apply';
  }
}

export function createLessonExecutionService({
  repos,
  clock,
  commands,
  teachingBriefPreparation,
  agendaWindow,
}: LessonExecutionDeps) {
  function preparationRouteInput(context: RouteContext) {
    return {
      workspaceId: context.session.workspaceId,
      curriculumVersionId: context.session.curriculumVersionId,
      studyPlanVersionId: context.session.studyPlanVersionId,
      learningUnitId: context.item.learningUnitId!,
      studySessionId: context.session.id,
      sessionAgendaId: context.agenda.id,
      expectedSessionVersion: context.session.version,
      expectedAgendaVersion: context.agenda.version,
      expectedAgendaItemId: context.item.id,
      expectedStudyPlanItemId: context.planItem.id,
      expectedExecutionSourceManifestFingerprint:
        context.session.executionSourceManifestFingerprint,
    };
  }

  function requireSession(workspaceId: string, sessionId: string): StudySession {
    if (!repos.workspaces.get(workspaceId)) throw notFound('Course not found.');
    const session = repos.studySessions.get(sessionId);
    if (!session || session.workspaceId !== workspaceId) throw notFound('StudySession not found.');
    return session;
  }

  function route(workspaceId: string, sessionId: string, allowPaused = true): RouteContext {
    const session = requireSession(workspaceId, sessionId);
    const execution = repos.courseExecution.get(workspaceId);
    if (
      execution.routeValidationStatus !== 'valid' ||
      execution.activeContractId !== session.contractVersionId ||
      execution.activeCurriculumId !== session.curriculumVersionId ||
      execution.acceptedPlanId !== session.studyPlanVersionId ||
      execution.activeAgendaId !== session.sessionAgendaId ||
      (execution.executionStatus !== 'active' &&
        !(allowPaused && execution.executionStatus === 'paused'))
    ) {
      throw new AppError(ApiErrorCode.VersionConflict, 'StudySession route is stale.');
    }
    const agenda = repos.sessionAgendas.get(session.sessionAgendaId);
    const curriculum = repos.curricula.get(session.curriculumVersionId);
    const plan = repos.studyPlans.get(session.studyPlanVersionId);
    const item = session.currentAgendaItemId
      ? agenda?.items.find((candidate) => candidate.id === session.currentAgendaItemId)
      : undefined;
    if (!agenda || !curriculum || !plan || !item) {
      throw new AppError(ApiErrorCode.VersionConflict, 'StudySession Agenda route is unavailable.');
    }
    const planItem = item.linkedPlanItemId
      ? plan.items.find((candidate) => candidate.id === item.linkedPlanItemId)
      : undefined;
    if (item.kind !== 'learning_unit_teaching' || !item.learningUnitId || !planItem) {
      return {
        session,
        agenda,
        item,
        curriculum,
        plan,
        planItem: (planItem ?? plan.items[0])!,
        courseTitle: repos.workspaces.get(workspaceId)?.name ?? 'Course',
      };
    }
    return {
      session,
      agenda,
      item,
      curriculum,
      plan,
      planItem,
      courseTitle: repos.workspaces.get(workspaceId)?.name ?? 'Course',
    };
  }

  function teachingRouteMatches(context: RouteContext): boolean {
    return (
      context.item.kind === 'learning_unit_teaching' &&
      context.item.launch.status === 'launchable' &&
      context.item.launch.capability === 'lesson' &&
      context.item.learningUnitId !== null &&
      context.planItem.kind === 'teach_unit' &&
      context.planItem.curriculumLearningUnitId === context.item.learningUnitId &&
      context.curriculum.nodes.some(
        (node) =>
          node.id === context.item.learningUnitId &&
          node.kind === 'learning_unit' &&
          node.learningUnit,
      )
    );
  }

  function executable(context: RouteContext): boolean {
    return (
      teachingRouteMatches(context) &&
      (context.item.state === 'queued' || context.item.state === 'active')
    );
  }

  /**
   * A teaching item whose execution already completed. The learner keeps the
   * finished Lesson to review, and preparation short-circuits on the existing
   * Brief instead of regenerating one. Actions remain gated by `executable`.
   */
  function reviewable(context: RouteContext): boolean {
    return teachingRouteMatches(context) && context.item.state === 'completed';
  }

  function currentBrief(context: RouteContext): TeachingBrief | null {
    if (!executable(context) && !reviewable(context)) return null;
    const state = stateFor(context);
    if (state?.preparationStatus !== 'ready' || !state.teachingBriefId) return null;
    const brief = repos.teachingBriefs.get(state.teachingBriefId);
    if (
      !brief ||
      state.sessionId !== context.session.id ||
      state.agendaItemId !== context.item.id ||
      state.curriculumVersionId !== context.curriculum.id ||
      state.studyPlanVersionId !== context.plan.id ||
      state.learningUnitId !== context.item.learningUnitId ||
      state.executionSourceManifestFingerprint !==
        context.session.executionSourceManifestFingerprint ||
      state.sourceContextFingerprint !== brief.sourceContextFingerprint ||
      brief.workspaceId !== context.session.workspaceId ||
      brief.curriculumVersionId !== context.curriculum.id ||
      brief.studyPlanVersionId !== context.plan.id ||
      brief.learningUnitId !== context.item.learningUnitId ||
      brief.executionSourceManifestFingerprint !==
        context.session.executionSourceManifestFingerprint
    ) {
      return null;
    }
    if (brief.composition) {
      const checkpoint = repos.acceptedLessonCheckpoints.get(
        brief.composition.acceptedLessonCheckpointId,
      );
      if (
        !checkpoint ||
        checkpoint.studySessionId !== context.session.id ||
        checkpoint.sessionAgendaId !== context.agenda.id ||
        checkpoint.agendaItemId !== context.item.id ||
        checkpoint.studyPlanItemId !== context.planItem.id ||
        checkpoint.learningUnitId !== context.item.learningUnitId ||
        checkpoint.executionSourceManifestFingerprint !==
          context.session.executionSourceManifestFingerprint ||
        checkpoint.sourceContextFingerprint !== brief.sourceContextFingerprint
      ) {
        return null;
      }
    }
    return brief;
  }

  function currentAcceptedLesson(context: RouteContext): AcceptedLessonPreview | null {
    if (!executable(context)) return null;
    return teachingBriefPreparation.getAcceptedLessonPreview(preparationRouteInput(context));
  }

  function preparationOperationFailed(state: LessonExecutionState | undefined): boolean {
    if (state?.preparationStatus !== 'preparing' || !state.preparationOperationId) return false;
    const status = repos.operations.get(state.preparationOperationId)?.status;
    return status === 'failed' || status === 'interrupted' || status === 'cancelled';
  }

  function projection(
    context: RouteContext,
    state: LessonExecutionState | undefined,
    brief: TeachingBrief | null,
    acceptedLesson: AcceptedLessonPreview | null = null,
  ): LessonExecutionProjection {
    if (!executable(context) && !reviewable(context)) {
      return LessonExecutionProjectionSchema.parse({
        status: 'lesson_unavailable',
        message: 'The current Agenda item is not executable teaching work.',
        course: { title: context.courseTitle },
        session: { status: context.session.status, version: context.session.version },
        agenda: { version: context.agenda.version, itemState: context.item.state },
        lesson: null,
        progress: null,
        currentInformalCheck: null,
        allowedActions: [],
      });
    }
    if (state?.preparationStatus === 'preparing' && preparationOperationFailed(state)) {
      return LessonExecutionProjectionSchema.parse({
        status: 'lesson_unavailable',
        message:
          '当前课程路线的来源绑定无法安全准备本节讲解。已有学习记录保持不变，请回到课程主页重新准备当前课程路线。',
        course: { title: context.courseTitle },
        session: { status: context.session.status, version: context.session.version },
        agenda: { version: context.agenda.version, itemState: context.item.state },
        lesson: null,
        progress: null,
        currentInformalCheck: null,
        allowedActions: [],
      });
    }
    if (state?.preparationStatus === 'preparing') {
      return LessonExecutionProjectionSchema.parse({
        status: 'preparing',
        message: 'Your lesson is being prepared.',
        course: { title: context.courseTitle },
        session: { status: context.session.status, version: context.session.version },
        agenda: { version: context.agenda.version, itemState: context.item.state },
        lesson: null,
        progress: null,
        currentInformalCheck: null,
        allowedActions: ['wait_for_preparation'],
      });
    }
    if (
      state?.preparationStatus === 'retryable_failure' &&
      state.acceptedLessonCheckpointId &&
      acceptedLesson?.checkpointId === state.acceptedLessonCheckpointId
    ) {
      return LessonExecutionProjectionSchema.parse({
        status: 'practice_retry_available',
        message:
          'The accepted Lesson is preserved. Retry preparation to generate only its informal Practice.',
        course: { title: context.courseTitle },
        session: { status: context.session.status, version: context.session.version },
        agenda: { version: context.agenda.version, itemState: context.item.state },
        lesson: projectLesson(acceptedLesson, state),
        progress: {
          stateVersion: state.version,
          currentSegmentIndex: 0,
          segmentCount: acceptedLesson.segments.length,
          presentedSegmentIndexes: [],
          presentationStatus: 'not_started',
          presentationCompletedAt: null,
        },
        currentInformalCheck: null,
        practice: null,
        allowedActions: ['retry_preparation'],
      });
    }
    if (!brief || !state || state.preparationStatus !== 'ready') {
      const retry = state?.preparationStatus === 'retryable_failure';
      return LessonExecutionProjectionSchema.parse({
        status: retry ? 'retry_available' : 'preparation_needed',
        message: retry ? 'Lesson preparation can be retried.' : 'Prepare this lesson to begin.',
        course: { title: context.courseTitle },
        session: { status: context.session.status, version: context.session.version },
        agenda: { version: context.agenda.version, itemState: context.item.state },
        lesson: null,
        progress: null,
        currentInformalCheck: null,
        allowedActions: [retry ? 'retry_preparation' : 'prepare_lesson'],
      });
    }
    const lesson = projectLesson(brief, state)!;
    const presentationCompleted = Boolean(state.presentationCompletedAt);
    const completed = Boolean(state.practiceCompletedAt);
    const presentationStatus = completed
      ? 'presentation_completed'
      : presentationCompleted
        ? 'presentation_completed'
        : state.presentedSegmentIndexes.length === 0
          ? 'not_started'
          : state.presentedSegmentIndexes.length === brief.segments.length
            ? 'summary_ready'
            : 'in_progress';
    const current = lesson.segments[state.currentSegmentIndex];
    const interaction = state.informalInteractions.find(
      (entry) => entry.segmentIndex === state.currentSegmentIndex,
    );
    const informal = current?.informalCheck
      ? {
          ...current.informalCheck,
          guidance: interaction?.response ? current.informalCheck.guidance : null,
          presented: Boolean(interaction),
          response: interaction?.response ?? null,
          respondedAt: interaction?.respondedAt ?? null,
        }
      : null;
    const practice = projectPractice(brief, state);
    const allowed =
      context.session.status === 'paused'
        ? (['resume_study_session'] as const)
        : completed
          ? (['review_lesson'] as const)
          : presentationCompleted
            ? (['submit_practice_response'] as const)
            : state.presentedSegmentIndexes.length === 0
              ? (['start_lesson'] as const)
              : [
                  ...(current?.informalCheck && !interaction?.response
                    ? (['respond_to_informal_check'] as const)
                    : []),
                  ...(state.currentSegmentIndex < brief.segments.length - 1 &&
                  (!current?.informalCheck || Boolean(interaction?.response))
                    ? (['move_to_next_segment'] as const)
                    : []),
                  ...(state.currentSegmentIndex > 0 ? (['revisit_segment'] as const) : []),
                  ...(state.presentedSegmentIndexes.length === brief.segments.length &&
                  (!current?.informalCheck || Boolean(interaction?.response))
                    ? (['complete_presentation'] as const)
                    : []),
                ];
    return LessonExecutionProjectionSchema.parse({
      status: 'ready',
      message: completed
        ? 'Lesson and informal Practice complete. Formal credit remains a separate action.'
        : presentationCompleted
          ? 'Lesson presentation complete. Continue with informal Practice.'
          : 'Lesson is ready.',
      course: { title: context.courseTitle },
      session: { status: context.session.status, version: context.session.version },
      agenda: { version: context.agenda.version, itemState: context.item.state },
      lesson,
      progress: {
        stateVersion: state.version,
        currentSegmentIndex: state.currentSegmentIndex,
        segmentCount: brief.segments.length,
        presentedSegmentIndexes: state.presentedSegmentIndexes,
        presentationStatus,
        presentationCompletedAt: state.presentationCompletedAt,
      },
      currentInformalCheck: informal,
      practice,
      allowedActions: [...allowed],
    });
  }

  function projectLesson(
    brief: TeachingBrief | AcceptedLessonPreview,
    state: LessonExecutionState,
  ): LessonExecutionProjection['lesson'] {
    const sources = sourceProjection(brief, repos);
    const byRef = new Map(sources.map((source) => [source.referenceKey, source]));
    const refs = (ids: string[]) =>
      ids
        .map((id) => byRef.get(id))
        .filter((source): source is LessonSourceProjection => Boolean(source));
    const segments = brief.segments.map((segment) => ({
      index: segment.index,
      purpose: purpose(segment.purpose),
      explanation: segment.explanation,
      explanationOrigin: authority(segment.explanationAuthority),
      sources: refs(segment.sourceRefIds),
      ...(segment.semanticRelations
        ? {
            semanticRelations: segment.semanticRelations.map(
              ({ kind, fromProposition, toProposition, relevanceToObjective }) => ({
                kind,
                fromProposition,
                toProposition,
                relevanceToObjective,
              }),
            ),
          }
        : {}),
      ...(segment.workedProcess !== undefined
        ? {
            workedProcess: segment.workedProcess
              ? {
                  startingState: segment.workedProcess.startingState,
                  ruleOrProcedure: segment.workedProcess.ruleOrProcedure,
                  steps: segment.workedProcess.steps,
                  learnerDecision: segment.workedProcess.learnerDecision,
                  result: segment.workedProcess.result,
                  whyResultFollows: segment.workedProcess.whyResultFollows,
                }
              : null,
          }
        : {}),
      example: segment.example
        ? {
            text: segment.example.text,
            origin: authority(segment.example.authority),
            sources: refs(segment.example.sourceRefIds),
          }
        : null,
      contrast: segment.contrast
        ? {
            text: segment.contrast.text,
            origin: authority(segment.contrast.authority),
            sources: refs(segment.contrast.sourceRefIds),
          }
        : null,
      possibleMisconception: segment.misconception
        ? {
            hypothesis: segment.misconception.hypothesis,
            correction: segment.misconception.correction,
            advisoryOnly: true as const,
            sources: refs(segment.misconception.sourceRefIds),
          }
        : null,
      informalCheck: segment.informalCheck
        ? {
            kind: informalKind(segment.informalCheck.kind),
            prompt: segment.informalCheck.prompt,
            guidance: state.informalInteractions.find(
              (entry) => entry.segmentIndex === segment.index,
            )?.response
              ? segment.informalCheck.expectedSignal
              : null,
            presented: state.informalInteractions.some(
              (entry) => entry.segmentIndex === segment.index,
            ),
            response:
              state.informalInteractions.find((entry) => entry.segmentIndex === segment.index)
                ?.response ?? null,
            respondedAt:
              state.informalInteractions.find((entry) => entry.segmentIndex === segment.index)
                ?.respondedAt ?? null,
            credit: 'none' as const,
          }
        : null,
    }));
    return {
      objective: {
        title: brief.objective.title,
        whyNow: brief.objective.whyNow,
        outcomes: brief.objective.objectives.map(({ title, description }) => ({
          title,
          description,
        })),
      },
      prerequisites: brief.prerequisites.map(({ title, reason, readinessHint }) => ({
        title,
        reason,
        readinessHint,
      })),
      segments,
      sourceReferencesAvailable: sources.length > 0,
      visuals: brief.visualReferences.map((reference) => reference.context),
      summary: {
        available: true,
        text: brief.summary,
        nextConnection: brief.nextConnection,
        formalOpportunities: brief.formalOpportunities,
      },
      ...(brief.pedagogyEvaluation
        ? {
            plannedTime: {
              agendaMinutes: brief.pedagogyEvaluation.claimedAgendaMinutes,
              activeMinutesMin: brief.pedagogyEvaluation.estimatedActiveMinutes.min,
              activeMinutesMax: brief.pedagogyEvaluation.estimatedActiveMinutes.max,
              basis: 'locally_evaluated_learning_actions' as const,
            },
          }
        : {}),
    };
  }

  function projectPractice(
    brief: TeachingBrief,
    state: LessonExecutionState,
  ): LearnerPracticeProjection | null {
    if (!brief.practice) return null;
    const completedItem = (itemIndex: number) => {
      const attempts = state.practiceInteractions.filter(
        (attempt) => attempt.itemIndex === itemIndex,
      );
      return attempts.some((attempt) => attempt.correct) || attempts.length >= 2;
    };
    const unresolvedIndex = brief.practice.items.findIndex((_, index) => !completedItem(index));
    const currentItemIndex =
      unresolvedIndex === -1 ? brief.practice.items.length - 1 : unresolvedIndex;
    const item = brief.practice.items[currentItemIndex]!;
    const itemAttempts = state.practiceInteractions.filter(
      (attempt) => attempt.itemIndex === currentItemIndex,
    );
    const surfaceName =
      itemAttempts.length === 1 && !itemAttempts[0]!.correct ? 'retry' : 'initial';
    const surface = item[surfaceName];
    const status = state.practiceCompletedAt
      ? 'completed'
      : !state.presentationCompletedAt
        ? 'locked'
        : state.practiceInteractions.length === 0
          ? 'available'
          : 'in_progress';
    return {
      status,
      currentItemIndex,
      itemCount: brief.practice.items.length,
      item: state.practiceCompletedAt
        ? null
        : {
            index: currentItemIndex,
            objectiveTitle: item.objectiveTitle,
            construct: item.construct,
            capabilityTested: item.capabilityTested,
            pedagogicalReason: item.pedagogicalReason,
            surface: surfaceName,
            prompt: surface.prompt,
            options: surface.options.map(({ id, text }) => ({ id, text })),
          },
      attempts: state.practiceInteractions,
      completedAt: state.practiceCompletedAt,
      credit: 'none',
    };
  }

  function stateFor(context: RouteContext): LessonExecutionState | undefined {
    return repos.lessonExecution.getForSession(context.session.id, context.item.id);
  }

  function recoverStrandedPreparation(
    context: RouteContext,
    state: LessonExecutionState | undefined,
  ): void {
    if (state?.preparationStatus !== 'preparing' || !state.preparationOperationId) return;
    const now = clock.now().toISOString();
    let operation = repos.operations.get(state.preparationOperationId);
    if (
      operation?.status === 'running' &&
      operation.leaseExpiresAt !== null &&
      operation.leaseExpiresAt <= now
    ) {
      repos.operations.recoverExpiredForWorkspace(
        context.session.workspaceId,
        'prepare_lesson_execution',
        now,
      );
      operation = repos.operations.get(state.preparationOperationId);
    }
    if (
      !operation ||
      (operation.status !== 'failed' &&
        operation.status !== 'interrupted' &&
        operation.status !== 'cancelled')
    ) {
      return;
    }
    const strandedOperation = operation;

    let acceptedLesson: AcceptedLessonPreview | null;
    try {
      acceptedLesson = currentAcceptedLesson(context);
    } catch {
      // A changed source/plan binding remains fail-closed. In that case the
      // existing failed-operation projection explains that Course preparation
      // must be repaired instead of offering an unsafe Lesson retry.
      return;
    }

    repos.transaction(() => {
      const latest = repos.lessonExecution.getForSession(context.session.id, context.item.id);
      if (
        latest?.preparationStatus !== 'preparing' ||
        latest.preparationOperationId !== strandedOperation.id
      ) {
        return;
      }
      const next = repos.lessonExecution.update(
        {
          ...latest,
          acceptedLessonCheckpointId:
            acceptedLesson?.checkpointId ?? latest.acceptedLessonCheckpointId,
          preparationStatus: 'retryable_failure',
          preparationOperationId: null,
          version: latest.version + 1,
          updatedAt: now,
        },
        latest.version,
      );
      repos.lessonExecution.appendEvent({
        id: newId('lesson_event'),
        lessonExecutionStateId: next.id,
        seq: repos.lessonExecution.listEvents(next.id).length + 1,
        commandId: strandedOperation.commandId,
        kind: 'preparation_failed',
        payload: {
          retryable: true,
          recovered: true,
          recoveryReason: strandedOperation.status,
          acceptedLessonPreserved: Boolean(next.acceptedLessonCheckpointId),
        },
        createdAt: now,
      });
    });
  }

  function get(workspaceId: string, sessionId: string): LessonExecutionProjection {
    const context = route(workspaceId, sessionId);
    recoverStrandedPreparation(context, stateFor(context));
    const state = stateFor(context);
    return projection(
      context,
      state,
      state?.preparationStatus === 'ready' ? currentBrief(context) : null,
      state?.acceptedLessonCheckpointId ? currentAcceptedLesson(context) : null,
    );
  }

  function assertExpected(
    context: RouteContext,
    expectedSessionVersion: number,
    expectedAgendaVersion: number,
    expectedAgendaItemId: string,
  ): void {
    if (
      context.session.version !== expectedSessionVersion ||
      context.agenda.version !== expectedAgendaVersion ||
      context.item.id !== expectedAgendaItemId
    ) {
      throw new AppError(ApiErrorCode.VersionConflict, 'Lesson execution request is stale.');
    }
  }

  function recoverRetryablePreparationFailure(
    workspaceId: string,
    sessionId: string,
    expected: {
      sessionVersion: number;
      agendaVersion: number;
      agendaItemId: string;
    },
    operationId: string,
    commandId: string,
    cancelled: boolean,
    recoverCurrentRoute = true,
  ): LessonExecutionProjection | null {
    let context: RouteContext | null = null;
    let acceptedLesson: AcceptedLessonPreview | null = null;
    let routeError: unknown;
    try {
      const current = route(workspaceId, sessionId, false);
      assertExpected(
        current,
        expected.sessionVersion,
        expected.agendaVersion,
        expected.agendaItemId,
      );
      context = current;
      try {
        acceptedLesson = currentAcceptedLesson(current);
      } catch {
        // Preview reconstruction is optional during failure cleanup. The
        // original preparation error remains authoritative if source or plan
        // validation now prevents reconstructing the accepted Lesson.
        acceptedLesson = null;
      }
    } catch (error) {
      routeError = error;
    }

    // A same-route source/version conflict remains fail-closed. A stale or
    // deleted route still needs the exact predecessor cleanup below.
    if (!routeError && !recoverCurrentRoute) return null;

    const recovered = repos.transaction(() => {
      const latest = repos.lessonExecution.getForSession(sessionId, expected.agendaItemId);
      if (!latest || latest.preparationOperationId !== operationId) return null;
      const now = clock.now().toISOString();
      const next = repos.lessonExecution.update(
        {
          ...latest,
          acceptedLessonCheckpointId:
            acceptedLesson?.checkpointId ?? latest.acceptedLessonCheckpointId,
          preparationStatus: 'retryable_failure',
          preparationOperationId: null,
          version: latest.version + 1,
          updatedAt: now,
        },
        latest.version,
      );
      repos.lessonExecution.appendEvent({
        id: newId('lesson_event'),
        lessonExecutionStateId: next.id,
        seq: repos.lessonExecution.listEvents(next.id).length + 1,
        commandId,
        kind: 'preparation_failed',
        payload: {
          retryable: true,
          ...(cancelled ? { cancelled: true } : {}),
          acceptedLessonPreserved: Boolean(next.acceptedLessonCheckpointId),
        },
        createdAt: now,
      });
      return next;
    });

    // The exact predecessor cleanup above is intentionally committed before a
    // stale or deleted live route is surfaced to the caller.
    if (routeError) throw routeError;
    if (!context || !recovered) {
      throw new AppError(
        ApiErrorCode.VersionConflict,
        'Lesson preparation failure recovery was superseded.',
      );
    }
    return projection(context, recovered, null, acceptedLesson);
  }

  async function ensure(
    workspaceId: string,
    sessionId: string,
    rawInput: unknown,
    options?: ProviderCallOptions,
  ): Promise<LessonExecutionProjection> {
    const input = EnsureLessonExecutionRequestSchema.parse(rawInput);
    if (input.command.workspaceId !== workspaceId) throw notFound('Course not found.');
    const initial = route(workspaceId, sessionId, false);
    assertExpected(
      initial,
      input.expectedSessionVersion,
      input.expectedAgendaVersion,
      input.expectedAgendaItemId,
    );
    const claim = commands.begin(
      input.command,
      'prepare_lesson_execution',
      {
        sessionId,
        expectedSessionVersion: input.expectedSessionVersion,
        expectedAgendaVersion: input.expectedAgendaVersion,
        agendaItemId: input.expectedAgendaItemId,
      },
      {
        leaseMs: LESSON_EXECUTION_PREPARATION_LEASE_MS,
        studySessionId: sessionId,
      },
    );
    if (claim.replayPayload) return LessonExecutionProjectionSchema.parse(claim.replayPayload);
    let claimedState: LessonExecutionState;
    try {
      claimedState = repos.transaction(() => {
        const context = route(workspaceId, sessionId, false);
        assertExpected(
          context,
          input.expectedSessionVersion,
          input.expectedAgendaVersion,
          input.expectedAgendaItemId,
        );
        const current = stateFor(context);
        const now = clock.now().toISOString();
        if (current?.preparationStatus === 'preparing') {
          const operation = current.preparationOperationId
            ? repos.operations.get(current.preparationOperationId)
            : null;
          if (
            operation?.status === 'running' &&
            operation.leaseExpiresAt &&
            operation.leaseExpiresAt > now
          ) {
            return current;
          }
        }
        if (current?.preparationStatus === 'ready' && currentBrief(context)) return current;
        const next = current
          ? repos.lessonExecution.update(
              {
                ...current,
                preparationStatus: 'preparing',
                preparationOperationId: claim.operationId,
                version: current.version + 1,
                updatedAt: now,
              },
              current.version,
            )
          : repos.lessonExecution.create({
              id: newId('lesson_execution'),
              sessionId,
              agendaItemId: context.item.id,
              curriculumVersionId: context.curriculum.id,
              studyPlanVersionId: context.plan.id,
              learningUnitId: context.item.learningUnitId!,
              teachingBriefId: null,
              acceptedLessonCheckpointId: null,
              executionSourceManifestFingerprint:
                context.session.executionSourceManifestFingerprint,
              sourceContextFingerprint: null,
              preparationStatus: 'preparing',
              preparationOperationId: claim.operationId,
              version: 1,
              currentSegmentIndex: 0,
              presentedSegmentIndexes: [],
              informalInteractions: [],
              presentationCompletedAt: null,
              practiceInteractions: [],
              practiceCompletedAt: null,
              createdAt: now,
              updatedAt: now,
            });
        repos.lessonExecution.appendEvent({
          id: newId('lesson_event'),
          lessonExecutionStateId: next.id,
          seq: repos.lessonExecution.listEvents(next.id).length + 1,
          commandId: input.command.commandId,
          kind: 'preparation_started',
          payload: {},
          createdAt: now,
        });
        return next;
      });
    } catch (error) {
      commands.fail(claim, error);
      throw error;
    }
    if (claimedState.preparationOperationId !== claim.operationId) {
      const context = route(workspaceId, sessionId);
      return commands.complete(claim, () => projection(context, claimedState, null));
    }
    try {
      const context = route(workspaceId, sessionId, false);
      commands.renew(claim, LESSON_EXECUTION_PREPARATION_LEASE_MS);
      const response = await teachingBriefPreparation.prepare(
        {
          ...preparationRouteInput(context),
          commandId: claim.operationId,
          confirmedCostPolicyIds: input.confirmedCostPolicyIds,
        },
        options,
      );
      commands.renew(claim, LESSON_EXECUTION_PREPARATION_LEASE_MS);
      const ready = repos.transaction(() => {
        const latestContext = route(workspaceId, sessionId, false);
        assertExpected(
          latestContext,
          input.expectedSessionVersion,
          input.expectedAgendaVersion,
          input.expectedAgendaItemId,
        );
        const latest = stateFor(latestContext);
        if (!latest || latest.preparationOperationId !== claim.operationId)
          throw new AppError(ApiErrorCode.VersionConflict, 'Lesson preparation was superseded.');
        const now = clock.now().toISOString();
        const next = repos.lessonExecution.update(
          {
            ...latest,
            teachingBriefId: response.brief.id,
            acceptedLessonCheckpointId:
              response.brief.composition?.acceptedLessonCheckpointId ?? null,
            sourceContextFingerprint: response.brief.sourceContextFingerprint,
            preparationStatus: 'ready',
            preparationOperationId: null,
            version: latest.version + 1,
            updatedAt: now,
          },
          latest.version,
        );
        repos.lessonExecution.appendEvent({
          id: newId('lesson_event'),
          lessonExecutionStateId: next.id,
          seq: repos.lessonExecution.listEvents(next.id).length + 1,
          commandId: input.command.commandId,
          kind: 'preparation_ready',
          payload: { reused: response.status === 'reused' },
          createdAt: now,
        });
        return next;
      });
      return commands.complete(claim, () =>
        projection(route(workspaceId, sessionId), ready, response.brief),
      );
    } catch (error) {
      if (error instanceof ProviderError && error.code === ApiErrorCode.RequestCancelled) {
        try {
          recoverRetryablePreparationFailure(
            workspaceId,
            sessionId,
            {
              sessionVersion: input.expectedSessionVersion,
              agendaVersion: input.expectedAgendaVersion,
              agendaItemId: input.expectedAgendaItemId,
            },
            claim.operationId,
            input.command.commandId,
            true,
          );
        } catch {
          // Cancellation remains the terminal result when the exact route was
          // concurrently switched, deleted, or superseded. Any matching exact
          // predecessor cleanup has already committed.
        } finally {
          // Failure cleanup must not depend on the route still existing. The
          // operation itself may already have cascaded with a deleted Course.
          commands.fail(claim, error);
        }
        throw error;
      }
      let recovered: LessonExecutionProjection | null;
      try {
        recovered = recoverRetryablePreparationFailure(
          workspaceId,
          sessionId,
          {
            sessionVersion: input.expectedSessionVersion,
            agendaVersion: input.expectedAgendaVersion,
            agendaItemId: input.expectedAgendaItemId,
          },
          claim.operationId,
          input.command.commandId,
          false,
          !(error instanceof AppError && error.code === ApiErrorCode.VersionConflict),
        );
      } catch (recoveryError) {
        commands.fail(claim, recoveryError);
        throw recoveryError;
      }
      if (!recovered) {
        commands.fail(claim, error);
        throw error;
      }
      if (
        error instanceof AppError &&
        (error.code === ApiErrorCode.VersionConflict ||
          (error.code === ApiErrorCode.ValidationError &&
            recovered.status !== 'practice_retry_available'))
      ) {
        commands.fail(claim, error);
        throw error;
      }
      try {
        return commands.complete(claim, () => recovered);
      } catch (completionError) {
        commands.fail(claim, completionError);
        throw completionError;
      }
    }
  }

  async function command(
    workspaceId: string,
    sessionId: string,
    rawInput: unknown,
  ): Promise<LessonExecutionProjection> {
    const input = LessonExecutionCommandRequestSchema.parse(rawInput);
    if (input.command.workspaceId !== workspaceId) throw notFound('Course not found.');
    const initial = route(workspaceId, sessionId, false);
    assertExpected(
      initial,
      input.expectedSessionVersion,
      input.expectedAgendaVersion,
      input.expectedAgendaItemId,
    );
    const claim = commands.begin(
      input.command,
      'lesson_execution_command',
      {
        sessionId,
        expectedSessionVersion: input.expectedSessionVersion,
        expectedAgendaVersion: input.expectedAgendaVersion,
        expectedAgendaItemId: input.expectedAgendaItemId,
        expectedLessonStateVersion: input.expectedLessonStateVersion,
        action: input.action,
      },
      { studySessionId: sessionId },
    );
    if (claim.replayPayload) return LessonExecutionProjectionSchema.parse(claim.replayPayload);
    try {
      const result = repos.transaction(() => {
        const context = route(workspaceId, sessionId, false);
        assertExpected(
          context,
          input.expectedSessionVersion,
          input.expectedAgendaVersion,
          input.expectedAgendaItemId,
        );
        const current = stateFor(context);
        const brief = current ? currentBrief(context) : null;
        if (!current || current.preparationStatus !== 'ready' || !brief)
          throw new AppError(
            ApiErrorCode.ValidationError,
            'Prepare the lesson before presenting it.',
          );
        if (current.version !== input.expectedLessonStateVersion)
          throw new AppError(ApiErrorCode.VersionConflict, 'Lesson presentation state is stale.');
        const now = clock.now().toISOString();
        const action = input.action;
        let eventKind:
          | 'segment_presented'
          | 'segment_revisited'
          | 'informal_response_recorded'
          | 'practice_response_recorded'
          | 'practice_completed'
          | 'presentation_completed' = 'segment_presented';
        let eventPayload: Record<string, unknown> = action;
        let next: LessonExecutionState = current;
        if (action.kind === 'start_lesson') {
          if (current.presentedSegmentIndexes.length > 0)
            throw new AppError(ApiErrorCode.ValidationError, 'Lesson has already started.');
          next = repos.lessonExecution.update(
            {
              ...current,
              currentSegmentIndex: 0,
              presentedSegmentIndexes: [0],
              version: current.version + 1,
              updatedAt: now,
            },
            current.version,
          );
          eventKind = 'segment_presented';
        } else if (action.kind === 'move_to_segment') {
          if (action.segmentIndex >= brief.segments.length)
            throw new AppError(ApiErrorCode.ValidationError, 'Unknown lesson segment.');
          const nextIndex = action.segmentIndex;
          const currentSegment = brief.segments[current.currentSegmentIndex];
          const currentInteraction = current.informalInteractions.find(
            (entry) => entry.segmentIndex === current.currentSegmentIndex,
          );
          if (
            nextIndex > current.currentSegmentIndex &&
            currentSegment?.informalCheck &&
            !currentInteraction?.response
          ) {
            throw new AppError(
              ApiErrorCode.ValidationError,
              'Commit a response to the current learning check before continuing.',
            );
          }
          if (
            nextIndex > current.currentSegmentIndex + 1 &&
            !current.presentedSegmentIndexes.includes(nextIndex)
          )
            throw new AppError(
              ApiErrorCode.ValidationError,
              'Lesson segments must be presented in order.',
            );
          const presented =
            nextIndex === current.currentSegmentIndex ||
            current.presentedSegmentIndexes.includes(nextIndex)
              ? current.presentedSegmentIndexes
              : [...current.presentedSegmentIndexes, nextIndex].sort((a, b) => a - b);
          eventKind = current.presentedSegmentIndexes.includes(nextIndex)
            ? 'segment_revisited'
            : 'segment_presented';
          next = repos.lessonExecution.update(
            {
              ...current,
              currentSegmentIndex: nextIndex,
              presentedSegmentIndexes: presented,
              version: current.version + 1,
              updatedAt: now,
            },
            current.version,
          );
        } else if (action.kind === 'respond_to_informal_check') {
          const segment = brief.segments.find(
            (candidate) => candidate.index === action.segmentIndex,
          );
          if (!segment?.informalCheck || current.currentSegmentIndex !== action.segmentIndex)
            throw new AppError(
              ApiErrorCode.ValidationError,
              'Respond to the current informal check.',
            );
          const existing = current.informalInteractions.find(
            (entry) => entry.segmentIndex === action.segmentIndex,
          );
          const interactions = existing
            ? current.informalInteractions.map((entry) =>
                entry.segmentIndex === action.segmentIndex
                  ? { ...entry, response: action.response, respondedAt: now }
                  : entry,
              )
            : [
                ...current.informalInteractions,
                {
                  segmentIndex: action.segmentIndex,
                  presentedAt: now,
                  response: action.response,
                  respondedAt: now,
                },
              ];
          eventKind = 'informal_response_recorded';
          next = repos.lessonExecution.update(
            {
              ...current,
              informalInteractions: interactions,
              version: current.version + 1,
              updatedAt: now,
            },
            current.version,
          );
        } else if (action.kind === 'submit_practice_response') {
          if (!current.presentationCompletedAt || current.practiceCompletedAt || !brief.practice) {
            throw new AppError(
              ApiErrorCode.ValidationError,
              'Practice is available only after Lesson presentation and before Practice completion.',
            );
          }
          const completedItem = (itemIndex: number) => {
            const attempts = current.practiceInteractions.filter(
              (attempt) => attempt.itemIndex === itemIndex,
            );
            return attempts.some((attempt) => attempt.correct) || attempts.length >= 2;
          };
          const expectedItemIndex = brief.practice.items.findIndex(
            (_, index) => !completedItem(index),
          );
          if (expectedItemIndex < 0 || action.itemIndex !== expectedItemIndex) {
            throw new AppError(
              ApiErrorCode.ValidationError,
              'Respond to the current Practice item.',
            );
          }
          const item = brief.practice.items[expectedItemIndex]!;
          const priorAttempts = current.practiceInteractions.filter(
            (attempt) => attempt.itemIndex === expectedItemIndex,
          );
          const attemptNumber = priorAttempts.length === 0 ? (1 as const) : (2 as const);
          const surfaceName = attemptNumber === 1 ? ('initial' as const) : ('retry' as const);
          const surface = item[surfaceName];
          const selected = surface.options.find((option) => option.id === action.optionId);
          if (!selected) {
            throw new AppError(ApiErrorCode.ValidationError, 'Select one offered Practice option.');
          }
          const correct = selected.id === surface.correctOptionId;
          const attempt = {
            itemIndex: expectedItemIndex,
            attemptNumber,
            surface: surfaceName,
            selectedOptionId: selected.id,
            correct,
            feedback:
              correct || attemptNumber === 2
                ? `${selected.feedbackIfSelected} ${surface.explanation}`
                : selected.feedbackIfSelected,
            hint: !correct && attemptNumber === 1 ? surface.hint : null,
            respondedAt: now,
            credit: 'none' as const,
          };
          const interactions = [...current.practiceInteractions, attempt];
          const itemDone = correct || attemptNumber === 2;
          const practiceDone = itemDone && expectedItemIndex === brief.practice.items.length - 1;
          eventKind = practiceDone ? 'practice_completed' : 'practice_response_recorded';
          eventPayload = {
            ...action,
            attemptNumber,
            surface: surfaceName,
            correct,
            feedback: attempt.feedback,
            hint: attempt.hint,
            credit: 'none',
          };
          next = repos.lessonExecution.update(
            {
              ...current,
              practiceInteractions: interactions,
              practiceCompletedAt: practiceDone ? now : null,
              version: current.version + 1,
              updatedAt: now,
            },
            current.version,
          );
        } else {
          if (current.presentationCompletedAt) {
            throw new AppError(
              ApiErrorCode.ValidationError,
              'Lesson presentation is already complete.',
            );
          }
          if (
            current.presentedSegmentIndexes.length !== brief.segments.length ||
            current.currentSegmentIndex !== brief.segments.length - 1
          )
            throw new AppError(
              ApiErrorCode.ValidationError,
              'Present every lesson segment before completing the presentation.',
            );
          const unansweredChecks = brief.segments.filter(
            (segment) =>
              segment.informalCheck &&
              !current.informalInteractions.some(
                (interaction) =>
                  interaction.segmentIndex === segment.index && Boolean(interaction.response),
              ),
          );
          if (unansweredChecks.length > 0) {
            throw new AppError(
              ApiErrorCode.ValidationError,
              'Commit a response to every Lesson learning check before Practice.',
            );
          }
          next = repos.lessonExecution.update(
            {
              ...current,
              presentationCompletedAt: now,
              version: current.version + 1,
              updatedAt: now,
            },
            current.version,
          );
          eventKind = 'presentation_completed';
        }
        repos.lessonExecution.appendEvent({
          id: newId('lesson_event'),
          lessonExecutionStateId: next.id,
          seq: repos.lessonExecution.listEvents(next.id).length + 1,
          commandId: input.command.commandId,
          kind: eventKind,
          payload: eventPayload,
          createdAt: now,
        });
        const latestSession = repos.studySessions.get(sessionId)!;
        repos.studySessions.update(
          { ...latestSession, version: latestSession.version + 1, updatedAt: now },
          latestSession.version,
        );
        // Teaching execution ends here, edge-triggered on this action's own
        // transition so a later revisit cannot complete the item twice. The
        // Agenda item and the linked teach_unit Plan progress advance together,
        // and a drained window continues the same accepted Plan. No Formal
        // Evidence, grade, mastery change or GoalOutcome is written.
        const completesTeaching =
          eventKind === 'practice_completed' ||
          (eventKind === 'presentation_completed' && !brief.practice);
        if (!completesTeaching) return projection(route(workspaceId, sessionId), next, brief);
        agendaWindow.completeTeachingExecution({
          workspaceId,
          sessionId,
          agenda: context.agenda,
          item: context.item,
          plan: context.plan,
          planItem: context.planItem,
          commandId: input.command.commandId,
          at: now,
        });
        // The route pointer may now address the successor Agenda, so the
        // finished window is projected from its own durable rows rather than
        // through the live-route lookup.
        const retiredAgenda = repos.sessionAgendas.get(context.agenda.id) ?? context.agenda;
        return projection(
          {
            ...context,
            agenda: retiredAgenda,
            item: retiredAgenda.items.find((item) => item.id === context.item.id) ?? context.item,
            session: repos.studySessions.get(sessionId) ?? context.session,
          },
          next,
          brief,
        );
      });
      return commands.complete(claim, () => result);
    } catch (error) {
      commands.fail(claim, error);
      throw error;
    }
  }

  function tutorContext(workspaceId: string, sessionId: string): LessonTutorContext | null {
    const context = route(workspaceId, sessionId);
    const state = stateFor(context);
    const brief = state?.preparationStatus === 'ready' ? currentBrief(context) : null;
    if (!state || !brief) return null;
    const lesson = projectLesson(brief, state)!;
    const current = lesson.segments[state.currentSegmentIndex];
    if (!current) return null;
    const nearbySegments = lesson.segments
      .filter((segment) => Math.abs(segment.index - current.index) === 1)
      .map((segment) => ({
        relation: segment.index < current.index ? ('previous' as const) : ('next' as const),
        purpose: segment.purpose,
        preview: segment.explanation.slice(0, 260),
      }));
    const result = LessonTutorContextSchema.parse({
      objective: { title: lesson.objective.title, whyNow: lesson.objective.whyNow },
      currentSegment: {
        index: current.index,
        purpose: current.purpose,
        explanation: current.explanation.slice(0, 1800),
        explanationOrigin: current.explanationOrigin,
        example: current.example?.text.slice(0, 700) ?? null,
        contrast: current.contrast?.text.slice(0, 700) ?? null,
        possibleMisconception: current.possibleMisconception?.correction.slice(0, 700) ?? null,
        informalCheck: current.informalCheck
          ? {
              prompt: current.informalCheck.prompt,
              guidance: current.informalCheck.guidance,
              learnerResponse: current.informalCheck.response,
              credit: 'none' as const,
            }
          : null,
      },
      nearbySegments,
      sources: current.sources.slice(0, 4),
      visuals: lesson.visuals.slice(0, 4),
      summary: lesson.summary.text,
      nextConnection: lesson.summary.nextConnection,
    });
    if (JSON.stringify(result).length > 12_000) {
      return LessonTutorContextSchema.parse({
        ...result,
        currentSegment: {
          ...result.currentSegment,
          explanation: result.currentSegment.explanation.slice(0, 900),
          example: result.currentSegment.example?.slice(0, 250) ?? null,
          contrast: result.currentSegment.contrast?.slice(0, 250) ?? null,
          possibleMisconception: result.currentSegment.possibleMisconception?.slice(0, 250) ?? null,
        },
        sources: result.sources.slice(0, 2),
        visuals: (result.visuals ?? []).slice(0, 2).map((visual) => ({
          ...visual,
          explanation: {
            ...visual.explanation,
            text: visual.explanation.text.slice(0, 600),
            importantConcepts: visual.explanation.importantConcepts.slice(0, 4),
            pedagogicalNotes: visual.explanation.pedagogicalNotes.slice(0, 2),
            uncertainty: visual.explanation.uncertainty.slice(0, 2),
          },
        })),
        summary: result.summary?.slice(0, 300) ?? null,
      });
    }
    return result;
  }

  return { get, ensure, command, tutorContext };
}

export type LessonExecutionService = ReturnType<typeof createLessonExecutionService>;
