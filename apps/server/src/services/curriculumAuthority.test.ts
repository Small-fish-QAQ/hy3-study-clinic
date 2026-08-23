import { describe, expect, it } from 'vitest';
import type {
  CourseMap,
  CurriculumAuthorityEnvelope,
  CurriculumDetailProposalPayload,
} from '@hy3-clinic/shared';
import type { CurriculumEvidenceOffer, CurriculumDetailProposalInput } from '../llm/provider.js';
import type { SourceAuthorityBundle } from '../repositories/sourceAuthority.js';
import {
  buildCurriculumAuthorityEnvelope,
  detectFormalConstruct,
  isExplicitSourceProcedure,
  isFormalObjectiveSupported,
  selectApplyCapableProcedureGroundings,
} from './curriculumAuthority.js';
import {
  repairCurriculumDetailAuthorityCandidate,
  validateCurriculumDetailCandidate,
} from './curriculumMaterialization.js';
import { buildCourseMapRegionAuthorityEnvelopeMap } from './curriculum.js';

const NOW = '2026-08-23T00:00:00.000Z';
const CLAIM = 'The system has three bounded layers.';

function offer(quote = CLAIM): CurriculumEvidenceOffer {
  return {
    id: 'evidence-1',
    bindingId: 'binding-1',
    materialId: 'material-1',
    materialRevisionId: 'revision-1',
    blockId: 'block-1',
    startOffset: 0,
    endOffset: quote.length,
    quote,
    headingPath: ['Foundations'],
    pageNumber: null,
  };
}

function authorityBundle(
  validationState: SourceAuthorityBundle['record']['validationState'] = 'validated',
): SourceAuthorityBundle {
  return {
    record: {
      id: 'authority-1',
      workspaceId: 'workspace-1',
      logicalSourceId: 'source-1',
      materialId: 'material-1',
      materialRevisionId: 'revision-1',
      version: 1,
      predecessorId: null,
      premiseScope: 'exact source statement',
      policyBasis: {
        policyVersion: 'test-v1',
        premiseKind: 'claim',
        basis: 'exact occurrence only',
      },
      validationState,
      conflictState: 'none',
      actor: 'local_validator',
      createdAt: NOW,
      updatedAt: NOW,
    },
    claims: [
      {
        id: 'claim-1',
        authorityRecordId: 'authority-1',
        sourceBlockId: 'block-1',
        claim: CLAIM,
        quote: CLAIM,
        startOffset: 0,
        endOffset: CLAIM.length,
        occurrenceCount: 1,
        createdAt: NOW,
      },
    ],
    events: [],
  };
}

function procedureAuthorityBundles(claim: string): SourceAuthorityBundle[] {
  return (['expected_answer', 'rubric_point'] as const).map((premiseKind, index) => ({
    record: {
      ...authorityBundle().record,
      id: `procedure-authority-${index + 1}`,
      logicalSourceId: `procedure-${premiseKind}`,
      policyBasis: {
        policyVersion: 'local-verbatim-source-v1',
        premiseKind,
        basis: 'Exact source occurrence only.',
      },
    },
    claims: [
      {
        ...authorityBundle().claims[0]!,
        id: `procedure-claim-${index + 1}`,
        authorityRecordId: `procedure-authority-${index + 1}`,
        claim,
        quote: claim,
        endOffset: claim.length,
      },
    ],
    events: [],
  }));
}

function envelope(
  overrides: Partial<CurriculumAuthorityEnvelope> = {},
): CurriculumAuthorityEnvelope {
  return {
    sourceRegionId: 'region-1',
    sourceBlockIds: ['block-1'],
    formalEvidenceIds: ['evidence-1'],
    supportedConstructs: ['identify', 'explain'],
    strongestSupportedConstruct: 'explain',
    narrowerClaim: CLAIM,
    tier: 'formal_sufficient',
    rationale: 'Exact local authority supports the bounded claim.',
    ...overrides,
  };
}

