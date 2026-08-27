import { describe, expect, it } from 'vitest';
import type {
  Curriculum,
  CurriculumNode,
  CurriculumObjective,
  ObjectiveAuthoritySemanticEvaluationProposal,
  ObjectiveAuthorityRequiredCapabilityPreservation,
  ObjectiveAuthoritySupportType,
  SourceAuthorityBundle,
  SourceBlock,
} from '@hy3-clinic/shared';
import { ObjectiveAuthoritySemanticEvaluationObjectiveInputSchema } from '@hy3-clinic/shared';
import type { CurriculumEvidenceOffer } from '../llm/provider.js';
import {
  OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_BATCH,
  OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_POLICY,
  assertCurriculumObjectiveAuthoritySemanticSupport,
  attachObjectiveAuthoritySemanticSupport,
  buildObjectiveAuthoritySemanticEvaluationBatches,
  buildObjectiveAuthoritySemanticEvaluationScopes,
  deriveEffectiveObjectiveSubjectClass,
  deriveObjectiveAuthoritySemanticEvaluationDecision,
  fingerprintObjectiveAuthorityBinding,
  fingerprintObjectiveAuthorityProposition,
  materializeObjectiveAuthoritySemanticSupport,
  isConfinedGeneralTeachingLaneSemanticFailure,
  objectiveAuthoritySemanticEvaluationSourceFingerprint,
  partitionObjectiveAuthoritySemanticEvaluationScopes,
  validateCurriculumObjectiveAuthoritySemanticSupport,
  validateObjectiveAuthoritySemanticSupport,
  validateObjectiveAuthoritySemanticEvaluationProposal,
  type ObjectiveAuthoritySemanticEvaluationBatch,
} from './objectiveAuthoritySemanticSupport.js';

const NOW = '2026-08-24T00:00:00.000Z';
const INGESTION = '上传 → 解析 → 切 chunk → embedding → 写入向量库';
const POSITIONING =
  'WeKnora 不是单纯的 LLM 或搜索引擎，而是文档、搜索、LLM、权限和工具调用的集成系统。';
const O1_TITLE = 'Explain WeKnora positioning';
const O1_DESCRIPTION =
  'Explain WeKnora’s integrated document/search/LLM/permission/tool positioning.';

function block(id: string, content: string, heading = 'Authority'): SourceBlock {
  return {
    id,
    materialId: 'material_1',
    materialRevisionId: 'revision_1',
    index: Number(id.replace(/\D/gu, '')) || 0,
    heading,
    headingPath: [heading],
    pageNumber: null,
    pageEnd: null,
    content,
    startOffset: 0,
    endOffset: content.length,
  };
}

function authority(
  id: string,
  sourceBlockId: string,
  quote: string,
  premiseKind: SourceAuthorityBundle['record']['policyBasis']['premiseKind'] = 'claim',
): SourceAuthorityBundle {
  return {
    record: {
      id,
      workspaceId: 'workspace_1',
      logicalSourceId: `logical_${id}`,
      materialId: 'material_1',
      materialRevisionId: 'revision_1',
      version: 1,
      predecessorId: null,
      premiseScope: 'Exact source claim',
      policyBasis: {
        policyVersion: 'local-verbatim-source-v1',
        premiseKind,
        basis: 'Exact source occurrence only; semantic support is evaluated separately.',
      },
      validationState: 'validated',
      conflictState: 'none',
      actor: 'local_validator',
      createdAt: NOW,
      updatedAt: NOW,
    },
    claims: [
      {
        id: `claim_${id}`,
        authorityRecordId: id,
        sourceBlockId,
        claim: quote,
        quote,
        startOffset: 0,
        endOffset: quote.length,
        occurrenceCount: 1,
        createdAt: NOW,
      },
    ],
    events: [],
  };
}

function objective(overrides: Partial<CurriculumObjective> = {}): CurriculumObjective {
  const truthAuthorityRecordIds = overrides.truthAuthorityRecordIds ?? ['authority_3'];
  const authorityClaimIds =
    overrides.authorityClaimIds ?? truthAuthorityRecordIds.map((id) => `claim_${id}`);
  return {
    id: 'objective_1',
    title: O1_TITLE,
    description: O1_DESCRIPTION,
    truthPremiseStatus: 'independently_verified',
    truthAuthorityRecordIds,
    authorityClaimIds,
    priority: 'required',
    formalAssessmentReady: true,
    formalAssessmentConstruct: 'explain',
    authorityEnvelopeTier: 'formal_sufficient',
    authoritySourceBlockIds: ['block_3'],
    formalEvidenceSourceBlockIds: ['block_3'],
    ...overrides,
  };
}

function nodesFor(...objectives: CurriculumObjective[]): CurriculumNode[] {
  return [
    {
      id: 'unit_1',
      parentId: null,
      kind: 'learning_unit',
      index: 0,
      title: 'WeKnora',
      sourceReferences: [],
      learningUnit: {
        conceptIds: [],
        canonicalConceptIds: [],
        objectives,
        prerequisiteUnitIds: [],
        graphRelationIds: [],
        riskIds: [],
      },
    },
  ];
}

function evidenceCatalogFor(blocks: readonly SourceBlock[]): CurriculumEvidenceOffer[] {
  return blocks.map((sourceBlock, index) => ({
    id: `evidence_${index + 1}`,
    materialId: sourceBlock.materialId,
    materialRevisionId: sourceBlock.materialRevisionId!,
    blockId: sourceBlock.id,
    quote: sourceBlock.content,
    startOffset: 0,
    endOffset: sourceBlock.content.length,
    headingPath: [...sourceBlock.headingPath],
  }));
}

function nodesWithSourceReferences(
  nodes: CurriculumNode[],
  blocks: readonly SourceBlock[],
): CurriculumNode[] {
  return nodes.map((node) => ({
    ...node,
    sourceReferences: blocks.map((sourceBlock) => ({
      materialId: sourceBlock.materialId,
      materialRevisionId: sourceBlock.materialRevisionId!,
      structuralUnitId: null,
      sourceBlockId: sourceBlock.id,
      sourceBlockRevisionFingerprint: null,
    })),
  }));
}

function curriculum(nodes: CurriculumNode[]): Curriculum {
  return {
    id: 'curriculum_1',
    workspaceId: 'workspace_1',
    contractVersionId: 'contract_1',
    version: 1,
    predecessorId: null,
    status: 'proposed',
    executionSourceManifest: {
      fingerprint: 'manifest_1',
      revisions: [
        {
          materialId: 'material_1',
          materialRevisionId: 'revision_1',
          parserVersion: null,
          parserFingerprint: null,
          sourceBlockRevisionIds: ['block_1@revision_1', 'block_3@revision_1'],
        },
      ],
    },
    nodes,
    synthesisGroups: [],
    validation: {
      valid: true,
      errors: [],
      warnings: [],
      unmappedStructuralUnitIds: [],
    },
    provider: 'fake',
    providerModel: null,
    createdAt: NOW,
    acceptedAt: null,
  };
}

function batchesFor(
  input: {
    objectives?: CurriculumObjective[];
    blocks?: SourceBlock[];
    bundles?: SourceAuthorityBundle[];
  } = {},
): ObjectiveAuthoritySemanticEvaluationBatch[] {
  const blocks = input.blocks ?? [block('block_3', INGESTION), block('block_1', POSITIONING)];
  return buildObjectiveAuthoritySemanticEvaluationBatches({
    nodes: nodesWithSourceReferences(nodesFor(...(input.objectives ?? [objective()])), blocks),
    sourceBlocks: blocks,
    authorityBundles: input.bundles ?? [
      authority('authority_3', 'block_3', INGESTION),
      authority('authority_1', 'block_1', POSITIONING),
    ],
    evidenceCatalog: evidenceCatalogFor(blocks),
    isBlockingEligible: () => true,
  });
}

