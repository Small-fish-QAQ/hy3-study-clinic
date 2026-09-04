import type { TeachingBrief, TeachingBriefSegment } from './teachingBrief.js';
import type { LessonExecutionState, LessonInformalInteractionState } from './lessonExecution.js';
import type { AcceptedLessonCheckpoint } from './teachingSkeleton.js';

export const TAUGHT_SURFACE_KINDS = [
  'explanation',
  'semantic_relation',
  'worked_process',
  'worked_interaction',
  'example',
  'contrast',
  'misconception',
] as const;
export type TaughtSurfaceKind = (typeof TAUGHT_SURFACE_KINDS)[number];

export interface PresentedTeachingSurface {
  checkpointId: string;
  skeletonFingerprint: string;
  sourceContextFingerprint: string;
  curriculumVersionId: string;
  studyPlanVersionId: string;
  learningUnitId: string;
  executionSourceManifestFingerprint: string;
  segmentIndex: number;
  surfaceKind: TaughtSurfaceKind;
  surfaceOrdinal: number;
  text: string;
  objectiveIds: string[];
  authority: 'source_backed_teaching' | 'ai_teaching_synthesis' | 'pedagogical_risk_candidate';
  sourceRefIds: string[];
}

export interface TaughtExposureProjection {
  objectiveIds: string[];
  presentedSegmentIndexes: number[];
  exposureClass: 'source_backed' | 'ai_teaching' | 'mixed';
  surfaces: PresentedTeachingSurface[];
}

function processText(
  segment: TeachingBriefSegment,
  interactionState?: LessonInformalInteractionState,
): string {
  const process = segment.workedProcess;
  if (!process) return '';
  const interaction = process.interaction;
  const progress = interactionState?.workedInteraction;
  const guidedCorrect = progress?.guidedResponse
    ? progress.guidedResponse === interaction?.activity.correctOptionId
    : null;
  const continuationVisible = Boolean(guidedCorrect || progress?.scaffoldResponse);
  const visibleSteps = interaction
    ? continuationVisible
      ? process.steps
      : process.steps.slice(0, interaction.pauseAfterStepIndex + 1)
    : process.steps;
  return [
    process.startingState,
    ...(process.inputs ?? []),
    process.ruleOrProcedure,
    ...visibleSteps.flatMap((step) => [step.action, step.reason, step.resultingState]),
    process.learnerDecision ?? '',
    continuationVisible || !interaction ? process.result : '',
    progress?.transferResponse || !interaction ? process.whyResultFollows : '',
  ].join('\n');
}

