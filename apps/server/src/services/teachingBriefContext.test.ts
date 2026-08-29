import { describe, expect, it } from 'vitest';
import type {
  Concept,
  Curriculum,
  EmbeddedAsset,
  Material,
  SourceAuthorityBundle,
  SourceBlockRevision,
  VisualDerivation,
} from '@hy3-clinic/shared';
import { makeMaterial, makeSemanticallySupportedObjective, T0 } from '../testing/fixtures.js';
import { curriculumSourceBlockFingerprint } from '../grounding/sourceFingerprint.js';
import {
  buildTeachingBriefSourceContext,
  TEACHING_BRIEF_MAX_BLOCKS,
  TEACHING_BRIEF_MAX_SERIALIZED_OFFER_BYTES,
  TEACHING_BRIEF_MAX_SERIALIZED_VISUAL_BYTES,
  TEACHING_BRIEF_MAX_VISUAL_OFFERS,
  type TeachingBriefVisualCandidate,
} from './teachingBriefContext.js';

function visualCandidate(index = 0): TeachingBriefVisualCandidate {
  const asset: EmbeddedAsset = {
    id: `asset_${index}`,
    materialId: 'material_a',
    materialRevisionId: 'revision_a',
    index,
    parentStructuralUnitId: null,
    sourcePath: `ppt/media/image${index + 1}.png`,
    mediaType: 'image/png',
    byteHash: `sha256:${index.toString(16).padStart(64, '0')}`,
    byteLength: 128,
    width: 320,
    height: 200,
    location: { slideNumber: index + 1 },
    relationshipKind: 'image',
    contentOrigin: 'extracted_original',
    parserVersion: 'pptx-ooxml-v1',
  };
  const derivation: VisualDerivation = {
    id: `visual_derivation_${index}`,
    materialId: asset.materialId,
    materialRevisionId: asset.materialRevisionId,
    assetId: asset.id,
    assetByteHash: asset.byteHash,
    identityFingerprint: `visual_derivation_${index.toString(16).padStart(64, '0')}`,
    semanticIdentityFingerprint: `visual_semantic_${index.toString(16).padStart(64, '0')}`,
    derivationKind: 'visual_description',
    contentOrigin: 'derived_visual_description',
    authority: 'derived',
    evidenceAdmissibility: 'advisory_nonblocking',
    validationStatus: 'accepted',
    generatorIdentity: 'provider_visual_description',
    generatorVersion: 'provider-visual-description-v1',
    provider: 'fake',
    providerModel: null,
    providerEndpointIdentity: 'local:fake',
    providerRuntimeIdentity: 'fake-provider-v1',
    configurationFingerprint: `configuration_${index}`,
    contextMode: 'image_only',
    contextFingerprint: null,
    transport: {
      mediaType: 'image/png',
      width: 320,
      height: 200,
      byteLength: 128,
      transformation: 'validated_original',
      preparationVersion: 'sharp-visual-transport-v1',
      fingerprint: `sha256:${index.toString(16).padStart(64, '0')}`,
    },
    payload: {
      description: `Diagram ${index} links the visible concepts.`,
      visualType: 'diagram',
      visibleText: null,
      importantConcepts: [`concept ${index}`],
      pedagogicalNotes: ['Use as advisory teaching context.'],
      uncertainty: [],
    },
    reusedFromDerivationId: null,
    createdAt: T0,
  };
  return { asset, derivation };
}

function block(input: {
  id: string;
  materialId: string;
  revisionId: string;
  index: number;
  content: string;
  heading?: string;
}): SourceBlockRevision {
  const base = {
    id: input.id,
    materialId: input.materialId,
    materialRevisionId: input.revisionId,
    structuralUnitId: null,
    index: input.index,
    heading: input.heading ?? `Section ${input.index}`,
    headingPath: [input.heading ?? `Section ${input.index}`],
    pageNumber: input.index + 1,
    pageEnd: input.index + 1,
    content: input.content,
    startOffset: input.index * 100,
    endOffset: input.index * 100 + input.content.length,
  };
  return {
    ...base,
    revisionFingerprint: curriculumSourceBlockFingerprint(base, input.revisionId),
  };
}

