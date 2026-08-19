import { describe, expect, it } from 'vitest';
import {
  fnv1a32,
  type Concept,
  type Curriculum,
  type SourceBlockRevision,
} from '@hy3-clinic/shared';
import { curriculumSourceBlockFingerprint } from './curriculumValidation.js';
import { buildCourseSourceMap, type CourseSourceMapInput } from './courseSourceMap.js';

const NOW = '2026-08-17T00:00:00.000Z';

function manifestFingerprint(
  revisions: CourseSourceMapInput['manifest']['revisions'],
  visualDerivationIdentityFingerprints: string[] = [],
): string {
  const identity =
    visualDerivationIdentityFingerprints.length === 0
      ? revisions
      : { revisions, visualDerivationIdentityFingerprints };
  return `manifest_${fnv1a32(JSON.stringify(identity)).toString(16).padStart(8, '0')}`;
}

function block(input: {
  id: string;
  materialId: string;
  materialRevisionId: string;
  index: number;
  headingPath: string[];
  content?: string;
}): SourceBlockRevision {
  const content =
    input.content ??
    `${input.id} unique opening evidence. ${'Additional exact current source evidence. '.repeat(18)}`;
  const source = {
    id: input.id,
    materialId: input.materialId,
    materialRevisionId: input.materialRevisionId,
    structuralUnitId: null,
    index: input.index,
    heading: input.headingPath.at(-1) ?? null,
    headingPath: input.headingPath,
    pageNumber: null,
    pageEnd: null,
    content,
    startOffset: input.index * 10_000,
    endOffset: input.index * 10_000 + content.length,
  };
  return {
    ...source,
    revisionFingerprint: curriculumSourceBlockFingerprint(source, input.materialRevisionId),
  };
}

function material(input: {
  materialId: string;
  revisionId: string;
  title: string;
  blocks: SourceBlockRevision[];
  workspaceId?: string;
}) {
  return {
    materialId: input.materialId,
    workspaceId: input.workspaceId ?? 'ws_course',
    title: input.title,
    availability: 'active' as const,
    activeRevisionId: input.revisionId,
    revision: {
      id: input.revisionId,
      materialId: input.materialId,
      status: 'active' as const,
      parserVersion: 'parser-1',
      parserFingerprint: `parser-${input.materialId}`,
    },
    blocks: input.blocks,
  };
}

function baseInput(): CourseSourceMapInput {
  const blocks = [
    block({
      id: 'block_a0',
      materialId: 'material_a',
      materialRevisionId: 'revision_a',
      index: 0,
      headingPath: ['Chapter 1', 'Topic A'],
    }),
    block({
      id: 'block_a1',
      materialId: 'material_a',
      materialRevisionId: 'revision_a',
      index: 1,
      headingPath: ['Chapter 1', 'Topic A'],
    }),
    block({
      id: 'block_a2',
      materialId: 'material_a',
      materialRevisionId: 'revision_a',
      index: 2,
      headingPath: ['Chapter 1', 'Topic B'],
    }),
    block({
      id: 'block_a3',
      materialId: 'material_a',
      materialRevisionId: 'revision_a',
      index: 3,
      headingPath: ['Chapter 1', 'Topic B'],
    }),
  ];
  const revisions = [
    {
      materialId: 'material_a',
      materialRevisionId: 'revision_a',
      parserVersion: 'parser-1',
      parserFingerprint: 'parser-material_a',
      sourceBlockRevisionIds: blocks.map((item) => item.id),
    },
  ];
  return {
    workspaceId: 'ws_course',
    manifest: {
      fingerprint: manifestFingerprint(revisions),
      revisions,
    },
    materials: [
      material({ materialId: 'material_a', revisionId: 'revision_a', title: 'Material A', blocks }),
    ],
    concepts: [],
    predecessor: null,
  };
}

function concept(id: string, source: SourceBlockRevision): Concept {
  const quote = source.content.slice(0, source.content.indexOf('.') + 1);
  return {
    id,
    materialId: source.materialId,
    materialRevisionId: source.materialRevisionId,
    name: id,
    summary: `Grounded concept ${id}`,
    importance: 'high',
    grounding: {
      blockId: source.id,
      quote,
      startOffset: 0,
      endOffset: quote.length,
      occurrenceCount: 1,
      reanchored: false,
    },
    createdAt: NOW,
  };
}

