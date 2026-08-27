import { describe, expect, it } from 'vitest';
import type {
  CurriculumNode,
  CurriculumObjective,
  CurriculumProposalPayload,
  ObjectiveAuthoritySemanticEvaluationProposal,
  SourceAuthorityBundle,
  SourceBlock,
} from '@hy3-clinic/shared';
import type { CurriculumEvidenceOffer } from '../llm/provider.js';
import {
  buildObjectiveAuthoritySemanticEvaluationBatches,
  type ObjectiveAuthoritySemanticEvaluationBatch,
} from './objectiveAuthoritySemanticSupport.js';
import {
  applyObjectiveAuthoritySemanticDeterministicRebind,
  applyObjectiveAuthoritySemanticRepairProposal,
  objectiveAuthoritySemanticRepairSourceFingerprint,
  prepareObjectiveAuthoritySemanticRepair,
  validateObjectiveAuthoritySemanticRepairProposal,
  type ObjectiveAuthoritySemanticRepairBatch,
} from './objectiveAuthoritySemanticRepair.js';

const NOW = '2026-08-24T00:00:00.000Z';
const INGESTION = '上传 → 解析 → 切 chunk → embedding → 写入向量库';
const POSITIONING =
  'WeKnora 不是单纯的 LLM 或搜索引擎，而是文档、搜索、LLM、权限和工具调用的集成系统。';
const FOREIGN = 'A foreign unit discusses an unrelated deployment topology.';

function block(id: string, content: string): SourceBlock {
  return {
    id,
    materialId: 'material_1',
    materialRevisionId: 'revision_1',
    index: Number(id.replace(/\D/gu, '')) || 0,
    heading: 'Authority',
    headingPath: ['Authority'],
    pageNumber: null,
    pageEnd: null,
    content,
    startOffset: 0,
    endOffset: content.length,
  };
}

function evidence(id: string, sourceBlock: SourceBlock): CurriculumEvidenceOffer {
  return {
    id,
    bindingId: `binding_${id}`,
    materialId: sourceBlock.materialId,
    materialRevisionId: sourceBlock.materialRevisionId,
    blockId: sourceBlock.id,
    startOffset: 0,
    endOffset: sourceBlock.content.length,
    quote: sourceBlock.content,
    headingPath: [...sourceBlock.headingPath],
    pageNumber: null,
  };
}

function authority(id: string, sourceBlock: SourceBlock): SourceAuthorityBundle {
  return {
    record: {
      id,
      workspaceId: 'workspace_1',
      logicalSourceId: `logical_${id}`,
      materialId: sourceBlock.materialId,
      materialRevisionId: sourceBlock.materialRevisionId,
      version: 1,
      predecessorId: null,
      premiseScope: 'Exact source claim',
      policyBasis: {
        policyVersion: 'local-verbatim-source-v1',
        premiseKind: 'claim',
        basis: 'Exact source occurrence; semantic support remains independent.',
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
        sourceBlockId: sourceBlock.id,
        claim: sourceBlock.content,
        quote: sourceBlock.content,
        startOffset: 0,
        endOffset: sourceBlock.content.length,
        occurrenceCount: 1,
        createdAt: NOW,
      },
    ],
    events: [],
  };
}

function proposal(): CurriculumProposalPayload {
  return {
    nodes: [
      {
        key: 'chapter',
        parentKey: null,
        kind: 'chapter',
        index: 0,
        title: 'WeKnora',
        structuralUnitIds: [],
        sourceEvidence: [],
        conceptIds: [],
        canonicalConceptIds: [],
        objectives: [],
        prerequisiteUnitKeys: [],
        graphRelationIds: [],
      },
      {
        key: 'section',
        parentKey: 'chapter',
        kind: 'section',
        index: 0,
        title: 'System overview',
        structuralUnitIds: [],
        sourceEvidence: [],
        conceptIds: [],
        canonicalConceptIds: [],
        objectives: [],
        prerequisiteUnitKeys: [],
        graphRelationIds: [],
      },
      {
        key: 'unit',
        parentKey: 'section',
        kind: 'learning_unit',
        index: 0,
        title: 'WeKnora positioning and ingestion',
        structuralUnitIds: [],
        sourceEvidence: [{ evidenceId: 'evidence_ingestion' }],
        conceptIds: [],
        canonicalConceptIds: [],
        objectives: [
          {
            key: 'failed',
            title: 'Explain WeKnora positioning',
            description:
              'Explain WeKnora’s integrated document/search/LLM/permission/tool positioning.',
            subjectClass: 'source_specific',
            scopeOrigin: 'anchored',
            construct: 'explain',
            evidence: [{ evidenceId: 'evidence_ingestion' }],
            priority: 'required',
            priorityRationale: 'This is the central course outcome.',
          },
          {
            key: 'passing',
            title: 'Identify the integrated-system statement',
            description: 'Recognize the source-stated positioning of WeKnora.',
            subjectClass: 'source_specific',
            scopeOrigin: 'anchored',
            construct: 'identify',
            evidence: [{ evidenceId: 'evidence_positioning' }],
            priority: 'high',
            priorityRationale: 'This prepares the explanation objective.',
          },
        ],
        prerequisiteUnitKeys: [],
        graphRelationIds: [],
      },
    ],
    synthesisGroups: [],
  };
}

