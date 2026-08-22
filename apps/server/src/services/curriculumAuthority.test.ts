import { describe, expect, it } from 'vitest';
import type {
  CurriculumAuthorityEnvelope,
  CurriculumDetailProposalPayload,
} from '@hy3-clinic/shared';
import type { CurriculumEvidenceOffer, CurriculumDetailProposalInput } from '../llm/provider.js';
import type { SourceAuthorityBundle } from '../repositories/sourceAuthority.js';
import { buildCurriculumAuthorityEnvelope, detectFormalConstruct } from './curriculumAuthority.js';
import {
  repairCurriculumDetailAuthorityCandidate,
  validateCurriculumDetailCandidate,
} from './curriculumMaterialization.js';

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
      targetOutcome: 'Explain the source',
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
        title: 'Layers',
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
    expect(repaired.candidate.units[0]!.objectives[0]!.title).toMatch(/^Explain /u);
    expect(validateCurriculumDetailCandidate(repaired.candidate, input).valid).toBe(true);
    expect(repairCurriculumDetailAuthorityCandidate(repaired.candidate, input).repaired).toBe(
      false,
    );
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
});