function workedInteractionText(
  segment: TeachingBriefSegment,
  interactionState?: LessonInformalInteractionState,
): string {
  const interaction = segment.workedProcess?.interaction;
  if (!interaction) return '';
  const progress = interactionState?.workedInteraction;
  const guidedOption = interaction.activity.options.find(
    (option) => option.id === progress?.guidedResponse,
  );
  const guidedCorrect = progress?.guidedResponse
    ? progress.guidedResponse === interaction.activity.correctOptionId
    : null;
  const continuationVisible = Boolean(guidedCorrect || progress?.scaffoldResponse);
  const scaffoldOption = interaction.scaffold.options.find(
    (option) => option.id === progress?.scaffoldResponse,
  );
  const transferOption = interaction.transfer.options.find(
    (option) => option.id === progress?.transferResponse,
  );
  return [
    interaction.activity.prompt,
    ...interaction.activity.options.map((option) => option.text),
    guidedOption?.feedbackIfSelected,
    guidedCorrect === false ? guidedOption?.misconception?.hypothesis : undefined,
    guidedCorrect === false ? guidedOption?.misconception?.whyTempting : undefined,
    guidedCorrect === false ? guidedOption?.misconception?.correction : undefined,
    guidedCorrect === false ? interaction.hint : undefined,
    guidedCorrect === false ? interaction.scaffold.prompt : undefined,
    ...(guidedCorrect === false ? interaction.scaffold.options.map((option) => option.text) : []),
    scaffoldOption?.feedbackIfSelected,
    progress?.scaffoldResponse ? interaction.scaffold.debrief : undefined,
    continuationVisible ? interaction.activity.correctDebrief : undefined,
    continuationVisible ? interaction.transfer.changedCondition : undefined,
    continuationVisible ? interaction.transfer.prompt : undefined,
    ...(continuationVisible ? interaction.transfer.options.map((option) => option.text) : []),
    transferOption?.feedbackIfSelected,
    progress?.transferResponse ? interaction.transfer.debrief : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join('\n');
}

/** Exact learner-visible text for one approved teaching surface. */
export function teachingSurfaceText(
  segment: TeachingBriefSegment,
  kind: TaughtSurfaceKind,
  ordinal = 0,
  interactionState?: LessonInformalInteractionState,
): string | null {
  switch (kind) {
    case 'explanation':
      return segment.explanation;
    case 'semantic_relation': {
      const relation = segment.semanticRelations?.[ordinal];
      return relation
        ? `${relation.fromProposition} → ${relation.toProposition}\n${relation.relevanceToObjective}`
        : null;
    }
    case 'worked_process':
      return segment.workedProcess ? processText(segment, interactionState) : null;
    case 'worked_interaction':
      return segment.workedProcess?.interaction
        ? workedInteractionText(segment, interactionState)
        : null;
    case 'example':
      return segment.example?.text ?? null;
    case 'contrast':
      return segment.contrast?.text ?? null;
    case 'misconception':
      return segment.misconception
        ? `${segment.misconception.hypothesis}\n${segment.misconception.correction}`
        : null;
  }
}

function surfaceAuthority(
  segment: TeachingBriefSegment,
  kind: TaughtSurfaceKind,
  ordinal: number,
): PresentedTeachingSurface['authority'] {
  if (kind === 'example' && segment.example) return segment.example.authority;
  if (kind === 'contrast' && segment.contrast) return segment.contrast.authority;
  if (kind === 'misconception')
    return segment.misconception?.authority ?? 'pedagogical_risk_candidate';
  if (kind === 'semantic_relation')
    return segment.semanticRelations?.[ordinal]?.sourceRefIds.length
      ? 'source_backed_teaching'
      : 'ai_teaching_synthesis';
  if (kind === 'worked_process')
    return segment.workedProcess?.sourceRefIds.length
      ? 'source_backed_teaching'
      : 'ai_teaching_synthesis';
  if (kind === 'worked_interaction')
    return segment.workedProcess?.interaction?.sourceRefs.length
      ? 'source_backed_teaching'
      : 'ai_teaching_synthesis';
  return segment.explanationAuthority;
}

function surfaceSources(
  segment: TeachingBriefSegment,
  kind: TaughtSurfaceKind,
  ordinal: number,
): string[] {
  if (kind === 'example') return segment.example?.sourceRefIds ?? [];
  if (kind === 'contrast') return segment.contrast?.sourceRefIds ?? [];
  if (kind === 'misconception') return segment.misconception?.sourceRefIds ?? [];
  if (kind === 'semantic_relation') return segment.semanticRelations?.[ordinal]?.sourceRefIds ?? [];
  if (kind === 'worked_process') return segment.workedProcess?.sourceRefIds ?? [];
  if (kind === 'worked_interaction') return segment.workedProcess?.interaction?.sourceRefs ?? [];
  return segment.sourceRefIds;
}

/**
 * Derive exactly what was presented from the accepted Brief and execution
 * state. A ready state with a presented segment is sufficient; whole-Lesson
 * completion is intentionally not required.
 */
export function projectTaughtExposure(input: {
  brief: Pick<
    TeachingBrief,
    | 'id'
    | 'workspaceId'
    | 'curriculumVersionId'
    | 'studyPlanVersionId'
    | 'learningUnitId'
    | 'executionSourceManifestFingerprint'
    | 'sourceContextFingerprint'
    | 'segments'
    | 'composition'
  >;
  state: Pick<
    LessonExecutionState,
    | 'preparationStatus'
    | 'teachingBriefId'
    | 'acceptedLessonCheckpointId'
    | 'curriculumVersionId'
    | 'studyPlanVersionId'
    | 'learningUnitId'
    | 'executionSourceManifestFingerprint'
    | 'sourceContextFingerprint'
    | 'presentedSegmentIndexes'
    | 'informalInteractions'
  >;
  checkpoint: Pick<
    AcceptedLessonCheckpoint,
    | 'id'
    | 'workspaceId'
    | 'curriculumVersionId'
    | 'studyPlanVersionId'
    | 'learningUnitId'
    | 'executionSourceManifestFingerprint'
    | 'sourceContextFingerprint'
    | 'skeleton'
  >;
  currentRoute?: {
    curriculumVersionId: string;
    studyPlanVersionId: string;
    learningUnitId: string;
    executionSourceManifestFingerprint: string;
  };
}): TaughtExposureProjection | null {
  const { brief, state, checkpoint, currentRoute } = input;
  if (
    state.preparationStatus !== 'ready' ||
    state.teachingBriefId !== brief.id ||
    state.curriculumVersionId !== brief.curriculumVersionId ||
    state.studyPlanVersionId !== brief.studyPlanVersionId ||
    state.learningUnitId !== brief.learningUnitId ||
    state.executionSourceManifestFingerprint !== brief.executionSourceManifestFingerprint ||
    state.sourceContextFingerprint !== brief.sourceContextFingerprint ||
    brief.composition?.acceptedLessonCheckpointId !== checkpoint.id ||
    state.acceptedLessonCheckpointId !== checkpoint.id ||
    checkpoint.workspaceId !== brief.workspaceId ||
    checkpoint.curriculumVersionId !== brief.curriculumVersionId ||
    checkpoint.studyPlanVersionId !== brief.studyPlanVersionId ||
    checkpoint.learningUnitId !== brief.learningUnitId ||
    checkpoint.executionSourceManifestFingerprint !== brief.executionSourceManifestFingerprint ||
    checkpoint.sourceContextFingerprint !== brief.sourceContextFingerprint ||
    brief.composition.skeletonFingerprint !== checkpoint.skeleton.fingerprint ||
    (currentRoute &&
      (currentRoute.curriculumVersionId !== state.curriculumVersionId ||
        currentRoute.studyPlanVersionId !== state.studyPlanVersionId ||
        currentRoute.learningUnitId !== state.learningUnitId ||
        currentRoute.executionSourceManifestFingerprint !==
          state.executionSourceManifestFingerprint))
  ) {
    return null;
  }
  const presented = new Set(state.presentedSegmentIndexes);
  const segments = brief.segments.filter((segment) => presented.has(segment.index));
  const surfaces: PresentedTeachingSurface[] = [];
  for (const segment of segments) {
    const interactionState = state.informalInteractions.find(
      (interaction) => interaction.segmentIndex === segment.index,
    );
    const kinds: TaughtSurfaceKind[] = ['explanation'];
    if (segment.semanticRelations?.length) kinds.push('semantic_relation');
    if (segment.workedProcess) kinds.push('worked_process');
    if (segment.workedProcess?.interaction) kinds.push('worked_interaction');
    if (segment.example) kinds.push('example');
    if (segment.contrast) kinds.push('contrast');
    if (segment.misconception) kinds.push('misconception');
    for (const kind of kinds) {
      const count = kind === 'semantic_relation' ? (segment.semanticRelations?.length ?? 0) : 1;
      for (let ordinal = 0; ordinal < count; ordinal += 1) {
        const text = teachingSurfaceText(segment, kind, ordinal, interactionState);
        if (!text) continue;
        surfaces.push({
          checkpointId: checkpoint.id,
          skeletonFingerprint: checkpoint.skeleton.fingerprint,
          sourceContextFingerprint: brief.sourceContextFingerprint,
          curriculumVersionId: brief.curriculumVersionId,
          studyPlanVersionId: brief.studyPlanVersionId,
          learningUnitId: brief.learningUnitId,
          executionSourceManifestFingerprint: brief.executionSourceManifestFingerprint,
          segmentIndex: segment.index,
          surfaceKind: kind,
          surfaceOrdinal: ordinal,
          text,
          objectiveIds: [...segment.objectiveIds],
          authority: surfaceAuthority(segment, kind, ordinal),
          sourceRefIds: surfaceSources(segment, kind, ordinal),
        });
      }
    }
  }
  const objectiveIds = [...new Set(segments.flatMap((segment) => segment.objectiveIds))];
  const hasSource = surfaces.some((surface) => surface.authority === 'source_backed_teaching');
  const hasAi = surfaces.some((surface) => surface.authority === 'ai_teaching_synthesis');
  return {
    objectiveIds,
    presentedSegmentIndexes: segments.map((segment) => segment.index),
    exposureClass: hasSource && hasAi ? 'mixed' : hasAi ? 'ai_teaching' : 'source_backed',
    surfaces,
  };
}
