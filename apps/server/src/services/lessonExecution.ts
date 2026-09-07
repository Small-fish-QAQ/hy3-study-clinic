import {
  ApiErrorCode,
  EnsureLessonExecutionRequestSchema,
  LessonExecutionCommandRequestSchema,
  LessonExecutionProjectionSchema,
  LessonTutorContextSchema,
  TeachingContentReviewSchema,
  PracticeRepairContentSchema,
  groupLessonSegmentsForLearner,
  isExecutableTeachingAgendaItem,
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
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import type { LlmProvider, ProviderCallOptions } from '../llm/provider.js';
import { enforceAgentCostPolicies } from './agentProviderRuntime.js';
import {
  runRecoverableGenerationStage,
  invalidateGenerationDependency,
} from './generationStages.js';
import { createTelemetryProvider } from './providerTelemetry.js';
import {
  failedPracticeAttempt,
  practiceItemPassed,
  practiceRecoveryProjection,
  practiceRepairInput,
  practiceRepairReview,
  validatePracticeRepair,
} from './practiceRecovery.js';
import type { AgendaWindowRolloverService } from './agendaWindowRollover.js';
import type { CourseCommandService } from './courseCommands.js';
import {
  COMPOSITIONAL_PREPARATION_LEASE_MS,
  type AcceptedLessonPreview,
  type TeachingBriefPreparationService,
} from './teachingBriefPreparation.js';

interface LessonExecutionDeps {
  provider?: LlmProvider;
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
    const material = repos.materials.getRouteIdentity(reference.materialId);
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

type WorkedProcess = NonNullable<TeachingBrief['segments'][number]['workedProcess']>;
type SegmentInteraction = LessonExecutionState['informalInteractions'][number] | undefined;

function workedInteractionStage(
  process: WorkedProcess,
  interaction: SegmentInteraction,
): 'guided' | 'scaffold' | 'transfer' | 'completed' | null {
  const authored = process.interaction;
  if (!authored) return null;
  const state = interaction?.workedInteraction;
  if (!state?.guidedResponse) return 'guided';
  const guidedCorrect = state.guidedResponse === authored.activity.correctOptionId;
  if (!guidedCorrect && !state.scaffoldResponse) return 'scaffold';
  return state.transferResponse ? 'completed' : 'transfer';
}

function workedInteractionComplete(
  segment: TeachingBrief['segments'][number],
  interaction: SegmentInteraction,
): boolean {
  if (!segment.workedProcess?.interaction) return true;
  return workedInteractionStage(segment.workedProcess, interaction) === 'completed';
}

export function createLessonExecutionService({
  provider: rawProvider,
  repos,
  clock,
  commands,
  teachingBriefPreparation,
  agendaWindow,
}: LessonExecutionDeps) {
  const provider = rawProvider
    ? createTelemetryProvider({ repos, clock, provider: rawProvider, providerGeneration: () => 1 })
    : undefined;
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
    return teachingRouteMatches(context) && isExecutableTeachingAgendaItem(context.item);
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

  function preparationWasCancelled(state: LessonExecutionState | undefined): boolean {
    if (state?.preparationStatus !== 'retryable_failure') return false;
    const failure = [...repos.lessonExecution.listEvents(state.id)]
      .reverse()
      .find((event) => event.kind === 'preparation_failed');
    return failure?.payload.cancelled === true || failure?.payload.recoveryReason === 'cancelled';
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
    if (state?.preparationStatus === 'retryable_failure' && preparationWasCancelled(state)) {
      return LessonExecutionProjectionSchema.parse({
        status: 'preparation_needed',
        message: 'Lesson preparation was cancelled. Start it again when you are ready.',
        course: { title: context.courseTitle },
        session: { status: context.session.status, version: context.session.version },
        agenda: { version: context.agenda.version, itemState: context.item.state },
        lesson: null,
        progress: null,
        currentInformalCheck: null,
        allowedActions: ['prepare_lesson'],
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
    const teachingSections = groupLessonSegmentsForLearner(brief.segments);
    const currentTeachingSection = teachingSections.find((section) =>
      section.segments.some((segment) => segment.index === state.currentSegmentIndex),
    );
    const presentationCompleted = Boolean(state.presentationCompletedAt);
    const completed = Boolean(state.practiceCompletedAt);
    const allChecksAnswered = brief.segments.every((segment) => {
      const segmentInteraction = state.informalInteractions.find(
        (candidate) => candidate.segmentIndex === segment.index,
      );
      return (
        (!segment.informalCheck || Boolean(segmentInteraction?.response)) &&
        workedInteractionComplete(segment, segmentInteraction)
      );
    });
    const presentationStatus = completed
      ? 'presentation_completed'
      : presentationCompleted
        ? 'presentation_completed'
        : state.presentedSegmentIndexes.length === 0
          ? 'not_started'
          : state.presentedSegmentIndexes.length === brief.segments.length && allChecksAnswered
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
    const currentWorkedInteraction = current?.workedProcess?.interaction;
    const currentInteractionComplete =
      !currentWorkedInteraction || currentWorkedInteraction.stage === 'completed';
    const currentReadyToAdvance =
      (!current?.informalCheck || Boolean(interaction?.response)) && currentInteractionComplete;
    const practice = projectPractice(brief, state);
    const allowed =
      context.session.status === 'paused'
        ? (['resume_study_session'] as const)
        : completed
          ? (['review_lesson'] as const)
          : presentationCompleted
            ? practice?.recovery
              ? practice.recovery.phase === 'diagnosis' ||
                practice.recovery.phase === 'needs_support'
                ? (['prepare_practice_repair'] as const)
                : practice.recovery.phase === 'repair'
                  ? (['start_practice_retest'] as const)
                  : practice.recovery.phase === 'retest'
                    ? (['submit_practice_retest'] as const)
                    : (['review_lesson'] as const)
              : (['submit_practice_response'] as const)
            : state.presentedSegmentIndexes.length === 0
              ? (['start_lesson'] as const)
              : [
                  ...(current?.informalCheck && !interaction?.response
                    ? (['respond_to_informal_check'] as const)
                    : []),
                  ...(currentWorkedInteraction && !currentInteractionComplete
                    ? (['respond_to_worked_interaction'] as const)
                    : []),
                  ...(currentTeachingSection &&
                  (state.currentSegmentIndex < currentTeachingSection.endSegmentIndex ||
                    currentTeachingSection.index < teachingSections.length - 1) &&
                  currentReadyToAdvance
                    ? (['move_to_next_segment'] as const)
                    : []),
                  ...(state.currentSegmentIndex > 0 ? (['revisit_segment'] as const) : []),
                  ...(state.presentedSegmentIndexes.length === brief.segments.length &&
                  allChecksAnswered
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
    const segments = brief.segments.map((segment) => {
      const interaction = state.informalInteractions.find(
        (entry) => entry.segmentIndex === segment.index,
      );
      const selectedChoice = segment.informalCheck?.options?.find(
        (option) => option.id === interaction?.response,
      );
      const projectWorkedProcess = (process: WorkedProcess) => {
        const authored = process.interaction;
        const interactionState = interaction?.workedInteraction;
        if (!authored) {
          return {
            startingState: process.startingState,
            ...(process.inputs ? { inputs: process.inputs } : {}),
            ruleOrProcedure: process.ruleOrProcedure,
            steps: process.steps,
            learnerDecision: process.learnerDecision,
            result: process.result,
            whyResultFollows: process.whyResultFollows,
            origin: authority(
              process.sourceRefIds.length > 0 ? 'source_backed_teaching' : 'ai_teaching_synthesis',
            ),
            sources: refs(process.sourceRefIds),
          };
        }
        const stage = workedInteractionStage(process, interaction)!;
        const guidedResponse = interactionState?.guidedResponse ?? null;
        const guidedOption = authored.activity.options.find(
          (option) => option.id === guidedResponse,
        );
        const guidedCorrect = guidedResponse
          ? guidedResponse === authored.activity.correctOptionId
          : null;
        const scaffoldResponse = interactionState?.scaffoldResponse ?? null;
        const scaffoldOption = authored.scaffold.options.find(
          (option) => option.id === scaffoldResponse,
        );
        const guidedResolved = guidedCorrect === true || scaffoldResponse !== null;
        const transferResponse = interactionState?.transferResponse ?? null;
        const transferOption = authored.transfer.options.find(
          (option) => option.id === transferResponse,
        );
        return {
          startingState: process.startingState,
          inputs: process.inputs ?? [],
          ruleOrProcedure: process.ruleOrProcedure,
          steps: guidedResolved
            ? process.steps
            : process.steps.slice(0, authored.pauseAfterStepIndex + 1),
          learnerDecision: null,
          result: guidedResolved ? process.result : null,
          whyResultFollows: transferResponse ? process.whyResultFollows : null,
          origin: authority(
            process.sourceRefIds.length > 0 ? 'source_backed_teaching' : 'ai_teaching_synthesis',
          ),
          sources: refs(process.sourceRefIds),
          interaction: {
            stage,
            modelledStepCount: authored.pauseAfterStepIndex + 1,
            origin: authority(
              authored.sourceRefs.length > 0 ? 'source_backed_teaching' : 'ai_teaching_synthesis',
            ),
            sources: refs(authored.sourceRefs),
            activity: {
              prompt: authored.activity.prompt,
              options: authored.activity.options.map(({ id, text }) => ({ id, text })),
              response: guidedResponse,
              respondedAt: interactionState?.guidedRespondedAt ?? null,
              correct: guidedCorrect,
              feedback: guidedOption?.feedbackIfSelected ?? null,
              misconception: guidedCorrect === false ? (guidedOption?.misconception ?? null) : null,
              debrief: guidedResolved ? authored.activity.correctDebrief : null,
              credit: 'none' as const,
            },
            hint: guidedCorrect === false ? authored.hint : null,
            scaffold:
              guidedCorrect === false
                ? {
                    prompt: authored.scaffold.prompt,
                    options: authored.scaffold.options.map(({ id, text }) => ({ id, text })),
                    response: scaffoldResponse,
                    respondedAt: interactionState?.scaffoldRespondedAt ?? null,
                    correct: scaffoldResponse
                      ? scaffoldResponse === authored.scaffold.correctOptionId
                      : null,
                    feedback: scaffoldOption?.feedbackIfSelected ?? null,
                    debrief: scaffoldResponse ? authored.scaffold.debrief : null,
                    credit: 'none' as const,
                  }
                : null,
            transfer: guidedResolved
              ? {
                  changedCondition: authored.transfer.changedCondition,
                  prompt: authored.transfer.prompt,
                  options: authored.transfer.options.map(({ id, text }) => ({ id, text })),
                  response: transferResponse,
                  respondedAt: interactionState?.transferRespondedAt ?? null,
                  correct: transferResponse
                    ? transferResponse === authored.transfer.correctOptionId
                    : null,
                  feedback: transferOption?.feedbackIfSelected ?? null,
                  debrief: transferResponse ? authored.transfer.debrief : null,
                  credit: 'none' as const,
                }
              : null,
          },
        };
      };
      return {
        index: segment.index,
        purpose: purpose(segment.purpose),
        explanation: segment.explanation,
        explanationOrigin: authority(segment.explanationAuthority),
        sources: refs(segment.sourceRefIds),
        ...(segment.semanticRelations
          ? {
              semanticRelations: segment.semanticRelations.map(
                ({ kind, fromProposition, toProposition, sourceRefIds }) => ({
                  kind,
                  fromProposition,
                  toProposition,
                  origin: authority(
                    sourceRefIds.length > 0 ? 'source_backed_teaching' : 'ai_teaching_synthesis',
                  ),
                  sources: refs(sourceRefIds),
                }),
              ),
            }
          : {}),
        ...(segment.workedProcess !== undefined
          ? {
              workedProcess: segment.workedProcess
                ? projectWorkedProcess(segment.workedProcess)
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
              origin: authority(
                segment.misconception.sourceRefIds.length > 0
                  ? 'source_backed_teaching'
                  : 'ai_teaching_synthesis',
              ),
              sources: refs(segment.misconception.sourceRefIds),
            }
          : null,
        informalCheck: segment.informalCheck
          ? {
              kind: informalKind(segment.informalCheck.kind),
              prompt: segment.informalCheck.prompt,
              guidance: interaction?.response ? segment.informalCheck.expectedSignal : null,
              options: segment.informalCheck.options?.map(({ id, text }) => ({ id, text })) ?? [],
              presented: Boolean(interaction),
              response: interaction?.response ?? null,
              respondedAt: interaction?.respondedAt ?? null,
              correct:
                interaction?.response && segment.informalCheck.correctOptionId
                  ? interaction.response === segment.informalCheck.correctOptionId
                  : null,
              feedback: selectedChoice?.feedbackIfSelected ?? null,
              credit: 'none' as const,
            }
          : null,
      };
    });
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
      return practiceItemPassed(state, itemIndex);
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
    const recoveryOperationId = failedPracticeAttempt(state, currentItemIndex)?.recovery
      ?.preparationOperationId;
    const operation = recoveryOperationId ? repos.operations.get(recoveryOperationId) : null;
    const generating =
      operation?.status === 'running' &&
      Boolean(operation.leaseExpiresAt && operation.leaseExpiresAt > clock.now().toISOString());
    const recovery = practiceRecoveryProjection(state, item, currentItemIndex, generating);
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
      item:
        state.practiceCompletedAt || recovery
          ? null
          : {
              index: currentItemIndex,
              objectiveTitle: item.objectiveTitle,
              construct: item.construct,
              surface: surfaceName,
              supplementary: item.authority === 'ai_teaching_synthesis',
              prompt: surface.prompt,
              options: surface.options.map(({ id, text }) => ({ id, text })),
            },
      attempts: state.practiceInteractions.map(({ recovery, ...attempt }) => ({
        ...attempt,
        ...(recovery?.rounds.some(
          (round) =>
            round.responses.length === 2 && round.responses.every((response) => response.correct),
        )
          ? {
              recovered: true,
              recoveryFeedback: recovery.rounds
                .find(
                  (round) =>
                    round.responses.length === 2 &&
                    round.responses.every((response) => response.correct),
                )!
                .responses.at(-1)!.feedback,
            }
          : {}),
      })),
      recovery,
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
    opts?: ProviderCallOptions,
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
      if (input.action.kind === 'prepare_practice_repair') {
        const current = stateFor(initial);
        const brief = current ? currentBrief(initial) : null;
        if (
          !current ||
          !brief?.practice ||
          !current.presentationCompletedAt ||
          current.practiceCompletedAt ||
          current.version !== input.expectedLessonStateVersion
        )
          throw new AppError(ApiErrorCode.VersionConflict, 'Practice repair state is stale.');
        const index = brief.practice.items.findIndex((_, i) => !practiceItemPassed(current, i));
        const attempt = failedPracticeAttempt(current, index);
        const recovery = attempt?.recovery ?? { rounds: [], preparationOperationId: null };
        const last = recovery.rounds.at(-1);
        if (
          !attempt ||
          (recovery.rounds.length >= 3 && !input.action.learnerNote.trim()) ||
          (last && !last.responses.some((response) => !response.correct))
        )
          throw new AppError(
            ApiErrorCode.ValidationError,
            'Repair requires an unresolved failed response.',
          );
        if (!provider?.generatePracticeRepair)
          throw new AppError(ApiErrorCode.ValidationError, 'Practice repair provider unavailable.');
        const reviewRepair = provider.reviewTeachingContent ?? provider.reviewPracticeRepair;
        if (!reviewRepair)
          throw new AppError(
            ApiErrorCode.ValidationError,
            'Independent repair review is unavailable.',
          );
        const ordinal = (last?.ordinal ?? recovery.rounds.length) + 1;
        const priorOperation = recovery.preparationOperationId
          ? repos.operations.get(recovery.preparationOperationId)
          : null;
        if (
          priorOperation?.status === 'running' &&
          priorOperation.leaseExpiresAt &&
          priorOperation.leaseExpiresAt > clock.now().toISOString()
        )
          throw new AppError(
            ApiErrorCode.VersionConflict,
            'Practice repair is already being prepared.',
          );
        const preparing = repos.lessonExecution.update(
          {
            ...current,
            practiceInteractions: current.practiceInteractions.map((value) =>
              value === attempt
                ? {
                    ...value,
                    recovery: {
                      ...recovery,
                      learnerNote:
                        input.action.kind === 'prepare_practice_repair'
                          ? input.action.learnerNote
                          : '',
                      preparationOperationId: claim.operationId,
                    },
                  }
                : value,
            ),
            version: current.version + 1,
            updatedAt: clock.now().toISOString(),
          },
          current.version,
        );
        const archivedRetestPrompts = repos.lessonExecution
          .listEvents(current.id)
          .flatMap((event) => {
            if (event.kind !== 'practice_repair_prepared' || event.payload.itemIndex !== index)
              return [];
            const archived = event.payload.archivedRound as { content?: unknown } | undefined;
            const parsed = PracticeRepairContentSchema.safeParse(archived?.content);
            return parsed.success ? parsed.data.retest.map((item) => item.prompt) : [];
          })
          .slice(-24);
        const request = practiceRepairInput(brief, current, index, input.action.learnerNote, {
          desiredDepth: initial.planItem.targetDepth,
          unitFocus:
            initial.curriculum.nodes.find((node) => node.id === current.learningUnitId)
              ?.learningUnit?.focus ?? 'normal',
          archivedRetestPrompts,
        });
        if (priorOperation) {
          const rejected = repos.operations
            .listEvents(priorOperation.id)
            .findLast((event) => event.kind === 'practice_repair_rejected');
          if (rejected) request.revision = rejected.payload as NonNullable<typeof request.revision>;
        }
        const assertCurrent = () => {
          const context = route(workspaceId, sessionId, false);
          assertExpected(
            context,
            input.expectedSessionVersion,
            input.expectedAgendaVersion,
            input.expectedAgendaItemId,
          );
          if (
            stateFor(context)?.version !== preparing.version ||
            currentBrief(context)?.id !== brief.id
          )
            throw new AppError(
              ApiErrorCode.VersionConflict,
              'Practice repair lost its current Lesson binding.',
            );
        };
        const logicalCallId = newId('llm_call');
        const content = await runRecoverableGenerationStage({
          repos,
          clock,
          provider,
          providerModel: provider.model ?? null,
          operationId: claim.operationId,
          owner: claim.owner,
          fencingToken: claim.fencingToken,
          workspaceId,
          studySessionId: sessionId,
          learningUnitId: current.learningUnitId,
          assessmentId: null,
          operationType: 'prepare_practice_repair',
          schemaFingerprint: 'practice-repair-v5',
          policyFingerprint: null,
          sourceFingerprint: current.sourceContextFingerprint,
          logicalCallId,
          providerOptions: opts,
          stageIdentity: {
            briefId: brief.id,
            stateId: current.id,
            itemIndex: index,
            round: ordinal,
            request,
            version: 'practice-repair-v5',
          },
          assertCurrent,
          beforeGenerate: () =>
            enforceAgentCostPolicies(repos, {
              workspaceId,
              operationType: 'prepare_practice_repair',
              studySessionId: sessionId,
              at: clock.now().toISOString(),
              confirmedPolicyIds: [],
            }),
          validateResult: (value) => validatePracticeRepair(value, request),
          invoke: (options) =>
            provider.generatePracticeRepair!(structuredClone(request), {
              ...options,
              validateCandidate: (value) => {
                try {
                  validatePracticeRepair(value, request);
                  return { valid: true, diagnostics: [], diagnosticCodes: [] };
                } catch (error) {
                  return {
                    valid: false,
                    diagnostics: [error instanceof Error ? error.message : 'Invalid repair'],
                    diagnosticCodes: ['practice_repair_invalid'],
                  };
                }
              },
            }),
        });
        const reviewLogicalCallId = newId('llm_call');
        const reviewInput = practiceRepairReview(request, content);
        commands.renew(claim, 5 * 60 * 1000);
        const reviewed = await runRecoverableGenerationStage({
          repos,
          clock,
          provider,
          providerModel: provider.model ?? null,
          operationId: claim.operationId,
          owner: claim.owner,
          fencingToken: claim.fencingToken,
          workspaceId,
          studySessionId: sessionId,
          learningUnitId: current.learningUnitId,
          assessmentId: null,
          operationType: 'review_practice_repair',
          schemaFingerprint: 'practice-repair-review-v1',
          policyFingerprint: null,
          sourceFingerprint: current.sourceContextFingerprint,
          logicalCallId: reviewLogicalCallId,
          providerOptions: opts,
          stageIdentity: { briefId: brief.id, input: reviewInput },
          assertCurrent,
          beforeGenerate: () =>
            enforceAgentCostPolicies(repos, {
              workspaceId,
              operationType: 'review_practice_repair',
              studySessionId: sessionId,
              at: clock.now().toISOString(),
              confirmedPolicyIds: [],
            }),
          validateResult: (value) => TeachingContentReviewSchema.parse(value),
          invoke: (options) => reviewRepair.call(provider, structuredClone(reviewInput), options),
        });
        const findings = reviewed.findings
          .filter((finding) => finding.code !== 'shallow_task')
          .map((finding) => `${finding.problem} ${finding.repairInstruction}`);
        for (const [i, question] of content.retest.entries()) {
          const decisions = reviewed.decisions.filter(
            (decision) => decision.actionId === `retest${i}.check`,
          );
          if (decisions.length !== 1 || decisions[0]!.answerId !== question.correctOptionId)
            findings.push(
              `Retest ${i + 1} lacks a unique independently confirmed answer. ${decisions[0]?.evidenceUsed ?? ''}`,
            );
        }
        if (findings.length) {
          invalidateGenerationDependency(repos, logicalCallId, clock.now().toISOString());
          commands.appendEvent(claim, 'practice_repair_rejected', { draft: content, findings });
          throw new AppError(
            ApiErrorCode.ValidationError,
            'The repair needs a content correction. Please retry.',
          );
        }
        return commands.complete(claim, () => {
          if (opts?.signal?.aborted) throw ProviderError.cancelled();
          assertCurrent();
          const now = clock.now().toISOString();
          const next = repos.lessonExecution.update(
            {
              ...preparing,
              practiceInteractions: preparing.practiceInteractions.map((value) =>
                value.recovery?.preparationOperationId === claim.operationId
                  ? {
                      ...value,
                      recovery: {
                        preparationOperationId: null,
                        learnerNote:
                          input.action.kind === 'prepare_practice_repair'
                            ? input.action.learnerNote
                            : '',
                        rounds: [
                          ...recovery.rounds.slice(-2),
                          {
                            ordinal,
                            content,
                            learnerNote:
                              input.action.kind === 'prepare_practice_repair'
                                ? input.action.learnerNote
                                : '',
                            logicalCallId,
                            reviewLogicalCallId,
                            createdAt: now,
                            startedAt: null,
                            responses: [],
                          },
                        ],
                      },
                    }
                  : value,
              ),
              version: preparing.version + 1,
              updatedAt: now,
            },
            preparing.version,
          );
          repos.lessonExecution.appendEvent({
            id: newId('lesson_event'),
            lessonExecutionStateId: next.id,
            seq: repos.lessonExecution.listEvents(next.id).length + 1,
            commandId: input.command.commandId,
            kind: 'practice_repair_prepared',
            payload: {
              itemIndex: index,
              round: ordinal,
              logicalCallId,
              ...(recovery.rounds.length >= 3 ? { archivedRound: recovery.rounds[0] } : {}),
              credit: 'none',
            },
            createdAt: now,
          });
          return projection(route(workspaceId, sessionId), next, brief);
        });
      }
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
          | 'practice_retest_started'
          | 'practice_retest_response_recorded'
          | 'practice_completed'
          | 'presentation_completed' = 'segment_presented';
        let eventPayload: Record<string, unknown> = action;
        let next: LessonExecutionState = current;
        if (action.kind === 'start_lesson') {
          if (current.presentedSegmentIndexes.length > 0)
            throw new AppError(ApiErrorCode.ValidationError, 'Lesson has already started.');
          const firstSection = groupLessonSegmentsForLearner(brief.segments)[0]!;
          const firstSectionIndexes = firstSection.segments.map((segment) => segment.index);
          next = repos.lessonExecution.update(
            {
              ...current,
              currentSegmentIndex: firstSection.endSegmentIndex,
              presentedSegmentIndexes: firstSectionIndexes,
              version: current.version + 1,
              updatedAt: now,
            },
            current.version,
          );
          eventKind = 'segment_presented';
        } else if (action.kind === 'move_to_segment') {
          if (action.segmentIndex >= brief.segments.length)
            throw new AppError(ApiErrorCode.ValidationError, 'Unknown lesson segment.');
          const sections = groupLessonSegmentsForLearner(brief.segments);
          const currentSection = sections.find((section) =>
            section.segments.some((segment) => segment.index === current.currentSegmentIndex),
          )!;
          const requestedSection = sections.find((section) =>
            section.segments.some((segment) => segment.index === action.segmentIndex),
          )!;
          const nextIndex = requestedSection.endSegmentIndex;
          const currentSegment = brief.segments[current.currentSegmentIndex];
          const currentInteraction = current.informalInteractions.find(
            (entry) => entry.segmentIndex === current.currentSegmentIndex,
          );
          if (
            requestedSection.index > currentSection.index &&
            ((currentSegment?.informalCheck && !currentInteraction?.response) ||
              (currentSegment && !workedInteractionComplete(currentSegment, currentInteraction)))
          ) {
            throw new AppError(
              ApiErrorCode.ValidationError,
              'Commit a response to the current learning check before continuing.',
            );
          }
          if (
            requestedSection.index > currentSection.index + 1 &&
            !requestedSection.segments.every((segment) =>
              current.presentedSegmentIndexes.includes(segment.index),
            )
          )
            throw new AppError(
              ApiErrorCode.ValidationError,
              'Lesson segments must be presented in order.',
            );
          const requestedIndexes = requestedSection.segments.map((segment) => segment.index);
          const presented = [
            ...new Set([...current.presentedSegmentIndexes, ...requestedIndexes]),
          ].sort((a, b) => a - b);
          eventKind = requestedIndexes.every((index) =>
            current.presentedSegmentIndexes.includes(index),
          )
            ? 'segment_revisited'
            : 'segment_presented';
          eventPayload = { ...action, presentedSegmentIndexes: requestedIndexes };
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
          if (
            segment.informalCheck.kind === 'choose_alternative' &&
            segment.informalCheck.options &&
            !segment.informalCheck.options.some((option) => option.id === action.response)
          ) {
            throw new AppError(
              ApiErrorCode.ValidationError,
              'Select one offered informal-check option.',
            );
          }
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
        } else if (action.kind === 'respond_to_worked_interaction') {
          const segment = brief.segments.find(
            (candidate) => candidate.index === action.segmentIndex,
          );
          const workedProcess = segment?.workedProcess;
          const authored = workedProcess?.interaction;
          if (
            !segment ||
            !workedProcess ||
            !authored ||
            current.currentSegmentIndex !== segment.index
          ) {
            throw new AppError(
              ApiErrorCode.ValidationError,
              'Respond to the current worked interaction.',
            );
          }
          const existing = current.informalInteractions.find(
            (entry) => entry.segmentIndex === action.segmentIndex,
          );
          const expectedPhase = workedInteractionStage(workedProcess, existing);
          if (expectedPhase !== action.phase) {
            throw new AppError(
              ApiErrorCode.ValidationError,
              'The worked-interaction response phase is stale.',
            );
          }
          const phaseContent =
            action.phase === 'guided'
              ? authored.activity
              : action.phase === 'scaffold'
                ? authored.scaffold
                : authored.transfer;
          if (!phaseContent.options.some((option) => option.id === action.response)) {
            throw new AppError(
              ApiErrorCode.ValidationError,
              'Select one offered worked-interaction option.',
            );
          }
          const previousWorked = existing?.workedInteraction ?? {
            guidedResponse: null,
            guidedRespondedAt: null,
            scaffoldResponse: null,
            scaffoldRespondedAt: null,
            transferResponse: null,
            transferRespondedAt: null,
          };
          const workedInteraction = {
            ...previousWorked,
            ...(action.phase === 'guided'
              ? { guidedResponse: action.response, guidedRespondedAt: now }
              : action.phase === 'scaffold'
                ? { scaffoldResponse: action.response, scaffoldRespondedAt: now }
                : { transferResponse: action.response, transferRespondedAt: now }),
          };
          const interactions = existing
            ? current.informalInteractions.map((entry) =>
                entry.segmentIndex === action.segmentIndex
                  ? { ...entry, workedInteraction }
                  : entry,
              )
            : [
                ...current.informalInteractions,
                {
                  segmentIndex: action.segmentIndex,
                  presentedAt: now,
                  response: null,
                  respondedAt: null,
                  workedInteraction,
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
        } else if (
          action.kind === 'start_practice_retest' ||
          action.kind === 'submit_practice_retest'
        ) {
          if (!current.presentationCompletedAt || current.practiceCompletedAt || !brief.practice)
            throw new AppError(
              ApiErrorCode.ValidationError,
              'Retest requires unfinished Practice.',
            );
          const index = brief.practice.items.findIndex((_, i) => !practiceItemPassed(current, i));
          const attempt = failedPracticeAttempt(current, index);
          const recovery = attempt?.recovery;
          const round = recovery?.rounds.at(-1);
          if (
            !attempt ||
            !recovery ||
            !round ||
            round.responses.some((response) => !response.correct) ||
            round.responses.length >= 2
          )
            throw new AppError(
              ApiErrorCode.ValidationError,
              'Prepare targeted Repair before retesting.',
            );
          let updatedRound = round;
          if (action.kind === 'start_practice_retest') {
            if (round.startedAt)
              throw new AppError(ApiErrorCode.ValidationError, 'Retest already started.');
            updatedRound = { ...round, startedAt: now };
            eventKind = 'practice_retest_started';
          } else {
            if (!round.startedAt || action.index !== round.responses.length)
              throw new AppError(
                ApiErrorCode.ValidationError,
                'Respond to the current Retest question.',
              );
            const surface = round.content.retest[action.index]!;
            const option = surface.options.find((value) => value.id === action.optionId);
            if (!option)
              throw new AppError(ApiErrorCode.ValidationError, 'Select an offered Retest option.');
            updatedRound = {
              ...round,
              responses: [
                ...round.responses,
                {
                  selectedOptionId: option.id,
                  correct: option.id === surface.correctOptionId,
                  feedback: `${option.feedbackIfSelected} ${surface.explanation}`,
                  respondedAt: now,
                },
              ],
            };
            eventKind = 'practice_retest_response_recorded';
            eventPayload = {
              ...action,
              correct: option.id === surface.correctOptionId,
              credit: 'none',
            };
          }
          const candidate = {
            ...current,
            practiceInteractions: current.practiceInteractions.map((value) =>
              value === attempt
                ? {
                    ...value,
                    recovery: {
                      ...recovery,
                      ...(updatedRound.responses.some((response) => !response.correct)
                        ? { learnerNote: '' }
                        : {}),
                      rounds: [...recovery.rounds.slice(0, -1), updatedRound],
                    },
                  }
                : value,
            ),
          };
          const done = brief.practice.items.every((_, i) => practiceItemPassed(candidate, i));
          if (done) eventKind = 'practice_completed';
          next = repos.lessonExecution.update(
            {
              ...candidate,
              practiceCompletedAt: done ? now : null,
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
            return practiceItemPassed(current, itemIndex);
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
          if (priorAttempts.some((attempt) => !attempt.correct))
            throw new AppError(
              ApiErrorCode.ValidationError,
              'Use targeted Repair and Retest after a failed Practice answer.',
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
          const itemDone = correct;
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
          const unansweredChecks = brief.segments.filter((segment) => {
            const segmentInteraction = current.informalInteractions.find(
              (interaction) => interaction.segmentIndex === segment.index,
            );
            return (
              (segment.informalCheck && !segmentInteraction?.response) ||
              !workedInteractionComplete(segment, segmentInteraction)
            );
          });
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
      ...(projectPractice(brief, state)?.recovery
        ? (() => {
            const practice = projectPractice(brief, state)!;
            const recovery = practice.recovery!;
            const attempt = failedPracticeAttempt(state, practice.currentItemIndex)!;
            const failedRound = attempt.recovery?.rounds.findLast((round) =>
              round.responses.some((response) => !response.correct),
            );
            const failedIndex =
              failedRound?.responses.findIndex((response) => !response.correct) ?? -1;
            const question =
              failedIndex >= 0
                ? failedRound!.content.retest[failedIndex]!.prompt
                : brief.practice!.items[practice.currentItemIndex]![attempt.surface].prompt;
            return {
              practiceRecovery: {
                phase: recovery.phase,
                question,
                selectedAnswer: recovery.selectedAnswer,
                feedback: recovery.feedback.slice(0, 700),
                gap: recovery.diagnosis?.gap ?? null,
                explanation: recovery.teaching?.explanation.slice(0, 900) ?? null,
                learnerNote: recovery.learnerNote ?? '',
                credit: 'none',
              },
            };
          })()
        : {}),
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