function predecessor(
  source: SourceBlockRevision,
  options: { workspaceId?: string; includeStale?: boolean } = {},
): Curriculum {
  const references = [
    {
      materialId: source.materialId,
      materialRevisionId: source.materialRevisionId,
      structuralUnitId: null,
      sourceBlockId: source.id,
      sourceBlockRevisionFingerprint: source.revisionFingerprint,
    },
    ...(options.includeStale
      ? [
          {
            materialId: source.materialId,
            materialRevisionId: 'revision_old',
            structuralUnitId: null,
            sourceBlockId: 'block_old',
            sourceBlockRevisionFingerprint: 'block_old',
          },
        ]
      : []),
  ];
  return {
    id: 'curriculum_predecessor',
    workspaceId: options.workspaceId ?? 'ws_course',
    contractVersionId: 'contract_previous',
    version: 1,
    predecessorId: null,
    status: 'proposed',
    executionSourceManifest: {
      fingerprint: 'manifest_previous',
      revisions: [
        {
          materialId: source.materialId,
          materialRevisionId: source.materialRevisionId,
          parserVersion: 'parser-1',
          parserFingerprint: `parser-${source.materialId}`,
          sourceBlockRevisionIds: [source.id],
        },
      ],
    },
    nodes: [
      {
        id: 'course_root',
        parentId: null,
        kind: 'course',
        index: 0,
        title: 'Course',
        sourceReferences: [],
        learningUnit: null,
      },
      {
        id: 'unit_previous',
        parentId: 'course_root',
        kind: 'learning_unit',
        index: 0,
        title: 'Previous unit',
        sourceReferences: references,
        learningUnit: {
          conceptIds: [],
          canonicalConceptIds: [],
          objectives: [
            {
              id: 'objective_previous',
              title: 'Previous objective',
              description: 'Previous objective description',
              truthPremiseStatus: 'unverified',
              truthAuthorityRecordIds: [],
            },
          ],
          prerequisiteUnitIds: [],
          graphRelationIds: [],
          riskIds: [],
        },
      },
    ],
    synthesisGroups: [],
    validation: { valid: true, errors: [], warnings: [], unmappedStructuralUnitIds: [] },
    provider: 'historical',
    providerModel: null,
    createdAt: NOW,
    acceptedAt: null,
  };
}