function singleEvaluation(
  batch: ObjectiveAuthoritySemanticEvaluationBatch,
  options: {
    verdict?: 'pass' | 'fail';
    status?: 'supported' | 'unsupported' | 'conflicted';
    supportType?: ObjectiveAuthoritySupportType | null;
    evidenceRefs?: string[];
    construct?: CurriculumObjective['formalAssessmentConstruct'];
    objectiveRef?: string;
    proposition?: string;
    subjectDependency?: 'source_specific_required' | 'general_sufficient';
  } = {},
): ObjectiveAuthoritySemanticEvaluationProposal {
  const expected = batch.input.objectives[0]!;
  const verdict = options.verdict ?? 'pass';
  const status = options.status ?? (verdict === 'pass' ? 'supported' : 'unsupported');
  const supportType =
    options.supportType === undefined
      ? status === 'supported'
        ? 'positioning'
        : null
      : options.supportType;
  const evidenceRefs =
    options.evidenceRefs ??
    (status === 'supported'
      ? [batch.aliasBindings.get(expected.objectiveRef)!.boundEvidenceRefs[0]!]
      : []);
  const relevantEvidenceRefs =
    evidenceRefs.length > 0
      ? evidenceRefs
      : options.subjectDependency === 'general_sufficient'
        ? batch.aliasBindings.get(expected.objectiveRef)!.boundEvidenceRefs
        : [];
  const evaluation: Record<string, unknown> = {
    objectiveRef: options.objectiveRef ?? expected.objectiveRef,
    subjectDependency: options.subjectDependency ?? 'source_specific_required',
    subjectDependencyRationale:
      options.subjectDependency === 'general_sufficient'
        ? 'Stable public field knowledge is sufficient for this controlled objective.'
        : 'This controlled objective requires at least one source-local proposition.',
    candidateLabels: expected.candidates.map((candidate) => ({
      evidenceRef: candidate.evidenceRef,
      relation:
        status === 'conflicted' && evidenceRefs.includes(candidate.evidenceRef)
          ? 'contradicts_claim'
          : relevantEvidenceRefs.includes(candidate.evidenceRef)
            ? 'relevant'
            : 'unrelated',
    })),
    supportGroups:
      status === 'supported' && supportType && evidenceRefs.length > 0
        ? [
            {
              evidenceRefs,
              supportType,
              rationale: 'The exact candidates jointly support this proposition.',
            },
          ]
        : [],
  };
  if (options.construct !== undefined) evaluation.construct = options.construct;
  if (options.proposition !== undefined) evaluation.proposition = options.proposition;
  return {
    schemaVersion: 2,
    evaluations: [evaluation],
  } as ObjectiveAuthoritySemanticEvaluationProposal;
}

function materializeAndAttach(
  originalNodes: CurriculumNode[],
  batch: ObjectiveAuthoritySemanticEvaluationBatch,
  proposal: ObjectiveAuthoritySemanticEvaluationProposal,
): CurriculumNode[] {
  const support = materializeObjectiveAuthoritySemanticSupport(batch, proposal, {
    evaluator: 'independent-objective-authority-evaluator',
    provider: 'fake',
    providerModel: null,
    evaluatedAt: NOW,
  });
  return attachObjectiveAuthoritySemanticSupport(originalNodes, support);
}

function preservationBatch(): {
  batch: ObjectiveAuthoritySemanticEvaluationBatch;
  requirement: ObjectiveAuthorityRequiredCapabilityPreservation;
} {
  const repairedObjective = objective({
    subjectClass: 'general',
    scopeOrigin: 'anchored',
    priority: 'normal',
    truthAuthorityRecordIds: ['authority_1'],
    authoritySourceBlockIds: ['block_1'],
    formalEvidenceSourceBlockIds: ['block_1'],
  });
  const originalProposition =
    'Explain the integrated document/search system\nand explain its permission and tool positioning.';
  const splitAt = originalProposition.indexOf('and explain');
  const requirement: ObjectiveAuthorityRequiredCapabilityPreservation = {
    originalProposition,
    originalFragments: [
      { fragmentId: 'original_1', text: originalProposition.slice(0, splitAt) },
      { fragmentId: 'original_2', text: originalProposition.slice(splitAt) },
    ],
  };
  const [batch] = buildObjectiveAuthoritySemanticEvaluationBatches({
    nodes: nodesFor(repairedObjective),
    sourceBlocks: [block('block_1', POSITIONING)],
    authorityBundles: [authority('authority_1', 'block_1', POSITIONING)],
    evidenceCatalog: evidenceCatalogFor([block('block_1', POSITIONING)]),
    isBlockingEligible: () => true,
    requiredCapabilityPreservationByObjectiveId: new Map([[repairedObjective.id, requirement]]),
  });
  return { batch: batch!, requirement };
}

function addCapabilityPreservation(
  proposal: ObjectiveAuthoritySemanticEvaluationProposal,
  requirement: ObjectiveAuthorityRequiredCapabilityPreservation,
  status: 'preserved' | 'lost' = 'preserved',
): void {
  const evaluation = proposal.evaluations[0]!;
  const mutable = evaluation as typeof evaluation & {
    fragments: Array<{
      fragmentId: string;
      text: string;
      status: 'supported';
      supportType: ObjectiveAuthoritySupportType;
      evidenceRefs: string[];
      rationale: string;
    }>;
  };
  mutable.fragments = [
    {
      fragmentId: 'fragment_1',
      text: `${O1_TITLE}\n${O1_DESCRIPTION}`,
      status: 'supported',
      supportType: 'positioning',
      evidenceRefs: ['evidence_1'],
      rationale: 'The repaired proposition retains its source support.',
    },
  ];
  evaluation.capabilityPreservation = {
    originalProposition: requirement.originalProposition,
    mappings: requirement.originalFragments.map((original) => ({
      originalFragmentId: original.fragmentId,
      originalText: original.text,
      repairedFragmentIds: [mutable.fragments[0]!.fragmentId],
      status,
      rationale:
        status === 'preserved'
          ? 'The repaired proposition retains this complete original capability.'
          : 'The repaired proposition omits this original capability.',
    })),
    lostOriginalFragmentIds:
      status === 'lost' ? requirement.originalFragments.map((original) => original.fragmentId) : [],
    verdict: status === 'preserved' ? 'pass' : 'fail',
    rationale:
      status === 'preserved'
        ? 'Every original capability is preserved.'
        : 'At least one original capability is lost.',
  };
}

