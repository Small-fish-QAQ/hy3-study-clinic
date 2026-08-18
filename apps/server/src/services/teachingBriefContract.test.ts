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
      objectives: [{ objectiveRef: 'O1', title: 'Objective', description: 'Explain it.' }],
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
          text: 'Source.',
        },
      ],
    },
    limits: { maxSegments: 12, maxSourceRefsPerSegment: 8, maxFormalOpportunities: 8 },
  };
}

function payload() {
  return TeachingBriefProposalPayloadSchema.parse({
    whyNow: 'It is next.',
    prerequisites: [{ prerequisiteRef: 'P1', reason: 'Needed.', readinessHint: null }],
    segments: [
      {
        purpose: 'explanation',
        objectiveRefs: ['O1'],
        explanation: 'Source-backed explanation.',
        explanationAuthority: 'source_backed_teaching',
        sourceRefs: ['S1'],
        example: { text: 'An illustration.', authority: 'ai_teaching_synthesis', sourceRefs: [] },
        informalCheck: { kind: 'own_words', prompt: 'Explain it.', expectedSignal: null },
      },
    ],
    formalOpportunities: ['A later assessment can attach here.'],
    summary: 'Summary.',
    nextConnection: null,
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