describe('buildCourseSourceMap', () => {
  it('accepts an asset-only material while keeping original visual and advisory description separate', () => {
    const revisions = [
      {
        materialId: 'material_visual',
        materialRevisionId: 'revision_visual',
        parserVersion: 'parser-1',
        parserFingerprint: 'parser-material_visual',
        sourceBlockRevisionIds: [],
      },
    ];
    const sourceMap = buildCourseSourceMap({
      workspaceId: 'ws_course',
      manifest: {
        fingerprint: manifestFingerprint(revisions, [`visual_derivation_${'b'.repeat(64)}`]),
        revisions,
      },
      materials: [
        {
          ...material({
            materialId: 'material_visual',
            revisionId: 'revision_visual',
            title: 'Capacity diagram',
            blocks: [],
          }),
          visuals: [
            {
              assetOccurrenceId: 'asset_visual_1',
              assetByteHash: `sha256:${'a'.repeat(64)}`,
              mediaType: 'image/png',
              width: 640,
              height: 480,
              location: {
                pageNumber: null,
                slideNumber: null,
                contextLabel: 'Standalone image',
              },
              contentOrigin: 'extracted_original',
              advisoryDescription: {
                text: 'Hy3 describes a diagram with two connected regions.',
                derivationId: 'derivation_visual_1',
                identityFingerprint: `visual_derivation_${'b'.repeat(64)}`,
                authority: 'advisory_nonblocking',
              },
            },
          ],
        },
      ],
      concepts: [],
      predecessor: null,
    });

    expect(sourceMap).toMatchObject({
      authority: 'organization_only',
      blockCount: 0,
      sectionCount: 0,
      conceptAssociationCount: 0,
      materials: [
        {
          blockCount: 0,
          sectionCount: 0,
          blocks: [],
          sections: [],
          visuals: [
            {
              contentOrigin: 'extracted_original',
              advisoryDescription: { authority: 'advisory_nonblocking' },
            },
          ],
        },
      ],
    });
    expect(sourceMap.materials[0]!.visuals[0]!.assetByteHash).toMatch(/^sha256:/u);
    expect(sourceMap.materials[0]!.visuals[0]!.advisoryDescription?.text).not.toBe(
      sourceMap.materials[0]!.visuals[0]!.assetByteHash,
    );

    expect(() =>
      buildCourseSourceMap({
        workspaceId: 'ws_course',
        manifest: { fingerprint: manifestFingerprint(revisions), revisions },
        materials: [
          material({
            materialId: 'material_visual',
            revisionId: 'revision_visual',
            title: 'Missing visual',
            blocks: [],
          }),
        ],
        concepts: [],
        predecessor: null,
      }),
    ).toThrow(/require original visual occurrences/);
  });

  it('builds deterministic exact leaves, parser hierarchy, and contiguous derived sections', () => {
    const input = baseInput();
    const first = buildCourseSourceMap(input);
    const repeated = buildCourseSourceMap(structuredClone(input));

    expect(repeated).toEqual(first);
    expect(first).toMatchObject({
      schemaVersion: 1,
      workspaceId: 'ws_course',
      manifestFingerprint: input.manifest.fingerprint,
      authority: 'organization_only',
      materialCount: 1,
      blockCount: 4,
      sectionCount: 2,
    });
    expect(first.fingerprint).toMatch(/^course_source_map_[0-9a-f]{40}$/u);

    const mapped = first.materials[0]!;
    expect(mapped.parserPathNodes.map((node) => node.headingPath)).toEqual([
      ['Chapter 1'],
      ['Chapter 1', 'Topic A'],
      ['Chapter 1', 'Topic B'],
    ]);
    expect(mapped.parserPathNodes[0]).toMatchObject({
      parentId: null,
      provenance: 'parser_heading_path',
      authority: 'navigation_only',
      sourceBlockIds: ['block_a0', 'block_a1', 'block_a2', 'block_a3'],
      blockCount: 4,
    });
    expect(mapped.parserPathNodes[1]!.parentId).toBe(mapped.parserPathNodes[0]!.id);
    expect(mapped.sections.map((section) => section.sourceBlockIds)).toEqual([
      ['block_a0', 'block_a1'],
      ['block_a2', 'block_a3'],
    ]);
    expect(
      mapped.sections.every(
        (section) =>
          section.boundaryProvenance === 'deterministic_compute_sections' &&
          section.titleProvenance === 'parser_heading_derived' &&
          section.authority === 'navigation_only' &&
          section.blockCount === section.sourceBlockIds.length,
      ),
    ).toBe(true);
    expect(mapped.blocks.map((item) => item.sourceBlockId)).toEqual([
      'block_a0',
      'block_a1',
      'block_a2',
      'block_a3',
    ]);
    expect(mapped.blocks.map((item) => item.courseSourceIndex)).toEqual([0, 1, 2, 3]);
    expect(mapped.blocks[0]).toMatchObject({
      materialId: 'material_a',
      materialRevisionId: 'revision_a',
      blockIndex: 0,
      sourceBlockRevisionFingerprint: input.materials[0]!.blocks[0]!.revisionFingerprint,
    });
  });

  it('uses manifest order across multiple Materials and ignores caller array order', () => {
    const input = baseInput();
    const blockB = block({
      id: 'block_b0',
      materialId: 'material_b',
      materialRevisionId: 'revision_b',
      index: 0,
      headingPath: ['Material B'],
    });
    input.manifest.revisions.push({
      materialId: 'material_b',
      materialRevisionId: 'revision_b',
      parserVersion: 'parser-1',
      parserFingerprint: 'parser-material_b',
      sourceBlockRevisionIds: [blockB.id],
    });
    input.manifest.fingerprint = manifestFingerprint(input.manifest.revisions);
    input.materials.unshift(
      material({
        materialId: 'material_b',
        revisionId: 'revision_b',
        title: 'Material B',
        blocks: [blockB],
      }),
    );
    input.materials[1]!.blocks.reverse();

    const result = buildCourseSourceMap(input);
    expect(result.materials.map((item) => item.materialId)).toEqual(['material_a', 'material_b']);
    expect(result.materials.map((item) => item.sourceIndex)).toEqual([0, 1]);
    expect(result.materials[0]!.blocks.map((item) => item.sourceBlockId)).toEqual([
      'block_a0',
      'block_a1',
      'block_a2',
      'block_a3',
    ]);
    expect(result.materials[1]!.blocks[0]!.courseSourceIndex).toBe(4);
  });

  it('labels heading-less computeSections windows as deterministic synthetic navigation', () => {
    const input = baseInput();
    const blocks = Array.from({ length: 4 }, (_, index) =>
      block({
        id: `plain_${index}`,
        materialId: 'material_a',
        materialRevisionId: 'revision_a',
        index,
        headingPath: [],
        content: `Plain source block ${index}. `.repeat(80),
      }),
    );
    input.materials[0]!.blocks = blocks;
    input.manifest.revisions[0]!.sourceBlockRevisionIds = blocks.map((item) => item.id);
    input.manifest.fingerprint = manifestFingerprint(input.manifest.revisions);

    const result = buildCourseSourceMap(input).materials[0]!;
    expect(result.parserPathNodes).toEqual([]);
    expect(result.sections.length).toBeGreaterThan(1);
    expect(
      result.sections.every(
        (section) =>
          section.titleProvenance === 'deterministic_synthetic' &&
          section.boundaryProvenance === 'deterministic_compute_sections',
      ),
    ).toBe(true);
    expect(result.sections.flatMap((section) => section.sourceBlockIds)).toEqual(
      blocks.map((item) => item.id),
    );
  });

  it('attaches only exact current grounded Concepts in deterministic identity order', () => {
    const input = baseInput();
    const source = input.materials[0]!.blocks[0]!;
    input.concepts = [concept('concept_z', source), concept('concept_a', source)];

    const result = buildCourseSourceMap(input);
    expect(result.conceptAssociationCount).toBe(2);
    expect(result.materials[0]!.blocks[0]!.conceptIds).toEqual(['concept_a', 'concept_z']);

    const stale = structuredClone(input);
    stale.concepts![0]!.materialRevisionId = 'revision_old';
    expect(() => buildCourseSourceMap(stale)).toThrow(/foreign or stale source owner/u);

    const inexact = structuredClone(input);
    inexact.concepts![0]!.grounding.endOffset -= 1;
    expect(() => buildCourseSourceMap(inexact)).toThrow(/not exact current evidence/u);
  });

  it('retains exact current predecessor usage while excluding stale historical references', () => {
    const input = baseInput();
    const source = input.materials[0]!.blocks[0]!;
    input.predecessor = predecessor(source, { includeStale: true });

    const result = buildCourseSourceMap(input);
    expect(result.predecessorUsedBlockCount).toBe(1);
    expect(result.materials[0]!.blocks[0]!.predecessorUsage).toEqual({
      curriculumId: 'curriculum_predecessor',
      nodeIds: ['unit_previous'],
      referenceCount: 1,
    });
    expect(
      result.materials[0]!.blocks.slice(1).every((item) => item.predecessorUsage === null),
    ).toBe(true);

    const foreign = structuredClone(input);
    foreign.predecessor = predecessor(source, { workspaceId: 'ws_foreign' });
    expect(() => buildCourseSourceMap(foreign)).toThrow(/foreign Course/u);
  });

  it.each([
    {
      name: 'foreign workspace Material',
      change: (input: CourseSourceMapInput) => {
        input.materials[0]!.workspaceId = 'ws_foreign';
      },
      error: /foreign Course/u,
    },
    {
      name: 'foreign MaterialRevision owner',
      change: (input: CourseSourceMapInput) => {
        input.materials[0]!.revision.materialId = 'material_foreign';
      },
      error: /foreign Material owner/u,
    },
    {
      name: 'foreign SourceBlock owner',
      change: (input: CourseSourceMapInput) => {
        input.materials[0]!.blocks[0]!.materialId = 'material_foreign';
      },
      error: /foreign Material or revision owner/u,
    },
    {
      name: 'stale active revision pointer',
      change: (input: CourseSourceMapInput) => {
        input.materials[0]!.activeRevisionId = 'revision_old';
      },
      error: /stale active MaterialRevision/u,
    },
    {
      name: 'stale manifest revision',
      change: (input: CourseSourceMapInput) => {
        input.manifest.revisions[0]!.materialRevisionId = 'revision_old';
      },
      error: /stale active MaterialRevision/u,
    },
    {
      name: 'parser version mismatch',
      change: (input: CourseSourceMapInput) => {
        input.manifest.revisions[0]!.parserVersion = 'parser-old';
      },
      error: /parser identity/u,
    },
    {
      name: 'parser fingerprint mismatch',
      change: (input: CourseSourceMapInput) => {
        input.materials[0]!.revision.parserFingerprint = 'parser-old';
      },
      error: /parser identity/u,
    },
  ])('rejects $name', ({ change, error }) => {
    const input = baseInput();
    change(input);
    expect(() => buildCourseSourceMap(input)).toThrow(error);
  });

  it.each([
    {
      name: 'duplicate Material identity',
      change: (input: CourseSourceMapInput) => {
        input.materials.push(structuredClone(input.materials[0]!));
        input.manifest.revisions.push({
          ...structuredClone(input.manifest.revisions[0]!),
          materialRevisionId: 'revision_other',
        });
      },
      error: /Material identities must be unique/u,
    },
    {
      name: 'duplicate MaterialRevision identity',
      change: (input: CourseSourceMapInput) => {
        const extraBlock = block({
          id: 'block_b0',
          materialId: 'material_b',
          materialRevisionId: 'revision_a',
          index: 0,
          headingPath: ['B'],
        });
        input.materials.push(
          material({
            materialId: 'material_b',
            revisionId: 'revision_a',
            title: 'B',
            blocks: [extraBlock],
          }),
        );
        input.manifest.revisions.push({
          materialId: 'material_b',
          materialRevisionId: 'revision_a',
          parserVersion: 'parser-1',
          parserFingerprint: 'parser-material_b',
          sourceBlockRevisionIds: [extraBlock.id],
        });
      },
      error: /MaterialRevision identities must be unique/u,
    },
    {
      name: 'duplicate SourceBlock identity',
      change: (input: CourseSourceMapInput) => {
        input.materials[0]!.blocks[1]!.id = input.materials[0]!.blocks[0]!.id;
      },
      error: /SourceBlock identities must be unique/u,
    },
    {
      name: 'duplicate block index',
      change: (input: CourseSourceMapInput) => {
        input.materials[0]!.blocks[1]!.index = input.materials[0]!.blocks[0]!.index;
      },
      error: /SourceBlock indexes/u,
    },
    {
      name: 'duplicate manifest SourceBlock identity',
      change: (input: CourseSourceMapInput) => {
        input.manifest.revisions[0]!.sourceBlockRevisionIds[1] =
          input.manifest.revisions[0]!.sourceBlockRevisionIds[0]!;
      },
      error: /Manifest SourceBlock identities must be unique/u,
    },
  ])('rejects $name', ({ change, error }) => {
    const input = baseInput();
    change(input);
    expect(() => buildCourseSourceMap(input)).toThrow(error);
  });

  it.each([
    {
      name: 'missing corpus block',
      change: (input: CourseSourceMapInput) => {
        input.materials[0]!.blocks.pop();
      },
    },
    {
      name: 'incomplete manifest',
      change: (input: CourseSourceMapInput) => {
        input.manifest.revisions[0]!.sourceBlockRevisionIds.pop();
      },
    },
    {
      name: 'missing manifest Material',
      change: (input: CourseSourceMapInput) => {
        input.manifest.revisions.push({
          materialId: 'material_missing',
          materialRevisionId: 'revision_missing',
          parserVersion: 'parser-1',
          parserFingerprint: 'parser-material_missing',
          sourceBlockRevisionIds: ['block_missing'],
        });
      },
    },
  ])('rejects $name', ({ change }) => {
    const input = baseInput();
    change(input);
    expect(() => buildCourseSourceMap(input)).toThrow(/exactly match|missing/u);
  });

  it('rejects a mismatched exact SourceBlock fingerprint', () => {
    const input = baseInput();
    input.materials[0]!.blocks[0]!.revisionFingerprint = 'block_stale';
    expect(() => buildCourseSourceMap(input)).toThrow(/fingerprint is stale or mismatched/u);
  });

  it('rejects a stale execution-source manifest fingerprint', () => {
    const input = baseInput();
    input.manifest.fingerprint = 'manifest_stale';
    expect(() => buildCourseSourceMap(input)).toThrow(/manifest fingerprint is stale/u);
  });

  it('rejects a manifest whose block identity order disagrees with exact source order', () => {
    const input = baseInput();
    input.manifest.revisions[0]!.sourceBlockRevisionIds.reverse();
    expect(() => buildCourseSourceMap(input)).toThrow(/does not preserve exact SourceBlock order/u);
  });

  it('rejects duplicate Concept identities before association', () => {
    const input = baseInput();
    const source = input.materials[0]!.blocks[0]!;
    input.concepts = [concept('concept_duplicate', source), concept('concept_duplicate', source)];
    expect(() => buildCourseSourceMap(input)).toThrow(/Concept identities must be unique/u);
  });

  it('rejects an input block that is not present in any manifest revision', () => {
    const input = baseInput();
    const extra = block({
      id: 'block_extra',
      materialId: 'material_a',
      materialRevisionId: 'revision_a',
      index: 4,
      headingPath: ['Chapter 1', 'Extra'],
    });
    input.materials[0]!.blocks.push(extra);
    expect(() => buildCourseSourceMap(input)).toThrow(/exactly match the manifest corpus/u);
  });
});
