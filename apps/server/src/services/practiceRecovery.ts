import {
  ApiErrorCode,
  PracticeRepairContentSchema,
  TAUGHT_SURFACE_KINDS,
  teachingSurfaceText,
  type LearnerPracticeRecovery,
  type LessonExecutionState,
  type LessonPracticeItem,
  type PracticeRepairContent,
  type TeachingBrief,
} from '@hy3-clinic/shared';
import { AppError } from '../errors.js';
import type { PracticeRepairInput, TeachingContentReviewInput } from '../llm/provider.js';
import { lexicalChallengeOverlap } from './masteryRedTeamPolicy.js';

export function practiceItemPassed(
  state: Pick<LessonExecutionState, 'practiceInteractions'>,
  itemIndex: number,
): boolean {
  return state.practiceInteractions.some(
    (attempt) =>
      attempt.itemIndex === itemIndex &&
      (attempt.correct ||
        attempt.recovery?.rounds.some(
          (round) =>
            round.responses.length === 2 && round.responses.every((response) => response.correct),
        )),
  );
}

export function failedPracticeAttempt(state: LessonExecutionState, itemIndex: number) {
  return state.practiceInteractions.findLast(
    (attempt) => attempt.itemIndex === itemIndex && !attempt.correct,
  );
}

export function practiceRecoveryProjection(
  state: LessonExecutionState,
  item: LessonPracticeItem,
  itemIndex: number,
  generating: boolean,
): LearnerPracticeRecovery | null {
  if (state.practiceCompletedAt || practiceItemPassed(state, itemIndex)) return null;
  const attempt = failedPracticeAttempt(state, itemIndex);
  if (!attempt) return null;
  const rounds = attempt.recovery?.rounds ?? [];
  const round = rounds.at(-1);
  const failed = round?.responses.some((response) => !response.correct);
  const phase = generating
    ? 'preparing'
    : failed && rounds.length >= 3
      ? 'needs_support'
      : !round || failed
        ? 'diagnosis'
        : !round.startedAt
          ? 'repair'
          : 'retest';
  const question = phase === 'retest' ? round?.content.retest[round.responses.length] : null;
  const triggeringRound = rounds.findLast((candidate) =>
    candidate.responses.some((response) => !response.correct),
  );
  const responseIndex = triggeringRound?.responses.findIndex((response) => !response.correct) ?? -1;
  const selectedAnswer =
    responseIndex >= 0
      ? triggeringRound!.content.retest[responseIndex]!.options.find(
          (option) => option.id === triggeringRound!.responses[responseIndex]!.selectedOptionId,
        )!.text
      : item[attempt.surface].options.find((option) => option.id === attempt.selectedOptionId)!
          .text;
  return {
    phase,
    selectedAnswer,
    learnerNote: attempt.recovery?.learnerNote ?? '',
    feedback: triggeringRound?.responses.at(-1)?.feedback ?? attempt.feedback,
    round: Math.min(3, rounds.length + (phase === 'diagnosis' || phase === 'preparing' ? 1 : 0)),
    diagnosis:
      round && !failed
        ? {
            ...round.content.diagnosis,
            uncertainty: '这是根据这次回答作出的判断；读题疏漏也可能导致同样的选择。',
          }
        : null,
    teaching:
      phase === 'repair' || phase === 'needs_support'
        ? {
            explanation: round!.content.explanation,
            workedExample: round!.content.workedExample,
            contrast: round!.content.contrast,
          }
        : null,
    retest: question
      ? {
          index: round!.responses.length,
          prompt: question.prompt,
          options: question.options.map(({ id, text }) => ({ id, text })),
        }
      : null,
  };
}

