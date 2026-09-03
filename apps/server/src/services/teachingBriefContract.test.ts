import { describe, expect, it } from 'vitest';
import { TeachingBriefProposalPayloadSchema, type TeachingBriefSegment } from '@hy3-clinic/shared';
import type {
  LessonSlotContentGenerationInput,
  PracticeContentGenerationInput,
  TeachingBriefGenerationInput,
} from '../llm/provider.js';
import { FakeProvider } from '../llm/fakeProvider.js';
import { lessonSlotContentMessages } from '../llm/prompts.js';
import {
  validateLessonSlotContentCandidate,
  validatePracticeContentCandidate,
  validateTeachingBriefCandidate,
} from './teachingBriefContract.js';
import { profileTeachingBrief } from './teachingBriefQuality.js';
import { planTeachingSkeleton } from './teachingSkeletonPlanner.js';

function input(): TeachingBriefGenerationInput {
  return {
    workspaceName: 'Course',
    learningUnit: {
      title: 'Unit',
      objectives: [
        {
          objectiveRef: 'O1',
          title: 'Objective mechanism',
          description: 'Explain how the objective mechanism works.',
          priority: 'required',
          construct: 'explain',
          authorityEnvelopeTier: 'teaching_only',
          practiceAuthority: 'exact_teaching',
        },
      ],
      concepts: [],
      canonicalConcepts: [],
    },
    prerequisites: [{ prerequisiteRef: 'P1', title: 'Prior unit', objectiveSummaries: [] }],
    nextConnection: null,
    sourceContext: {
      fingerprint: 'context_1',
      blockCount: 1,
      offerCount: 1,
      serializedBytes: 10,
      materialCount: 1,
      sectionCount: 1,
      offers: [
        {
          sourceRef: 'S1',
          materialTitle: 'Material',
          headingPath: ['Section'],
          pageNumber: null,
          slideNumber: null,
          text: 'Source.',
          authorizedObjectiveRefs: ['O1'],
        },
      ],
    },
    limits: { maxSegments: 12, maxSourceRefsPerSegment: 8, maxFormalOpportunities: 8 },
    plannedMinutes: 20,
  };
}

