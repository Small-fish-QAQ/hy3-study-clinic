import { describe, expect, it } from 'vitest';
import { CourseMapSourceAllocationSchema } from './courseMap.js';
import { CourseMapProposalPayloadSchema } from '../provider/payloads.js';

function proposal() {
  return {
    sourceAllocationFingerprint: `course_map_source_allocation_${'a'.repeat(40)}`,
    modules: [
      {
        key: 'module-1',
        index: 0,
        title: 'Module',
        learningIntent: 'Build a coherent foundation.',
        regions: [
          {
            key: 'region-1',
            index: 0,
            title: 'Region',
            learningIntent: 'Understand the first source region.',
            approximateScope: 'standard',
            sourceRegionIds: ['source-region-1'],
            conceptIds: [],
            canonicalConceptIds: [],
          },
        ],
      },
    ],
    prerequisites: [],
    synthesisGroups: [],
  };
}

function sourceAllocation() {
  return {
    schemaVersion: 1,
    workspaceId: 'workspace-1',
    courseSourceMapFingerprint: 'course_source_map_1',
    fingerprint: `course_map_source_allocation_${'a'.repeat(40)}`,
    authority: 'planning_visibility_only',
    materialCount: 1,
    sourceSectionCount: 1,
    sourceBlockCount: 1,
    limits: { maxRegions: 1, maxEvidenceOffers: 1, maxEvidenceOffersPerRegion: 1 },
    regions: [
      {
        id: `course_map_source_region_${'b'.repeat(24)}`,
        index: 0,
        materialId: 'material-1',
        materialRevisionId: 'revision-1',
        title: 'Source region',
        firstCourseSourceIndex: 0,
        lastCourseSourceIndex: 0,
        charCount: 3,
        sourceSectionIds: ['section-1'],
        sourceBlockIds: ['block-1'],
        conceptIds: ['concept-1'],
        evidence: [
          {
            evidenceId: 'E1',
            bindingId: 'binding-1',
            blockId: 'block-1',
            startOffset: 0,
            endOffset: 3,
            quote: 'abc',
          },
        ],
      },
    ],
  };
}

describe('CourseMapProposalPayloadSchema', () => {
  it('accepts the smallest strict planning-only skeleton', () => {
    expect(CourseMapProposalPayloadSchema.parse(proposal())).toEqual(proposal());
  });

  it('rejects lifecycle, evidence-truth, and other unknown authority fields', () => {
    expect(() =>
      CourseMapProposalPayloadSchema.parse({ ...proposal(), status: 'accepted' }),
    ).toThrow();
  });

  it('rejects duplicate module and region proposal identities', () => {
    const duplicateModule = proposal();
    duplicateModule.modules.push(structuredClone(duplicateModule.modules[0]!));
    expect(() => CourseMapProposalPayloadSchema.parse(duplicateModule)).toThrow(
      /duplicate Course Map module key/u,
    );

    const duplicateRegion = proposal();
    duplicateRegion.modules[0]!.regions.push(
      structuredClone(duplicateRegion.modules[0]!.regions[0]!),
    );
    expect(() => CourseMapProposalPayloadSchema.parse(duplicateRegion)).toThrow(
      /duplicate Course Map region key/u,
    );
  });

  it('requires every instructional region to name bounded source allocation', () => {
    const missing = proposal();
    missing.modules[0]!.regions[0]!.sourceRegionIds = [];
    expect(() => CourseMapProposalPayloadSchema.parse(missing)).toThrow();
  });

  it('rejects duplicate Concept and canonical Concept anchors', () => {
    const duplicateConcept = proposal();
    duplicateConcept.modules[0]!.regions[0]!.conceptIds = ['concept-1', 'concept-1'];
    expect(() => CourseMapProposalPayloadSchema.parse(duplicateConcept)).toThrow(
      /Concept anchors must be unique/u,
    );

    const duplicateCanonical = proposal();
    duplicateCanonical.modules[0]!.regions[0]!.canonicalConceptIds = ['canonical-1', 'canonical-1'];
    expect(() => CourseMapProposalPayloadSchema.parse(duplicateCanonical)).toThrow(
      /canonical Concept anchors must be unique/u,
    );
  });
});

describe('CourseMapSourceAllocationSchema', () => {
  it('enforces declared counts, contiguous order, and unique source coverage', () => {
    const wrongCount = sourceAllocation();
    wrongCount.sourceBlockCount = 2;
    expect(() => CourseMapSourceAllocationSchema.parse(wrongCount)).toThrow(
      /source blocks are not represented exactly once/u,
    );

    const wrongIndex = sourceAllocation();
    wrongIndex.regions[0]!.index = 1;
    expect(() => CourseMapSourceAllocationSchema.parse(wrongIndex)).toThrow(
      /indexes must be contiguous/u,
    );

    const duplicateCoverage = sourceAllocation();
    duplicateCoverage.sourceBlockCount = 2;
    duplicateCoverage.regions[0]!.sourceBlockIds.push('block-1');
    expect(() => CourseMapSourceAllocationSchema.parse(duplicateCoverage)).toThrow(
      /duplicate Course Map source block id/u,
    );
  });

  it('rejects inconsistent revisions, duplicate Concepts, and foreign evidence', () => {
    const duplicateConcept = sourceAllocation();
    duplicateConcept.regions[0]!.conceptIds.push('concept-1');
    expect(() => CourseMapSourceAllocationSchema.parse(duplicateConcept)).toThrow(
      /Concept identities must be unique/u,
    );

    const foreignEvidence = sourceAllocation();
    foreignEvidence.regions[0]!.evidence[0]!.blockId = 'block-foreign';
    expect(() => CourseMapSourceAllocationSchema.parse(foreignEvidence)).toThrow(
      /evidence must belong to its source region/u,
    );

    const inconsistentRevision = sourceAllocation();
    const secondRegion = structuredClone(inconsistentRevision.regions[0]!);
    secondRegion.id = `course_map_source_region_${'c'.repeat(24)}`;
    secondRegion.index = 1;
    secondRegion.materialRevisionId = 'revision-2';
    secondRegion.firstCourseSourceIndex = 1;
    secondRegion.lastCourseSourceIndex = 1;
    secondRegion.sourceSectionIds = ['section-2'];
    secondRegion.sourceBlockIds = ['block-2'];
    secondRegion.evidence = [];
    inconsistentRevision.regions.push(secondRegion);
    inconsistentRevision.limits.maxRegions = 2;
    inconsistentRevision.sourceSectionCount = 2;
    inconsistentRevision.sourceBlockCount = 2;
    expect(() => CourseMapSourceAllocationSchema.parse(inconsistentRevision)).toThrow(
      /spans inconsistent revisions/u,
    );
  });
});
