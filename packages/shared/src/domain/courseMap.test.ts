import { describe, expect, it } from 'vitest';
import { CourseMapSourceAllocationSchema } from './courseMap.js';
import {
  CourseMapAnchorOptionRefSchema,
  CourseMapProposalPayloadSchema,
  CourseMapSourceRegionRefSchema,
} from '../provider/payloads.js';

function proposal() {
  return {
    modules: [
      {
        title: 'Module',
        learningIntent: 'Build a coherent foundation.',
        regions: [
          {
            sourceRegionRef: 'R1',
            title: 'Region',
            learningIntent: 'Understand the first source region.',
            approximateScope: 'standard',
            anchorOptionRefs: ['R1:A1'],
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

  it('accepts only compact operation-local region and anchor-option references', () => {
    expect(CourseMapSourceRegionRefSchema.safeParse('R1').success).toBe(true);
    expect(CourseMapSourceRegionRefSchema.safeParse('R0').success).toBe(false);
    expect(CourseMapSourceRegionRefSchema.safeParse('region-1').success).toBe(false);
    expect(CourseMapAnchorOptionRefSchema.safeParse('R12:A3').success).toBe(true);
    expect(CourseMapAnchorOptionRefSchema.safeParse('R12:concept-3').success).toBe(false);
  });

  it('rejects old model-owned identity, ordering, and authority fields', () => {
    const legacyTopLevel = {
      ...proposal(),
      sourceAllocationFingerprint: `course_map_source_allocation_${'a'.repeat(40)}`,
    };
    expect(() => CourseMapProposalPayloadSchema.parse(legacyTopLevel)).toThrow();

    for (const fields of [{ key: 'module-1' }, { index: 0 }]) {
      const legacyModule = proposal();
      Object.assign(legacyModule.modules[0]!, fields);
      expect(() => CourseMapProposalPayloadSchema.parse(legacyModule)).toThrow();
    }

    for (const fields of [
      { key: 'region-1' },
      { index: 0 },
      { sourceRegionIds: ['source-region-1'] },
      { conceptIds: ['concept-1'] },
      { canonicalConceptIds: ['canonical-1'] },
    ]) {
      const legacyRegion = proposal();
      Object.assign(legacyRegion.modules[0]!.regions[0]!, fields);
      expect(() => CourseMapProposalPayloadSchema.parse(legacyRegion)).toThrow();
    }

    const legacySynthesis = proposal();
    legacySynthesis.synthesisGroups.push({
      title: 'Synthesis',
      level: 'module',
      regionRefs: ['R1', 'R2'],
    });
    for (const fields of [{ key: 'synthesis-1' }, { regionKeys: ['region-1', 'region-2'] }]) {
      const candidate = structuredClone(legacySynthesis);
      Object.assign(candidate.synthesisGroups[0]!, fields);
      expect(() => CourseMapProposalPayloadSchema.parse(candidate)).toThrow();
    }
  });

  it('rejects duplicate anchor-option references and leaves ownership to local validation', () => {
    const duplicate = proposal();
    duplicate.modules[0]!.regions[0]!.anchorOptionRefs = ['R1:A1', 'R1:A1'];
    expect(() => CourseMapProposalPayloadSchema.parse(duplicate)).toThrow(
      /anchor-option references must be unique/u,
    );

    const crossRegion = proposal();
    crossRegion.modules[0]!.regions[0]!.anchorOptionRefs = ['R2:A1'];
    expect(CourseMapProposalPayloadSchema.parse(crossRegion)).toEqual(crossRegion);
  });

  it('accepts bounded recovery aliases and rejects duplicate or over-capacity placement', () => {
    const accepted = proposal();
    Object.assign(accepted.modules[0]!.regions[0]!, {
      capabilityRequirementRefs: ['capability-1', 'capability-2'],
    });
    expect(CourseMapProposalPayloadSchema.parse(accepted)).toEqual(accepted);

    const duplicateWithinRegion = proposal();
    Object.assign(duplicateWithinRegion.modules[0]!.regions[0]!, {
      capabilityRequirementRefs: ['capability-1', 'capability-1'],
    });
    expect(() => CourseMapProposalPayloadSchema.parse(duplicateWithinRegion)).toThrow(
      /capability-requirement references must be unique/u,
    );

    const duplicateAcrossRegions = proposal();
    const secondRegion = structuredClone(duplicateAcrossRegions.modules[0]!.regions[0]!);
    secondRegion.sourceRegionRef = 'R2';
    secondRegion.anchorOptionRefs = ['R2:A1'];
    Object.assign(duplicateAcrossRegions.modules[0]!.regions[0]!, {
      capabilityRequirementRefs: ['capability-1'],
    });
    Object.assign(secondRegion, { capabilityRequirementRefs: ['capability-1'] });
    duplicateAcrossRegions.modules[0]!.regions.push(secondRegion);
    expect(() => CourseMapProposalPayloadSchema.parse(duplicateAcrossRegions)).toThrow(
      /duplicate Course Map capability requirement/u,
    );

    const overCapacity = proposal();
    Object.assign(overCapacity.modules[0]!.regions[0]!, {
      capabilityRequirementRefs: Array.from({ length: 5 }, (_, index) => `capability-${index + 1}`),
    });
    expect(CourseMapProposalPayloadSchema.safeParse(overCapacity).success).toBe(false);
  });

  it('rejects extra prerequisite keys and old prerequisite field names', () => {
    const extraKey = proposal();
    extraKey.prerequisites.push({ prerequisiteRegionRef: 'R1', dependentRegionRef: 'R2' });
    Object.assign(extraKey.prerequisites[0]!, { reason: 'Invented provider explanation' });
    expect(() => CourseMapProposalPayloadSchema.parse(extraKey)).toThrow();

    const legacyFields = proposal();
    legacyFields.prerequisites.push({ prerequisiteRegionRef: 'R1', dependentRegionRef: 'R2' });
    Object.assign(legacyFields.prerequisites[0]!, {
      prerequisiteRegionKey: 'region-1',
      dependentRegionKey: 'region-2',
    });
    expect(() => CourseMapProposalPayloadSchema.parse(legacyFields)).toThrow();
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
