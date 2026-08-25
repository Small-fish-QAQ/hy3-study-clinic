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
import {
  OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_BATCH,
  OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_POLICY,
  assertCurriculumObjectiveAuthoritySemanticSupport,
  attachObjectiveAuthoritySemanticSupport,
  buildObjectiveAuthoritySemanticEvaluationBatches,
  buildObjectiveAuthoritySemanticEvaluationScopes,
  fingerprintObjectiveAuthorityBinding,
  fingerprintObjectiveAuthorityProposition,
  materializeObjectiveAuthoritySemanticSupport,
  objectiveAuthoritySemanticEvaluationSourceFingerprint,
  partitionObjectiveAuthoritySemanticEvaluationScopes,
  validateCurriculumObjectiveAuthoritySemanticSupport,
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
  return buildObjectiveAuthoritySemanticEvaluationBatches({
    nodes: nodesFor(...(input.objectives ?? [objective()])),
    sourceBlocks: input.blocks ?? [block('block_3', INGESTION), block('block_1', POSITIONING)],
    authorityBundles: input.bundles ?? [
      authority('authority_3', 'block_3', INGESTION),
      authority('authority_1', 'block_1', POSITIONING),
    ],
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
    options.evidenceRefs ?? (status === 'supported' ? [expected.evidence[0]!.evidenceRef] : []);
  return {
    schemaVersion: 1,
    evaluations: [
      {
        objectiveRef: options.objectiveRef ?? expected.objectiveRef,
        proposition: options.proposition ?? expected.proposition,
        construct: options.construct ?? expected.construct,
        fragments: [
          {
            fragmentId: 'fragment_1',
            text: expected.proposition,
            status,
            supportType,
            evidenceRefs,
            rationale:
              status === 'supported'
                ? 'The exact bound evidence supports this proposition.'
                : 'The exact bound evidence supports a different proposition.',
          },
        ],
        unsupportedFragmentIds: status === 'unsupported' ? ['fragment_1'] : [],
        conflicts:
          status === 'conflicted'
            ? [
                {
                  kind: 'scope_mismatch',
                  fragmentIds: ['fragment_1'],
                  evidenceRefs,
                  rationale: 'The source scope conflicts with the proposition.',
                },
              ]
            : [],
        overreach: [],
        verdict,
        rationale:
          verdict === 'pass'
            ? 'Every fragment has exact bound semantic support.'
            : 'At least one proposition fragment is unsupported.',
      },
    ],
  };
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
  evaluation.capabilityPreservation = {
    originalProposition: requirement.originalProposition,
    mappings: requirement.originalFragments.map((original) => ({
      originalFragmentId: original.fragmentId,
      originalText: original.text,
      repairedFragmentIds: [evaluation.fragments[0]!.fragmentId],
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
  if (status === 'lost') {
    evaluation.verdict = 'fail';
    evaluation.rationale =
      'The repaired authority is supported, but the original capability is lost.';
  }
}

describe('objective-authority semantic evaluation scope', () => {
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
    expect(batch!.input.objectives[0]!.evidence.map((offer) => offer.text)).toEqual([INGESTION]);
    expect(JSON.stringify(batch!.input)).not.toContain(POSITIONING);
    const honestFailure = singleEvaluation(batch!, { verdict: 'fail' });
    const attached = materializeAndAttach(nodesFor(persisted), batch!, honestFailure);
    expect(
      validateCurriculumObjectiveAuthoritySemanticSupport(curriculum(attached)).diagnosticCodes,
    ).toContain('semantic_support_failed');
  });

  it('keeps the B7C2 O1 provider scope bound to ingestion and rejects unbound positioning', () => {
    const [batch] = batchesFor();
    expect(batch).toBeDefined();
    expect(batch!.input.policyVersion).toBe(OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_POLICY);
    expect(batch!.input.objectives[0]!.evidence).toHaveLength(1);
    expect(batch!.input.objectives[0]!.evidence[0]!.text).toBe(INGESTION);
    expect(batch!.input.objectives[0]!.evidence.some((offer) => offer.text === POSITIONING)).toBe(
      false,
    );

    const unbound = singleEvaluation(batch!, {
      supportType: 'positioning',
      evidenceRefs: ['evidence_2'],
    });
    const validation = validateObjectiveAuthoritySemanticEvaluationProposal(batch!, unbound);
    expect(validation.valid).toBe(false);
    expect(validation.diagnosticCodes).toContain('semantic_unbound_evidence_ref');
  });

  it('derives a legacy exact block only from bound claims intersecting Formal evidence', () => {
    const legacy = objective({
      authoritySourceBlockIds: undefined,
      truthAuthorityRecordIds: ['authority_1', 'authority_3'],
      authorityClaimIds: ['claim_authority_1'],
      formalEvidenceSourceBlockIds: ['block_1'],
    });
    const scopes = buildObjectiveAuthoritySemanticEvaluationScopes({
      nodes: nodesFor(legacy),
      sourceBlocks: [block('block_1', POSITIONING), block('block_3', INGESTION)],
      authorityBundles: [
        authority('authority_1', 'block_1', POSITIONING),
        authority('authority_3', 'block_3', INGESTION),
      ],
      isBlockingEligible: () => true,
    });
    expect(scopes[0]!.aliasBinding.boundSourceBlockIds).toEqual(['block_1']);
    expect(scopes[0]!.input.evidence.map((offer) => offer.text)).toEqual([POSITIONING]);
  });

  it('exposes only exact current eligible claims and keeps aliases local', () => {
    const [batch] = buildObjectiveAuthoritySemanticEvaluationBatches({
      nodes: nodesFor(
        objective({
          truthAuthorityRecordIds: ['authority_1'],
          authorityClaimIds: ['claim_authority_1'],
          authoritySourceBlockIds: ['block_1'],
          formalEvidenceSourceBlockIds: ['block_1'],
        }),
      ),
      sourceBlocks: [block('block_1', POSITIONING), block('block_3', INGESTION)],
      authorityBundles: [
        authority('authority_1', 'block_1', POSITIONING),
        authority('authority_3', 'block_3', INGESTION),
      ],
      isBlockingEligible: (id) => id === 'authority_1',
    });
    expect(batch!.input.objectives[0]!.evidence).toHaveLength(1);
    expect(batch!.input.objectives[0]!.evidence[0]!.text).toBe(POSITIONING);
    expect(JSON.stringify(batch!.input)).not.toContain('block_1');
    expect(batch!.aliasBindings.get('objective_1')!.evidenceByRef.get('evidence_1')).toEqual({
      evidenceRef: 'evidence_1',
      sourceBlockId: 'block_1',
      authorityRecordIds: ['authority_1'],
      authorityClaimIds: ['claim_authority_1'],
    });
  });

  it('does not expose an unselected convenient claim from the same authority record and block', () => {
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
    const [batch] = buildObjectiveAuthoritySemanticEvaluationBatches({
      nodes: nodesFor(
        objective({
          truthAuthorityRecordIds: ['authority_1'],
          authorityClaimIds: ['claim_selected_irrelevant'],
          authoritySourceBlockIds: ['block_1'],
          formalEvidenceSourceBlockIds: ['block_1'],
        }),
      ),
      sourceBlocks: [block('block_1', content)],
      authorityBundles: [bundle],
      isBlockingEligible: () => true,
    });

    expect(batch!.input.objectives[0]!.evidence.map((evidence) => evidence.text)).toEqual([
      selectedIrrelevantClaim,
    ]);
    expect(JSON.stringify(batch!.input)).not.toContain(POSITIONING);
    expect(batch!.aliasBindings.get('objective_1')).toMatchObject({
      boundAuthorityClaimIds: ['claim_selected_irrelevant'],
    });
    expect(batch!.aliasBindings.get('objective_1')!.evidenceByRef.get('evidence_1')).toEqual({
      evidenceRef: 'evidence_1',
      sourceBlockId: 'block_1',
      authorityRecordIds: ['authority_1'],
      authorityClaimIds: ['claim_selected_irrelevant'],
    });

    const support = materializeObjectiveAuthoritySemanticSupport(
      batch!,
      singleEvaluation(batch!, { supportType: 'positioning' }),
      {
        evaluator: 'independent-objective-authority-evaluator',
        provider: 'fake',
        providerModel: null,
        evaluatedAt: NOW,
      },
    ).get('objective_1')!;
    expect(support.boundAuthorityClaimIds).toEqual(['claim_selected_irrelevant']);
    expect(support.fragments[0]!.authorityClaimIds).toEqual(['claim_selected_irrelevant']);
    expect(JSON.stringify(support)).not.toContain('claim_unselected_convenient');
  });

  it('fingerprints exact local claim aliases even when provider-visible evidence is identical', () => {
    const makeBatch = (claimId: string) => {
      const exactAuthority = authority('authority_1', 'block_1', POSITIONING);
      exactAuthority.claims[0]!.id = claimId;
      return buildObjectiveAuthoritySemanticEvaluationBatches({
        nodes: nodesFor(
          objective({
            truthAuthorityRecordIds: ['authority_1'],
            authorityClaimIds: [claimId],
            authoritySourceBlockIds: ['block_1'],
            formalEvidenceSourceBlockIds: ['block_1'],
          }),
        ),
        sourceBlocks: [block('block_1', POSITIONING)],
        authorityBundles: [exactAuthority],
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

  it('rejects definition-only support for EXPLAIN and explanation-only support for APPLY', () => {
    const [explainBatch] = batchesFor();
    const definitionOnly = singleEvaluation(explainBatch!, { supportType: 'definition' });
    const explainValidation = validateObjectiveAuthoritySemanticEvaluationProposal(
      explainBatch!,
      definitionOnly,
    );
    expect(explainValidation.valid).toBe(false);
    expect(explainValidation.diagnosticCodes).toContain('semantic_construct_core_missing');

    const applyObjective = objective({ formalAssessmentConstruct: 'apply' });
    const [applyBatch] = batchesFor({ objectives: [applyObjective] });
    const explanationOnly = singleEvaluation(applyBatch!, { supportType: 'mechanism' });
    const applyValidation = validateObjectiveAuthoritySemanticEvaluationProposal(
      applyBatch!,
      explanationOnly,
    );
    expect(applyValidation.valid).toBe(false);
    expect(applyValidation.diagnosticCodes).toContain('semantic_construct_core_missing');
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

  it('rejects an incomplete mixed-clause partition and accepts an honestly reported unsupported clause', () => {
    const mixedObjective = objective({
      title: 'Explain the positioning',
      description: 'Explain the integration and diagnose every deployment failure.',
      truthAuthorityRecordIds: ['authority_1'],
      authoritySourceBlockIds: ['block_1'],
      formalEvidenceSourceBlockIds: ['block_1'],
    });
    const [batch] = batchesFor({ objectives: [mixedObjective] });
    const expected = batch!.input.objectives[0]!;
    const incomplete = singleEvaluation(batch!, { verdict: 'fail' });
    incomplete.evaluations[0]!.fragments[0]!.text = 'Explain the integration';
    expect(
      validateObjectiveAuthoritySemanticEvaluationProposal(batch!, incomplete).diagnosticCodes,
    ).toContain('semantic_fragment_partition_incomplete');

    const splitAt = expected.proposition.indexOf(' and diagnose');
    const mixed: ObjectiveAuthoritySemanticEvaluationProposal = {
      schemaVersion: 1,
      evaluations: [
        {
          objectiveRef: expected.objectiveRef,
          proposition: expected.proposition,
          construct: expected.construct,
          fragments: [
            {
              fragmentId: 'supported_clause',
              text: expected.proposition.slice(0, splitAt),
              status: 'supported',
              supportType: 'positioning',
              evidenceRefs: ['evidence_1'],
              rationale: 'The source states the positioning.',
            },
            {
              fragmentId: 'unsupported_clause',
              text: expected.proposition.slice(splitAt),
              status: 'unsupported',
              supportType: null,
              evidenceRefs: [],
              rationale: 'The source does not support universal diagnosis.',
            },
          ],
          unsupportedFragmentIds: ['unsupported_clause'],
          conflicts: [],
          overreach: [
            {
              kind: 'unsupported_capability',
              fragmentIds: ['unsupported_clause'],
              evidenceRefs: [],
              rationale: 'Universal diagnosis exceeds the exact source.',
            },
          ],
          verdict: 'fail',
          rationale: 'One required clause is unsupported.',
        },
      ],
    };
    expect(validateObjectiveAuthoritySemanticEvaluationProposal(batch!, mixed).valid).toBe(true);
  });

  it('accepts joint support from multiple exact bound blocks', () => {
    const jointObjective = objective({
      truthAuthorityRecordIds: ['authority_1', 'authority_3'],
      authoritySourceBlockIds: ['block_1', 'block_3'],
      formalEvidenceSourceBlockIds: ['block_1', 'block_3'],
    });
    const [batch] = batchesFor({ objectives: [jointObjective] });
    expect(batch!.input.objectives[0]!.evidence).toHaveLength(2);
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
    expect(support.fragments[0]!.sourceBlockIds).toEqual(['block_1', 'block_3']);
    expect(support.boundSourceBlockIds).toEqual(['block_1', 'block_3']);
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
    duplicate.evaluations[0]!.fragments[0]!.evidenceRefs = ['evidence_1', 'evidence_1'];
    expect(
      validateObjectiveAuthoritySemanticEvaluationProposal(batch!, duplicate).diagnosticCodes,
    ).toContain('semantic_evaluation_schema_invalid');
  });
});

describe('persisted objective-authority semantic support', () => {
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
    expect(artifact.fragments[0]!.authorityClaimIds).toEqual(['claim_authority_1']);
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
