import {
  TeachingBriefQualityProfileSchema,
  type TeachingBriefQualityProfile,
  type TeachingBriefSegment,
  type TeachingBriefSourceReference,
} from '@hy3-clinic/shared';

interface ProfileInput {
  objectiveIds: string[];
  segments: TeachingBriefSegment[];
  sourceReferences: TeachingBriefSourceReference[];
  prerequisiteCount: number;
  formalOpportunityCount: number;
  summary: string;
  nextConnection: string | null;
}

function normalizedIntent(segment: TeachingBriefSegment): string {
  return `${segment.purpose}:${segment.explanation.toLocaleLowerCase().replace(/\s+/g, ' ').trim()}`;
}

/** Structural diagnostics only; this deliberately produces no universal score. */
export function profileTeachingBrief(input: ProfileInput): TeachingBriefQualityProfile {
  const knownRefIds = new Set(input.sourceReferences.map((reference) => reference.refId));
  const allUsedRefs = input.segments.flatMap((segment) => [
    ...segment.sourceRefIds,
    ...(segment.example?.sourceRefIds ?? []),
    ...(segment.contrast?.sourceRefIds ?? []),
    ...(segment.misconception?.sourceRefIds ?? []),
  ]);
  const sourceBackedSegmentCount = input.segments.filter(
    (segment) =>
      segment.explanationAuthority === 'source_backed_teaching' &&
      segment.sourceRefIds.some((refId) => knownRefIds.has(refId)),
  ).length;
  const coveredObjectives = new Set(
    input.segments
      .flatMap((segment) => segment.objectiveIds)
      .filter((id) => input.objectiveIds.includes(id)),
  );
  const intents = input.segments.map(normalizedIntent);

  return TeachingBriefQualityProfileSchema.parse({
    objectiveCoverage: coveredObjectives.size,
    segmentCount: input.segments.length,
    sourceBackedSegmentCount,
    sourceBackedSegmentRatio:
      input.segments.length === 0 ? 0 : sourceBackedSegmentCount / input.segments.length,
    sourceReferenceCount: new Set(allUsedRefs.filter((refId) => knownRefIds.has(refId))).size,
    sourceMaterialCount: new Set(input.sourceReferences.map((reference) => reference.materialId))
      .size,
    exampleCount: input.segments.filter((segment) => segment.example).length,
    contrastCount: input.segments.filter((segment) => segment.contrast).length,
    misconceptionCount: input.segments.filter((segment) => segment.misconception).length,
    informalCheckCount: input.segments.filter((segment) => segment.informalCheck).length,
    prerequisiteCount: input.prerequisiteCount,
    formalOpportunityCount: input.formalOpportunityCount,
    hasSummary: input.summary.trim().length > 0,
    hasNextConnection: Boolean(input.nextConnection?.trim()),
    unsupportedSourceRefCount: allUsedRefs.filter((refId) => !knownRefIds.has(refId)).length,
    duplicatedTeachingIntentCount: intents.length - new Set(intents).size,
    dimensions: [
      {
        name: 'objective_coverage',
        kind: 'deterministic',
        note: 'Counts offered objectives referenced by validated segments.',
      },
      {
        name: 'source_structure',
        kind: 'deterministic',
        note: 'Counts locally resolved source references, Materials, and source-backed segments.',
      },
      {
        name: 'teaching_components',
        kind: 'deterministic',
        note: 'Counts examples, contrasts, misconceptions, informal checks, prerequisites, and formal opportunity markers.',
      },
      {
        name: 'duplicate_intent',
        kind: 'heuristic',
        note: 'Flags exact normalized purpose-and-explanation repetition; it does not judge semantic redundancy.',
      },
      {
        name: 'teaching_effectiveness',
        kind: 'model_or_human_judged',
        note: 'Usefulness, correctness of synthesis, and learner outcomes require later evaluation.',
      },
    ],
    nonclaims: [
      'Structural completeness does not prove teaching effectiveness.',
      'Exact source occurrence does not prove complete semantic entailment.',
      'Informal checks and formal opportunity markers do not create Evidence or mastery.',
    ],
  });
}
