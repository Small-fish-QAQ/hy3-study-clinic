import type { TeachingBrief, TeachingBriefSegment } from './teachingBrief.js';
import type { LessonExecutionState } from './lessonExecution.js';
import type { AcceptedLessonCheckpoint } from './teachingSkeleton.js';

export const TAUGHT_SURFACE_KINDS = [
  'explanation',
  'semantic_relation',
  'worked_process',
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

function processText(segment: TeachingBriefSegment): string {
  const process = segment.workedProcess;
  if (!process) return '';
  return [
    process.startingState,
    process.ruleOrProcedure,
    ...process.steps.flatMap((step) => [step.action, step.reason, step.resultingState]),
    process.learnerDecision ?? '',
    process.result,
    process.whyResultFollows,
  ].join('\n');
}

/** Exact learner-visible text for one approved teaching surface. */
export function teachingSurfaceText(
  segment: TeachingBriefSegment,
  kind: TaughtSurfaceKind,
  ordinal = 0,
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
      return segment.workedProcess ? processText(segment) : null;
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
): PresentedTeachingSurface['authority'] {
  if (kind === 'example' && segment.example) return segment.example.authority;
  if (kind === 'contrast' && segment.contrast) return segment.contrast.authority;
  if (kind === 'misconception')
    return segment.misconception?.authority ?? 'pedagogical_risk_candidate';
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
    const kinds: TaughtSurfaceKind[] = ['explanation'];
    if (segment.semanticRelations?.length) kinds.push('semantic_relation');
    if (segment.workedProcess) kinds.push('worked_process');
    if (segment.example) kinds.push('example');
    if (segment.contrast) kinds.push('contrast');
    if (segment.misconception) kinds.push('misconception');
    for (const kind of kinds) {
      const count = kind === 'semantic_relation' ? (segment.semanticRelations?.length ?? 0) : 1;
      for (let ordinal = 0; ordinal < count; ordinal += 1) {
        const text = teachingSurfaceText(segment, kind, ordinal);
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
          authority: surfaceAuthority(segment, kind),
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
