import {
  ApiErrorCode,
  PracticeRepairContentSchema,
  TAUGHT_SURFACE_KINDS,
  teachingSurfaceText,
  projectPracticePriorTeaching,
  type LearnerPracticeRecovery,
  type LessonExecutionState,
  type LessonPracticeItem,
  type PracticeRepairContent,
  type PracticeRecoveryState,
  type TeachingBrief,
} from '@hy3-clinic/shared';
import { AppError } from '../errors.js';
import type { PracticeRepairInput } from '../llm/provider.js';
import { compareLearnerPracticeTasks } from './practiceTaskCanonicalization.js';

export function practiceItemPassed(
  state: Pick<LessonExecutionState, 'practiceInteractions'>,
  itemIndex: number,
  acceptedRound?: (
    round: NonNullable<
      LessonExecutionState['practiceInteractions'][number]['recovery']
    >['rounds'][number],
  ) => boolean,
): boolean {
  return state.practiceInteractions.some(
    (attempt) =>
      attempt.itemIndex === itemIndex &&
      (attempt.correct ||
        attempt.recovery?.rounds.some(
          (round) =>
            (!acceptedRound || acceptedRound(round)) &&
            round.responses.length === 2 &&
            round.responses.every((response) => response.correct),
        )),
  );
}

export function failedPracticeAttempt(state: LessonExecutionState, itemIndex: number) {
  return state.practiceInteractions.findLast(
    (attempt) => attempt.itemIndex === itemIndex && !attempt.correct,
  );
}

/** The recovery panel reveals the original failed-choice feedback, then the
 * feedback of each failed Retest. Successful responses and the original stored
 * Practice hint are never rendered there. Lesson/Tutor hints have their own
 * learner-visible teaching projections. Keep display and review authority here.
 */
function revealedRecoveryFeedback(
  attempt: Pick<LessonExecutionState['practiceInteractions'][number], 'feedback'>,
  rounds: PracticeRecoveryState['rounds'],
): string[] {
  return [
    attempt.feedback,
    ...rounds.flatMap((round) => {
      const failed = round.responses.find((response) => !response.correct);
      return failed ? [failed.feedback] : [];
    }),
  ];
}

export function practiceRecoveryProjection(
  state: LessonExecutionState,
  item: LessonPracticeItem,
  itemIndex: number,
  generating: boolean,
  currentRoundAccepted = true,
): LearnerPracticeRecovery | null {
  if (state.practiceCompletedAt || (currentRoundAccepted && practiceItemPassed(state, itemIndex)))
    return null;
  const attempt = failedPracticeAttempt(state, itemIndex);
  if (!attempt) return null;
  const savedRounds = attempt.recovery?.rounds ?? [];
  const rounds = currentRoundAccepted ? savedRounds : [];
  const round = rounds.at(-1);
  const failed = round?.responses.some((response) => !response.correct);
  const phase = generating
    ? 'preparing'
    : (failed || !currentRoundAccepted) && savedRounds.length >= 3
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
    feedback: revealedRecoveryFeedback(attempt, rounds).at(-1)!,
    round: Math.min(
      3,
      savedRounds.length + (phase === 'diagnosis' || phase === 'preparing' ? 1 : 0),
    ),
    diagnosis:
      round && !failed
        ? {
            ...round.content.diagnosis,
            uncertainty: '这是根据这次回答作出的判断；读题疏漏也可能导致同样的选择。',
          }
        : null,
    teaching:
      round && (phase === 'repair' || phase === 'needs_support')
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
    teachingContext: [
      JSON.stringify(projectPracticePriorTeaching(brief)),
      ...brief.segments
        .flatMap((segment) =>
          TAUGHT_SURFACE_KINDS.flatMap((kind) =>
            Array.from(
              {
                length: kind === 'semantic_relation' ? (segment.semanticRelations?.length ?? 0) : 1,
              },
              (_, ordinal) =>
                teachingSurfaceText(
                  segment,
                  kind,
                  ordinal,
                  state.informalInteractions.find(
                    (interaction) => interaction.segmentIndex === segment.index,
                  ),
                ),
            ),
          ),
        )
        .filter((text): text is string => Boolean(text)),
    ],
    sourceExcerpts: brief.sourceReferences.map((reference) => reference.quote),
    priorRounds: rounds.map((round) => round.content),
    priorResponses: rounds.flatMap((round) =>
      round.responses.map(
        (response, responseIndex) =>
          `${round.content.retest[responseIndex]!.prompt}\nChosen: ${round.content.retest[responseIndex]!.options.find((option) => option.id === response.selectedOptionId)!.text}\n${response.feedback}`,
      ),
    ),
    visibleFeedback: revealedRecoveryFeedback(attempt, rounds),
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
      prior.some(
        (prompt) =>
          question.prompt === prompt ||
          compareLearnerPracticeTasks(
            { prompt: question.prompt, options: [] },
            { prompt, options: [] },
          ) === 'equal',
      ) ||
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