function detailInput(
  authorityEnvelope: CurriculumAuthorityEnvelope,
): CurriculumDetailProposalInput {
  return {
    workspaceName: 'Authority test',
    contract: {
      intent: 'Master the source',
      targetOutcome: { description: 'Explain the source', targetScore: null },
      desiredDepth: 'working_fluency',
      subjectBoundaries: ['systems'],
      includedTopics: ['layers'],
      excludedTopics: [],
    },
    courseMapId: 'course_map_000000000000000000000001',
    sourceAllocationFingerprint:
      'course_map_source_allocation_0000000000000000000000000000000000000000',
    batchKey: 'batch-1',
    regions: [
      {
        regionId: 'course_map_region_000000000000000000000001',
        moduleId: 'module-1',
        moduleIndex: 0,
        moduleTitle: 'Foundations',
        regionIndex: 0,
        title: 'Layers',
        learningIntent: 'Explain the source',
        approximateScope: 'focused',
        sourceAllocationRegionIds: ['region-1'],
        prerequisiteRegionIds: [],
        synthesisGroups: [],
        concepts: [],
        canonicalConcepts: [],
        evidence: [{ evidenceId: 'evidence-1', sourceAllocationRegionId: 'region-1', text: CLAIM }],
        authorityEnvelope,
      },
    ],
    limits: { maxUnits: 1, maxObjectivesPerUnit: 1, maxEvidenceSelectionsPerUnit: 1 },
  };
}

function detailCandidate(title: string, description: string): CurriculumDetailProposalPayload {
  return {
    courseMapId: 'course_map_000000000000000000000001',
    sourceAllocationFingerprint:
      'course_map_source_allocation_0000000000000000000000000000000000000000',
    units: [
      {
        regionId: 'course_map_region_000000000000000000000001',
        title: 'Source workflow layers',
        sourceEvidence: [{ evidenceId: 'evidence-1' }],
        conceptIds: [],
        canonicalConceptIds: [],
        objectives: [
          {
            key: 'objective-1',
            title,
            description,
            evidence: [{ evidenceId: 'evidence-1' }],
            priority: 'required',
          },
        ],
      },
    ],
  };
}