describe('objective-authority semantic evaluation scope', () => {
  it('keeps the evaluator structurally and byte-wise blind to generator classification', () => {
    const baseInput = {
      objectiveRef: 'objective_1',
      proposition: `${O1_TITLE}\n${O1_DESCRIPTION}`,
      construct: 'explain' as const,
      candidates: [],
    };
    expect(
      ObjectiveAuthoritySemanticEvaluationObjectiveInputSchema.safeParse(baseInput).success,
    ).toBe(true);
    expect(
      ObjectiveAuthoritySemanticEvaluationObjectiveInputSchema.safeParse({
        ...baseInput,
        subjectClass: 'general',
      }).success,
    ).toBe(false);
    expect(
      ObjectiveAuthoritySemanticEvaluationObjectiveInputSchema.safeParse({
        ...baseInput,
        scopeOrigin: 'anchored',
      }).success,
    ).toBe(false);
    expect(
      ObjectiveAuthoritySemanticEvaluationObjectiveInputSchema.safeParse({
        ...baseInput,
        generatorClassificationRationale: 'The generator called this general.',
      }).success,
    ).toBe(false);
    expect(
      ObjectiveAuthoritySemanticEvaluationObjectiveInputSchema.safeParse({
        ...baseInput,
        selected: true,
      }).success,
    ).toBe(false);

    const labelledNodes = (first: 'general' | 'source_specific') =>
      nodesFor(
        objective({
          id: 'objective_a',
          subjectClass: first,
          scopeOrigin: 'anchored',
        }),
        objective({
          id: 'objective_b',
          subjectClass: first === 'general' ? 'source_specific' : 'general',
          scopeOrigin: 'anchored',
        }),
      );
    const build = (first: 'general' | 'source_specific') =>
      buildObjectiveAuthoritySemanticEvaluationBatches({
        nodes: nodesWithSourceReferences(labelledNodes(first), [block('block_3', INGESTION)]),
        sourceBlocks: [block('block_3', INGESTION)],
        authorityBundles: [authority('authority_3', 'block_3', INGESTION)],
        evidenceCatalog: evidenceCatalogFor([block('block_3', INGESTION)]),
        isBlockingEligible: () => true,
      }).map((batch) => batch.input);

    const generalFirst = build('general');
    const sourceSpecificFirst = build('source_specific');
    expect(JSON.stringify(generalFirst)).toBe(JSON.stringify(sourceSpecificFirst));
    expect(
      generalFirst.flatMap((batch) => batch.objectives.map((item) => item.objectiveRef)),
    ).toEqual(['objective_1', 'objective_2']);

    const supplemental = buildObjectiveAuthoritySemanticEvaluationBatches({
      nodes: nodesWithSourceReferences(
        nodesFor(objective({ subjectClass: 'general', scopeOrigin: 'supplemental' })),
        [block('block_3', INGESTION)],
      ),
      sourceBlocks: [block('block_3', INGESTION)],
      authorityBundles: [authority('authority_3', 'block_3', INGESTION)],
      evidenceCatalog: evidenceCatalogFor([block('block_3', INGESTION)]),
      isBlockingEligible: () => true,
    })[0]!.input;
    const anchored = buildObjectiveAuthoritySemanticEvaluationBatches({
      nodes: nodesWithSourceReferences(
        nodesFor(objective({ subjectClass: 'general', scopeOrigin: 'anchored' })),
        [block('block_3', INGESTION)],
      ),
      sourceBlocks: [block('block_3', INGESTION)],
      authorityBundles: [authority('authority_3', 'block_3', INGESTION)],
      evidenceCatalog: evidenceCatalogFor([block('block_3', INGESTION)]),
      isBlockingEligible: () => true,
    })[0]!.input;
    expect(JSON.stringify(supplemental)).toBe(JSON.stringify(anchored));
  });

  it('permanently regresses the exact persisted B7C2 O1 and block identities', () => {
    const persistedObjectiveId = 'obj_8298c6b4-0e35-4ec0-b3c9-690e2449ad4b';
    const ingestionBlockId = 'blk_3_87594204';
    const positioningBlockId = 'blk_1_706f25b9';
    const persisted = objective({
      id: persistedObjectiveId,
      truthAuthorityRecordIds: [
        'ta_29468e8c-c744-4368-b31a-b42440a473cf',
        'ta_00bcdb69-b5d8-422c-922d-00fd70f0887f',
      ],
      authoritySourceBlockIds: [ingestionBlockId],
      formalEvidenceSourceBlockIds: [ingestionBlockId],
    });
    const [batch] = batchesFor({
      objectives: [persisted],
      blocks: [block(ingestionBlockId, INGESTION), block(positioningBlockId, POSITIONING)],
      bundles: [
        authority('ta_29468e8c-c744-4368-b31a-b42440a473cf', ingestionBlockId, INGESTION),
        authority('ta_00bcdb69-b5d8-422c-922d-00fd70f0887f', ingestionBlockId, INGESTION),
        authority('authority_positioning_unbound', positioningBlockId, POSITIONING),
      ],
    });
    expect(batch!.input.objectives[0]!.candidates.map((offer) => offer.text)).toEqual([
      INGESTION,
      POSITIONING,
    ]);
    const honestFailure = singleEvaluation(batch!, { verdict: 'fail' });
    const attached = materializeAndAttach(nodesFor(persisted), batch!, honestFailure);
    expect(
      validateCurriculumObjectiveAuthoritySemanticSupport(curriculum(attached)).diagnosticCodes,
    ).toContain('semantic_support_failed');
  });

  it('exposes the B7C2 unit window without bound markers and rejects foreign aliases', () => {
    const [batch] = batchesFor();
    expect(batch).toBeDefined();
    expect(batch!.input.policyVersion).toBe(OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_POLICY);
    expect(batch!.input.objectives[0]!.candidates).toHaveLength(2);
    expect(batch!.input.objectives[0]!.candidates.map((offer) => offer.text)).toEqual([
      INGESTION,
      POSITIONING,
    ]);
    expect(JSON.stringify(batch!.input)).not.toContain('bound');

    const unbound = singleEvaluation(batch!, {
      supportType: 'positioning',
      evidenceRefs: ['evidence_foreign'],
    });
    const validation = validateObjectiveAuthoritySemanticEvaluationProposal(batch!, unbound);
    expect(validation.valid).toBe(false);
    expect(validation.diagnosticCodes).toContain('semantic_support_group_unbound_evidence_ref');
  });

  it('derives a legacy exact block only from bound claims intersecting Formal evidence', () => {
    const legacy = objective({
      authoritySourceBlockIds: undefined,
      truthAuthorityRecordIds: ['authority_1', 'authority_3'],
      authorityClaimIds: ['claim_authority_1'],
      formalEvidenceSourceBlockIds: ['block_1'],
    });
    const blocks = [block('block_1', POSITIONING), block('block_3', INGESTION)];
    const scopes = buildObjectiveAuthoritySemanticEvaluationScopes({
      nodes: nodesWithSourceReferences(nodesFor(legacy), blocks),
      sourceBlocks: blocks,
      authorityBundles: [
        authority('authority_1', 'block_1', POSITIONING),
        authority('authority_3', 'block_3', INGESTION),
      ],
      evidenceCatalog: evidenceCatalogFor(blocks),
      isBlockingEligible: () => true,
    });
    expect(scopes[0]!.aliasBinding.boundSourceBlockIds).toEqual(['block_1']);
    expect(scopes[0]!.input.candidates.map((offer) => offer.text)).toEqual([
      POSITIONING,
      INGESTION,
    ]);
  });

  it('exposes only exact current eligible claims and keeps aliases local', () => {
    const blocks = [block('block_1', POSITIONING), block('block_3', INGESTION)];
    const [batch] = buildObjectiveAuthoritySemanticEvaluationBatches({
      nodes: nodesWithSourceReferences(
        nodesFor(
          objective({
            truthAuthorityRecordIds: ['authority_1'],
            authorityClaimIds: ['claim_authority_1'],
            authoritySourceBlockIds: ['block_1'],
            formalEvidenceSourceBlockIds: ['block_1'],
          }),
        ),
        blocks,
      ),
      sourceBlocks: blocks,
      authorityBundles: [
        authority('authority_1', 'block_1', POSITIONING),
        authority('authority_3', 'block_3', INGESTION),
      ],
      evidenceCatalog: evidenceCatalogFor(blocks),
      isBlockingEligible: (id) => id === 'authority_1',
    });
    expect(batch!.input.objectives[0]!.candidates).toHaveLength(1);
    expect(batch!.input.objectives[0]!.candidates[0]!.text).toBe(POSITIONING);
    expect(JSON.stringify(batch!.input)).not.toContain('block_1');
    expect(batch!.aliasBindings.get('objective_1')!.evidenceByRef.get('evidence_1')).toEqual({
      evidenceRef: 'evidence_1',
      evidenceId: 'evidence_1',
      candidateIndex: 0,
      sourceBlockId: 'block_1',
      authorityRecordIds: ['authority_1'],
      authorityClaimIds: ['claim_authority_1'],
    });
  });

  it('exposes exact alternate claims without revealing which claim is bound', () => {
    const selectedIrrelevantClaim = 'The ingestion queue is blue.';
    const content = `${selectedIrrelevantClaim} ${POSITIONING}`;
    const convenientStart = selectedIrrelevantClaim.length + 1;
    const bundle = authority('authority_1', 'block_1', selectedIrrelevantClaim);
    bundle.claims = [
      {
        ...bundle.claims[0]!,
        id: 'claim_selected_irrelevant',
      },
      {
        ...bundle.claims[0]!,
        id: 'claim_unselected_convenient',
        claim: POSITIONING,
        quote: POSITIONING,
        startOffset: convenientStart,
        endOffset: convenientStart + POSITIONING.length,
      },
    ];
    const sourceBlock = block('block_1', content);
    const evidenceCatalog: CurriculumEvidenceOffer[] = [
      {
        id: 'evidence_selected',
        materialId: 'material_1',
        materialRevisionId: 'revision_1',
        blockId: 'block_1',
        quote: selectedIrrelevantClaim,
        startOffset: 0,
        endOffset: selectedIrrelevantClaim.length,
        headingPath: ['Authority'],
      },
      {
        id: 'evidence_alternate',
        materialId: 'material_1',
        materialRevisionId: 'revision_1',
        blockId: 'block_1',
        quote: POSITIONING,
        startOffset: convenientStart,
        endOffset: convenientStart + POSITIONING.length,
        headingPath: ['Authority'],
      },
    ];
    const [batch] = buildObjectiveAuthoritySemanticEvaluationBatches({
      nodes: nodesWithSourceReferences(
        nodesFor(
          objective({
            truthAuthorityRecordIds: ['authority_1'],
            authorityClaimIds: ['claim_selected_irrelevant'],
            authoritySourceBlockIds: ['block_1'],
            formalEvidenceSourceBlockIds: ['block_1'],
          }),
        ),
        [sourceBlock],
      ),
      sourceBlocks: [sourceBlock],
      authorityBundles: [bundle],
      evidenceCatalog,
      isBlockingEligible: () => true,
    });

    expect(batch!.input.objectives[0]!.candidates.map((evidence) => evidence.text)).toEqual([
      selectedIrrelevantClaim,
      POSITIONING,
    ]);
    expect(batch!.aliasBindings.get('objective_1')).toMatchObject({
      boundAuthorityClaimIds: ['claim_selected_irrelevant'],
      boundEvidenceRefs: ['evidence_1'],
    });
    expect(batch!.aliasBindings.get('objective_1')!.evidenceByRef.get('evidence_1')).toEqual({
      evidenceRef: 'evidence_1',
      evidenceId: 'evidence_selected',
      candidateIndex: 0,
      sourceBlockId: 'block_1',
      authorityRecordIds: ['authority_1'],
      authorityClaimIds: ['claim_selected_irrelevant'],
    });

    expect(batch!.aliasBindings.get('objective_1')!.evidenceByRef.get('evidence_2')).toMatchObject({
      evidenceId: 'evidence_alternate',
      authorityClaimIds: ['claim_unselected_convenient'],
    });
  });

  it('keeps provider bytes identical when only private bound membership changes', () => {
    const firstText = 'The first exact candidate describes ingestion.';
    const secondText = 'The second exact candidate describes integrated positioning.';
    const separator = ' ';
    const content = `${firstText}${separator}${secondText}`;
    const secondStart = firstText.length + separator.length;
    const bundle = authority('authority_1', 'block_1', firstText);
    bundle.claims = [
      { ...bundle.claims[0]!, id: 'claim_first' },
      {
        ...bundle.claims[0]!,
        id: 'claim_second',
        claim: secondText,
        quote: secondText,
        startOffset: secondStart,
        endOffset: secondStart + secondText.length,
      },
    ];
    const sourceBlock = block('block_1', content);
    const evidenceCatalog: CurriculumEvidenceOffer[] = [
      {
        id: 'evidence_first',
        materialId: 'material_1',
        materialRevisionId: 'revision_1',
        blockId: sourceBlock.id,
        quote: firstText,
        startOffset: 0,
        endOffset: firstText.length,
        headingPath: [...sourceBlock.headingPath],
      },
      {
        id: 'evidence_second',
        materialId: 'material_1',
        materialRevisionId: 'revision_1',
        blockId: sourceBlock.id,
        quote: secondText,
        startOffset: secondStart,
        endOffset: secondStart + secondText.length,
        headingPath: [...sourceBlock.headingPath],
      },
    ];
    const makeBatch = (claimId: string) =>
      buildObjectiveAuthoritySemanticEvaluationBatches({
        nodes: nodesWithSourceReferences(
          nodesFor(
            objective({
              truthAuthorityRecordIds: ['authority_1'],
              authorityClaimIds: [claimId],
              authoritySourceBlockIds: ['block_1'],
              formalEvidenceSourceBlockIds: ['block_1'],
            }),
          ),
          [sourceBlock],
        ),
        sourceBlocks: [sourceBlock],
        authorityBundles: [bundle],
        evidenceCatalog,
        isBlockingEligible: () => true,
      })[0]!;

    const firstBound = makeBatch('claim_first');
    const secondBound = makeBatch('claim_second');
    expect(JSON.stringify(firstBound.input)).toBe(JSON.stringify(secondBound.input));
    expect(firstBound.aliasBindings.get('objective_1')!.boundEvidenceRefs).toEqual(['evidence_1']);
    expect(secondBound.aliasBindings.get('objective_1')!.boundEvidenceRefs).toEqual(['evidence_2']);
  });

  it('retains every bound candidate and reports non-fatal candidate-window truncation', () => {
    const blocks = Array.from({ length: 14 }, (_, index) =>
      block(`block_${index + 1}`, `Exact candidate ${index + 1}.`),
    );
    const bundles = blocks.map((sourceBlock, index) =>
      authority(`authority_${index + 1}`, sourceBlock.id, sourceBlock.content),
    );
    const bound = objective({
      truthAuthorityRecordIds: ['authority_14'],
      authorityClaimIds: ['claim_authority_14'],
      authoritySourceBlockIds: ['block_14'],
      formalEvidenceSourceBlockIds: ['block_14'],
    });
    const [batch] = batchesFor({ objectives: [bound], blocks, bundles });
    const input = batch!.input.objectives[0]!;
    const binding = batch!.aliasBindings.get(input.objectiveRef)!;

    expect(input.candidates).toHaveLength(12);
    expect(input.candidates.map((candidate) => candidate.text)).toEqual([
      ...blocks.slice(0, 11).map((sourceBlock) => sourceBlock.content),
      blocks[13]!.content,
    ]);
    expect(binding).toMatchObject({
      totalCandidateCount: 14,
      candidateWindowTruncated: true,
      boundEvidenceRefs: ['evidence_12'],
    });
    const noCoverage = singleEvaluation(batch!, { verdict: 'fail' });
    const decision = deriveObjectiveAuthoritySemanticEvaluationDecision(
      batch!,
      input.objectiveRef,
      noCoverage.evaluations[0]!,
    );
    expect(decision).toMatchObject({ coverage: false, candidateWindowTruncated: true });
    expect(
      materializeObjectiveAuthoritySemanticSupport(batch!, noCoverage, {
        evaluator: 'independent-objective-authority-evaluator',
        provider: 'fake',
        providerModel: null,
        evaluatedAt: NOW,
      }).get(bound.id),
    ).toMatchObject({
      candidateWindow: { totalCandidateCount: 14, offeredCandidateCount: 12, truncated: true },
      verdict: 'fail',
    });
  });

  it('fingerprints exact local claim aliases even when provider-visible evidence is identical', () => {
    const makeBatch = (claimId: string) => {
      const exactAuthority = authority('authority_1', 'block_1', POSITIONING);
      exactAuthority.claims[0]!.id = claimId;
      const blocks = [block('block_1', POSITIONING)];
      return buildObjectiveAuthoritySemanticEvaluationBatches({
        nodes: nodesWithSourceReferences(
          nodesFor(
            objective({
              truthAuthorityRecordIds: ['authority_1'],
              authorityClaimIds: [claimId],
              authoritySourceBlockIds: ['block_1'],
              formalEvidenceSourceBlockIds: ['block_1'],
            }),
          ),
          blocks,
        ),
        sourceBlocks: blocks,
        authorityBundles: [exactAuthority],
        evidenceCatalog: evidenceCatalogFor(blocks),
        isBlockingEligible: () => true,
      })[0]!;
    };
    const first = makeBatch('claim_first');
    const second = makeBatch('claim_second');

    expect(second.input).toEqual(first.input);
    expect(objectiveAuthoritySemanticEvaluationSourceFingerprint(second)).not.toBe(
      objectiveAuthoritySemanticEvaluationSourceFingerprint(first),
    );
  });

  it('re-derives a merged exact candidate as bound when any merged claim is bound', () => {
    const sourceBlock = block('block_1', POSITIONING);
    const primary = authority('authority_1', sourceBlock.id, POSITIONING);
    const alternate = authority('authority_alternate', sourceBlock.id, POSITIONING);
    const boundObjective = objective({
      truthAuthorityRecordIds: ['authority_1'],
      authorityClaimIds: ['claim_authority_1'],
      authoritySourceBlockIds: [sourceBlock.id],
      formalEvidenceSourceBlockIds: [sourceBlock.id],
    });
    const [batch] = batchesFor({
      objectives: [boundObjective],
      blocks: [sourceBlock],
      bundles: [primary, alternate],
    });
    const pass = singleEvaluation(batch!, { supportType: 'positioning' });
    const attached = materializeAndAttach(nodesFor(boundObjective), batch!, pass);
    const support = attached[0]!.learningUnit!.objectives[0]!.semanticSupport!;

    expect(support).toMatchObject({
      schemaVersion: 2,
      candidateLabels: [
        {
          authorityClaimIds: ['claim_authority_1', 'claim_authority_alternate'],
          relation: 'relevant',
        },
      ],
      verdict: 'pass',
    });
    expect(validateCurriculumObjectiveAuthoritySemanticSupport(curriculum(attached))).toEqual({
      valid: true,
      diagnostics: [],
      diagnosticCodes: [],
    });
  });

  it('partitions every objective exactly once in stable order across bounded batches', () => {
    const many = Array.from({ length: 49 }, (_, index) =>
      objective({
        id: `objective_${index + 1}`,
        truthPremiseStatus: 'unverified',
        truthAuthorityRecordIds: [],
        authoritySourceBlockIds: [],
        formalEvidenceSourceBlockIds: [],
      }),
    );
    const scopes = buildObjectiveAuthoritySemanticEvaluationScopes({
      nodes: nodesFor(...many),
      sourceBlocks: [],
      authorityBundles: [],
      evidenceCatalog: [],
      isBlockingEligible: () => false,
    });
    const batches = partitionObjectiveAuthoritySemanticEvaluationScopes(scopes);
    expect(OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_BATCH).toBe(24);
    expect(batches.map((batch) => batch.input.objectives.length)).toEqual([24, 24, 1]);
    const refs = batches.flatMap((batch) =>
      batch.input.objectives.map((item) => item.objectiveRef),
    );
    expect(refs).toEqual(many.map((_, index) => `objective_${index + 1}`));
    expect(new Set(refs)).toHaveLength(many.length);
  });
});