export function practiceRepairInput(
  brief: TeachingBrief,
  state: LessonExecutionState,
  index: number,
  learnerNote: string,
  context: Pick<PracticeRepairInput, 'desiredDepth' | 'unitFocus' | 'archivedRetestPrompts'>,
): PracticeRepairInput {
  const item = brief.practice!.items[index]!;
  const attempt = failedPracticeAttempt(state, index)!;
  const rounds = attempt.recovery?.rounds ?? [];
  const previous = rounds.at(-1);
  const failedIndex = previous?.responses.findIndex((response) => !response.correct) ?? -1;
  const surface = failedIndex >= 0 ? previous!.content.retest[failedIndex]! : item[attempt.surface];
  const selected =
    failedIndex >= 0
      ? previous!.responses[failedIndex]!.selectedOptionId
      : attempt.selectedOptionId;
  return {
    ...context,
    objective: {
      objectiveTitle: item.objectiveTitle,
      construct: item.construct,
      capabilityTested: item.capabilityTested,
    },
    failedPrompt: surface.prompt,
    selectedAnswer: surface.options.find((option) => option.id === selected)!.text,
    feedback: surface.options.find((option) => option.id === selected)!.feedbackIfSelected,
    failedCase: {
      options: surface.options.map((option) => option.text),
      expectedAnswer: surface.options.find((option) => option.id === surface.correctOptionId)!.text,
      explanation: surface.explanation,
    },
    learnerNote,
    teachingContext: brief.segments
      .filter((segment) => segment.objectiveIds.includes(item.objectiveId))
      .flatMap((segment) =>
        TAUGHT_SURFACE_KINDS.map((kind) =>
          teachingSurfaceText(
            segment,
            kind,
            0,
            state.informalInteractions.find(
              (interaction) => interaction.segmentIndex === segment.index,
            ),
          ),
        ),
      )
      .filter((text): text is string => Boolean(text)),
    sourceExcerpts: brief.sourceReferences.map((reference) => reference.quote).slice(0, 6),
    priorRounds: rounds.map((round) => round.content),
    priorResponses: rounds.flatMap((round) =>
      round.responses.map(
        (response, responseIndex) =>
          `${round.content.retest[responseIndex]!.prompt}\nChosen: ${round.content.retest[responseIndex]!.options.find((option) => option.id === response.selectedOptionId)!.text}\n${response.feedback}`,
      ),
    ),
    unseenPracticePrompts: brief.practice!.items.flatMap((candidate) => [
      candidate.initial.prompt,
      candidate.retry.prompt,
    ]),
  };
}

export function validatePracticeRepair(
  value: unknown,
  input: PracticeRepairInput,
): PracticeRepairContent {
  const content = PracticeRepairContentSchema.parse(value);
  const prior = [
    input.failedPrompt,
    ...(input.tutorExplanations ?? []).flatMap((text) => [text, ...text.split(/\n+/u)]),
    ...input.unseenPracticePrompts,
    ...input.archivedRetestPrompts,
    ...input.priorRounds.flatMap((round) => [
      round.workedExample.prompt,
      ...round.retest.map((item) => item.prompt),
    ]),
    content.workedExample.prompt,
  ];
  for (const question of content.retest) {
    if (
      prior.some((prompt) => lexicalChallengeOverlap(question.prompt, prompt) >= 0.72) ||
      (input.tutorExplanations ?? []).some((text) =>
        text.replace(/\s+/gu, '').includes(question.prompt.replace(/\s+/gu, '')),
      )
    ) {
      throw new AppError(
        ApiErrorCode.ValidationError,
        'Retest repeats an exposed or reserved case.',
      );
    }
    prior.push(question.prompt);
  }
  return content;
}

export function practiceRepairReview(
  input: PracticeRepairInput,
  content: PracticeRepairContent,
): TeachingContentReviewInput {
  return {
    stage: 'practice',
    desiredDepth: input.desiredDepth,
    objectives: [
      { title: input.objective.objectiveTitle, description: input.objective.capabilityTested },
    ],
    sources: input.sourceExcerpts.map((text, index) => ({ sourceRef: `S${index + 1}`, text })),
    acceptedLesson: {
      failedQuestion: input.failedPrompt,
      selectedAnswer: input.selectedAnswer,
      failedCase: input.failedCase,
      failedChoiceFeedback: input.feedback,
      learnerNote: input.learnerNote,
      priorTeaching: input.teachingContext,
      priorRounds: input.priorRounds.map((round) => ({
        explanation: round.explanation,
        workedExample: round.workedExample,
        retestPrompts: round.retest.map((item) => item.prompt),
      })),
      reservedPractice: input.unseenPracticePrompts,
      archivedRetestPrompts: input.archivedRetestPrompts,
    },
    candidate: {
      itemId: 'repair',
      authority: 'supplementary',
      diagnosis: content.diagnosis,
      explanation: content.explanation,
      workedExample: content.workedExample,
      contrast: content.contrast,
      retest: content.retest.map((item, index) => ({
        itemId: `retest${index}`,
        actionId: `retest${index}.check`,
        prompt: item.prompt,
        options: item.options.map(({ id, text }) => ({ id, text })),
        visibility: 'Self-contained question. Answer keys and feedback withheld until commitment.',
      })),
    },
    actionIds: ['retest0.check', 'retest1.check'],
  };
}