function fixture(blocksOverride?: SourceBlockRevision[]) {
  const blocks = blocksOverride ?? [
    block({
      id: 'block_a0',
      materialId: 'material_a',
      revisionId: 'revision_a',
      index: 0,
      content: 'Neighbor before.',
    }),
    block({
      id: 'block_a1',
      materialId: 'material_a',
      revisionId: 'revision_a',
      index: 1,
      content: 'Mapped exact evidence for mechanism.',
    }),
    block({
      id: 'block_a2',
      materialId: 'material_a',
      revisionId: 'revision_a',
      index: 2,
      content: 'Neighbor after.',
    }),
    block({
      id: 'block_b1',
      materialId: 'material_b',
      revisionId: 'revision_b',
      index: 0,
      content: 'Second material evidence.',
    }),
  ];
  const materials: Material[] = [
    makeMaterial({
      id: 'material_a',
      workspaceId: 'ws_1',
      activeRevisionId: 'revision_a',
      title: 'Material A',
      availability: 'active',
    }),
    makeMaterial({
      id: 'material_b',
      workspaceId: 'ws_1',
      activeRevisionId: 'revision_b',
      title: 'Material B',
      availability: 'active',
    }),
  ];
  const refs = blocks
    .filter((candidate) => candidate.id === 'block_a1' || candidate.id === 'block_b1')
    .map((candidate) => ({
      materialId: candidate.materialId,
      materialRevisionId: candidate.materialRevisionId,
      structuralUnitId: null,
      sourceBlockId: candidate.id,
      sourceBlockRevisionFingerprint: candidate.revisionFingerprint,
    }));
  const curriculum: Curriculum = {
    id: 'curriculum_1',
    workspaceId: 'ws_1',
    contractVersionId: 'contract_1',
    version: 1,
    predecessorId: null,
    status: 'accepted',
    executionSourceManifest: {
      fingerprint: 'manifest_1',
      revisions: [
        {
          materialId: 'material_a',
          materialRevisionId: 'revision_a',
          parserVersion: null,
          parserFingerprint: null,
          sourceBlockRevisionIds: blocks
            .filter((candidate) => candidate.materialId === 'material_a')
            .map((candidate) => candidate.id),
        },
        {
          materialId: 'material_b',
          materialRevisionId: 'revision_b',
          parserVersion: null,
          parserFingerprint: null,
          sourceBlockRevisionIds: blocks
            .filter((candidate) => candidate.materialId === 'material_b')
            .map((candidate) => candidate.id),
        },
      ],
    },
    nodes: [
      {
        id: 'course',
        parentId: null,
        kind: 'course',
        index: 0,
        title: 'Course',
        sourceReferences: [],
        learningUnit: null,
      },
      {
        id: 'unit_1',
        parentId: 'course',
        kind: 'learning_unit',
        index: 1,
        title: 'Mechanism',
        sourceReferences: refs,
        learningUnit: {
          conceptIds: ['concept_1'],
          canonicalConceptIds: [],
          objectives: [
            {
              id: 'objective_1',
              title: 'Explain mechanism',
              description: 'Explain it.',
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
    provider: 'fake',
    providerModel: null,
    createdAt: T0,
    acceptedAt: T0,
  };
  const groundingBlock = blocks.find((candidate) => candidate.id === 'block_a1');
  const concepts: Concept[] = groundingBlock
    ? [
        {
          id: 'concept_1',
          materialId: 'material_a',
          materialRevisionId: 'revision_a',
          name: 'Mechanism',
          summary: 'A mechanism.',
          importance: 'high',
          createdAt: T0,
          grounding: {
            blockId: groundingBlock.id,
            quote: 'exact evidence',
            startOffset: 7,
            endOffset: 21,
            occurrenceCount: 1,
            reanchored: false,
          },
        },
      ]
    : [];
  return { workspaceId: 'ws_1', curriculum, learningUnitId: 'unit_1', materials, blocks, concepts };
}

describe('Teaching Brief source context', () => {
  it('prioritizes mapped evidence, retains Concept grounding and supports multiple Materials', () => {
    const context = buildTeachingBriefSourceContext(fixture());
    expect(context.references.slice(0, 2).map((reference) => reference.sourceBlockId)).toEqual([
      'block_a1',
      'block_b1',
    ]);
    expect(context.references[0]!.quote).toContain('Mapped exact evidence');
    expect(context.materialCount).toBe(2);
    expect(context.references.map((reference) => reference.sourceBlockId)).toContain('block_a0');
  });

  it('offers the complete late exact semantic claim first without authorizing a block prefix or unselected same-block claim', () => {
    const prefix = 'context-only-prefix '.repeat(70);
    expect(prefix.length).toBeGreaterThan(1200);
    const selectedQuote = `SELECTED_EXACT_CLAIM:${'s'.repeat(1280)}`;
    expect(selectedQuote.length).toBeGreaterThan(1200);
    const unselectedQuote = 'UNSELECTED_SAME_BLOCK_CLAIM';
    const content = `${prefix}${selectedQuote}\n${unselectedQuote}`;
    const base = fixture();
    const blocks = base.blocks.map((candidate) =>
      candidate.id === 'block_a1'
        ? block({
            id: candidate.id,
            materialId: candidate.materialId,
            revisionId: candidate.materialRevisionId,
            index: candidate.index,
            content,
            heading: candidate.heading ?? 'Late claim section',
          })
        : candidate,
    );
    const input = fixture(blocks);
    input.curriculum.nodes[1]!.learningUnit!.conceptIds = [];
    input.concepts = [];
    const objective = input.curriculum.nodes[1]!.learningUnit!.objectives[0]!;
    const supportedClaimId = 'claim_supported_late';
    const unselectedClaimId = 'claim_unselected_same_block';
    const supported = makeSemanticallySupportedObjective(
      {
        ...objective,
        truthPremiseStatus: 'independently_verified',
        truthAuthorityRecordIds: ['authority_1'],
        formalAssessmentConstruct: 'explain',
        authoritySourceBlockIds: ['block_a1'],
        authorityClaimIds: [supportedClaimId, unselectedClaimId],
      },
      'relationship',
    );
    supported.semanticSupport!.fragments[0]!.authorityClaimIds = [supportedClaimId];
    input.curriculum.nodes[1]!.learningUnit!.objectives = [supported];
    const selectedStart = prefix.length;
    const unselectedStart = content.indexOf(unselectedQuote);
    const authorityBundle: SourceAuthorityBundle = {
      record: {
        id: 'authority_1',
        workspaceId: 'ws_1',
        logicalSourceId: 'logical_authority_1',
        materialId: 'material_a',
        materialRevisionId: 'revision_a',
        version: 1,
        predecessorId: null,
        premiseScope: 'Exact late-claim Teaching authority fixture.',
        policyBasis: {
          policyVersion: 'test-policy-v1',
          premiseKind: 'claim',
          basis: 'Exact quotation fixture.',
        },
        validationState: 'validated',
        conflictState: 'none',
        actor: 'local_validator',
        createdAt: T0,
        updatedAt: T0,
      },
      claims: [
        {
          id: supportedClaimId,
          authorityRecordId: 'authority_1',
          sourceBlockId: 'block_a1',
          claim: 'The selected late claim is the supported Teaching premise.',
          quote: selectedQuote,
          startOffset: selectedStart,
          endOffset: selectedStart + selectedQuote.length,
          occurrenceCount: 1,
          createdAt: T0,
        },
        {
          id: unselectedClaimId,
          authorityRecordId: 'authority_1',
          sourceBlockId: 'block_a1',
          claim: 'This second same-block claim was not mapped as semantic support.',
          quote: unselectedQuote,
          startOffset: unselectedStart,
          endOffset: unselectedStart + unselectedQuote.length,
          occurrenceCount: 1,
          createdAt: T0,
        },
      ],
      events: [],
    };

    const context = buildTeachingBriefSourceContext({
      ...input,
      authorizedObjectiveIds: [supported.id],
      sourceAuthorityBundles: [authorityBundle],
    });

    expect(context.offers[0]).toMatchObject({ sourceRef: 'S1', text: selectedQuote });
    expect(context.offers[0]!.text).toHaveLength(selectedQuote.length);
    expect(context.references[0]).toMatchObject({
      refId: 'S1',
      sourceBlockId: 'block_a1',
      startOffset: selectedStart,
      endOffset: selectedStart + selectedQuote.length,
      quote: selectedQuote,
      authorityClaimIds: [supportedClaimId],
    });
    const contextualPrefix = context.references.find(
      (reference) =>
        reference.sourceBlockId === 'block_a1' && reference.refId !== context.references[0]!.refId,
    );
    expect(contextualPrefix).toMatchObject({
      startOffset: 0,
      quote: content.slice(0, 1200),
    });
    expect(contextualPrefix).not.toHaveProperty('authorityClaimIds');
    expect(
      context.references.flatMap((reference) => reference.authorityClaimIds ?? []),
    ).not.toContain(unselectedClaimId);
  });

  it('teaches an artifact-free objective from exact manifest-confined text claiming no exact authority', () => {
    const input = fixture();
    const legacyObjective = input.curriculum.nodes[1]!.learningUnit!.objectives[0]!;
    expect(legacyObjective.semanticSupport).toBeUndefined();

    const context = buildTeachingBriefSourceContext({
      ...input,
      authorizedObjectiveIds: [legacyObjective.id],
    });

    expect(context.references.length).toBeGreaterThan(0);
    const manifestBlockIds = new Set(
      input.curriculum.executionSourceManifest.revisions.flatMap(
        (revision) => revision.sourceBlockRevisionIds,
      ),
    );
    const blockById = new Map(input.blocks.map((block) => [block.id, block]));
    for (const reference of context.references) {
      expect(reference.authorityClaimIds).toBeUndefined();
      expect(manifestBlockIds.has(reference.sourceBlockId!)).toBe(true);
      const block = blockById.get(reference.sourceBlockId!)!;
      expect(block.content.slice(reference.startOffset, reference.endOffset)).toBe(reference.quote);
      expect(block.revisionFingerprint).toBe(reference.sourceBlockRevisionFingerprint);
    }
    expect(context.offers.map((offer) => offer.text)).toEqual(
      context.references.map((reference) => reference.quote),
    );
  });

  it('refuses an artifact-free objective outside the LearningUnit and a failed present artifact', () => {
    const input = fixture();
    expect(() =>
      buildTeachingBriefSourceContext({ ...input, authorizedObjectiveIds: ['objective_foreign'] }),
    ).toThrow(/not part of this LearningUnit/u);

    const failed = fixture();
    const objective = failed.curriculum.nodes[1]!.learningUnit!.objectives[0]!;
    const supported = makeSemanticallySupportedObjective(
      {
        ...objective,
        truthAuthorityRecordIds: ['authority_1'],
        formalAssessmentConstruct: 'explain',
        authoritySourceBlockIds: ['block_a1'],
        authorityClaimIds: ['claim_authority_1'],
      },
      'mechanism',
    );
    failed.curriculum.nodes[1]!.learningUnit!.objectives[0] = {
      ...supported,
      semanticSupport: { ...supported.semanticSupport!, verdict: 'fail' },
    };
    expect(() =>
      buildTeachingBriefSourceContext({ ...failed, authorizedObjectiveIds: [objective.id] }),
    ).toThrow(/lacks passing semantic source support/u);
  });

  it('is deterministic and enforces exact block and byte budgets independently of corpus size', () => {
    const many = Array.from({ length: 80 }, (_, index) =>
      block({
        id: `block_${index}`,
        materialId: index % 2 === 0 ? 'material_a' : 'material_b',
        revisionId: index % 2 === 0 ? 'revision_a' : 'revision_b',
        index: Math.floor(index / 2),
        content: `${index} ${'bounded source text '.repeat(90)}`,
      }),
    );
    const input = fixture(many);
    input.curriculum.nodes[1]!.sourceReferences = many.map((candidate) => ({
      materialId: candidate.materialId,
      materialRevisionId: candidate.materialRevisionId,
      structuralUnitId: null,
      sourceBlockId: candidate.id,
      sourceBlockRevisionFingerprint: candidate.revisionFingerprint,
    }));
    input.curriculum.nodes[1]!.learningUnit!.conceptIds = [];
    input.concepts = [];
    const first = buildTeachingBriefSourceContext(input);
    const second = buildTeachingBriefSourceContext(input);
    expect(second).toEqual(first);
    expect(first.blockCount).toBeLessThanOrEqual(TEACHING_BRIEF_MAX_BLOCKS);
    expect(first.serializedBytes).toBe(Buffer.byteLength(JSON.stringify(first.offers), 'utf8'));
    expect(first.serializedBytes).toBeLessThanOrEqual(TEACHING_BRIEF_MAX_SERIALIZED_OFFER_BYTES);
  });

  it('rejects stale revisions and foreign Course ownership', () => {
    const stale = fixture();
    stale.materials[0] = { ...stale.materials[0]!, activeRevisionId: 'revision_new' };
    expect(() => buildTeachingBriefSourceContext(stale)).toThrow(/stale/);

    const foreign = fixture();
    foreign.materials[1] = { ...foreign.materials[1]!, workspaceId: 'ws_other' };
    expect(() => buildTeachingBriefSourceContext(foreign)).toThrow(/outside this Course/);
  });

  it('keeps bounded original visuals separate from advisory explanations and fingerprints exact derivations', () => {
    const input = {
      ...fixture(),
      visuals: Array.from({ length: 12 }, (_, index) => visualCandidate(index)),
    };
    const context = buildTeachingBriefSourceContext(input);

    expect(context.visualOfferCount).toBe(TEACHING_BRIEF_MAX_VISUAL_OFFERS);
    expect(context.visualSerializedBytes).toBeLessThanOrEqual(
      TEACHING_BRIEF_MAX_SERIALIZED_VISUAL_BYTES,
    );
    expect(context.visualOffers[0]).toMatchObject({
      referenceKey: 'V1',
      source: { authority: 'original_visual', sourceKind: 'embedded' },
      explanation: {
        contentOrigin: 'derived_visual_description',
        authority: 'advisory',
        evidenceAdmissibility: 'advisory_nonblocking',
        formalEvidenceEligible: false,
      },
    });
    expect(context.visualOffers[0]).not.toHaveProperty('assetId');
    expect(context.visualOffers[0]).not.toHaveProperty('assetByteHash');
    expect(context.visualReferences[0]).toMatchObject({
      assetId: 'asset_0',
      assetByteHash: `sha256:${'0'.repeat(64)}`,
      context: context.visualOffers[0],
    });

    const changed = fixture();
    const changedVisual = visualCandidate(0);
    changedVisual.derivation = {
      ...changedVisual.derivation,
      id: 'visual_derivation_changed',
      identityFingerprint: `visual_derivation_${'f'.repeat(64)}`,
    };
    const changedContext = buildTeachingBriefSourceContext({
      ...changed,
      visuals: [changedVisual],
    });
    expect(changedContext.fingerprint).not.toBe(
      buildTeachingBriefSourceContext({ ...fixture(), visuals: [visualCandidate(0)] }).fingerprint,
    );

    expect(() =>
      buildTeachingBriefSourceContext({
        ...fixture(),
        visuals: [visualCandidate(0), visualCandidate(0)],
      }),
    ).toThrow(/occurrence-unique/);
    const stale = visualCandidate(0);
    stale.asset = { ...stale.asset, materialRevisionId: 'revision_old' };
    expect(() => buildTeachingBriefSourceContext({ ...fixture(), visuals: [stale] })).toThrow(
      /stale, foreign, or not advisory/,
    );
  });
});