function payload() {
  return TeachingBriefProposalPayloadSchema.parse({
    whyNow: 'It is next.',
    prerequisites: [{ prerequisiteRef: 'P1', reason: 'Needed.', readinessHint: null }],
    segments: [
      {
        purpose: 'objective_orientation',
        objectiveRefs: ['O1'],
        explanation: 'Learn the Objective mechanism now because later decisions depend on it.',
        explanationAuthority: 'ai_teaching_synthesis',
        sourceRefs: [],
      },
      {
        purpose: 'explanation',
        objectiveRefs: ['O1'],
        explanation:
          'The Objective mechanism works because the source condition controls the result.',
        explanationAuthority: 'source_backed_teaching',
        sourceRefs: ['S1'],
      },
      {
        purpose: 'mechanism',
        objectiveRefs: ['O1'],
        explanation:
          'When the source condition holds, the Objective mechanism therefore changes the result.',
        explanationAuthority: 'source_backed_teaching',
        sourceRefs: ['S1'],
      },
      {
        purpose: 'worked_example',
        objectiveRefs: ['O1'],
        explanation:
          'First inspect the condition, then trace its effect, and finally justify the result.',
        explanationAuthority: 'ai_teaching_synthesis',
        sourceRefs: ['S1'],
        example: {
          text: 'Given a small case, first mark the condition, next infer the consequence, then state the result.',
          authority: 'ai_teaching_synthesis',
          sourceRefs: [],
        },
      },
      {
        purpose: 'contrast',
        objectiveRefs: ['O1'],
        explanation:
          'Compare causal Objective reasoning with a surface label that does not explain why.',
        explanationAuthority: 'ai_teaching_synthesis',
        sourceRefs: ['S1'],
        contrast: {
          text: 'One account uses the condition; the other only repeats vocabulary.',
          authority: 'ai_teaching_synthesis',
          sourceRefs: [],
        },
      },
      {
        purpose: 'guided_practice',
        objectiveRefs: ['O1'],
        explanation:
          'Explain why the Objective condition controls a new case, then commit your reasoning.',
        explanationAuthority: 'ai_teaching_synthesis',
        sourceRefs: ['S1'],
        informalCheck: {
          kind: 'own_words',
          prompt: 'Explain how the Objective mechanism controls the result.',
          expectedSignal: 'Connect the condition to the result.',
        },
      },
    ],
    formalOpportunities: ['A later assessment can attach here.'],
    summary: 'Summary.',
    nextConnection: null,
    practice: {
      items: [
        {
          objectiveRef: 'O1',
          construct: 'explain',
          capabilityTested: 'Explain the Objective mechanism from condition to result.',
          pedagogicalReason: 'This checks causal explanation rather than source-location recall.',
          authority: 'exact_source',
          sourceRefs: ['S1'],
          visualRefs: [],
          initial: {
            prompt:
              'Which explanation best shows how and why the Objective mechanism changes the result?',
            options: [
              {
                optionRef: 'A',
                text: 'It traces the condition to its consequence.',
                feedbackIfSelected: 'Correct.',
              },
              {
                optionRef: 'B',
                text: 'It repeats the label.',
                feedbackIfSelected: 'Surface recall.',
              },
              {
                optionRef: 'C',
                text: 'It ignores the condition.',
                feedbackIfSelected: 'Missing cause.',
              },
            ],
            correctOptionRef: 'A',
            hint: 'Look for causal reasoning.',
            explanation: 'The condition explains the consequence.',
          },
          retry: {
            prompt:
              'In a changed case, which account best explains why the Objective result must be narrowed?',
            options: [
              {
                optionRef: 'A',
                text: 'The label looks similar.',
                feedbackIfSelected: 'Not causal.',
              },
              {
                optionRef: 'B',
                text: 'A required condition changed.',
                feedbackIfSelected: 'Correct.',
              },
              { optionRef: 'C', text: 'The page is longer.', feedbackIfSelected: 'Irrelevant.' },
            ],
            correctOptionRef: 'B',
            hint: 'Inspect the changed condition.',
            explanation: 'Changed conditions change the supported conclusion.',
          },
        },
      ],
    },
  });
}

describe('Teaching Brief provider candidate validation', () => {
  it('accepts offered refs and complete objective coverage', () => {
    expect(validateTeachingBriefCandidate(payload(), input())).toEqual({
      valid: true,
      diagnostics: [],
      diagnosticCodes: [],
    });
  });

  it('rejects unknown source/objective/prerequisite refs and unsupported claims', () => {
    const invalid = payload();
    invalid.prerequisites[0]!.prerequisiteRef = 'P9';
    invalid.segments[0]!.objectiveRefs = ['O9'];
    invalid.segments[0]!.sourceRefs = ['S9'];
    const result = validateTeachingBriefCandidate(invalid, input());
    expect(result.valid).toBe(false);
    expect(result.diagnosticCodes).toEqual(
      expect.arrayContaining([
        'unknown_prerequisite_ref',
        'unknown_objective_ref',
        'unknown_source_ref',
      ]),
    );
  });

  it('rejects duplicated teaching intents and a sequence without source references', () => {
    const invalid = payload();
    invalid.segments = [
      { ...invalid.segments[0]!, explanationAuthority: 'ai_teaching_synthesis', sourceRefs: [] },
      { ...invalid.segments[0]!, explanationAuthority: 'ai_teaching_synthesis', sourceRefs: [] },
    ];
    const result = validateTeachingBriefCandidate(invalid, input());
    expect(result.diagnosticCodes).toEqual(
      expect.arrayContaining(['duplicate_teaching_intent', 'no_source_backed_segment']),
    );
  });
});

