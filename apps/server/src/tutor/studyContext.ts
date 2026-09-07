import {
  ApiErrorCode,
  LessonTutorContextSchema,
  type LessonExecutionProjection,
  type LessonExecutionState,
  type LearnerPracticeProjection,
  type LessonSegmentProjection,
  type LessonTutorContext,
  type TutorStudyAnchor,
} from '@hy3-clinic/shared';
import { AppError } from '../errors.js';

/** Consume the learner projection, never the private authored Teaching Brief. */
export function visibleSegmentText(segment: LessonSegmentProjection): string {
  const process = segment.workedProcess;
  const interaction = process?.interaction;
  const parts = [
    `${segment.explanationOrigin === 'source_grounded' ? '依据资料' : 'Hy3 补充讲解'}：${segment.explanation}`,
    ...(segment.semanticRelations ?? []).map(
      (link) =>
        `${link.origin === 'source_grounded' ? '依据资料' : '补充说明'}：${link.fromProposition} → ${link.toProposition}`,
    ),
    ...(process
      ? [
          process.origin === 'source_grounded' ? '以下推演依据资料：' : '以下推演为补充教学案例：',
          process.startingState,
          ...(process.inputs ?? []),
          process.ruleOrProcedure,
          ...process.steps.flatMap((step) => [step.action, step.reason, step.resultingState]),
          process.learnerDecision,
          process.result,
          process.whyResultFollows,
        ]
      : []),
    // These fields are already gated by the Lesson projection's response state.
    ...(interaction ? strings(interaction) : []),
    segment.example
      ? `${segment.example.origin === 'source_grounded' ? '依据资料的示例' : '补充示例'}：${segment.example.text}`
      : null,
    segment.contrast
      ? `${segment.contrast.origin === 'source_grounded' ? '依据资料的对比' : '补充对比'}：${segment.contrast.text}`
      : null,
    segment.possibleMisconception?.hypothesis,
    segment.possibleMisconception?.correction,
    ...(segment.informalCheck?.presented ? strings(segment.informalCheck) : []),
  ];
  return parts.filter((part): part is string => Boolean(part)).join('\n');
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) =>
    /^(id|.*Id|origin|credit|stage|kind|.*At|classification|referenceKey)$/.test(key)
      ? []
      : strings(child),
  );
}

const normalize = (text: string) => text.replace(/\s+/gu, '');

export function enrichTutorContext(
  base: LessonTutorContext,
  lesson: NonNullable<LessonExecutionProjection['lesson']>,
  state: LessonExecutionState,
  practice: LearnerPracticeProjection | null,
  anchor: TutorStudyAnchor | undefined,
  courseDesign: NonNullable<LessonTutorContext['courseDesign']>,
): LessonTutorContext {
  const presented = new Set(state.presentedSegmentIndexes);
  if (anchor?.segmentIndex !== undefined && !presented.has(anchor.segmentIndex)) {
    throw new AppError(ApiErrorCode.VersionConflict, '这段讲解还未呈现，请选择当前可见的内容。');
  }
  const visible = lesson.segments.filter((segment) => presented.has(segment.index));
  const focused = anchor?.segmentIndex ?? state.currentSegmentIndex;
  const ordered = [...visible].sort(
    (a, b) => Math.abs(a.index - focused) - Math.abs(b.index - focused),
  );
  let remaining = 20000;
  const visibleLesson = ordered
    .map((segment) => {
      const full = visibleSegmentText(segment);
      const text = full.slice(0, Math.min(9000, remaining));
      remaining -= text.length;
      return { index: segment.index, text };
    })
    .filter((segment) => segment.text)
    .sort((a, b) => a.index - b.index);
  const recovery = practice?.recovery;
  const segment = visible.find((value) => value.index === state.currentSegmentIndex);
  const interaction = segment?.workedProcess?.interaction;
  const check =
    interaction?.stage === 'guided'
      ? interaction.activity
      : interaction?.stage === 'scaffold'
        ? interaction.scaffold
        : interaction?.stage === 'transfer'
          ? interaction.transfer
          : segment?.informalCheck;
  const priorRound = state.practiceInteractions
    .findLast((attempt) => attempt.itemIndex === practice?.currentItemIndex && !attempt.correct)
    ?.recovery?.rounds.at(-1);
  const shownRepair =
    recovery?.teaching ??
    (recovery?.phase === 'retest' && priorRound?.startedAt
      ? {
          explanation: priorRound.content.explanation,
          workedExample: priorRound.content.workedExample,
          contrast: priorRound.content.contrast,
        }
      : null);
  const repairTeaching = shownRepair ? strings(shownRepair).join('\n').slice(0, 7000) : undefined;
  const activeQuestion: LessonTutorContext['activeQuestion'] = recovery?.retest
    ? {
        kind: 'retest',
        prompt: recovery.retest.prompt,
        options: recovery.retest.options,
        learnerResponse: null,
      }
    : practice?.item && practice.status !== 'locked'
      ? {
          kind: 'practice',
          prompt: practice.item.prompt,
          options: practice.item.options,
          learnerResponse: null,
        }
      : check && !check.response
        ? {
            kind: 'inline_check',
            prompt: check.prompt,
            options: check.options ?? [],
            learnerResponse: check.response,
          }
        : undefined;
  if (anchor?.selectedText) {
    const permitted = [
      ...visible
        .filter(
          (segment) => anchor.segmentIndex === undefined || segment.index === anchor.segmentIndex,
        )
        .flatMap((segment) => strings(segment)),
      ...strings(lesson.objective),
      ...(state.presentationCompletedAt ? strings(lesson.summary) : []),
      ...strings(activeQuestion),
      ...strings(recovery),
    ];
    const selected = normalize(anchor.selectedText);
    if (!permitted.some((text) => normalize(text).includes(selected))) {
      throw new AppError(ApiErrorCode.VersionConflict, '所选内容已变化，请回到讲解重新选择。');
    }
  }
  const sources = [
    ...new Map(
      [
        ...ordered.flatMap((segment) => [
          ...segment.sources,
          ...(segment.workedProcess?.sources ?? []),
          ...(segment.example?.sources ?? []),
          ...(segment.contrast?.sources ?? []),
        ]),
        ...base.sources,
      ].map((source) => [source.referenceKey, source]),
    ).values(),
  ].slice(0, 6);
  return LessonTutorContextSchema.parse({
    ...base,
    ...(!presented.has(base.currentSegment.index)
      ? {
          currentSegment: {
            ...base.currentSegment,
            explanation: lesson.objective.whyNow,
            example: null,
            contrast: null,
            possibleMisconception: null,
            informalCheck: null,
          },
        }
      : {}),
    identity: { stateId: state.id, version: state.version },
    phase:
      recovery?.phase ??
      (state.practiceCompletedAt
        ? 'completed'
        : state.presentationCompletedAt
          ? 'practice'
          : 'lesson'),
    courseDesign,
    ...(anchor?.selectedText ? { selectedText: anchor.selectedText } : {}),
    visibleLesson,
    ...(activeQuestion ? { activeQuestion } : {}),
    ...(repairTeaching ? { repairTeaching } : {}),
    sources,
    nearbySegments: base.nearbySegments.filter((segment) => segment.relation === 'previous'),
    summary: state.presentationCompletedAt ? base.summary : null,
    nextConnection: state.presentationCompletedAt ? base.nextConnection : null,
  });
}
