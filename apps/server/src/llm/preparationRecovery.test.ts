import { describe, expect, it } from 'vitest';
import {
  LessonSlotContentProposalPayloadSchema,
  PracticeContentProposalPayloadSchema,
} from '@hy3-clinic/shared';
import { AppError } from '../errors.js';
import { ProviderError } from './errors.js';
import {
  classifyPreparationError,
  classifyStructuredPreparationFailure,
  containsInternalTeachingAlias,
  mergeLocalizedAliasRepair,
  normalizeLessonPreparationCandidate,
  normalizePracticePreparationCandidate,
} from './preparationRecovery.js';

function surface(prompt = 'Which consequence follows from the changed condition?') {
  return {
    prompt,
    options: [
      { optionRef: 'A', text: 'The bounded consequence follows.', feedbackIfSelected: 'Correct.' },
      { optionRef: 'B', text: 'Nothing changes.', feedbackIfSelected: 'Recheck the condition.' },
      { optionRef: 'C', text: 'An unrelated result.', feedbackIfSelected: 'Outside scope.' },
    ],
    correctOptionRef: 'A',
    hint: 'Connect the condition and consequence.',
    explanation: 'The changed condition produces the bounded consequence.',
  };
}

function lessonCandidate(): Record<string, unknown> {
  return {
    narrative: {
      whyNow: 'This bounded mechanism matters before the next topic.',
      summary: 'The condition activates the mechanism and changes the result.',
    },
    slots: [
      {
        slotId: 'L1',
        explanation: 'The condition activates the mechanism and changes the result.',
        sourceRefs: ['S1'],
        example: null,
        contrast: null,
        misconception: null,
        informalCheck: null,
      },
    ],
  };
}