describe('Teaching Brief quality profile', () => {
  it('reports structural dimensions and explicit nonclaims without a universal score', () => {
    const segments: TeachingBriefSegment[] = [
      {
        index: 0,
        purpose: 'explanation',
        objectiveIds: ['objective_1'],
        explanation: 'Explain.',
        explanationAuthority: 'source_backed_teaching',
        sourceRefIds: ['S1'],
        example: { text: 'Example.', authority: 'ai_teaching_synthesis', sourceRefIds: [] },
        contrast: { text: 'Contrast.', authority: 'ai_teaching_synthesis', sourceRefIds: [] },
        informalCheck: { kind: 'own_words', prompt: 'Explain.', expectedSignal: null },
      },
    ];
    const profile = profileTeachingBrief({
      objectiveIds: ['objective_1'],
      segments,
      sourceReferences: [
        {
          refId: 'S1',
          materialId: 'material_1',
          materialRevisionId: 'revision_1',
          sourceBlockId: 'block_1',
          sourceBlockRevisionFingerprint: 'block_fp',
          startOffset: 0,
          endOffset: 7,
          quote: 'Source.',
          headingPath: [],
          pageNumber: null,
        },
      ],
      prerequisiteCount: 1,
      formalOpportunityCount: 1,
      summary: 'Summary.',
      nextConnection: null,
    });
    expect(profile).toMatchObject({
      objectiveCoverage: 1,
      sourceBackedSegmentRatio: 1,
      exampleCount: 1,
      contrastCount: 1,
      informalCheckCount: 1,
      unsupportedSourceRefCount: 0,
    });
    expect(profile.nonclaims.join(' ')).toContain('does not prove teaching effectiveness');
    expect(profile).not.toHaveProperty('score');
  });
});

function compositionalContractInput(): LessonSlotContentGenerationInput {
  const skeleton = planTeachingSkeleton({
    learningUnitTitle: 'Bounded retrieval',
    targetMinutes: 18,
    targetDepth: 'pass_oriented',
    objectives: [
      {
        objectiveRef: 'O1',
        title: 'Explain bounded retrieval',
        description:
          'Explain how a retrieval condition controls candidate eligibility and the returned result.',
        priority: 'required',
        construct: 'explain',
        authorityMode: 'exact_source',
        allowedSourceRefs: ['S1', 'S2'],
        allowedVisualRefs: [],
      },
    ],
  });
  return {
    workspaceName: 'Course',
    skeleton,
    sourceContext: {
      fingerprint: 'context_contract',
      blockCount: 2,
      offerCount: 2,
      serializedBytes: 500,
      materialCount: 1,
      sectionCount: 1,
      offers: [
        {
          sourceRef: 'S1',
          materialTitle: 'Retrieval notes',
          headingPath: ['Mechanism'],
          pageNumber: 1,
          slideNumber: null,
          text: 'A retrieval condition is checked against each candidate, and candidates that fail the condition are excluded.',
          authorizedObjectiveRefs: ['O1'],
        },
        {
          sourceRef: 'S2',
          materialTitle: 'Retrieval notes',
          headingPath: ['Result'],
          pageNumber: 2,
          slideNumber: null,
          text: 'The remaining eligible candidate is returned as the bounded retrieval result.',
          authorizedObjectiveRefs: ['O1'],
        },
      ],
    },
    visualContext: { offerCount: 0, serializedBytes: 0, offers: [] },
    learningContext: {
      concepts: [],
      canonicalConcepts: [],
      prerequisites: [],
      nextConnection: null,
    },
  };
}

