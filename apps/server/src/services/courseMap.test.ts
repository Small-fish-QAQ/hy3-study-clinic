import { describe, expect, it } from 'vitest';
import { CourseMapAnalysisSchema, CourseMapSourceAllocationSchema } from '@hy3-clinic/shared';
import {
  analyzeCourseMapProposal,
  assertCourseMapSourceAllocationIntegrity,
  buildCourseMapProposalInput,
  buildCourseMapSourceAllocation,
  repairOmittedCourseMapCoverage,
} from './courseMap.js';
import { measureCourseMapRequest } from '../llm/prompts.js';
import { createCourseMapFixture } from '../testing/courseMapFixtures.js';
import { validateCourseMapSemanticCoherence } from './curriculumSemanticEvaluator.js';

describe('Course Map bounded source allocation', () => {
  it('does not scatter a system overview from a RAG workflow on the domain label alone', () => {
    const fixture = createCourseMapFixture();
    const candidate = structuredClone(fixture.good);
    candidate.modules = [
      {
        title: '系统定位与语义表示基础',
        learningIntent: 'Establish the system position and semantic representation foundation.',
        regions: [candidate.modules[0]!.regions[0]!],
      },
      {
        title: 'RAG 流程与权限工程体系',
        learningIntent: 'Develop the RAG workflow, hallucination controls, and permissions.',
        regions: [...candidate.modules[0]!.regions.slice(1), ...candidate.modules[1]!.regions],
      },
    ];
    candidate.modules[0]!.regions[0]!.title = '系统定位与 RAG 全景';
    candidate.modules[1]!.regions[0]!.title = 'RAG 流程与幻觉';
    candidate.synthesisGroups = [];
    const courseMap = analyzeCourseMapProposal(candidate, fixture).courseMap;
    const sourceAllocation = structuredClone(fixture.sourceAllocation);
    sourceAllocation.regions[0]!.title = '系统定位与 RAG 全景';
    sourceAllocation.regions[1]!.title = 'RAG 流程与幻觉';

    const validation = validateCourseMapSemanticCoherence(courseMap, sourceAllocation);

    expect(validation.diagnosticCodes).not.toContain('semantic_topic_scattering');
    expect(validation.valid).toBe(true);
  });

  it('recovers omitted coverage as a real region, never disposition-only bookkeeping', () => {
    const fixture = createCourseMapFixture();
    const candidate = structuredClone(fixture.good);
    candidate.modules[1]!.regions.pop();
    expect(candidate.sourceDispositions).toBeUndefined();
    expect(
      repairOmittedCourseMapCoverage(candidate, fixture.providerInput, fixture.sourceAllocation),
    ).toBe(true);
    expect(
      candidate.modules.flatMap((module) => module.regions).map((region) => region.sourceRegionRef),
    ).toContain('R6');
    expect(candidate.sourceDispositions).toBeUndefined();
    const repaired = analyzeCourseMapProposal(candidate, {
      providerInput: fixture.providerInput,
      sourceAllocation: fixture.sourceAllocation,
    });
    expect(
      repaired.validation.diagnostics.some(
        (diagnostic) => diagnostic.code === 'unallocated_source_region',
      ),
    ).toBe(false);
  });

  it('is deterministic, complete, multi-Material, and bounded', () => {
    const fixture = createCourseMapFixture();
    const again = buildCourseMapSourceAllocation({
      workspaceId: fixture.workspaceId,
      sourceMap: fixture.sourceMap,
      blocks: fixture.blocks,
      evidenceCatalog: fixture.evidenceCatalog,
      maxRegions: 6,
      maxEvidenceOffers: 6,
      maxEvidenceOffersPerRegion: 1,
    });

    expect(again).toEqual(fixture.sourceAllocation);
    expect(() => CourseMapSourceAllocationSchema.parse(again)).not.toThrow();
    expect(again.regions).toHaveLength(6);
    expect(new Set(again.regions.map((region) => region.materialId))).toEqual(
      new Set(['material_alpha', 'material_beta']),
    );
    expect(again.regions.flatMap((region) => region.sourceBlockIds)).toEqual(
      fixture.blocks.map((block) => block.id),
    );
    expect(again.regions.flatMap((region) => region.sourceSectionIds)).toHaveLength(
      fixture.sourceMap.sectionCount,
    );
    expect(again.regions.flatMap((region) => region.evidence)).toHaveLength(6);
  });

  it('groups the complete corpus when sections exceed the source-region cap', () => {
    const fixture = createCourseMapFixture();
    const allocation = buildCourseMapSourceAllocation({
      workspaceId: fixture.workspaceId,
      sourceMap: fixture.sourceMap,
      blocks: fixture.blocks,
      evidenceCatalog: fixture.evidenceCatalog,
      maxRegions: 2,
      maxEvidenceOffers: 2,
      maxEvidenceOffersPerRegion: 1,
    });
    expect(allocation.regions).toHaveLength(2);
    expect(new Set(allocation.regions.map((region) => region.materialId))).toEqual(
      new Set(['material_alpha', 'material_beta']),
    );
    expect(allocation.regions.every((region) => region.sourceSectionIds.length === 3)).toBe(true);
    expect(allocation.regions.every((region) => region.sourceBlockIds.length === 6)).toBe(true);
    expect(allocation.regions.flatMap((region) => region.sourceBlockIds)).toEqual(
      fixture.blocks.map((block) => block.id),
    );
  });

  it('enforces the global and per-region provider visibility ceilings', () => {
    const fixture = createCourseMapFixture();
    expect(() =>
      buildCourseMapSourceAllocation({
        workspaceId: fixture.workspaceId,
        sourceMap: fixture.sourceMap,
        blocks: fixture.blocks,
        evidenceCatalog: fixture.evidenceCatalog,
        maxRegions: 121,
      }),
    ).toThrow(/between 1 and 120/u);
    expect(() =>
      buildCourseMapSourceAllocation({
        workspaceId: fixture.workspaceId,
        sourceMap: fixture.sourceMap,
        blocks: fixture.blocks,
        evidenceCatalog: fixture.evidenceCatalog,
        maxEvidenceOffers: 161,
      }),
    ).toThrow(/between 0 and 160/u);
    expect(() =>
      buildCourseMapSourceAllocation({
        workspaceId: fixture.workspaceId,
        sourceMap: fixture.sourceMap,
        blocks: fixture.blocks,
        evidenceCatalog: fixture.evidenceCatalog,
        maxEvidenceOffersPerRegion: 3,
      }),
    ).toThrow(/between 0 and 2/u);
  });

  it('rejects foreign/stale source maps, source text, and duplicate evidence identities', () => {
    const fixture = createCourseMapFixture();
    expect(() =>
      buildCourseMapSourceAllocation({
        workspaceId: 'foreign_course',
        sourceMap: fixture.sourceMap,
        blocks: fixture.blocks,
        evidenceCatalog: fixture.evidenceCatalog,
      }),
    ).toThrow(/foreign Course/u);
    expect(() =>
      buildCourseMapSourceAllocation({
        workspaceId: fixture.workspaceId,
        sourceMap: fixture.sourceMap,
        blocks: [{ ...fixture.blocks[0]!, content: 'stale text' }, ...fixture.blocks.slice(1)],
        evidenceCatalog: fixture.evidenceCatalog,
      }),
    ).toThrow(/stale, foreign, or out of source order/u);

    const staleHierarchy = structuredClone(fixture.sourceMap);
    staleHierarchy.materials[0]!.sections[0]!.title = 'Stale hierarchy title';
    expect(() =>
      buildCourseMapSourceAllocation({
        workspaceId: fixture.workspaceId,
        sourceMap: staleHierarchy,
        blocks: fixture.blocks,
        evidenceCatalog: fixture.evidenceCatalog,
      }),
    ).toThrow(/Course Source Map fingerprint is stale or mismatched/u);
    expect(() =>
      buildCourseMapSourceAllocation({
        workspaceId: fixture.workspaceId,
        sourceMap: fixture.sourceMap,
        blocks: fixture.blocks,
        evidenceCatalog: [fixture.evidenceCatalog[0]!, fixture.evidenceCatalog[0]!],
      }),
    ).toThrow(/identities must be unique/u);
  });

  it('builds a compact provider view without the full SourceBlock corpus', () => {
    const fixture = createCourseMapFixture();
    const measured = measureCourseMapRequest(fixture.providerInput);
    expect(measured.counts).toEqual({
      sourceRegions: 6,
      evidenceOffers: 6,
      anchorOptions: 2,
      canonicalAnchorOptions: 1,
    });
    expect('blocks' in fixture.providerInput).toBe(false);
    expect(JSON.stringify(fixture.providerInput)).not.toContain('block_1_1');
    expect(measured.messages.bytes).toBeLessThan(60_000);
  });

  it('rejects stale or foreign Concept ownership before provider visibility', () => {
    const fixture = createCourseMapFixture();
    const staleConcept = {
      id: 'foreign_concept',
      materialId: 'foreign_material',
      materialRevisionId: 'foreign_revision',
      name: 'Foreign',
      summary: 'Foreign',
      importance: 'high' as const,
      grounding: {
        blockId: fixture.blocks[0]!.id,
        quote: fixture.blocks[0]!.content,
        startOffset: 0,
        endOffset: fixture.blocks[0]!.content.length,
        occurrenceCount: 1,
        reanchored: false,
      },
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    expect(() =>
      buildCourseMapProposalInput({
        workspaceName: fixture.providerInput.workspaceName,
        contract: fixture.providerInput.contract,
        sourceAllocation: fixture.sourceAllocation,
        concepts: [staleConcept],
        canonicalConcepts: [],
      }),
    ).toThrow(/stale or outside/u);

    const wrongBlockConcept = structuredClone(fixture.concepts[0]!);
    wrongBlockConcept.grounding.blockId = fixture.blocks.at(-1)!.id;
    expect(() =>
      buildCourseMapProposalInput({
        workspaceName: fixture.providerInput.workspaceName,
        contract: fixture.providerInput.contract,
        sourceAllocation: fixture.sourceAllocation,
        concepts: [wrongBlockConcept, fixture.concepts[1]!],
        canonicalConcepts: [],
      }),
    ).toThrow(/stale or outside/u);
  });

  it('rejects Contract/source and canonical-membership authority mismatches', () => {
    const fixture = createCourseMapFixture();
    expect(() =>
      buildCourseMapProposalInput({
        workspaceName: fixture.providerInput.workspaceName,
        contract: {
          ...fixture.providerInput.contract,
          materials: fixture.providerInput.contract.materials.filter(
            (material) => material.materialId !== 'material_beta',
          ),
        },
        sourceAllocation: fixture.sourceAllocation,
        concepts: fixture.concepts,
        canonicalConcepts: [],
      }),
    ).toThrow(/exactly match the included Contract Material scope/u);

    expect(() =>
      buildCourseMapProposalInput({
        workspaceName: fixture.providerInput.workspaceName,
        contract: {
          ...fixture.providerInput.contract,
          materials: [
            ...fixture.providerInput.contract.materials,
            {
              ...fixture.providerInput.contract.materials[0]!,
              materialId: 'material_gamma',
              materialRoleAssignmentId: 'role_gamma',
            },
          ],
        },
        sourceAllocation: fixture.sourceAllocation,
        concepts: fixture.concepts,
        canonicalConcepts: [],
      }),
    ).toThrow(/exactly match the included Contract Material scope/u);

    expect(() =>
      buildCourseMapProposalInput({
        workspaceName: fixture.providerInput.workspaceName,
        contract: fixture.providerInput.contract,
        sourceAllocation: fixture.sourceAllocation,
        concepts: fixture.concepts,
        canonicalConcepts: [
          {
            id: 'canonical_unknown',
            displayName: 'Unknown membership',
            sourceConceptIds: ['unknown_concept'],
          },
        ],
      }),
    ).toThrow(/unknown source Concept/u);
  });

  it('rejects stale allocation fingerprints and incomplete provider views', () => {
    const fixture = createCourseMapFixture();
    const tamperedAllocation = structuredClone(fixture.sourceAllocation);
    tamperedAllocation.regions[0]!.title = 'Tampered source region';
    expect(() => assertCourseMapSourceAllocationIntegrity(tamperedAllocation)).toThrow(
      /fingerprint is stale or mismatched/u,
    );
    expect(() =>
      buildCourseMapProposalInput({
        workspaceName: fixture.providerInput.workspaceName,
        contract: fixture.providerInput.contract,
        sourceAllocation: tamperedAllocation,
        concepts: fixture.concepts,
        canonicalConcepts: [],
      }),
    ).toThrow(/fingerprint is stale or mismatched/u);

    const incompleteContext = {
      ...fixture,
      providerInput: {
        ...fixture.providerInput,
        sourceRegions: fixture.providerInput.sourceRegions.slice(0, -1),
      },
    };
    expect(() => analyzeCourseMapProposal(fixture.good, incompleteContext)).toThrow(
      /must expose every source-allocation region/u,
    );

    const staleAnchorContext = structuredClone(fixture);
    staleAnchorContext.providerInput.sourceRegions[0]!.anchorOptions[0]!.binding.conceptId =
      'unknown_concept';
    expect(() => analyzeCourseMapProposal(fixture.good, staleAnchorContext)).toThrow(
      /anchor-option Concept binding is stale or outside/u,
    );
  });
});

describe('Course Map hierarchy and quality profile', () => {
  it('materializes a valid deterministic multi-module, multi-Material skeleton', () => {
    const fixture = createCourseMapFixture();
    const first = analyzeCourseMapProposal(fixture.good, fixture);
    const second = analyzeCourseMapProposal(fixture.good, fixture);
    expect(first).toEqual(second);
    expect(() => CourseMapAnalysisSchema.parse(first)).not.toThrow();
    expect(first.validation.valid).toBe(true);
    expect(first.courseMap.authority).toBe('planning_proposal_only');
    expect(first.qualityProfile.hierarchy).toMatchObject({ moduleCount: 2, regionCount: 6 });
    expect(first.qualityProfile.sourceAllocation).toMatchObject({
      allocatedSourceRegionCount: 6,
      representedMaterialCount: 2,
      representedSectionCount: 6,
      representedBlockCount: 12,
      unsupportedRegionCount: 0,
    });
    expect(first.qualityProfile.prerequisites).toMatchObject({
      edgeCount: 5,
      dagValid: true,
      maxInDegree: 1,
      maxOutDegree: 1,
    });
    expect(first.qualityProfile.synthesis.groupCount).toBe(3);
    expect('score' in first.qualityProfile).toBe(false);

    const changed = structuredClone(fixture.good);
    changed.modules[0]!.learningIntent = 'A materially changed module intent.';
    const changedAnalysis = analyzeCourseMapProposal(changed, fixture);
    expect(changedAnalysis.courseMap.id).not.toBe(first.courseMap.id);
    expect(changedAnalysis.courseMap.modules[0]!.id).not.toBe(first.courseMap.modules[0]!.id);
  });

  it('derives hierarchy order locally and reports a flat hierarchy as a named dimension', () => {
    const fixture = createCourseMapFixture();
    const analysis = analyzeCourseMapProposal(fixture.good, fixture);
    expect(analysis.courseMap.modules.map((module) => module.index)).toEqual([0, 1]);
    expect(analysis.courseMap.modules[0]!.regions.map((region) => region.index)).toEqual([0, 1, 2]);
    expect(analysis.courseMap.modules[1]!.regions.map((region) => region.index)).toEqual([0, 1, 2]);
    expect(analysis.courseMap.modules.map((module) => module.proposalKey)).toEqual([
      'module-1',
      'module-2',
    ]);
    expect(
      analysis.courseMap.modules.flatMap((module) =>
        module.regions.map((region) => region.proposalKey),
      ),
    ).toEqual(['region-1', 'region-2', 'region-3', 'region-4', 'region-5', 'region-6']);

    const flat = analyzeCourseMapProposal(fixture.flat, fixture);
    expect(flat.qualityProfile.hierarchy.flat).toBe(true);
    expect(flat.validation.diagnostics.map((item) => item.code)).toContain('flat_hierarchy');
  });

  it('profiles sparse, duplicate, unknown, and unsupported source allocation', () => {
    const fixture = createCourseMapFixture();
    const sparse = analyzeCourseMapProposal(fixture.sparse, fixture);
    expect(sparse.validation.valid).toBe(false);
    expect(sparse.qualityProfile.sourceAllocation.unallocatedSourceRegionCount).toBe(4);
    expect(sparse.validation.diagnostics.map((item) => item.code)).toContain(
      'unallocated_source_region',
    );

    const missingMaterial = structuredClone(fixture.good);
    missingMaterial.modules = [missingMaterial.modules[0]!];
    missingMaterial.prerequisites = missingMaterial.prerequisites.slice(0, 2);
    missingMaterial.synthesisGroups = [missingMaterial.synthesisGroups[0]!];
    const missingMaterialAnalysis = analyzeCourseMapProposal(missingMaterial, fixture);
    expect(missingMaterialAnalysis.validation.valid).toBe(false);
    expect(missingMaterialAnalysis.validation.diagnostics.map((item) => item.code)).toContain(
      'missing_material_representation',
    );

    const duplicate = structuredClone(fixture.good);
    duplicate.modules[0]!.regions[1]!.sourceRegionRef =
      duplicate.modules[0]!.regions[0]!.sourceRegionRef;
    duplicate.modules[0]!.regions[1]!.anchorOptionRefs = [];
    const duplicateAnalysis = analyzeCourseMapProposal(duplicate, fixture);
    expect(duplicateAnalysis.validation.valid).toBe(false);
    expect(duplicateAnalysis.qualityProfile.sourceAllocation.duplicateAllocationCount).toBe(1);

    const unsupported = analyzeCourseMapProposal(fixture.unknownSource, fixture);
    expect(unsupported.validation.valid).toBe(false);
    expect(unsupported.qualityProfile.sourceAllocation.unsupportedRegionCount).toBe(1);
    expect(unsupported.validation.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(['unknown_source_region', 'unsupported_region']),
    );
  });

  it('reports duplicate region intents without turning warnings into a universal score', () => {
    const fixture = createCourseMapFixture();
    const analysis = analyzeCourseMapProposal(fixture.duplicateIntent, fixture);
    expect(analysis.validation.valid).toBe(true);
    expect(analysis.qualityProfile.duplication.duplicateIntentPairCount).toBeGreaterThan(0);
    expect(analysis.validation.diagnostics.map((item) => item.code)).toContain(
      'duplicate_region_intent',
    );
  });

  it('resolves exact Concept/canonical bindings and rejects invalid local anchor options', () => {
    const fixture = createCourseMapFixture();
    const valid = analyzeCourseMapProposal(fixture.good, fixture);
    expect(valid.courseMap.modules[0]!.regions[0]).toMatchObject({
      conceptIds: ['concept_1'],
      canonicalConceptIds: ['canonical_alpha'],
    });
    expect(valid.courseMap.modules[1]!.regions[0]).toMatchObject({
      conceptIds: ['concept_2'],
      canonicalConceptIds: [],
    });

    const invalid = structuredClone(fixture.good);
    invalid.modules[0]!.regions[0]!.anchorOptionRefs = ['R1:A999'];
    const analysis = analyzeCourseMapProposal(invalid, fixture);
    expect(analysis.validation.valid).toBe(false);
    expect(analysis.qualityProfile.anchors.invalidAnchorCount).toBe(1);
    expect(analysis.validation.diagnostics.map((item) => item.code)).toContain(
      'unknown_anchor_option',
    );

    const crossRegion = structuredClone(fixture.good);
    crossRegion.modules[1]!.regions[0]!.anchorOptionRefs = ['R1:A1'];
    const crossRegionAnalysis = analyzeCourseMapProposal(crossRegion, fixture);
    expect(crossRegionAnalysis.validation.valid).toBe(false);
    expect(crossRegionAnalysis.qualityProfile.anchors.invalidAnchorCount).toBe(1);
    expect(crossRegionAnalysis.validation.diagnostics.map((item) => item.code)).toContain(
      'anchor_option_outside_region',
    );
  });

  it('validates synthesis identities and module boundaries', () => {
    const fixture = createCourseMapFixture();
    const invalid = structuredClone(fixture.good);
    invalid.synthesisGroups[0]!.regionRefs = ['R1', 'R4'];
    invalid.synthesisGroups[0]!.level = 'module';
    const analysis = analyzeCourseMapProposal(invalid, fixture);
    expect(analysis.validation.valid).toBe(false);
    expect(analysis.validation.diagnostics.map((item) => item.code)).toContain(
      'invalid_synthesis_boundary',
    );
  });
});

describe('Course Map prerequisite validation', () => {
  it('accepts a known, ordered, bounded DAG', () => {
    const fixture = createCourseMapFixture();
    const analysis = analyzeCourseMapProposal(fixture.good, fixture);
    expect(analysis.validation.valid).toBe(true);
    expect(analysis.qualityProfile.prerequisites.dagValid).toBe(true);
  });

  it.each([
    [
      'cycle',
      (fixture: ReturnType<typeof createCourseMapFixture>) => fixture.cycle,
      'prerequisite_cycle',
    ],
    [
      'self edge',
      (fixture: ReturnType<typeof createCourseMapFixture>) => ({
        ...fixture.good,
        prerequisites: [{ prerequisiteRegionRef: 'R1', dependentRegionRef: 'R1' }],
      }),
      'self_prerequisite',
    ],
    [
      'unknown id',
      (fixture: ReturnType<typeof createCourseMapFixture>) => ({
        ...fixture.good,
        prerequisites: [{ prerequisiteRegionRef: 'R999', dependentRegionRef: 'R1' }],
      }),
      'unknown_prerequisite_region',
    ],
    [
      'duplicate edge',
      (fixture: ReturnType<typeof createCourseMapFixture>) => ({
        ...fixture.good,
        prerequisites: [fixture.good.prerequisites[0]!, fixture.good.prerequisites[0]!],
      }),
      'duplicate_prerequisite',
    ],
    [
      'wrong ordering',
      (fixture: ReturnType<typeof createCourseMapFixture>) => ({
        ...fixture.good,
        prerequisites: [{ prerequisiteRegionRef: 'R2', dependentRegionRef: 'R1' }],
      }),
      'prerequisite_wrong_order',
    ],
  ])('rejects %s', (_name, proposalFor, expectedCode) => {
    const fixture = createCourseMapFixture();
    const analysis = analyzeCourseMapProposal(proposalFor(fixture), fixture);
    expect(analysis.validation.valid).toBe(false);
    expect(analysis.validation.diagnostics.map((item) => item.code)).toContain(expectedCode);
  });

  it('enforces edge-count and degree bounds supplied to the provider', () => {
    const fixture = createCourseMapFixture();
    const edgeBounded = {
      ...fixture,
      providerInput: {
        ...fixture.providerInput,
        limits: { ...fixture.providerInput.limits, maxPrerequisiteEdges: 1 },
      },
    };
    expect(
      analyzeCourseMapProposal(fixture.good, edgeBounded).validation.diagnostics.map(
        (item) => item.code,
      ),
    ).toContain('prerequisite_edge_limit_exceeded');

    const degreeBounded = {
      ...fixture,
      providerInput: {
        ...fixture.providerInput,
        limits: { ...fixture.providerInput.limits, maxPrerequisiteDegree: 0 },
      },
    };
    expect(
      analyzeCourseMapProposal(fixture.good, degreeBounded).validation.diagnostics.map(
        (item) => item.code,
      ),
    ).toContain('prerequisite_degree_exceeded');
  });
});