describe('Curriculum source-authority envelope', () => {
  it('classifies exact formal claims and keeps stale authority teaching-only', () => {
    const formal = buildCurriculumAuthorityEnvelope({
      sourceRegionId: 'region-1',
      sourceBlockIds: ['block-1'],
      evidence: [offer()],
      authorityBundles: [authorityBundle()],
      isBlockingEligible: () => true,
    });
    expect(formal.tier).toBe('formal_sufficient');
    expect(formal.supportedConstructs).toEqual(['identify', 'explain']);
    expect(formal.formalEvidenceIds).toEqual(['evidence-1']);

    const stale = buildCurriculumAuthorityEnvelope({
      sourceRegionId: 'region-1',
      sourceBlockIds: ['block-1'],
      evidence: [offer()],
      authorityBundles: [authorityBundle('stale')],
      isBlockingEligible: () => false,
    });
    expect(stale.tier).toBe('teaching_only');
    expect(stale.formalEvidenceIds).toEqual([]);
    expect(stale.supportedConstructs).toEqual([]);
  });

  it('admits apply only for an exact locally validated ordered procedure pair', () => {
    const procedure = '必须：先检索 → 按权限过滤 → 再给模型。';
    const procedureBundles = procedureAuthorityBundles(procedure);
    expect(isExplicitSourceProcedure(procedure)).toBe(true);
    expect(isExplicitSourceProcedure('RBAC = User → Role → Permission')).toBe(false);
    expect(
      selectApplyCapableProcedureGroundings({
        authorityBundles: procedureBundles,
        isBlockingEligible: () => true,
      }),
    ).toEqual([
      {
        blockId: 'block-1',
        quote: procedure,
        startOffset: 0,
        endOffset: procedure.length,
        occurrenceCount: 1,
        reanchored: false,
      },
    ]);
    expect(
      selectApplyCapableProcedureGroundings({
        authorityBundles: procedureBundles.slice(0, 1),
        isBlockingEligible: () => true,
      }),
    ).toEqual([]);
    expect(
      selectApplyCapableProcedureGroundings({
        authorityBundles: procedureBundles,
        isBlockingEligible: () => false,
      }),
    ).toEqual([]);

    const authority = buildCurriculumAuthorityEnvelope({
      sourceRegionId: 'region-1',
      sourceBlockIds: ['block-1'],
      evidence: [offer(procedure)],
      authorityBundles: procedureBundles,
      isBlockingEligible: () => true,
    });
    expect(authority).toMatchObject({
      tier: 'formal_sufficient',
      supportedConstructs: ['identify', 'explain', 'apply'],
      strongestSupportedConstruct: 'apply',
      narrowerClaim: procedure,
    });

    const onlyExpected = buildCurriculumAuthorityEnvelope({
      sourceRegionId: 'region-1',
      sourceBlockIds: ['block-1'],
      evidence: [offer(procedure)],
      authorityBundles: procedureBundles.slice(0, 1),
      isBlockingEligible: () => true,
    });
    expect(onlyExpected.supportedConstructs).not.toContain('apply');
  });

  it('keeps apply within the exact source-stated procedure and learner target', () => {
    const procedure = '查询流程：识别实体 → 定位节点 → 结合原文。';
    const authority = envelope({
      supportedConstructs: ['identify', 'explain', 'apply'],
      strongestSupportedConstruct: 'apply',
      narrowerClaim: procedure,
    });
    const input = detailInput(authority);
    input.contract.targetOutcome = {
      description: 'Explain and apply the core procedure',
      targetScore: null,
    };
    input.regions[0]!.evidence[0]!.authorityEnvelope = authority;
    const broad = detailCandidate(
      'Apply the workflow in production',
      'Transfer the workflow to an unbounded deployment scenario.',
    );

    expect(validateCurriculumDetailCandidate(broad, input)).toMatchObject({
      valid: false,
      diagnosticCodes: expect.arrayContaining(['required_objective_formal_authority_missing']),
    });
    const repaired = repairCurriculumDetailAuthorityCandidate(broad, input);
    const objective = repaired.candidate.units[0]!.objectives[0]!;
    expect(repaired.repaired).toBe(true);
    expect(objective.title).toMatch(/^Apply:/u);
    expect(objective.description).toContain(`Source-supported procedure: ${procedure}`);
    expect(
      isFormalObjectiveSupported(`${objective.title} ${objective.description}`, authority),
    ).toBe(true);
    expect(validateCurriculumDetailCandidate(repaired.candidate, input).valid).toBe(true);

    const flattened = detailCandidate(
      'Explain the workflow',
      'Explain the exact source-stated workflow.',
    );
    expect(validateCurriculumDetailCandidate(flattened, input)).toMatchObject({
      valid: false,
      diagnosticCodes: expect.arrayContaining(['required_target_apply_missing']),
    });
  });

  it('requires the learner-visible unit title to cover every required objective', () => {
    const input = detailInput(envelope());
    const candidate = detailCandidate(
      'Explain the knowledge rebuild workflow',
      'Explain when the knowledge rebuild workflow is triggered.',
    );
    candidate.units[0]!.title = 'RBAC roles and backend checks';
    const siblingRegionId = 'course_map_region_000000000000000000000002';
    input.regions.push({
      ...structuredClone(input.regions[0]!),
      regionId: siblingRegionId,
      title: 'Knowledge rebuild workflow',
      regionIndex: 1,
    });
    input.limits.maxUnits = 2;
    candidate.units.push({
      regionId: siblingRegionId,
      title: 'Knowledge rebuild workflow',
      sourceEvidence: [{ evidenceId: 'evidence-1' }],
      conceptIds: [],
      canonicalConceptIds: [],
      objectives: [
        {
          key: 'objective-2',
          title: 'Explain source workflow layers',
          description: 'Explain the source workflow layers.',
          evidence: [{ evidenceId: 'evidence-1' }],
          priority: 'normal',
        },
      ],
    });

    expect(validateCurriculumDetailCandidate(candidate, input)).toMatchObject({
      valid: false,
      diagnosticCodes: expect.arrayContaining(['required_objective_parent_topic_mismatch']),
    });

    candidate.units[0]!.title = 'RBAC roles and knowledge rebuild workflow';
    expect(validateCurriculumDetailCandidate(candidate, input).valid).toBe(true);
  });

  it('rejects a unit title that anchors none of its required objectives', () => {
    const input = detailInput(envelope());
    const candidate = detailCandidate(
      'Explain IVF vector retrieval',
      'Explain how IVF retrieval selects candidate buckets.',
    );
    candidate.units[0]!.title = 'RBAC roles and backend security';

    expect(validateCurriculumDetailCandidate(candidate, input)).toMatchObject({
      valid: false,
      diagnosticCodes: expect.arrayContaining(['required_objective_parent_topic_mismatch']),
    });

    candidate.units[0]!.title = 'IVF vector retrieval';
    expect(validateCurriculumDetailCandidate(candidate, input).valid).toBe(true);
  });

  it('narrows an over-broad required objective without changing priority or provenance', () => {
    const input = detailInput(envelope());
    const candidate = detailCandidate(
      'Design and evaluate a secure deployment',
      'Apply every layer in production.',
    );
    expect(validateCurriculumDetailCandidate(candidate, input)).toMatchObject({
      valid: false,
      diagnosticCodes: expect.arrayContaining(['required_objective_formal_authority_missing']),
    });

    const repaired = repairCurriculumDetailAuthorityCandidate(candidate, input);
    expect(repaired.repaired).toBe(true);
    expect(repaired.candidate.units[0]!.objectives[0]).toMatchObject({
      priority: 'required',
      evidence: [{ evidenceId: 'evidence-1' }],
    });
    expect(repaired.candidate.units[0]!.objectives[0]!.title).toMatch(/^Explain:/u);
    expect(validateCurriculumDetailCandidate(repaired.candidate, input).valid).toBe(true);
    expect(repairCurriculumDetailAuthorityCandidate(repaired.candidate, input).repaired).toBe(
      false,
    );
  });

  it('uses the selected evidence envelope instead of borrowing broader region authority', () => {
    const input = detailInput(envelope());
    input.regions[0]!.evidence[0]!.authorityEnvelope = envelope({
      sourceRegionId: 'evidence-1',
      supportedConstructs: ['identify'],
      strongestSupportedConstruct: 'identify',
      tier: 'narrower_formal',
    });
    const candidate = detailCandidate(
      'Explain the source-supported architecture',
      'Explain relationships that the selected evidence does not authorize.',
    );

    expect(validateCurriculumDetailCandidate(candidate, input)).toMatchObject({
      valid: false,
      diagnosticCodes: expect.arrayContaining(['required_objective_formal_authority_missing']),
    });
    const repaired = repairCurriculumDetailAuthorityCandidate(candidate, input);
    expect(repaired.repaired).toBe(true);
    expect(repaired.candidate.units[0]!.objectives[0]!.title).toMatch(/^Identify:/u);
    expect(validateCurriculumDetailCandidate(repaired.candidate, input).valid).toBe(true);
  });

  it('keeps selected unavailable evidence fail-closed even when the region has broader authority', () => {
    const input = detailInput(envelope());
    input.regions[0]!.evidence[0]!.authorityEnvelope = envelope({
      sourceRegionId: 'evidence-1',
      formalEvidenceIds: [],
      supportedConstructs: [],
      strongestSupportedConstruct: null,
      narrowerClaim: null,
      tier: 'unavailable',
    });
    const candidate = detailCandidate('Explain the architecture', 'Explain the system.');

    expect(repairCurriculumDetailAuthorityCandidate(candidate, input).repaired).toBe(false);
    expect(validateCurriculumDetailCandidate(candidate, input)).toMatchObject({
      valid: false,
      diagnosticCodes: expect.arrayContaining(['required_objective_formal_authority_missing']),
    });
    expect(candidate.units[0]!.objectives[0]!.priority).toBe('required');
  });

  it('rekeys source-allocation authority onto the final Course Map region identity', () => {
    const courseMap = {
      modules: [
        {
          regions: [
            {
              id: 'course_map_region_000000000000000000000001',
              sourceAllocationRegionIds: ['source-allocation-1'],
            },
          ],
        },
      ],
    } as CourseMap;
    const envelopes = buildCourseMapRegionAuthorityEnvelopeMap(
      courseMap,
      { regions: [{ id: 'source-allocation-1', sourceBlockIds: ['block-1'] }] },
      [offer()],
      { authorityBundles: [authorityBundle()] } as never,
      { sourceAuthority: { isBlockingEligible: () => true } } as never,
    );

    expect(envelopes.get('source-allocation-1')).toBeUndefined();
    expect(envelopes.get('course_map_region_000000000000000000000001')).toMatchObject({
      sourceRegionId: 'course_map_region_000000000000000000000001',
      sourceBlockIds: ['block-1'],
      supportedConstructs: ['identify', 'explain'],
      tier: 'formal_sufficient',
    });
  });

  it('does not formalize teaching-only or unavailable authority and never downgrades required scope', () => {
    const teachingInput = detailInput(
      envelope({
        tier: 'teaching_only',
        formalEvidenceIds: [],
        supportedConstructs: [],
        strongestSupportedConstruct: null,
      }),
    );
    const teachingCandidate = detailCandidate(
      'Design a secure deployment',
      'Evaluate the architecture.',
    );
    expect(
      repairCurriculumDetailAuthorityCandidate(teachingCandidate, teachingInput).repaired,
    ).toBe(false);
    expect(validateCurriculumDetailCandidate(teachingCandidate, teachingInput)).toMatchObject({
      valid: false,
      diagnosticCodes: expect.arrayContaining(['required_objective_formal_authority_missing']),
    });
    expect(teachingCandidate.units[0]!.objectives[0]!.priority).toBe('required');

    const unavailableInput = detailInput(
      envelope({
        tier: 'unavailable',
        formalEvidenceIds: [],
        supportedConstructs: [],
        strongestSupportedConstruct: null,
        narrowerClaim: null,
      }),
    );
    const unavailableCandidate = detailCandidate(
      'Design a secure deployment',
      'Evaluate the architecture.',
    );
    expect(
      repairCurriculumDetailAuthorityCandidate(unavailableCandidate, unavailableInput).repaired,
    ).toBe(false);
    expect(unavailableCandidate.units[0]!.objectives[0]!.priority).toBe('required');
  });

  it('uses deterministic construct detection for mixed claims', () => {
    expect(detectFormalConstruct('Identify the parts and explain their roles')).toBe('explain');
    expect(detectFormalConstruct('Apply the method to a new example')).toBe('apply');
    expect(detectFormalConstruct('Evaluate the security boundary')).toBe('evaluate');
  });

  it('keeps a locally narrowed construct distinct from higher-order topical words', () => {
    const cases = [
      {
        supportedConstructs: ['identify', 'explain'] as const,
        strongestSupportedConstruct: 'explain' as const,
        tier: 'formal_sufficient' as const,
        narrowerClaim: '# Weknora学习：概念层（它们是什么）+ 实现层（工程上怎么做）。',
        expectedConstruct: 'explain' as const,
        expectedPrefix: 'Explain:',
      },
      {
        supportedConstructs: ['identify'] as const,
        strongestSupportedConstruct: 'identify' as const,
        tier: 'narrower_formal' as const,
        narrowerClaim: '安全原则：前端负责体验，后端负责安全。',
        expectedConstruct: 'identify' as const,
        expectedPrefix: 'Identify:',
      },
    ];

    for (const item of cases) {
      const authority = envelope({
        supportedConstructs: [...item.supportedConstructs],
        strongestSupportedConstruct: item.strongestSupportedConstruct,
        tier: item.tier,
        narrowerClaim: item.narrowerClaim,
      });
      const input = detailInput(authority);
      input.regions[0]!.evidence[0]!.authorityEnvelope = authority;
      const candidate = detailCandidate(
        'Design and apply an unsupported operation',
        'Deploy the result in production.',
      );

      const repaired = repairCurriculumDetailAuthorityCandidate(candidate, input);
      const objective = repaired.candidate.units[0]!.objectives[0]!;
      expect(repaired.repaired).toBe(true);
      expect(objective.title).toMatch(new RegExp(`^${item.expectedPrefix}`, 'u'));
      expect(detectFormalConstruct(`${objective.title} ${objective.description}`)).toBe(
        item.expectedConstruct,
      );
      expect(objective.description).toContain(item.narrowerClaim);
      expect(validateCurriculumDetailCandidate(repaired.candidate, input).valid).toBe(true);
    }
  });
});