describe('compositional provider candidate validation', () => {
  it('prompts for the minimum sufficient worked-process contract without a duplicate relation', () => {
    const prompt = lessonSlotContentMessages(compositionalContractInput())
      .map((message) => message.content)
      .join('\n');
    expect(prompt).toContain('worked_process needs a complete workedProcess');
    expect(prompt).toContain('semanticRelations are optional');
    expect(prompt).not.toContain('worked_process needs both a semantic relation');
  });

  it('accepts Fake Lesson then Practice content inside the immutable plans', async () => {
    const provider = new FakeProvider();
    const lessonInput = compositionalContractInput();
    const lesson = await provider.generateLessonSlotContent(lessonInput);
    expect(validateLessonSlotContentCandidate(lesson, lessonInput)).toEqual({
      valid: true,
      diagnostics: [],
      diagnosticCodes: [],
    });
    const practiceInput: PracticeContentGenerationInput = {
      workspaceName: 'Course',
      skeleton: lessonInput.skeleton,
      acceptedLesson: lesson.slots,
      sourceContext: lessonInput.sourceContext,
      visualContext: lessonInput.visualContext,
    };
    const practice = await provider.generatePracticeContent(practiceInput);
    expect(validatePracticeContentCandidate(practice, practiceInput)).toEqual({
      valid: true,
      diagnostics: [],
      diagnosticCodes: [],
    });
  });

  it('reports one invalid Lesson slot and freezes every unaffected stable slot', async () => {
    const input = compositionalContractInput();
    const candidate = await new FakeProvider().generateLessonSlotContent(input);
    const invalidSlotId = input.skeleton.lessonSlots.find(
      (slot) => slot.qualityContract === 'semantic_relation',
    )!.slotId;
    candidate.slots.find((slot) => slot.slotId === invalidSlotId)!.semanticRelations = [];
    const result = validateLessonSlotContentCandidate(candidate, input);
    expect(result.valid).toBe(false);
    expect(result.diagnosticCodes).toContain('missing_typed_semantic_relation');
    expect(result.targetedRepair).toEqual({ invalidItemIds: [invalidSlotId] });
    expect(result.failureArtifact?.context).toMatchObject({
      invalidItemIds: [invalidSlotId],
      frozenValidItemIds: input.skeleton.lessonSlots
        .map((slot) => slot.slotId)
        .filter((slotId) => slotId !== invalidSlotId),
    });
  });

  it('rejects missing, unknown, duplicate, and provider-authored local Lesson authority', async () => {
    const input = compositionalContractInput();
    const valid = await new FakeProvider().generateLessonSlotContent(input);
    const missingNarrative = structuredClone(valid);
    delete missingNarrative.narrative;
    expect(validateLessonSlotContentCandidate(missingNarrative, input).diagnosticCodes).toContain(
      'missing_lesson_narrative',
    );
    const missing = structuredClone(valid);
    const removedId = missing.slots.splice(1, 1)[0]!.slotId;
    expect(validateLessonSlotContentCandidate(missing, input).diagnosticCodes).toContain(
      'missing_lesson_slot',
    );

    const unknown = structuredClone(valid);
    unknown.slots[1]!.slotId = 'L99';
    expect(validateLessonSlotContentCandidate(unknown, input).diagnosticCodes).toEqual(
      expect.arrayContaining(['missing_lesson_slot', 'unknown_lesson_slot']),
    );

    const duplicate = structuredClone(valid);
    duplicate.slots.push(structuredClone(duplicate.slots[0]!));
    expect(validateLessonSlotContentCandidate(duplicate, input).diagnosticCodes).toContain(
      'duplicate_lesson_slot',
    );

    const mutation = structuredClone(valid) as unknown as {
      slots: Array<Record<string, unknown>>;
    };
    mutation.slots[1]!.construct = 'evaluate';
    const mutationResult = validateLessonSlotContentCandidate(mutation, input);
    expect(mutationResult.diagnosticCodes).toContain('lesson_attempted_local_authority_mutation');
    expect(mutationResult.targetedRepair?.invalidItemIds).toContain(
      input.skeleton.lessonSlots[1]!.slotId,
    );
    expect(removedId).toBe(input.skeleton.lessonSlots[1]!.slotId);
  });

  it('rejects Lesson aliases outside a slot and source-location Practice trivia', async () => {
    const provider = new FakeProvider();
    const lessonInput = compositionalContractInput();
    const lesson = await provider.generateLessonSlotContent(lessonInput);
    lesson.slots[1]!.sourceRefs = ['S9'];
    expect(validateLessonSlotContentCandidate(lesson, lessonInput).diagnosticCodes).toContain(
      'lesson_source_alias_outside_slot_authority',
    );

    const acceptedLesson = await provider.generateLessonSlotContent(lessonInput);
    const practiceInput: PracticeContentGenerationInput = {
      workspaceName: 'Course',
      skeleton: lessonInput.skeleton,
      acceptedLesson: acceptedLesson.slots,
      sourceContext: lessonInput.sourceContext,
      visualContext: lessonInput.visualContext,
    };
    const practice = await provider.generatePracticeContent(practiceInput);
    practice.items[0]!.initial.prompt = 'On which page is bounded retrieval described?';
    const result = validatePracticeContentCandidate(practice, practiceInput);
    expect(result.diagnosticCodes).toContain('source_location_trivia');
    expect(result.targetedRepair).toEqual({ invalidItemIds: ['PR1'] });
  });

  it('T3/T4/T6 keeps source and supplementary lanes distinct and blocks learner-facing internals', async () => {
    const provider = new FakeProvider();
    const input = compositionalContractInput();
    const valid = await provider.generateLessonSlotContent(input);
    const supplementary = valid.slots.find((slot) => slot.sourceRefs.length === 0);
    const sourceBacked = valid.slots.find((slot) => slot.sourceRefs.length > 0);
    expect(supplementary).toBeDefined();
    expect(sourceBacked?.sourceRefs).toEqual(expect.arrayContaining(['S1']));
    expect(validateLessonSlotContentCandidate(valid, input).valid).toBe(true);

    const unknownEvidence = structuredClone(valid);
    unknownEvidence.slots.find((slot) => slot.sourceRefs.length > 0)!.sourceRefs = ['S9'];
    expect(validateLessonSlotContentCandidate(unknownEvidence, input).diagnosticCodes).toContain(
      'lesson_source_alias_outside_slot_authority',
    );

    const leaked = structuredClone(valid);
    leaked.narrative!.summary =
      'This Lesson develops O1 through the locally planned instructional spine and S1.';
    const leakage = validateLessonSlotContentCandidate(leaked, input);
    expect(leakage.valid).toBe(false);
    expect(leakage.diagnosticCodes).toEqual(
      expect.arrayContaining(['lesson_internal_alias_leak', 'lesson_planning_language_leak']),
    );

    const copiedPurpose = structuredClone(valid);
    copiedPurpose.slots[0]!.explanation = input.skeleton.lessonSlots[0]!.purpose;
    expect(validateLessonSlotContentCandidate(copiedPurpose, input).diagnosticCodes).toContain(
      'lesson_planning_language_leak',
    );
  });

  it('T12-T14 blocks answer-bearing quotations, accepted-Lesson repetition, and same retries', async () => {
    const provider = new FakeProvider();
    const lessonInput = compositionalContractInput();
    const lesson = await provider.generateLessonSlotContent(lessonInput);
    const practiceInput: PracticeContentGenerationInput = {
      workspaceName: 'Course',
      courseDesign: { desiredDepth: 'working_fluency', unitFocus: 'normal' },
      skeleton: lessonInput.skeleton,
      acceptedLesson: lesson.slots,
      sourceContext: lessonInput.sourceContext,
      visualContext: lessonInput.visualContext,
    };
    const practice = await provider.generatePracticeContent(practiceInput);

    const quoted = structuredClone(practice);
    quoted.items[0]!.initial.prompt = `${lessonInput.sourceContext.offers[0]!.text} Which conclusion follows?`;
    const quotedResult = validatePracticeContentCandidate(quoted, practiceInput);
    expect(quotedResult.diagnosticCodes).toContain('practice_prompt_quotes_answer_source');
    expect(quotedResult.targetedRepair).toEqual({ invalidItemIds: ['PR1'] });

    const repeatedCase =
      'A concrete retrieval case begins with three candidates, removes two that fail the condition, and returns the remaining eligible passage.';
    const exposureInput = structuredClone(practiceInput);
    exposureInput.acceptedLesson[0]!.example = {
      text: repeatedCase,
      sourceRefs: [],
      visualRefs: [],
    };
    const repeated = structuredClone(practice);
    repeated.items[0]!.initial.prompt = `${repeatedCase} Which result should the learner choose?`;
    const repeatedResult = validatePracticeContentCandidate(repeated, exposureInput);
    expect(repeatedResult.diagnosticCodes).toContain('practice_repeats_accepted_lesson');
    expect(repeatedResult.targetedRepair).toEqual({ invalidItemIds: ['PR1'] });

    const sameRetry = structuredClone(practice);
    sameRetry.items[0]!.retry.prompt = sameRetry.items[0]!.initial.prompt;
    expect(validatePracticeContentCandidate(sameRetry, practiceInput).diagnosticCodes).toContain(
      'retry_surface_not_meaningfully_changed',
    );
  });
});
