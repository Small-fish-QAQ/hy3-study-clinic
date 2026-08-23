import { describe, expect, it } from 'vitest';
import { TeachingBriefProposalPayloadSchema, type TeachingBriefSegment } from '@hy3-clinic/shared';
import type { TeachingBriefGenerationInput } from '../llm/provider.js';
import { validateTeachingBriefCandidate } from './teachingBriefContract.js';
import { profileTeachingBrief } from './teachingBriefQuality.js';

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