describe('objective-authority semantic proposal validation', () => {
  it('requires an exact complete capability-preservation mapping only for repaired objectives', () => {
    const { batch, requirement } = preservationBatch();
    expect(batch.input.objectives[0]!.requiredCapabilityPreservation).toEqual(requirement);

    const missing = singleEvaluation(batch, { supportType: 'positioning' });
    expect(
      validateObjectiveAuthoritySemanticEvaluationProposal(batch, missing).diagnosticCodes,
    ).toContain('semantic_capability_preservation_missing');

    const complete = singleEvaluation(batch, { supportType: 'positioning' });
    addCapabilityPreservation(complete, requirement);
    expect(validateObjectiveAuthoritySemanticEvaluationProposal(batch, complete)).toEqual({
      valid: true,
      diagnostics: [],
      diagnosticCodes: [],
    });

    const ordinaryBatch = batchesFor({
      objectives: [
        objective({
          truthAuthorityRecordIds: ['authority_1'],
          authoritySourceBlockIds: ['block_1'],
          formalEvidenceSourceBlockIds: ['block_1'],
        }),
      ],
    })[0]!;
    const unexpected = singleEvaluation(ordinaryBatch, { supportType: 'positioning' });
    addCapabilityPreservation(unexpected, requirement);
    expect(
      validateObjectiveAuthoritySemanticEvaluationProposal(ordinaryBatch, unexpected)
        .diagnosticCodes,
    ).toContain('semantic_capability_preservation_unexpected');
  });

  it('rejects incomplete, reordered, changed, or foreign preservation mappings', () => {
    const { batch, requirement } = preservationBatch();
    const incomplete = singleEvaluation(batch, { supportType: 'positioning' });
    addCapabilityPreservation(incomplete, requirement);
    incomplete.evaluations[0]!.capabilityPreservation!.mappings.pop();
    expect(
      validateObjectiveAuthoritySemanticEvaluationProposal(batch, incomplete).diagnosticCodes,
    ).toContain('semantic_capability_original_fragment_set_mismatch');

    const changed = singleEvaluation(batch, { supportType: 'positioning' });
    addCapabilityPreservation(changed, requirement);
    changed.evaluations[0]!.capabilityPreservation!.mappings[0]!.originalText += ' changed';
    expect(
      validateObjectiveAuthoritySemanticEvaluationProposal(batch, changed).diagnosticCodes,
    ).toContain('semantic_capability_original_fragment_mismatch');

    const reordered = singleEvaluation(batch, { supportType: 'positioning' });
    addCapabilityPreservation(reordered, requirement);
    reordered.evaluations[0]!.capabilityPreservation!.mappings.reverse();
    expect(
      validateObjectiveAuthoritySemanticEvaluationProposal(batch, reordered).diagnosticCodes,
    ).toContain('semantic_capability_original_fragment_mismatch');

    const foreign = singleEvaluation(batch, { supportType: 'positioning' });
    addCapabilityPreservation(foreign, requirement);
    foreign.evaluations[0]!.capabilityPreservation!.mappings.forEach((mapping, index) => {
      mapping.repairedFragmentIds = [`foreign_repaired_fragment_${index + 1}`];
    });
    const foreignValidation = validateObjectiveAuthoritySemanticEvaluationProposal(batch, foreign);
    expect(foreignValidation.diagnosticCodes).toContain(
      'semantic_capability_repaired_fragment_foreign',
    );
    expect(foreignValidation.diagnosticCodes).toContain(
      'semantic_capability_repaired_fragment_coverage_incomplete',
    );
  });

  it('accepts an honest lost-capability result structurally but keeps its verdict failed', () => {
    const { batch, requirement } = preservationBatch();
    const lost = singleEvaluation(batch, { supportType: 'positioning' });
    addCapabilityPreservation(lost, requirement, 'lost');
    expect(validateObjectiveAuthoritySemanticEvaluationProposal(batch, lost)).toEqual({
      valid: true,
      diagnostics: [],
      diagnosticCodes: [],
    });
    const attached = materializeAndAttach(
      nodesFor(
        objective({
          truthAuthorityRecordIds: ['authority_1'],
          authoritySourceBlockIds: ['block_1'],
          formalEvidenceSourceBlockIds: ['block_1'],
        }),
      ),
      batch,
      lost,
    );
    const validation = validateCurriculumObjectiveAuthoritySemanticSupport(curriculum(attached));
    expect(validation.diagnosticCodes).toContain('semantic_capability_preservation_failed');
    expect(validation.diagnosticCodes).toContain('semantic_support_failed');
  });

  it('accepts the honest O1 ingestion-only fail but refuses it as downstream authority', () => {
    const [batch] = batchesFor();
    const failure = singleEvaluation(batch!, { verdict: 'fail' });
    expect(validateObjectiveAuthoritySemanticEvaluationProposal(batch!, failure).valid).toBe(true);

    const originalNodes = nodesFor(objective());
    const attached = materializeAndAttach(originalNodes, batch!, failure);
    expect(originalNodes[0]!.learningUnit!.objectives[0]!.formalAssessmentReady).toBe(true);
    expect(attached).not.toBe(originalNodes);
    expect(attached[0]).not.toBe(originalNodes[0]);
    expect(attached[0]!.learningUnit!.objectives[0]!.semanticSupport?.verdict).toBe('fail');
    expect(attached[0]!.learningUnit!.objectives[0]!.formalAssessmentReady).toBe(false);
    const downstream = validateCurriculumObjectiveAuthoritySemanticSupport(curriculum(attached));
    expect(downstream.valid).toBe(false);
    expect(downstream.diagnosticCodes).toContain('semantic_support_failed');
    expect(() => assertCurriculumObjectiveAuthoritySemanticSupport(curriculum(attached))).toThrow(
      /not semantically supported/u,
    );
  });

  it('reports only invalid objective identities for bounded evaluator repair', () => {
    const objectives = [
      objective({ id: 'objective_1' }),
      objective({ id: 'objective_2' }),
      objective({ id: 'objective_3' }),
    ];
    const [batch] = batchesFor({ objectives });
    const proposal: ObjectiveAuthoritySemanticEvaluationProposal = {
      schemaVersion: 2,
      evaluations: batch!.input.objectives.map((expected) => ({
        objectiveRef: expected.objectiveRef,
        subjectDependency: 'source_specific_required',
        subjectDependencyRationale: 'The objective requires source-local truth.',
        candidateLabels: expected.candidates.map((candidate) => ({
          evidenceRef: candidate.evidenceRef,
          relation: 'relevant' as const,
        })),
        supportGroups: [
          {
            evidenceRefs: [batch!.aliasBindings.get(expected.objectiveRef)!.boundEvidenceRefs[0]!],
            supportType: 'positioning',
          },
        ],
      })),
    };
    proposal.evaluations[1]!.candidateLabels = [];

    expect(validateObjectiveAuthoritySemanticEvaluationProposal(batch!, proposal)).toMatchObject({
      valid: false,
      diagnosticCodes: ['semantic_candidate_label_set_mismatch'],
      targetedRepair: { invalidItemIds: ['objective_2'] },
    });
  });

  it('accepts bound positioning support across Chinese evidence and an English objective', () => {
    const repairedObjective = objective({
      truthAuthorityRecordIds: ['authority_1'],
      authoritySourceBlockIds: ['block_1'],
      formalEvidenceSourceBlockIds: ['block_1'],
    });
    const [batch] = batchesFor({ objectives: [repairedObjective] });
    const pass = singleEvaluation(batch!, { supportType: 'positioning' });
    expect(validateObjectiveAuthoritySemanticEvaluationProposal(batch!, pass).valid).toBe(true);
    const attached = materializeAndAttach(nodesFor(repairedObjective), batch!, pass);
    const validation = validateCurriculumObjectiveAuthoritySemanticSupport(curriculum(attached), {
      isBlockingEligible: (id) => id === 'authority_1',
    });
    expect(validation).toEqual({ valid: true, diagnostics: [], diagnosticCodes: [] });
  });

  it('does not require lexical overlap for a structurally valid semantic mapping', () => {
    const noOverlapObjective = objective({
      title: 'Classify specimen Zephyr',
      description: 'Discriminate the intended category in the supplied case.',
      formalAssessmentConstruct: 'identify',
      truthAuthorityRecordIds: ['authority_1'],
      authoritySourceBlockIds: ['block_1'],
      formalEvidenceSourceBlockIds: ['block_1'],
    });
    const [batch] = batchesFor({ objectives: [noOverlapObjective] });
    const pass = singleEvaluation(batch!, { supportType: 'discrimination' });
    expect(validateObjectiveAuthoritySemanticEvaluationProposal(batch!, pass).valid).toBe(true);
  });

  it('locally fails definition-only EXPLAIN and explanation-only APPLY support', () => {
    const [explainBatch] = batchesFor();
    const definitionOnly = singleEvaluation(explainBatch!, { supportType: 'definition' });
    const explainValidation = validateObjectiveAuthoritySemanticEvaluationProposal(
      explainBatch!,
      definitionOnly,
    );
    expect(explainValidation.valid).toBe(true);
    const explainSupport = materializeObjectiveAuthoritySemanticSupport(
      explainBatch!,
      definitionOnly,
      {
        evaluator: 'independent-objective-authority-evaluator',
        provider: 'fake',
        providerModel: null,
        evaluatedAt: NOW,
      },
    ).get('objective_1')!;
    expect(explainSupport.verdict).toBe('fail');

    const applyObjective = objective({ formalAssessmentConstruct: 'apply' });
    const [applyBatch] = batchesFor({ objectives: [applyObjective] });
    const explanationOnly = singleEvaluation(applyBatch!, { supportType: 'mechanism' });
    const applyValidation = validateObjectiveAuthoritySemanticEvaluationProposal(
      applyBatch!,
      explanationOnly,
    );
    expect(applyValidation.valid).toBe(true);
    const applySupport = materializeObjectiveAuthoritySemanticSupport(
      applyBatch!,
      explanationOnly,
      {
        evaluator: 'independent-objective-authority-evaluator',
        provider: 'fake',
        providerModel: null,
        evaluatedAt: NOW,
      },
    ).get('objective_1')!;
    expect(applySupport.verdict).toBe('fail');
  });

  it('accepts an exact procedure mapping for APPLY', () => {
    const applyObjective = objective({
      title: 'Apply the ingestion procedure',
      description: 'Perform the source-stated ingestion sequence.',
      formalAssessmentConstruct: 'apply',
    });
    const [batch] = batchesFor({ objectives: [applyObjective] });
    const procedure = singleEvaluation(batch!, { supportType: 'procedure' });
    expect(validateObjectiveAuthoritySemanticEvaluationProposal(batch!, procedure).valid).toBe(
      true,
    );
  });

  it('accepts a complete no-coverage observation and derives a local failure', () => {
    const mixedObjective = objective({
      title: 'Explain the positioning',
      description: 'Explain the integration and diagnose every deployment failure.',
      truthAuthorityRecordIds: ['authority_1'],
      authoritySourceBlockIds: ['block_1'],
      formalEvidenceSourceBlockIds: ['block_1'],
    });
    const [batch] = batchesFor({ objectives: [mixedObjective] });
    const observation = singleEvaluation(batch!, { verdict: 'fail' });
    expect(validateObjectiveAuthoritySemanticEvaluationProposal(batch!, observation).valid).toBe(
      true,
    );
    const support = materializeObjectiveAuthoritySemanticSupport(batch!, observation, {
      evaluator: 'independent-objective-authority-evaluator',
      provider: 'fake',
      providerModel: null,
      evaluatedAt: NOW,
    }).get('objective_1')!;
    expect(support).toMatchObject({
      schemaVersion: 2,
      supportGroups: [],
      verdict: 'fail',
    });
  });

  it('accepts joint support from multiple exact bound blocks', () => {
    const jointObjective = objective({
      truthAuthorityRecordIds: ['authority_1', 'authority_3'],
      authoritySourceBlockIds: ['block_1', 'block_3'],
      formalEvidenceSourceBlockIds: ['block_1', 'block_3'],
    });
    const [batch] = batchesFor({ objectives: [jointObjective] });
    expect(batch!.input.objectives[0]!.candidates).toHaveLength(2);
    const joint = singleEvaluation(batch!, {
      supportType: 'positioning',
      evidenceRefs: ['evidence_1', 'evidence_2'],
    });
    expect(validateObjectiveAuthoritySemanticEvaluationProposal(batch!, joint).valid).toBe(true);
    const support = materializeObjectiveAuthoritySemanticSupport(batch!, joint, {
      evaluator: 'independent-objective-authority-evaluator',
      provider: 'fake',
      providerModel: null,
      evaluatedAt: NOW,
    }).get('objective_1')!;
    expect(support.supportGroups[0]!.candidateIndexes).toEqual([0, 1]);
    expect(support.candidateLabels.map((candidate) => candidate.sourceBlockId)).toEqual([
      'block_3',
      'block_1',
    ]);
    expect(support.boundSourceBlockIds).toEqual(['block_1', 'block_3']);
  });

  it('discards label-inconsistent and non-minimal groups before local derivation', () => {
    const jointObjective = objective({
      truthAuthorityRecordIds: ['authority_3', 'authority_1'],
      authorityClaimIds: ['claim_authority_3', 'claim_authority_1'],
      authoritySourceBlockIds: ['block_3', 'block_1'],
      formalEvidenceSourceBlockIds: ['block_3', 'block_1'],
    });
    const [batch] = batchesFor({ objectives: [jointObjective] });
    const inconsistent = singleEvaluation(batch!, {
      supportType: 'positioning',
      evidenceRefs: ['evidence_1', 'evidence_2'],
    });
    inconsistent.evaluations[0]!.candidateLabels[1] = {
      evidenceRef: 'evidence_2',
      relation: 'unrelated',
    };
    expect(validateObjectiveAuthoritySemanticEvaluationProposal(batch!, inconsistent).valid).toBe(
      true,
    );
    const inconsistentSupport = materializeObjectiveAuthoritySemanticSupport(batch!, inconsistent, {
      evaluator: 'independent-objective-authority-evaluator',
      provider: 'fake',
      providerModel: null,
      evaluatedAt: NOW,
    }).get(jointObjective.id)!;
    expect(inconsistentSupport).toMatchObject({
      supportGroups: [],
      validationDiagnosticCodes: ['semantic_support_group_label_inconsistent'],
      verdict: 'fail',
    });

    const nonMinimal = singleEvaluation(batch!, {
      supportType: 'positioning',
      evidenceRefs: ['evidence_1'],
    });
    nonMinimal.evaluations[0]!.candidateLabels = [
      { evidenceRef: 'evidence_1', relation: 'relevant' },
      { evidenceRef: 'evidence_2', relation: 'relevant' },
    ];
    nonMinimal.evaluations[0]!.supportGroups.push({
      evidenceRefs: ['evidence_1', 'evidence_2'],
      supportType: 'positioning',
      rationale: 'This padded group is a strict superset.',
    });
    const minimalSupport = materializeObjectiveAuthoritySemanticSupport(batch!, nonMinimal, {
      evaluator: 'independent-objective-authority-evaluator',
      provider: 'fake',
      providerModel: null,
      evaluatedAt: NOW,
    }).get(jointObjective.id)!;
    expect(minimalSupport).toMatchObject({
      supportGroups: [{ candidateIndexes: [0] }],
      validationDiagnosticCodes: ['semantic_support_group_not_minimal'],
      verdict: 'pass',
    });
  });

  it('blocks only contradictions on privately bound candidates', () => {
    const nonBoundObjective = objective({
      truthAuthorityRecordIds: ['authority_3'],
      authorityClaimIds: ['claim_authority_3'],
      authoritySourceBlockIds: ['block_3'],
      formalEvidenceSourceBlockIds: ['block_3'],
    });
    const boundBothObjective = objective({
      truthAuthorityRecordIds: ['authority_3', 'authority_1'],
      authorityClaimIds: ['claim_authority_3', 'claim_authority_1'],
      authoritySourceBlockIds: ['block_3', 'block_1'],
      formalEvidenceSourceBlockIds: ['block_3', 'block_1'],
    });
    const [nonBoundBatch] = batchesFor({ objectives: [nonBoundObjective] });
    const [boundBatch] = batchesFor({ objectives: [boundBothObjective] });
    expect(nonBoundBatch!.input).toEqual(boundBatch!.input);

    const observation = singleEvaluation(nonBoundBatch!, {
      supportType: 'positioning',
      evidenceRefs: ['evidence_1'],
    });
    observation.evaluations[0]!.candidateLabels = [
      { evidenceRef: 'evidence_1', relation: 'relevant' },
      {
        evidenceRef: 'evidence_2',
        relation: 'contradicts_claim',
        rationale: 'The alternate exact candidate contradicts the proposition.',
      },
    ];
    const advisory = deriveObjectiveAuthoritySemanticEvaluationDecision(
      nonBoundBatch!,
      'objective_1',
      observation.evaluations[0]!,
    );
    const blocking = deriveObjectiveAuthoritySemanticEvaluationDecision(
      boundBatch!,
      'objective_1',
      observation.evaluations[0]!,
    );
    expect(advisory).toMatchObject({
      contradiction: false,
      nonBoundContradictionCount: 1,
      verdict: 'pass',
    });
    expect(blocking).toMatchObject({
      contradiction: true,
      nonBoundContradictionCount: 0,
      verdict: 'fail',
    });
  });

  it('fails closed on malformed, foreign, and duplicate provider output', () => {
    const [batch] = batchesFor();
    const malformed = { ...singleEvaluation(batch!), confidence: 0.99 };
    expect(
      validateObjectiveAuthoritySemanticEvaluationProposal(batch!, malformed).diagnosticCodes,
    ).toContain('semantic_evaluation_schema_invalid');

    const foreign = singleEvaluation(batch!, { objectiveRef: 'objective_foreign' });
    expect(
      validateObjectiveAuthoritySemanticEvaluationProposal(batch!, foreign).diagnosticCodes,
    ).toContain('semantic_objective_ref_mismatch');

    const duplicate = singleEvaluation(batch!);
    duplicate.evaluations[0]!.supportGroups[0]!.evidenceRefs = ['evidence_1', 'evidence_1'];
    expect(
      validateObjectiveAuthoritySemanticEvaluationProposal(batch!, duplicate).diagnosticCodes,
    ).toContain('semantic_evaluation_schema_invalid');
  });
});