describe('preparation recovery normalization', () => {
  it('T1 converts only optional Lesson component nulls to omission', () => {
    const normalized = normalizeLessonPreparationCandidate(lessonCandidate());
    const slot = (normalized.candidate as { slots: Array<Record<string, unknown>> }).slots[0]!;

    expect(slot).not.toHaveProperty('example');
    expect(slot).not.toHaveProperty('contrast');
    expect(slot).not.toHaveProperty('misconception');
    expect(slot).not.toHaveProperty('informalCheck');
    expect(slot.workedProcess).toBeNull();
    expect(normalized.actions).toContainEqual({
      code: 'optional_null_omitted',
      paths: [
        'slots.0.example',
        'slots.0.contrast',
        'slots.0.misconception',
        'slots.0.informalCheck',
      ],
    });
    expect(LessonSlotContentProposalPayloadSchema.safeParse(normalized.candidate).success).toBe(
      true,
    );
  });

  it('T2 defaults only mechanically empty arrays and nullable sentinels', () => {
    const lesson = normalizeLessonPreparationCandidate(lessonCandidate());
    const lessonSlot = (lesson.candidate as { slots: Array<Record<string, unknown>> }).slots[0]!;
    expect(lessonSlot.visualRefs).toEqual([]);
    expect(lessonSlot.semanticRelations).toEqual([]);
    expect(
      (lesson.candidate as { narrative: { forwardBridge: unknown } }).narrative.forwardBridge,
    ).toBeNull();

    const practice = normalizePracticePreparationCandidate({
      items: [
        {
          practiceSlotId: 'PR1',
          capabilityTested: 'Explain the bounded relation.',
          pedagogicalReason: 'This requires a causal explanation.',
          sourceRefs: ['S1'],
          initial: surface(),
          retry: surface('Which result follows in a different bounded case?'),
        },
      ],
    });
    const item = (practice.candidate as { items: Array<Record<string, unknown>> }).items[0]!;
    expect(item.visualRefs).toEqual([]);
    expect(item.application).toBeNull();
    expect(PracticeContentProposalPayloadSchema.safeParse(practice.candidate).success).toBe(true);
  });

  it('T3 never invents missing substantive content or provenance', () => {
    const candidate = lessonCandidate();
    const slot = (candidate.slots as Array<Record<string, unknown>>)[0]!;
    delete slot.explanation;
    delete slot.sourceRefs;

    const normalized = normalizeLessonPreparationCandidate(candidate);
    const output = (normalized.candidate as { slots: Array<Record<string, unknown>> }).slots[0]!;
    expect(output).not.toHaveProperty('explanation');
    expect(output).not.toHaveProperty('sourceRefs');
    expect(LessonSlotContentProposalPayloadSchema.safeParse(normalized.candidate).success).toBe(
      false,
    );
  });

  it('normalizes known R1.3 representation mistakes without changing the worked interaction', () => {
    const candidate = lessonCandidate();
    const slot = (candidate.slots as Array<Record<string, unknown>>)[0]!;
    const workedProcess = {
      startingState: 'A bounded process has entered its initial state.',
      inputs: ['The current state', 'The active condition'],
      ruleOrProcedure: 'Check the active condition before selecting the next action.',
      steps: [
        {
          action: 'Inspect the active condition.',
          reason: 'It bounds the available action.',
          resultingState: 'The applicable action set is known.',
        },
        {
          action: 'Select the supported action.',
          reason: 'It follows the bounded rule.',
          resultingState: 'The process reaches its supported result.',
        },
      ],
      learnerDecision: 'Which supported action follows?',
      result: 'The supported action advances the process.',
      whyResultFollows: 'The selected action satisfies the active condition.',
      sourceRefs: ['S1'],
      interaction: {
        pauseAfterStepIndex: 0,
        sourceRefs: [],
        activity: {
          prompt: 'Which action should happen next?',
          options: [
            {
              id: 'A',
              text: 'Select the supported action.',
              feedbackIfSelected: 'Correct because it satisfies the condition.',
              misconception: null,
            },
            {
              id: 'B',
              text: 'Ignore the active condition.',
              feedbackIfSelected: 'The condition cannot be skipped.',
              misconception: {
                hypothesis: 'The condition is optional.',
                whyTempting: 'The familiar action looks sufficient.',
                correction: 'Check the condition before acting.',
              },
            },
            {
              id: 'C',
              text: 'Use an unrelated action.',
              feedbackIfSelected: 'That action has no bounded support.',
              misconception: {
                hypothesis: 'Any action advances the process.',
                whyTempting: 'All actions look operational.',
                correction: 'Only the condition-supported action applies.',
              },
            },
          ],
          correctOptionId: 'A',
          correctDebrief: 'The active condition determines the supported action.',
        },
        hint: 'Inspect the active condition.',
        scaffold: {
          prompt: 'Which fact narrows the action set?',
          options: [
            { id: 'A', text: 'The active condition.', feedbackIfSelected: 'Correct.' },
            { id: 'B', text: 'An unrelated label.', feedbackIfSelected: 'It has no effect.' },
          ],
          correctOptionId: 'A',
          debrief: 'The condition narrows the action set.',
        },
        transfer: {
          changedCondition: 'The condition is no longer active.',
          prompt: 'What changes now?',
          options: [
            { id: 'A', text: 'Keep the action.', feedbackIfSelected: 'Recheck the condition.' },
            { id: 'B', text: 'Withhold the action.', feedbackIfSelected: 'Correct.' },
            { id: 'C', text: 'Guess.', feedbackIfSelected: 'Guessing has no support.' },
          ],
          correctOptionId: 'B',
          debrief: 'Removing the condition changes the supported action.',
        },
      },
    };
    slot.workedProcess = workedProcess;

    const normalized = normalizeLessonPreparationCandidate(candidate);
    const output = (normalized.candidate as { slots: Array<Record<string, unknown>> }).slots[0]!;
    expect(output.workedProcess).toEqual(workedProcess);
  });

  it('T12 repairs only unambiguous R1.3 representation errors and leaves substantive gaps invalid', () => {
    const candidate = lessonCandidate();
    const slot = (candidate.slots as Array<Record<string, unknown>>)[0]!;
    slot.workedProcess = {
      interaction: {
        activity: {
          correctOptionId: 'A',
          options: [
            { id: 'A', text: 'Supported action.', feedbackIfSelected: 'Correct.' },
            { id: 'B', text: 'Wrong action.', feedbackIfSelected: 'Recheck the condition.' },
          ],
          hint: 'Inspect the active condition.',
          scaffold: {
            options: [
              {
                id: 'A',
                text: 'Active condition.',
                feedbackIfSelected: 'Correct.',
                misconception: null,
              },
            ],
          },
          transfer: {
            options: [
              {
                id: 'A',
                text: 'Withhold the action.',
                feedbackIfSelected: 'Correct.',
                misconception: { hypothesis: 'unsupported extra mapping' },
              },
            ],
          },
        },
      },
    };

    const normalized = normalizeLessonPreparationCandidate(candidate);
    const process = (normalized.candidate as { slots: Array<Record<string, unknown>> }).slots[0]!
      .workedProcess as {
      interaction: {
        activity: { options: Array<Record<string, unknown>>; hint?: unknown };
        hint: string;
        scaffold: { options: Array<Record<string, unknown>> };
        transfer: { options: Array<Record<string, unknown>> };
      };
    };
    expect(process.interaction.activity).not.toHaveProperty('hint');
    expect(process.interaction.hint).toBe('Inspect the active condition.');
    expect(process.interaction.activity.options[0]!.misconception).toBeNull();
    expect(process.interaction.activity.options[1]).not.toHaveProperty('misconception');
    expect(process.interaction.scaffold.options[0]).not.toHaveProperty('misconception');
    expect(process.interaction.transfer.options[0]).not.toHaveProperty('misconception');
    expect(LessonSlotContentProposalPayloadSchema.safeParse(normalized.candidate).success).toBe(
      false,
    );
    expect(normalized.actions.map((action) => action.code)).toEqual(
      expect.arrayContaining([
        'worked_interaction_fields_relocated',
        'nullable_field_defaulted',
        'unsupported_optional_mapping_removed',
      ]),
    );
  });
});