function objective(
  id: string,
  candidateObjective: CurriculumProposalPayload['nodes'][number]['objectives'][number],
  authorityId: string,
  blockId: string,
): CurriculumObjective {
  return {
    id,
    title: candidateObjective.title,
    description: candidateObjective.description,
    subjectClass: candidateObjective.subjectClass,
    scopeOrigin: candidateObjective.scopeOrigin,
    truthPremiseStatus: 'independently_verified',
    truthAuthorityRecordIds: [authorityId],
    authorityClaimIds: [`claim_${authorityId}`],
    priority: candidateObjective.priority,
    priorityRationale: candidateObjective.priorityRationale,
    formalAssessmentReady: true,
    formalAssessmentConstruct: candidateObjective.construct,
    authorityEnvelopeTier: 'formal_sufficient',
    authoritySourceBlockIds: [blockId],
    formalEvidenceSourceBlockIds: [blockId],
  };
}

function evaluationProposal(
  batch: ObjectiveAuthoritySemanticEvaluationBatch,
  secondVerdict: 'pass' | 'fail',
): ObjectiveAuthoritySemanticEvaluationProposal {
  return {
    schemaVersion: 2,
    evaluations: batch.input.objectives.map((item, index) => {
      const verdict = index === 0 ? 'fail' : secondVerdict;
      const fragmentId = `fragment_${index + 1}`;
      const boundEvidenceRef = batch.aliasBindings.get(item.objectiveRef)!.boundEvidenceRefs[0]!;
      return {
        objectiveRef: item.objectiveRef,
        subjectDependency: 'source_specific_required' as const,
        subjectDependencyRationale:
          'The repair fixture conservatively requires source-specific truth.',
        candidateLabels: item.candidates.map((candidate) => ({
          evidenceRef: candidate.evidenceRef,
          relation:
            verdict === 'pass' && candidate.evidenceRef === boundEvidenceRef
              ? ('relevant' as const)
              : ('unrelated' as const),
        })),
        supportGroups:
          verdict === 'pass'
            ? [
                {
                  evidenceRefs: [boundEvidenceRef],
                  supportType: 'recognition' as const,
                  rationale: 'The exact evidence supports recognition.',
                },
              ]
            : [],
        ...(item.requiredCapabilityPreservation
          ? {
              fragments: [
                {
                  fragmentId,
                  text: item.proposition,
                  status: verdict === 'pass' ? ('supported' as const) : ('unsupported' as const),
                  supportType: verdict === 'pass' ? ('recognition' as const) : null,
                  evidenceRefs: verdict === 'pass' ? [boundEvidenceRef] : [],
                  rationale: 'The exact recovery proposition remains partitioned.',
                },
              ],
              capabilityPreservation: {
                originalProposition: item.requiredCapabilityPreservation.originalProposition,
                mappings: item.requiredCapabilityPreservation.originalFragments.map((original) => ({
                  originalFragmentId: original.fragmentId,
                  originalText: original.text,
                  repairedFragmentIds: [fragmentId],
                  status: 'preserved' as const,
                  rationale: 'The frozen capability proposition remains unchanged.',
                })),
                lostOriginalFragmentIds: [],
                verdict: 'pass' as const,
                rationale: 'The complete frozen capability remains present.',
              },
            }
          : {}),
      };
    }),
  };
}

