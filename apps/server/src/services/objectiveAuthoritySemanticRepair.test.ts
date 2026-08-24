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
            construct: 'explain',
            evidence: [{ evidenceId: 'evidence_ingestion' }],
            priority: 'required',
            priorityRationale: 'This is the central course outcome.',
          },
          {
            key: 'passing',
            title: 'Identify the integrated-system statement',
            description: 'Recognize the source-stated positioning of WeKnora.',
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
    schemaVersion: 1,
    evaluations: batch.input.objectives.map((item, index) => {
      const verdict = index === 0 ? 'fail' : secondVerdict;
      return {
        objectiveRef: item.objectiveRef,
        proposition: item.proposition,
        construct: item.construct,
        fragments: [
          verdict === 'fail'
            ? {
                fragmentId: `fragment_${index + 1}`,
                text: item.proposition,
                status: 'unsupported' as const,
                supportType: null,
                evidenceRefs: [],
                rationale: 'The exact current evidence supports a different proposition.',
              }
            : {
                fragmentId: `fragment_${index + 1}`,
                text: item.proposition,
                status: 'supported' as const,
                supportType: 'recognition' as const,
                evidenceRefs: [item.evidence[0]!.evidenceRef],
                rationale: 'The exact evidence supports recognition.',
              },
        ],
        unsupportedFragmentIds: verdict === 'fail' ? [`fragment_${index + 1}`] : [],
        conflicts: [],
        overreach: [],
        verdict,
        rationale:
          verdict === 'fail'
            ? 'The proposition is unsupported by its exact binding.'
            : 'The proposition is supported by its exact binding.',
      };
    }),
  };
}

function setup(secondVerdict: 'pass' | 'fail' = 'pass'): {
  original: CurriculumProposalPayload;
  batch: ObjectiveAuthoritySemanticRepairBatch;
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
      sourceReferences: [],
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
  const [firstPassBatch] = buildObjectiveAuthoritySemanticEvaluationBatches({
    nodes: materializedNodes,
    sourceBlocks: [ingestionBlock, positioningBlock, foreignBlock],
    authorityBundles: bundles,
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
      evidenceCatalog: [
        evidence('evidence_ingestion', ingestionBlock),
        evidence('evidence_positioning', positioningBlock),
        evidence('evidence_foreign', foreignBlock),
      ],
      authorityBundles: bundles,
      isAuthorityBlockingEligible: () => true,
      deterministicCoverageByNodeKey: new Map([
        ['unit', { structuralUnitIds: [], sourceBlockIds: ['block_3', 'block_1'] }],
      ]),
    },
  });
  expect(prepared.validation).toMatchObject({ valid: true, diagnostics: [] });
  expect(prepared.batch).not.toBeNull();
  return { original, batch: prepared.batch! };
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
                fragmentId: 'fragment_1',
                text: 'Explain WeKnora positioning\nExplain WeKnora’s integrated document/search/LLM/permission/tool positioning.',
              },
            ],
          },
        ],
      ]),
    );
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
  });

  it('rejects missing, extra, or reordered failed-objective replacements', () => {
    const { batch } = setup('fail');
    const replacements = batch.input.objectives.map((objective) => ({
      objectiveRef: objective.objectiveRef,
      title: objective.title,
      description: objective.description,
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
});