describe('preparation failure taxonomy and localized alias merge', () => {
  it('classifies the required transport, output, structural, semantic, and state families', () => {
    expect(classifyPreparationError(ProviderError.network(), 'lesson')).toEqual({
      failureClass: 'TRANSPORT',
      failureCode: 'provider_connection_failure',
    });
    expect(classifyStructuredPreparationFailure('TRUNCATED_OUTPUT')).toEqual({
      failureClass: 'OUTPUT',
      failureCode: 'truncated_output',
    });
    expect(
      classifyStructuredPreparationFailure('SEMANTIC_VALIDATION_FAILURE', [
        'missing_practice_slot',
      ]),
    ).toEqual({ failureClass: 'STRUCTURAL', failureCode: 'missing_immutable_slot' });
    expect(
      classifyStructuredPreparationFailure('SEMANTIC_VALIDATION_FAILURE', [
        'lesson_internal_alias_leak',
      ]),
    ).toEqual({ failureClass: 'SEMANTIC', failureCode: 'internal_alias_leak' });
    expect(classifyPreparationError(new AppError('VERSION_CONFLICT', 'stale'), 'lesson')).toEqual({
      failureClass: 'STATE',
      failureCode: 'fencing_version_conflict',
    });
    expect(
      classifyPreparationError(new AppError('VERSION_CONFLICT', 'checkpoint race'), 'checkpoint'),
    ).toEqual({ failureClass: 'STATE', failureCode: 'checkpoint_conflict' });
    expect(classifyPreparationError(new AppError('VERSION_CONFLICT', 'stale'), 'route')).toEqual({
      failureClass: 'STATE',
      failureCode: 'stale_operation',
    });
  });

  it('T4 keeps O1/L1/PR1/S1-style learner aliases as hard matches', () => {
    for (const value of ['Objective O1', 'Lesson L1', 'Practice PR1', 'source S1']) {
      expect(containsInternalTeachingAlias(value)).toBe(true);
    }
    expect(containsInternalTeachingAlias('ordinary learner prose')).toBe(false);
  });

  it('T5/T11/T13 merges only alias-bearing learner text and grants no refs, answers, or R1.3 changes', () => {
    const acceptedWorkedInteraction = {
      startingState: 'Accepted worked-process state.',
      inputs: ['Accepted input.'],
      interaction: {
        sourceRefs: [],
        hint: 'Accepted hint.',
        scaffold: { prompt: 'Accepted scaffold.' },
        transfer: { prompt: 'Accepted transfer.' },
      },
    };
    const previous = {
      narrative: { whyNow: 'Natural opening.', summary: 'Natural summary.', forwardBridge: null },
      slots: [
        {
          slotId: 'L1',
          explanation: 'Natural unchanged orientation.',
          sourceRefs: [],
          visualRefs: [],
          semanticRelations: [],
          workedProcess: null,
        },
        {
          slotId: 'L2',
          explanation: 'The bounded mechanism follows from S1.',
          sourceRefs: ['S1'],
          visualRefs: [],
          semanticRelations: [
            {
              kind: 'mechanism_effect',
              fromProposition: 'The S1 condition becomes active.',
              toProposition: 'The bounded result changes.',
              relevanceToObjective: 'This relation explains the bounded result.',
              sourceRefs: ['S1'],
            },
          ],
          workedProcess: acceptedWorkedInteraction,
          informalCheck: {
            kind: 'choose_alternative',
            prompt: 'Choose the bounded consequence.',
            expectedSignal: null,
            options: [
              { id: 'A', text: 'Supported result.', feedbackIfSelected: 'Correct.' },
              { id: 'B', text: 'Unsupported result.', feedbackIfSelected: 'Incorrect.' },
            ],
            correctOptionId: 'A',
          },
        },
      ],
    };
    const repaired = {
      slots: [
        {
          ...previous.slots[1],
          explanation: 'The bounded mechanism follows from the cited course material.',
          sourceRefs: ['S9'],
          semanticRelations: [
            {
              kind: 'cause_consequence',
              fromProposition: 'The cited course condition becomes active.',
              toProposition: 'Provider rewrote unrelated valid text.',
              relevanceToObjective: 'Provider rewrote unrelated valid text.',
              sourceRefs: ['S9'],
            },
          ],
          workedProcess: {
            startingState: 'Provider tried to replace the accepted process.',
            inputs: ['Provider replacement input.'],
            interaction: {
              sourceRefs: ['S9'],
              hint: 'Provider replacement hint.',
              scaffold: { prompt: 'Provider replacement scaffold.' },
              transfer: { prompt: 'Provider replacement transfer.' },
            },
          },
          informalCheck: {
            ...previous.slots[1]!.informalCheck,
            prompt: 'Provider tried to rewrite unrelated text.',
            correctOptionId: 'B',
          },
        },
      ],
    };
    const merged = mergeLocalizedAliasRepair(previous, repaired, 'slots', 'slotId', {
      rootNarrative: false,
      items: [{ itemId: 'L2', components: ['explanation', 'semanticRelations'] }],
    }) as typeof previous;

    expect(merged.slots[0]).toEqual(previous.slots[0]);
    expect(merged.slots[1]!.explanation).toBe(
      'The bounded mechanism follows from the cited course material.',
    );
    expect(merged.slots[1]!.sourceRefs).toEqual(['S1']);
    expect(merged.slots[1]!.workedProcess).toEqual(acceptedWorkedInteraction);
    expect(merged.slots[1]!.semanticRelations).toEqual([
      {
        kind: 'mechanism_effect',
        fromProposition: 'The cited course condition becomes active.',
        toProposition: 'The bounded result changes.',
        relevanceToObjective: 'This relation explains the bounded result.',
        sourceRefs: ['S1'],
      },
    ]);
    expect(merged.slots[1]!.informalCheck).toEqual(previous.slots[1]!.informalCheck);
  });
});