function setup(secondVerdict: 'pass' | 'fail' = 'pass'): {
  original: CurriculumProposalPayload;
  batch: ObjectiveAuthoritySemanticRepairBatch;
  evaluationBatch: ObjectiveAuthoritySemanticEvaluationBatch;
} {
  const original = proposal();
  const unit = original.nodes.find((node) => node.key === 'unit')!;
  const ingestionBlock = block('block_3', INGESTION);
  const positioningBlock = block('block_1', POSITIONING);
  const foreignBlock = block('block_9', FOREIGN);
  const bundles = [
    authority('authority_ingestion', ingestionBlock),
    authority('authority_positioning', positioningBlock),
    authority('authority_foreign', foreignBlock),
  ];
  const materializedNodes: CurriculumNode[] = [
    {
      id: 'unit_1',
      parentId: null,
      kind: 'learning_unit',
      index: 0,
      title: unit.title,
      sourceReferences: [ingestionBlock, positioningBlock].map((sourceBlock) => ({
        materialId: sourceBlock.materialId,
        materialRevisionId: sourceBlock.materialRevisionId!,
        structuralUnitId: null,
        sourceBlockId: sourceBlock.id,
        sourceBlockRevisionFingerprint: null,
      })),
      learningUnit: {
        conceptIds: [],
        canonicalConceptIds: [],
        objectives: [
          objective('objective_failed', unit.objectives[0]!, 'authority_ingestion', 'block_3'),
          objective('objective_passing', unit.objectives[1]!, 'authority_positioning', 'block_1'),
        ],
        prerequisiteUnitIds: [],
        graphRelationIds: [],
        riskIds: [],
      },
    },
  ];
  const evaluationCatalog = [
    evidence('evidence_ingestion', ingestionBlock),
    evidence('evidence_positioning', positioningBlock),
    evidence('evidence_foreign', foreignBlock),
  ];
  const [firstPassBatch] = buildObjectiveAuthoritySemanticEvaluationBatches({
    nodes: materializedNodes,
    sourceBlocks: [ingestionBlock, positioningBlock, foreignBlock],
    authorityBundles: bundles,
    evidenceCatalog: evaluationCatalog,
    isBlockingEligible: () => true,
  });
  const prepared = prepareObjectiveAuthoritySemanticRepair({
    candidate: original,
    objectiveIdByProposalKey: new Map([
      ['failed', 'objective_failed'],
      ['passing', 'objective_passing'],
    ]),
    firstPass: [
      {
        batch: firstPassBatch!,
        proposal: evaluationProposal(firstPassBatch!, secondVerdict),
      },
    ],
    context: {
      workspaceId: 'workspace_1',
      evidenceCatalog: evaluationCatalog,
      authorityBundles: bundles,
      isAuthorityBlockingEligible: () => true,
      deterministicCoverageByNodeKey: new Map([
        ['unit', { structuralUnitIds: [], sourceBlockIds: ['block_3', 'block_1'] }],
      ]),
    },
  });
  expect(prepared.validation).toMatchObject({ valid: true, diagnostics: [] });
  expect(prepared.batch).not.toBeNull();
  return { original, batch: prepared.batch!, evaluationBatch: firstPassBatch! };
}

function validReplacement(batch: ObjectiveAuthoritySemanticRepairBatch) {
  const objective = batch.input.objectives[0]!;
  const positioningRef = objective.allowedEvidence.find(
    (offer) => offer.text === POSITIONING,
  )!.evidenceRef;
  return {
    schemaVersion: 1 as const,
    replacements: [
      {
        objectiveRef: objective.objectiveRef,
        title: 'Explain WeKnora as an integrated system',
        description:
          'Explain the source-stated integration of documents, search, LLMs, permissions, and tools.',
        subjectClass: objective.subjectClass,
        scopeOrigin: objective.scopeOrigin,
        construct: objective.construct,
        evidenceRefs: [positioningRef],
      },
    ],
  };
}

