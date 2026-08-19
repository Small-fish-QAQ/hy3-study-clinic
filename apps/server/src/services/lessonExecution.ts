import {
  ApiErrorCode,
  EnsureLessonExecutionRequestSchema,
  LessonExecutionCommandRequestSchema,
  LessonExecutionProjectionSchema,
  LessonTutorContextSchema,
  type LessonExecutionProjection,
  type LessonExecutionState,
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
import type { CourseCommandService } from './courseCommands.js';
import type { TeachingBriefPreparationService } from './teachingBriefPreparation.js';

interface LessonExecutionDeps {
  repos: Repositories;
  clock: Clock;
  commands: CourseCommandService;
  teachingBriefPreparation: Pick<TeachingBriefPreparationService, 'prepare' | 'getCurrent'>;
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

function sourceProjection(brief: TeachingBrief, repos: Repositories): LessonSourceProjection[] {
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
}: LessonExecutionDeps) {
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

  function executable(context: RouteContext): boolean {
    return (
      context.item.kind === 'learning_unit_teaching' &&
      (context.item.state === 'queued' || context.item.state === 'active') &&
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

  function currentBrief(context: RouteContext): TeachingBrief | null {
    if (!executable(context)) return null;
    return teachingBriefPreparation.getCurrent({
      workspaceId: context.session.workspaceId,
      curriculumVersionId: context.session.curriculumVersionId,
      studyPlanVersionId: context.session.studyPlanVersionId,
      learningUnitId: context.item.learningUnitId!,
      expectedExecutionSourceManifestFingerprint:
        context.session.executionSourceManifestFingerprint,
    });
  }

  function projection(
    context: RouteContext,
    state: LessonExecutionState | undefined,
    brief: TeachingBrief | null,
  ): LessonExecutionProjection {
    if (!executable(context)) {
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
    const completed = Boolean(state.presentationCompletedAt);
    const presentationStatus = completed
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
          presented: Boolean(interaction),
          response: interaction?.response ?? null,
          respondedAt: interaction?.respondedAt ?? null,
        }
      : null;
    const allowed =
      context.session.status === 'paused'
        ? (['resume_study_session'] as const)
        : completed
          ? (['review_lesson'] as const)
          : state.presentedSegmentIndexes.length === 0
            ? (['start_lesson'] as const)
            : [
                ...(current?.informalCheck && !interaction?.response
                  ? (['respond_to_informal_check'] as const)
                  : []),
                ...(state.currentSegmentIndex < brief.segments.length - 1
                  ? (['move_to_next_segment'] as const)
                  : []),
                ...(state.currentSegmentIndex > 0 ? (['revisit_segment'] as const) : []),
                ...(state.presentedSegmentIndexes.length === brief.segments.length
                  ? (['complete_presentation'] as const)
                  : []),
              ];
    return LessonExecutionProjectionSchema.parse({
      status: 'ready',
      message: completed ? 'Lesson presentation complete.' : 'Lesson is ready.',
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
      allowedActions: [...allowed],
    });
  }

  function projectLesson(
    brief: TeachingBrief,
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
            guidance: segment.informalCheck.expectedSignal,
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
      summary: {
        available: true,
        text: brief.summary,
        nextConnection: brief.nextConnection,
        formalOpportunities: brief.formalOpportunities,
      },
    };
  }

  function stateFor(context: RouteContext): LessonExecutionState | undefined {
    return repos.lessonExecution.getForSession(context.session.id, context.item.id);
  }

  function get(workspaceId: string, sessionId: string): LessonExecutionProjection {
    const context = route(workspaceId, sessionId);
    return projection(context, stateFor(context), currentBrief(context));
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
    const claim = commands.begin(input.command, 'prepare_lesson_execution', {
      sessionId,
      expectedSessionVersion: input.expectedSessionVersion,
      expectedAgendaVersion: input.expectedAgendaVersion,
      agendaItemId: input.expectedAgendaItemId,
    });
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
      const response = await teachingBriefPreparation.prepare(
        {
          workspaceId,
          curriculumVersionId: context.curriculum.id,
          studyPlanVersionId: context.plan.id,
          learningUnitId: context.item.learningUnitId!,
          commandId: claim.operationId,
          expectedExecutionSourceManifestFingerprint:
            context.session.executionSourceManifestFingerprint,
          confirmedCostPolicyIds: input.confirmedCostPolicyIds,
        },
        options,
      );
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
      if (
        error instanceof AppError &&
        (error.code === ApiErrorCode.VersionConflict || error.code === ApiErrorCode.ValidationError)
      ) {
        commands.fail(claim, error);
        throw error;
      }
      if (error instanceof ProviderError && error.code === ApiErrorCode.RequestCancelled) {
        const context = route(workspaceId, sessionId);
        const latest = stateFor(context);
        if (latest?.preparationOperationId === claim.operationId) {
          const now = clock.now().toISOString();
          const retry = repos.transaction(() => {
            const current = stateFor(route(workspaceId, sessionId));
            if (!current || current.preparationOperationId !== claim.operationId) return current;
            const next = repos.lessonExecution.update(
              {
                ...current,
                preparationStatus: 'retryable_failure',
                preparationOperationId: null,
                version: current.version + 1,
                updatedAt: now,
              },
              current.version,
            );
            repos.lessonExecution.appendEvent({
              id: newId('lesson_event'),
              lessonExecutionStateId: next.id,
              seq: repos.lessonExecution.listEvents(next.id).length + 1,
              commandId: input.command.commandId,
              kind: 'preparation_failed',
              payload: { retryable: true, cancelled: true },
              createdAt: now,
            });
            return next;
          });
          void retry;
        }
        commands.fail(claim, error);
        throw error;
      }
      const retry = repos.transaction(() => {
        const context = route(workspaceId, sessionId);
        const latest = stateFor(context);
        if (!latest || latest.preparationOperationId !== claim.operationId) return latest;
        const now = clock.now().toISOString();
        const next = repos.lessonExecution.update(
          {
            ...latest,
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
          commandId: input.command.commandId,
          kind: 'preparation_failed',
          payload: { retryable: true },
          createdAt: now,
        });
        return next;
      });
      const result = projection(route(workspaceId, sessionId), retry, null);
      return commands.complete(claim, () => result);
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
    const claim = commands.begin(input.command, 'lesson_execution_command', {
      sessionId,
      expectedSessionVersion: input.expectedSessionVersion,
      expectedAgendaVersion: input.expectedAgendaVersion,
      expectedAgendaItemId: input.expectedAgendaItemId,
      expectedLessonStateVersion: input.expectedLessonStateVersion,
      action: input.action,
    });
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
          | 'presentation_completed' = 'segment_presented';
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
        } else {
          if (
            current.presentedSegmentIndexes.length !== brief.segments.length ||
            current.currentSegmentIndex !== brief.segments.length - 1
          )
            throw new AppError(
              ApiErrorCode.ValidationError,
              'Present every lesson segment before completing the presentation.',
            );
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
          payload: action,
          createdAt: now,
        });
        const latestSession = repos.studySessions.get(sessionId)!;
        repos.studySessions.update(
          { ...latestSession, version: latestSession.version + 1, updatedAt: now },
          latestSession.version,
        );
        return projection(route(workspaceId, sessionId), next, brief);
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
        summary: result.summary?.slice(0, 300) ?? null,
      });
    }
    return result;
  }

  return { get, ensure, command, tutorContext };
}

export type LessonExecutionService = ReturnType<typeof createLessonExecutionService>;