describe('persisted objective-authority semantic support', () => {
  it('derives effective subject class with a conservative two-key trust table', () => {
    const attestation = (subjectDependency: 'source_specific_required' | 'general_sufficient') => ({
      subjectDependency,
    });
    expect(
      deriveEffectiveObjectiveSubjectClass(
        { subjectClass: 'general' },
        attestation('general_sufficient'),
      ),
    ).toBe('general');
    expect(
      deriveEffectiveObjectiveSubjectClass(
        { subjectClass: 'general' },
        attestation('source_specific_required'),
      ),
    ).toBe('source_specific');
    expect(
      deriveEffectiveObjectiveSubjectClass(
        { subjectClass: 'source_specific' },
        attestation('general_sufficient'),
      ),
    ).toBe('source_specific');
    expect(
      deriveEffectiveObjectiveSubjectClass(
        { subjectClass: 'source_specific' },
        attestation('source_specific_required'),
      ),
    ).toBe('source_specific');
    expect(
      deriveEffectiveObjectiveSubjectClass(
        { subjectClass: undefined },
        attestation('general_sufficient'),
      ),
    ).toBe('source_specific');
    expect(deriveEffectiveObjectiveSubjectClass({ subjectClass: 'general' }, undefined)).toBe(
      'source_specific',
    );
  });

  it('admits only an anchored double-general unsupported failure and confines all authority', () => {
    const generalObjective = objective({
      subjectClass: 'general',
      scopeOrigin: 'anchored',
      priority: 'normal',
    });
    const [batch] = batchesFor({ objectives: [generalObjective] });
    const failure = singleEvaluation(batch!, {
      verdict: 'fail',
      subjectDependency: 'general_sufficient',
    });
    const attached = materializeAndAttach(nodesFor(generalObjective), batch!, failure);
    const confined = attached[0]!.learningUnit!.objectives[0]!;

    expect(isConfinedGeneralTeachingLaneSemanticFailure(confined, confined.semanticSupport)).toBe(
      true,
    );
    expect(confined.semanticSupport?.verdict).toBe('fail');
    expect(confined.truthPremiseStatus).toBe('unverified');
    expect(confined.formalEvidenceSourceBlockIds).toEqual([]);
    expect(confined.formalAssessmentReady).toBe(false);
    expect(confined.authoritySourceBlockIds).toEqual(['block_3']);
    expect(validateCurriculumObjectiveAuthoritySemanticSupport(curriculum(attached))).toEqual({
      valid: true,
      diagnostics: [],
      diagnosticCodes: [],
    });
  });

  it('never tolerates conflicts, capability loss, construct defects, or stale authority', () => {
    const generalObjective = objective({
      subjectClass: 'general',
      scopeOrigin: 'anchored',
      priority: 'normal',
    });
    const [batch] = batchesFor({ objectives: [generalObjective] });
    const conflicted = singleEvaluation(batch!, {
      verdict: 'fail',
      status: 'conflicted',
      evidenceRefs: ['evidence_1'],
      subjectDependency: 'general_sufficient',
    });
    const conflictedNodes = materializeAndAttach(nodesFor(generalObjective), batch!, conflicted);
    expect(
      validateCurriculumObjectiveAuthoritySemanticSupport(curriculum(conflictedNodes))
        .diagnosticCodes,
    ).toContain('semantic_support_failed');

    const { batch: recoveryBatch, requirement } = preservationBatch();
    const lost = singleEvaluation(recoveryBatch, {
      supportType: 'positioning',
      subjectDependency: 'general_sufficient',
    });
    addCapabilityPreservation(lost, requirement, 'lost');
    const lostObjective = objective({
      subjectClass: 'general',
      scopeOrigin: 'anchored',
      priority: 'normal',
      truthAuthorityRecordIds: ['authority_1'],
      authoritySourceBlockIds: ['block_1'],
      formalEvidenceSourceBlockIds: ['block_1'],
    });
    const lostNodes = materializeAndAttach(nodesFor(lostObjective), recoveryBatch, lost);
    const lostValidation = validateCurriculumObjectiveAuthoritySemanticSupport(
      curriculum(lostNodes),
    );
    expect(lostValidation.diagnosticCodes).toContain('semantic_capability_preservation_failed');
    expect(lostValidation.diagnosticCodes).toContain('semantic_support_failed');

    const designObjective = objective({
      subjectClass: 'general',
      scopeOrigin: 'anchored',
      priority: 'normal',
      formalAssessmentConstruct: 'design',
    });
    const [designBatch] = batchesFor({ objectives: [designObjective] });
    const designFailure = singleEvaluation(designBatch!, {
      verdict: 'fail',
      subjectDependency: 'general_sufficient',
    });
    const designNodes = materializeAndAttach(
      nodesFor(designObjective),
      designBatch!,
      designFailure,
    );
    const designValidation = validateCurriculumObjectiveAuthoritySemanticSupport(
      curriculum(designNodes),
    );
    expect(designValidation.diagnosticCodes).toContain('semantic_construct_prohibited_v1');
    expect(designValidation.diagnosticCodes).toContain('semantic_support_failed');

    const unsupportedFailure = singleEvaluation(batch!, {
      verdict: 'fail',
      subjectDependency: 'general_sufficient',
    });
    const staleNodes = materializeAndAttach(nodesFor(generalObjective), batch!, unsupportedFailure);
    staleNodes[0]!.learningUnit!.objectives[0]!.semanticSupport!.propositionFingerprint = 'stale';
    const staleValidation = validateCurriculumObjectiveAuthoritySemanticSupport(
      curriculum(staleNodes),
    );
    expect(staleValidation.diagnosticCodes).toContain('semantic_proposition_fingerprint_mismatch');
    expect(staleValidation.diagnosticCodes).toContain('semantic_support_failed');

    const ineligibleNodes = materializeAndAttach(
      nodesFor(generalObjective),
      batch!,
      unsupportedFailure,
    );
    const ineligibleValidation = validateCurriculumObjectiveAuthoritySemanticSupport(
      curriculum(ineligibleNodes),
      { isBlockingEligible: () => false },
    );
    expect(ineligibleValidation.diagnosticCodes).toContain(
      'semantic_authority_not_blocking_eligible',
    );
    expect(ineligibleValidation.diagnosticCodes).toContain('semantic_support_failed');
  });

  it('keeps one-key, required, supplemental, and legacy failures on the full gate', () => {
    const cases: Array<{
      name: string;
      objective: CurriculumObjective;
      subjectDependency: 'source_specific_required' | 'general_sufficient';
      expectedCode?: string;
    }> = [
      {
        name: 'generator only',
        objective: objective({
          subjectClass: 'general',
          scopeOrigin: 'anchored',
          priority: 'normal',
        }),
        subjectDependency: 'source_specific_required',
      },
      {
        name: 'attester only',
        objective: objective({
          subjectClass: 'source_specific',
          scopeOrigin: 'anchored',
          priority: 'normal',
        }),
        subjectDependency: 'general_sufficient',
      },
      {
        name: 'supplemental',
        objective: objective({
          subjectClass: 'general',
          scopeOrigin: 'supplemental',
          priority: 'normal',
        }),
        subjectDependency: 'general_sufficient',
      },
      {
        name: 'required',
        objective: objective({
          subjectClass: 'general',
          scopeOrigin: 'anchored',
          priority: 'required',
        }),
        subjectDependency: 'general_sufficient',
        expectedCode: 'semantic_required_objective_not_ready',
      },
      {
        name: 'legacy objective',
        objective: objective({ priority: 'normal' }),
        subjectDependency: 'general_sufficient',
      },
    ];

    for (const item of cases) {
      const [batch] = batchesFor({ objectives: [item.objective] });
      const failure = singleEvaluation(batch!, {
        verdict: 'fail',
        subjectDependency: item.subjectDependency,
      });
      const attached = materializeAndAttach(nodesFor(item.objective), batch!, failure);
      const validation = validateCurriculumObjectiveAuthoritySemanticSupport(curriculum(attached));
      expect(validation.diagnosticCodes, item.name).toContain('semantic_support_failed');
      if (item.expectedCode)
        expect(validation.diagnosticCodes, item.name).toContain(item.expectedCode);
    }

    const generalObjective = objective({
      subjectClass: 'general',
      scopeOrigin: 'anchored',
      priority: 'normal',
    });
    const [batch] = batchesFor({ objectives: [generalObjective] });
    const failure = singleEvaluation(batch!, {
      verdict: 'fail',
      subjectDependency: 'general_sufficient',
    });
    const attached = materializeAndAttach(nodesFor(generalObjective), batch!, failure);
    delete attached[0]!.learningUnit!.objectives[0]!.semanticSupport!.subjectDependency;
    delete attached[0]!.learningUnit!.objectives[0]!.semanticSupport!.subjectDependencyRationale;
    expect(
      validateCurriculumObjectiveAuthoritySemanticSupport(curriculum(attached)).diagnosticCodes,
    ).toContain('semantic_support_malformed');
  });

  it('validates an explicit objective scope without changing the whole-Curriculum default', () => {
    const baseObjective = objective({
      truthAuthorityRecordIds: ['authority_1'],
      authoritySourceBlockIds: ['block_1'],
      formalEvidenceSourceBlockIds: ['block_1'],
    });
    const [batch] = batchesFor({ objectives: [baseObjective] });
    const attached = materializeAndAttach(
      nodesFor(baseObjective),
      batch!,
      singleEvaluation(batch!, { supportType: 'positioning' }),
    );
    const target = attached[0]!.learningUnit!.objectives[0]!;
    const unrelated = structuredClone(target);
    unrelated.id = 'objective_unrelated';
    unrelated.semanticSupport!.objectiveId = unrelated.id;
    unrelated.description = `${unrelated.description} Stale outside the selected Lesson scope.`;

    const combined = curriculum(nodesFor(target, unrelated));
    expect(validateObjectiveAuthoritySemanticSupport(combined, [target])).toEqual({
      valid: true,
      diagnostics: [],
      diagnosticCodes: [],
    });
    expect(
      validateObjectiveAuthoritySemanticSupport(combined, [unrelated]).diagnosticCodes,
    ).toEqual(
      expect.arrayContaining([
        'semantic_proposition_mismatch',
        'semantic_proposition_fingerprint_mismatch',
      ]),
    );
    expect(validateCurriculumObjectiveAuthoritySemanticSupport(combined).diagnosticCodes).toEqual(
      expect.arrayContaining(['semantic_proposition_mismatch']),
    );
  });

  it('keeps Lesson-style exact scope while allowing only an eligible relevant general failure', () => {
    const targetObjective = objective({
      id: 'objective_target_general',
      subjectClass: 'general',
      scopeOrigin: 'anchored',
      priority: 'normal',
    });
    const unrelatedObjective = objective({
      id: 'objective_unrelated_source_specific',
      subjectClass: 'source_specific',
      scopeOrigin: 'anchored',
      priority: 'normal',
    });
    const [targetBatch] = batchesFor({ objectives: [targetObjective] });
    const [unrelatedBatch] = batchesFor({ objectives: [unrelatedObjective] });
    const target = materializeAndAttach(
      nodesFor(targetObjective),
      targetBatch!,
      singleEvaluation(targetBatch!, {
        verdict: 'fail',
        subjectDependency: 'general_sufficient',
      }),
    )[0]!.learningUnit!.objectives[0]!;
    const unrelated = materializeAndAttach(
      nodesFor(unrelatedObjective),
      unrelatedBatch!,
      singleEvaluation(unrelatedBatch!, {
        verdict: 'fail',
        subjectDependency: 'general_sufficient',
      }),
    )[0]!.learningUnit!.objectives[0]!;
    const combined = curriculum(nodesFor(target, unrelated));

    expect(validateObjectiveAuthoritySemanticSupport(combined, [target])).toEqual({
      valid: true,
      diagnostics: [],
      diagnosticCodes: [],
    });
    expect(
      validateObjectiveAuthoritySemanticSupport(combined, [unrelated]).diagnosticCodes,
    ).toContain('semantic_support_failed');
    expect(validateCurriculumObjectiveAuthoritySemanticSupport(combined).diagnosticCodes).toContain(
      'semantic_support_failed',
    );
  });

  it('persists and defensively fingerprints the independently evaluated original capability', () => {
    const { batch, requirement } = preservationBatch();
    const pass = singleEvaluation(batch, { supportType: 'positioning' });
    addCapabilityPreservation(pass, requirement);
    const repairedObjective = objective({
      truthAuthorityRecordIds: ['authority_1'],
      authoritySourceBlockIds: ['block_1'],
      formalEvidenceSourceBlockIds: ['block_1'],
    });
    const attached = materializeAndAttach(nodesFor(repairedObjective), batch, pass);
    const artifact = attached[0]!.learningUnit!.objectives[0]!.semanticSupport!;
    expect(artifact.boundAuthorityClaimIds).toEqual(['claim_authority_1']);
    expect(artifact.fragments![0]!.authorityClaimIds).toEqual(['claim_authority_1']);
    expect(artifact.capabilityPreservation).toMatchObject({
      originalProposition: requirement.originalProposition,
      originalPropositionFingerprint: fingerprintObjectiveAuthorityProposition(
        requirement.originalProposition,
      ),
      verdict: 'pass',
    });
    expect(validateCurriculumObjectiveAuthoritySemanticSupport(curriculum(attached))).toEqual({
      valid: true,
      diagnostics: [],
      diagnosticCodes: [],
    });

    const stale = structuredClone(attached);
    stale[0]!.learningUnit!.objectives[0]!.semanticSupport!.capabilityPreservation!.originalPropositionFingerprint =
      'stale';
    expect(
      validateCurriculumObjectiveAuthoritySemanticSupport(curriculum(stale)).diagnosticCodes,
    ).toContain('semantic_capability_original_fingerprint_mismatch');
  });

  it('computes deterministic proposition and exact-binding fingerprints', () => {
    expect(fingerprintObjectiveAuthorityProposition('A\nB')).toBe(
      fingerprintObjectiveAuthorityProposition('A\nB'),
    );
    expect(
      fingerprintObjectiveAuthorityBinding({
        authorityRecordIds: ['authority_1'],
        sourceBlockIds: ['block_1'],
        authorityClaimIds: ['claim_authority_1'],
      }),
    ).not.toBe(
      fingerprintObjectiveAuthorityBinding({
        authorityRecordIds: ['authority_1'],
        sourceBlockIds: ['block_3'],
        authorityClaimIds: ['claim_authority_1'],
      }),
    );
  });

  it('detects stale proposition and binding fingerprints defensively', () => {
    const repairedObjective = objective({
      truthAuthorityRecordIds: ['authority_1'],
      authoritySourceBlockIds: ['block_1'],
      formalEvidenceSourceBlockIds: ['block_1'],
    });
    const [batch] = batchesFor({ objectives: [repairedObjective] });
    const attached = materializeAndAttach(
      nodesFor(repairedObjective),
      batch!,
      singleEvaluation(batch!, { supportType: 'positioning' }),
    );
    const stale = structuredClone(attached);
    stale[0]!.learningUnit!.objectives[0]!.semanticSupport!.propositionFingerprint = 'stale';
    stale[0]!.learningUnit!.objectives[0]!.semanticSupport!.bindingFingerprint = 'stale';
    const validation = validateCurriculumObjectiveAuthoritySemanticSupport(curriculum(stale));
    expect(validation.diagnosticCodes).toContain('semantic_proposition_fingerprint_mismatch');
    expect(validation.diagnosticCodes).toContain('semantic_binding_fingerprint_mismatch');
  });

  it('rejects a Formal objective whose semantic and Formal exact envelopes diverge', () => {
    const mismatchedObjective = objective({
      truthAuthorityRecordIds: ['authority_1'],
      authoritySourceBlockIds: ['block_1'],
      formalEvidenceSourceBlockIds: ['block_3'],
    });
    const [batch] = batchesFor({ objectives: [mismatchedObjective] });
    const attached = materializeAndAttach(
      nodesFor(mismatchedObjective),
      batch!,
      singleEvaluation(batch!, { supportType: 'positioning' }),
    );

    const validation = validateCurriculumObjectiveAuthoritySemanticSupport(curriculum(attached));

    expect(validation.valid).toBe(false);
    expect(validation.diagnosticCodes).toContain('semantic_formal_authority_envelope_mismatch');
    expect(() => assertCurriculumObjectiveAuthoritySemanticSupport(curriculum(attached))).toThrow(
      /one exact source-block envelope/u,
    );
  });

  it('retains a distinct exact teaching envelope when no Formal evidence is granted', () => {
    const teachingObjective = objective({
      truthPremiseStatus: 'unverified',
      truthAuthorityRecordIds: ['authority_1'],
      priority: 'normal',
      formalAssessmentReady: false,
      authoritySourceBlockIds: ['block_1'],
      formalEvidenceSourceBlockIds: [],
    });
    const [batch] = batchesFor({ objectives: [teachingObjective] });
    const attached = materializeAndAttach(
      nodesFor(teachingObjective),
      batch!,
      singleEvaluation(batch!, { supportType: 'positioning' }),
    );

    expect(validateCurriculumObjectiveAuthoritySemanticSupport(curriculum(attached))).toEqual({
      valid: true,
      diagnostics: [],
      diagnosticCodes: [],
    });
  });

  it('fails legacy Curriculum data locally when no semantic artifact exists', () => {
    const legacy = curriculum(nodesFor(objective({ semanticSupport: undefined })));
    const validation = validateCurriculumObjectiveAuthoritySemanticSupport(legacy);
    expect(validation.valid).toBe(false);
    expect(validation.diagnosticCodes).toContain('semantic_support_missing');
    expect(() => assertCurriculumObjectiveAuthoritySemanticSupport(legacy)).toThrow();
  });

  it('fails when any exact authority record becomes non-blocking-eligible', () => {
    const repairedObjective = objective({
      truthAuthorityRecordIds: ['authority_1'],
      authoritySourceBlockIds: ['block_1'],
      formalEvidenceSourceBlockIds: ['block_1'],
    });
    const [batch] = batchesFor({ objectives: [repairedObjective] });
    const attached = materializeAndAttach(
      nodesFor(repairedObjective),
      batch!,
      singleEvaluation(batch!, { supportType: 'positioning' }),
    );
    const validation = validateCurriculumObjectiveAuthoritySemanticSupport(curriculum(attached), {
      isBlockingEligible: () => false,
    });
    expect(validation.diagnosticCodes).toContain('semantic_authority_not_blocking_eligible');
  });
});