describe('bounded objective-authority semantic repair', () => {
  it('fingerprints exact repair claim aliases when provider-visible evidence is unchanged', () => {
    const { batch } = setup();
    const changedBindings = new Map(
      [...batch.aliasBindings].map(
        ([objectiveRef, binding]) =>
          [
            objectiveRef,
            {
              ...binding,
              authorityClaimIdsByRef: new Map(
                [...binding.authorityClaimIdsByRef].map(([evidenceRef, claimIds]) => [
                  evidenceRef,
                  claimIds.map((claimId) => `${claimId}_replacement`),
                ]),
              ),
            },
          ] as const,
      ),
    );
    const rebound: ObjectiveAuthoritySemanticRepairBatch = {
      ...batch,
      aliasBindings: changedBindings,
    };

    expect(rebound.input).toEqual(batch.input);
    expect(objectiveAuthoritySemanticRepairSourceFingerprint(rebound)).not.toBe(
      objectiveAuthoritySemanticRepairSourceFingerprint(batch),
    );
  });

  it('exposes only failed objectives and allows unbound eligible evidence from the same unit', () => {
    const { batch } = setup();
    expect(batch.input.objectives).toHaveLength(1);
    const failed = batch.input.objectives[0]!;
    expect(failed.title).toBe('Explain WeKnora positioning');
    expect(failed.construct).toBe('explain');
    expect(failed.priority).toBe('required');
    expect(failed.allowedEvidence.map((offer) => [offer.text, offer.selected])).toEqual([
      [INGESTION, true],
      [POSITIONING, false],
    ]);
    const binding = batch.aliasBindings.get(failed.objectiveRef)!;
    const positioningRef = failed.allowedEvidence[1]!.evidenceRef;
    expect(binding.evidenceIdByRef.get(positioningRef)).toBe('evidence_positioning');
    expect([...binding.evidenceIdByRef.values()]).not.toContain('evidence_foreign');
    expect(JSON.stringify(batch.input)).not.toContain(FOREIGN);
    expect(batch.requiredCapabilityPreservationByObjectiveKey).toEqual(
      new Map([
        [
          'failed',
          {
            originalProposition:
              'Explain WeKnora positioning\nExplain WeKnora’s integrated document/search/LLM/permission/tool positioning.',
            originalFragments: [
              {
                fragmentId: 'objective_1:F1',
                text: 'Explain WeKnora positioning\nExplain WeKnora’s integrated document/search/LLM/permission/tool positioning.',
              },
            ],
          },
        ],
      ]),
    );
  });

  it('keeps two disjoint 29-offer recovery scopes separate inside one merged unit', () => {
    const scopeSize = 29;
    const blocks = ['alpha', 'beta'].flatMap((scope) =>
      Array.from({ length: scopeSize }, (_, index) =>
        block(`block_${scope}_${index + 1}`, `${scope} exact recovery claim ${index + 1}`),
      ),
    );
    const offers = blocks.map((sourceBlock, index) =>
      evidence(`evidence_${index + 1}`, sourceBlock),
    );
    const bundles = blocks.map((sourceBlock, index) =>
      authority(`authority_${index + 1}`, sourceBlock),
    );
    const original = proposal();
    const unit = original.nodes.find((node) => node.key === 'unit')!;
    const objectiveDefinitions = ['alpha', 'beta'].map((scope, index) => ({
      key: `recovery_${scope}`,
      title: `Explain ${scope}`,
      description: `Explain the complete ${scope} recovery capability.`,
      subjectClass: 'source_specific' as const,
      scopeOrigin: 'anchored' as const,
      construct: 'explain' as const,
      priority: 'required' as const,
      priorityRationale: 'Frozen predecessor capability.',
      evidence: [{ evidenceId: offers[index * scopeSize]!.id }],
    }));
    unit.sourceEvidence = offers.map((offer) => ({ evidenceId: offer.id }));
    unit.objectives = objectiveDefinitions;
    const objectiveIds = ['objective_alpha', 'objective_beta'];
    const requirements = new Map(
      objectiveDefinitions.map((objectiveDefinition, index) => {
        const proposition = `${objectiveDefinition.title}\n${objectiveDefinition.description}`;
        return [
          objectiveIds[index]!,
          {
            originalProposition: proposition,
            originalFragments: [
              {
                fragmentId: `recovery_${index + 1}:F1`,
                text: proposition,
              },
            ],
          },
        ] as const;
      }),
    );
    const materializedNodes: CurriculumNode[] = [
      {
        id: 'unit_merged_recovery',
        parentId: null,
        kind: 'learning_unit',
        index: 0,
        title: unit.title,
        sourceReferences: [],
        learningUnit: {
          conceptIds: [],
          canonicalConceptIds: [],
          objectives: objectiveDefinitions.map((definition, index) =>
            objective(
              objectiveIds[index]!,
              definition,
              `authority_${index * scopeSize + 1}`,
              blocks[index * scopeSize]!.id,
            ),
          ),
          prerequisiteUnitIds: [],
          graphRelationIds: [],
          riskIds: [],
        },
      },
    ];
    const [firstPassBatch] = buildObjectiveAuthoritySemanticEvaluationBatches({
      nodes: materializedNodes,
      sourceBlocks: blocks,
      authorityBundles: bundles,
      evidenceCatalog: offers,
      isBlockingEligible: () => true,
      requiredCapabilityPreservationByObjectiveId: requirements,
    });
    const recoveryEvidenceScopeByObjectiveId = new Map(
      objectiveIds.map((objectiveId, index) => {
        const scopedOffers = offers.slice(index * scopeSize, (index + 1) * scopeSize);
        return [
          objectiveId,
          {
            allowedEvidenceIds: scopedOffers.map((offer) => offer.id),
            allowedSourceBlockIds: scopedOffers.map((offer) => offer.blockId),
          },
        ] as const;
      }),
    );

    const prepared = prepareObjectiveAuthoritySemanticRepair({
      candidate: original,
      objectiveIdByProposalKey: new Map([
        ['recovery_alpha', objectiveIds[0]!],
        ['recovery_beta', objectiveIds[1]!],
      ]),
      firstPass: [
        {
          batch: firstPassBatch!,
          proposal: evaluationProposal(firstPassBatch!, 'fail'),
        },
      ],
      requiredCapabilityPreservationByObjectiveId: requirements,
      recoveryEvidenceScopeByObjectiveId,
      context: {
        workspaceId: 'workspace_1',
        evidenceCatalog: offers,
        authorityBundles: bundles,
        isAuthorityBlockingEligible: () => true,
        deterministicCoverageByNodeKey: new Map([
          ['unit', { structuralUnitIds: [], sourceBlockIds: blocks.map((item) => item.id) }],
        ]),
      },
    });

    expect(prepared.validation).toMatchObject({ valid: true, diagnostics: [] });
    expect(prepared.batch?.input.objectives).toHaveLength(2);
    for (const [index, repairObjective] of prepared.batch!.input.objectives.entries()) {
      const scopedOffers = offers.slice(index * scopeSize, (index + 1) * scopeSize);
      expect(repairObjective.allowedEvidence).toHaveLength(scopeSize);
      expect(repairObjective.allowedEvidence.map((offer) => offer.text)).toEqual(
        scopedOffers.map((offer) => offer.quote),
      );
      expect(prepared.batch!.aliasBindings.get(repairObjective.objectiveRef)).toMatchObject({
        allowedEvidenceIds: scopedOffers.map((offer) => offer.id),
        allowedSourceBlockIds: scopedOffers.map((offer) => offer.blockId),
      });
    }
  });

  it('fails closed when one failing objective legitimately exceeds the 32-offer envelope', () => {
    const offerCount = 33;
    const blocks = Array.from({ length: offerCount }, (_, index) =>
      block(`block_limit_${index + 1}`, `Exact bounded repair claim ${index + 1}.`),
    );
    const offers = blocks.map((sourceBlock, index) =>
      evidence(`evidence_limit_${index + 1}`, sourceBlock),
    );
    const bundles = blocks.map((sourceBlock, index) =>
      authority(`authority_limit_${index + 1}`, sourceBlock),
    );
    const original = proposal();
    const unit = original.nodes.find((node) => node.key === 'unit')!;
    unit.sourceEvidence = offers.map((offer) => ({ evidenceId: offer.id }));
    unit.objectives[0]!.evidence = [{ evidenceId: offers[0]!.id }];
    unit.objectives[1]!.evidence = [{ evidenceId: offers[1]!.id }];
    const materializedNodes: CurriculumNode[] = [
      {
        id: 'unit_limit',
        parentId: null,
        kind: 'learning_unit',
        index: 0,
        title: unit.title,
        sourceReferences: [],
        learningUnit: {
          conceptIds: [],
          canonicalConceptIds: [],
          objectives: [
            objective(
              'objective_limit_failed',
              unit.objectives[0]!,
              bundles[0]!.record.id,
              blocks[0]!.id,
            ),
            objective(
              'objective_limit_passing',
              unit.objectives[1]!,
              bundles[1]!.record.id,
              blocks[1]!.id,
            ),
          ],
          prerequisiteUnitIds: [],
          graphRelationIds: [],
          riskIds: [],
        },
      },
    ];
    const [firstPassBatch] = buildObjectiveAuthoritySemanticEvaluationBatches({
      nodes: materializedNodes,
      sourceBlocks: blocks,
      authorityBundles: bundles,
      evidenceCatalog: offers,
      isBlockingEligible: () => true,
    });
    const prepared = prepareObjectiveAuthoritySemanticRepair({
      candidate: original,
      objectiveIdByProposalKey: new Map([
        ['failed', 'objective_limit_failed'],
        ['passing', 'objective_limit_passing'],
      ]),
      firstPass: [
        {
          batch: firstPassBatch!,
          proposal: evaluationProposal(firstPassBatch!, 'pass'),
        },
      ],
      context: {
        workspaceId: 'workspace_1',
        evidenceCatalog: offers,
        authorityBundles: bundles,
        isAuthorityBlockingEligible: () => true,
        deterministicCoverageByNodeKey: new Map([
          ['unit', { structuralUnitIds: [], sourceBlockIds: blocks.map((item) => item.id) }],
        ]),
      },
    });

    expect(prepared.batch).toBeNull();
    expect(prepared.validation).toMatchObject({
      valid: false,
      diagnosticCodes: ['semantic_repair_unit_evidence_limit_exceeded'],
      failureArtifact: {
        diagnostics: [
          {
            facts: { offeredEvidenceCount: offerCount, limit: 32 },
          },
        ],
      },
    });
  });

  it('lets legacy recovery repair E1 with an unselected frozen E2 offer', () => {
    const e1Block = block('block_legacy_1', 'E1 is initially selected but does not support B.');
    const e2Block = block('block_legacy_2', 'E2 is the exact supporting statement for B.');
    const e1 = evidence('evidence_legacy_e1', e1Block);
    const e2 = evidence('evidence_legacy_e2', e2Block);
    const bundles = [
      authority('authority_legacy_e1', e1Block),
      authority('authority_legacy_e2', e2Block),
    ];
    const original = proposal();
    const unit = original.nodes.find((node) => node.key === 'unit')!;
    unit.sourceEvidence = [{ evidenceId: e1.id }];
    unit.objectives = [
      {
        key: 'legacy_recovery',
        title: 'Explain B',
        description: 'Explain the complete source-stated B capability.',
        subjectClass: 'source_specific',
        scopeOrigin: 'anchored',
        construct: 'explain',
        priority: 'required',
        priorityRationale: 'Frozen predecessor capability.',
        evidence: [{ evidenceId: e1.id }],
      },
    ];
    const proposition = 'Explain B\nExplain the complete source-stated B capability.';
    const requirement = {
      originalProposition: proposition,
      originalFragments: [{ fragmentId: 'legacy_recovery:F1', text: proposition }],
    };
    const materializedNodes: CurriculumNode[] = [
      {
        id: 'unit_legacy_recovery',
        parentId: null,
        kind: 'learning_unit',
        index: 0,
        title: unit.title,
        sourceReferences: [],
        learningUnit: {
          conceptIds: [],
          canonicalConceptIds: [],
          objectives: [
            objective(
              'objective_legacy_recovery',
              unit.objectives[0]!,
              'authority_legacy_e1',
              e1Block.id,
            ),
          ],
          prerequisiteUnitIds: [],
          graphRelationIds: [],
          riskIds: [],
        },
      },
    ];
    const requiredCapabilityPreservationByObjectiveId = new Map([
      ['objective_legacy_recovery', requirement],
    ]);
    const [firstPassBatch] = buildObjectiveAuthoritySemanticEvaluationBatches({
      nodes: materializedNodes,
      sourceBlocks: [e1Block, e2Block],
      authorityBundles: bundles,
      evidenceCatalog: [e1, e2],
      isBlockingEligible: () => true,
      requiredCapabilityPreservationByObjectiveId,
    });
    const prepared = prepareObjectiveAuthoritySemanticRepair({
      candidate: original,
      objectiveIdByProposalKey: new Map([['legacy_recovery', 'objective_legacy_recovery']]),
      firstPass: [
        {
          batch: firstPassBatch!,
          proposal: evaluationProposal(firstPassBatch!, 'pass'),
        },
      ],
      requiredCapabilityPreservationByObjectiveId,
      recoveryEvidenceScopeByObjectiveId: new Map([
        [
          'objective_legacy_recovery',
          {
            allowedEvidenceIds: [e1.id, e2.id],
            allowedSourceBlockIds: [e1.blockId, e2.blockId],
          },
        ],
      ]),
      context: {
        workspaceId: 'workspace_1',
        evidenceCatalog: [e1, e2],
        authorityBundles: bundles,
        isAuthorityBlockingEligible: () => true,
      },
    });

    expect(prepared.validation).toMatchObject({ valid: true, diagnostics: [] });
    const repairObjective = prepared.batch!.input.objectives[0]!;
    expect(repairObjective.allowedEvidence.map((offer) => [offer.text, offer.selected])).toEqual([
      [e1.quote, true],
      [e2.quote, false],
    ]);
    const e2Ref = repairObjective.allowedEvidence[1]!.evidenceRef;
    const applied = applyObjectiveAuthoritySemanticRepairProposal(prepared.batch!, {
      schemaVersion: 1,
      replacements: [
        {
          objectiveRef: repairObjective.objectiveRef,
          title: repairObjective.title,
          description: repairObjective.description,
          subjectClass: repairObjective.subjectClass,
          scopeOrigin: repairObjective.scopeOrigin,
          construct: repairObjective.construct,
          evidenceRefs: [e2Ref],
        },
      ],
    });
    expect(applied.validation).toMatchObject({ valid: true, diagnostics: [] });
    expect(
      applied.payload!.nodes.find((node) => node.key === 'unit')!.objectives[0]!.evidence,
    ).toEqual([{ evidenceId: e2.id }]);
  });

  it('rejects foreign or out-of-unit aliases and construct lowering', () => {
    const { batch } = setup();
    const valid = validReplacement(batch);
    const foreign = structuredClone(valid);
    foreign.replacements[0]!.evidenceRefs = ['repair_evidence_999'];
    expect(validateObjectiveAuthoritySemanticRepairProposal(batch, foreign)).toMatchObject({
      valid: false,
      diagnosticCodes: ['semantic_repair_evidence_outside_unit'],
    });

    const lowered = structuredClone(valid);
    lowered.replacements[0]!.construct = 'identify';
    expect(validateObjectiveAuthoritySemanticRepairProposal(batch, lowered)).toMatchObject({
      valid: false,
      diagnosticCodes: ['semantic_repair_construct_changed'],
    });

    const changedSubjectClass = structuredClone(valid);
    changedSubjectClass.replacements[0]!.subjectClass = 'general';
    expect(
      validateObjectiveAuthoritySemanticRepairProposal(batch, changedSubjectClass),
    ).toMatchObject({
      valid: false,
      diagnosticCodes: ['semantic_repair_subject_class_changed'],
    });

    const changedScopeOrigin = structuredClone(valid);
    changedScopeOrigin.replacements[0]!.subjectClass = 'general';
    changedScopeOrigin.replacements[0]!.scopeOrigin = 'supplemental';
    expect(
      validateObjectiveAuthoritySemanticRepairProposal(batch, changedScopeOrigin),
    ).toMatchObject({
      valid: false,
      diagnosticCodes: expect.arrayContaining([
        'semantic_repair_subject_class_changed',
        'semantic_repair_scope_origin_changed',
      ]),
    });
  });

  it('rejects missing, extra, or reordered failed-objective replacements', () => {
    const { batch } = setup('fail');
    const replacements = batch.input.objectives.map((objective) => ({
      objectiveRef: objective.objectiveRef,
      title: objective.title,
      description: objective.description,
      subjectClass: objective.subjectClass,
      scopeOrigin: objective.scopeOrigin,
      construct: objective.construct,
      evidenceRefs: [objective.allowedEvidence[0]!.evidenceRef],
    }));
    const missing = { schemaVersion: 1 as const, replacements: replacements.slice(0, 1) };
    expect(
      validateObjectiveAuthoritySemanticRepairProposal(batch, missing).diagnosticCodes,
    ).toContain('semantic_repair_objective_set_or_order_mismatch');
    const extra = {
      schemaVersion: 1 as const,
      replacements: [
        ...replacements,
        {
          objectiveRef: 'objective_unrelated',
          title: 'Unrelated',
          description: 'This objective was not failed.',
          subjectClass: 'general' as const,
          scopeOrigin: 'supplemental' as const,
          construct: 'identify' as const,
          evidenceRefs: [],
        },
      ],
    };
    const extraValidation = validateObjectiveAuthoritySemanticRepairProposal(batch, extra);
    expect(extraValidation.diagnosticCodes).toContain(
      'semantic_repair_objective_set_or_order_mismatch',
    );
    expect(extraValidation.diagnosticCodes).toContain('semantic_repair_unrelated_objective');
    const reversed = { schemaVersion: 1 as const, replacements: [...replacements].reverse() };
    expect(
      validateObjectiveAuthoritySemanticRepairProposal(batch, reversed).diagnosticCodes,
    ).toContain('semantic_repair_objective_set_or_order_mismatch');
  });

  it('rejects duplicate and over-limit replacement evidence', () => {
    const { batch } = setup();
    const valid = validReplacement(batch);
    const ref = valid.replacements[0]!.evidenceRefs[0]!;
    const duplicate = structuredClone(valid);
    duplicate.replacements[0]!.evidenceRefs = [ref, ref];
    expect(
      validateObjectiveAuthoritySemanticRepairProposal(batch, duplicate).diagnosticCodes,
    ).toContain('semantic_repair_proposal_schema_invalid');

    const overLimit = structuredClone(valid);
    overLimit.replacements[0]!.evidenceRefs = Array.from(
      { length: 6 },
      (_, index) => `repair_evidence_${index + 1}`,
    );
    expect(
      validateObjectiveAuthoritySemanticRepairProposal(batch, overLimit).diagnosticCodes,
    ).toContain('semantic_repair_proposal_schema_invalid');
  });

  it('applies only failed replacements, preserves frozen fields, and never mutates input', () => {
    const { original, batch } = setup();
    const before = JSON.stringify(original);
    const originalUnit = original.nodes.find((node) => node.key === 'unit')!;
    const originalPassing = structuredClone(originalUnit.objectives[1]!);
    const result = applyObjectiveAuthoritySemanticRepairProposal(batch, validReplacement(batch));
    expect(result.validation.valid).toBe(true);
    expect(result.payload).not.toBeNull();
    expect(JSON.stringify(original)).toBe(before);
    const repairedUnit = result.payload!.nodes.find((node) => node.key === 'unit')!;
    expect(repairedUnit.objectives[1]).toEqual(originalPassing);
    expect(repairedUnit.objectives[0]).toMatchObject({
      key: 'failed',
      subjectClass: 'source_specific',
      scopeOrigin: 'anchored',
      construct: 'explain',
      priority: 'required',
      priorityRationale: 'This is the central course outcome.',
      evidence: [{ evidenceId: 'evidence_positioning' }],
    });
    expect(repairedUnit.objectives[0]!.title).toBe('Explain WeKnora as an integrated system');
    expect(batch.candidate.nodes.find((node) => node.key === 'unit')!.objectives[0]).toEqual(
      originalUnit.objectives[0],
    );
  });

  it('deterministically rebinds a partially bound compositional group without changing objective text', () => {
    const { original, evaluationBatch } = setup();
    const before = JSON.stringify(original);
    const originalUnit = original.nodes.find((node) => node.key === 'unit')!;
    const originalFailedObjective = structuredClone(originalUnit.objectives[0]!);
    const proposal = evaluationProposal(evaluationBatch, 'pass');
    const failedEvaluation = proposal.evaluations[0]!;
    const candidateRefs = evaluationBatch.input.objectives[0]!.candidates.map(
      (candidate) => candidate.evidenceRef,
    );
    failedEvaluation.candidateLabels = candidateRefs.map((evidenceRef) => ({
      evidenceRef,
      relation: 'relevant',
    }));
    failedEvaluation.supportGroups = [
      {
        evidenceRefs: candidateRefs,
        supportType: 'relationship',
        rationale: 'Both exact candidates are jointly required for the proposition.',
      },
    ];

    const result = applyObjectiveAuthoritySemanticDeterministicRebind({
      candidate: original,
      objectiveIdByProposalKey: new Map([
        ['failed', 'objective_failed'],
        ['passing', 'objective_passing'],
      ]),
      firstPass: [{ batch: evaluationBatch, proposal }],
    });

    expect(result.validation).toMatchObject({ valid: true, diagnostics: [] });
    expect(result.reboundObjectiveIds).toEqual(['objective_failed']);
    expect(result.reboundObjectiveKeys).toEqual(['failed']);
    expect(JSON.stringify(original)).toBe(before);
    const reboundUnit = result.payload!.nodes.find((node) => node.key === 'unit')!;
    expect(reboundUnit.objectives[0]).toMatchObject({
      ...originalFailedObjective,
      evidence: [{ evidenceId: 'evidence_ingestion' }, { evidenceId: 'evidence_positioning' }],
    });
    expect({
      title: reboundUnit.objectives[0]!.title,
      description: reboundUnit.objectives[0]!.description,
      construct: reboundUnit.objectives[0]!.construct,
      subjectClass: reboundUnit.objectives[0]!.subjectClass,
      scopeOrigin: reboundUnit.objectives[0]!.scopeOrigin,
    }).toEqual({
      title: originalFailedObjective.title,
      description: originalFailedObjective.description,
      construct: originalFailedObjective.construct,
      subjectClass: originalFailedObjective.subjectClass,
      scopeOrigin: originalFailedObjective.scopeOrigin,
    });
    expect(reboundUnit.objectives[1]).toEqual(originalUnit.objectives[1]);
  });
});
