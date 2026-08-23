import { describe, expect, it } from 'vitest';
import { TeachingBriefCompositionSchema, TeachingBriefSchema } from './teachingBrief.js';

function validBrief() {
  return {
    id: 'brief_1',
    workspaceId: 'ws_1',
    curriculumVersionId: 'curriculum_1',
    studyPlanVersionId: 'plan_1',
    learningUnitId: 'unit_1',
    executionSourceManifestFingerprint: 'manifest_1',
    sourceContextFingerprint: 'context_1',
    sourceManifest: {
      fingerprint: 'manifest_1',
      revisions: [
        {
          materialId: 'material_1',
          materialRevisionId: 'revision_1',
          parserVersion: null,
          parserFingerprint: null,
          sourceBlockRevisionIds: ['block_1'],
        },
      ],
    },
    conceptIds: ['concept_1'],
    canonicalConceptIds: [],
    objective: {
      title: 'Working memory',
      whyNow: 'It supports the next route step.',
      objectives: [
        {
          id: 'objective_1',
          title: 'Explain capacity',
          description: 'Explain the capacity limit.',
        },
      ],
    },
    prerequisites: [],
    segments: [
      {
        index: 0,
        purpose: 'explanation',
        objectiveIds: ['objective_1'],
        explanation: 'Working memory has limited capacity.',
        explanationAuthority: 'source_backed_teaching',
        sourceRefIds: ['S1'],
        misconception: {
          authority: 'pedagogical_risk_candidate',
          hypothesis: 'Capacity may be treated as unlimited.',
          correction: 'Return to the source-backed capacity constraint.',
          sourceRefIds: ['S1'],
        },
      },
    ],
    formalOpportunities: ['A later assessment may test capacity.'],
    summary: 'Working memory capacity is limited.',
    nextConnection: null,
    sourceReferences: [
      {
        refId: 'S1',
        materialId: 'material_1',
        materialRevisionId: 'revision_1',
        sourceBlockId: 'block_1',
        sourceBlockRevisionFingerprint: 'block_fp_1',
        startOffset: 0,
        endOffset: 35,
        quote: 'Working memory has limited capacity.',
        headingPath: ['Memory'],
        pageNumber: 2,
      },
    ],
    qualityProfile: {
      objectiveCoverage: 1,
      segmentCount: 1,
      sourceBackedSegmentCount: 1,
      sourceBackedSegmentRatio: 1,
      sourceReferenceCount: 1,
      sourceMaterialCount: 1,
      exampleCount: 0,
      contrastCount: 0,
      misconceptionCount: 1,
      informalCheckCount: 0,
      prerequisiteCount: 0,
      formalOpportunityCount: 1,
      hasSummary: true,
      hasNextConnection: false,
      unsupportedSourceRefCount: 0,
      duplicatedTeachingIntentCount: 0,
      dimensions: [{ name: 'structure', kind: 'deterministic', note: 'Structural measurement.' }],
      nonclaims: ['Structure does not prove teaching effectiveness.'],
    },
    provider: 'fake',
    providerModel: null,
    promptVersion: 'teaching-brief-v1',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('TeachingBrief domain', () => {
  it('keeps legacy composition readable and requires distinct paired logical-call provenance', () => {
    const legacy = {
      schemaVersion: 1 as const,
      skeletonId: `teaching_skeleton_${'a'.repeat(40)}`,
      skeletonSchemaVersion: 1 as const,
      skeletonPlannerVersion: 'teaching-skeleton-planner-v1',
      skeletonFingerprint: `sha256:${'b'.repeat(64)}`,
      acceptedLessonCheckpointId: 'accepted_lesson_1',
      lessonOperationId: 'operation_1',
      practiceOperationId: 'operation_1',
      lessonPromptVersion: 'lesson-prompt-v1',
      practicePromptVersion: 'practice-prompt-v1',
      targetMinutes: 12,
      acceptableActiveMinutes: { min: 8, max: 15 },
      protectedActivityMinutes: { min: 6, max: 10 },
      plannedActivityMinutes: { min: 8, max: 14 },
    };

    expect(TeachingBriefCompositionSchema.parse(legacy)).toEqual(legacy);
    expect(
      TeachingBriefCompositionSchema.parse({
        ...legacy,
        lessonLogicalCallId: 'logical_lesson_1',
        practiceLogicalCallId: 'logical_practice_1',
      }),
    ).toMatchObject({
      lessonLogicalCallId: 'logical_lesson_1',
      practiceLogicalCallId: 'logical_practice_1',
    });
    expect(
      TeachingBriefCompositionSchema.safeParse({
        ...legacy,
        lessonLogicalCallId: 'logical_lesson_1',
      }).success,
    ).toBe(false);
    expect(
      TeachingBriefCompositionSchema.safeParse({
        ...legacy,
        lessonLogicalCallId: 'logical_shared_1',
        practiceLogicalCallId: 'logical_shared_1',
      }).success,
    ).toBe(false);
  });

  it('accepts an ordered source-visible Brief with advisory misconception metadata', () => {
    const parsed = TeachingBriefSchema.parse(validBrief());
    expect(parsed.segments[0]!.misconception?.authority).toBe('pedagogical_risk_candidate');
  });

  it('rejects empty teaching sequences', () => {
    expect(() => TeachingBriefSchema.parse({ ...validBrief(), segments: [] })).toThrow();
  });

  it('rejects non-contiguous segment order and unknown source refs', () => {
    const brief = validBrief();
    brief.segments[0]!.index = 2;
    brief.segments[0]!.sourceRefIds = ['S-unknown'];
    expect(() => TeachingBriefSchema.parse(brief)).toThrow(/ordered contiguously|unknown/);
  });

  it('rejects duplicate source identities and mismatched route manifests', () => {
    const brief = validBrief();
    brief.sourceReferences.push({ ...brief.sourceReferences[0]! });
    brief.sourceManifest.fingerprint = 'manifest_other';
    expect(() => TeachingBriefSchema.parse(brief)).toThrow(/fingerprint|unique/);
  });

  it('requires refs for source-backed claims but allows honest AI teaching synthesis', () => {
    const invalid = validBrief();
    invalid.segments[0]!.sourceRefIds = [];
    expect(() => TeachingBriefSchema.parse(invalid)).toThrow(/source references/);

    const synthesis = validBrief();
    synthesis.segments[0]!.explanationAuthority = 'ai_teaching_synthesis';
    synthesis.segments[0]!.sourceRefIds = [];
    synthesis.segments[0]!.misconception = undefined as never;
    expect(TeachingBriefSchema.parse(synthesis).segments[0]!.sourceRefIds).toEqual([]);
  });
});
