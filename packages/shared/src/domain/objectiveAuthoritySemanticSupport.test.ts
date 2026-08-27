import { describe, expect, it } from 'vitest';
import { CurriculumObjectiveSchema } from './curriculum.js';
import {
  ObjectiveAuthoritySemanticEvaluationInputSchema,
  ObjectiveAuthoritySemanticEvaluationProposalSchema,
  ObjectiveAuthorityRequiredCapabilityPreservationSchema,
  ObjectiveAuthoritySemanticRepairInputSchema,
  ObjectiveAuthoritySemanticRepairProposalSchema,
  ObjectiveAuthoritySemanticSupportSchema,
} from './objectiveAuthoritySemanticSupport.js';

const evidenceOffer = {
  evidenceRef: 'evidence_1',
  text: 'The system combines document, search, LLM, permission, and tool-call capabilities.',
  claimKinds: ['claim'] as const,
  headingPath: ['Positioning'],
};

function passProposal(): unknown {
  return {
    schemaVersion: 2,
    evaluations: [
      {
        objectiveRef: 'objective_1',
        subjectDependency: 'source_specific_required',
        subjectDependencyRationale:
          'The objective asserts source-local integrated-system positioning.',
        candidateLabels: [{ evidenceRef: 'evidence_1', relation: 'relevant' }],
        supportGroups: [
          {
            evidenceRefs: ['evidence_1'],
            supportType: 'positioning',
            rationale: 'The bound claim explicitly states the integrated positioning.',
          },
        ],
      },
    ],
  };
}

function persistedPass(): unknown {
  return {
    schemaVersion: 1,
    policyVersion: 'objective-authority-semantic-support-v1',
    evaluator: 'objective-authority-semantic-support',
    provider: 'fake',
    providerModel: null,
    independent: true,
    objectiveId: 'objective_1',
    proposition: 'Explain the integrated-system positioning.',
    propositionFingerprint: 'sha256:proposition',
    construct: 'explain',
    subjectDependency: 'source_specific_required',
    subjectDependencyRationale: 'The objective asserts source-local integrated-system positioning.',
    boundAuthorityRecordIds: ['authority_1'],
    boundSourceBlockIds: ['block_1'],
    boundAuthorityClaimIds: ['claim_1'],
    bindingFingerprint: 'sha256:binding',
    fragments: [
      {
        fragmentId: 'fragment_1',
        text: 'Explain the integrated-system positioning.',
        status: 'supported',
        supportType: 'positioning',
        sourceBlockIds: ['block_1'],
        authorityRecordIds: ['authority_1'],
        authorityClaimIds: ['claim_1'],
        rationale: 'The bound claim directly supports the positioning.',
      },
    ],
    unsupportedFragmentIds: [],
    conflicts: [],
    overreach: [],
    verdict: 'pass',
    rationale: 'Every objective fragment is supported.',
    evaluatedAt: '2026-08-24T00:00:00.000Z',
  };
}

describe('objective-authority semantic-support contracts', () => {
  it('accepts bounded evaluation input and rejects unknown fields', () => {
    const input = {
      schemaVersion: 2,
      policyVersion: 'objective-authority-semantic-support-v2',
      objectives: [
        {
          objectiveRef: 'objective_1',
          proposition: 'Explain the integrated-system positioning.',
          construct: 'explain',
          candidates: [evidenceOffer],
        },
      ],
    };
    expect(ObjectiveAuthoritySemanticEvaluationInputSchema.safeParse(input).success).toBe(true);
    expect(
      ObjectiveAuthoritySemanticEvaluationInputSchema.safeParse({ ...input, confidence: 0.99 })
        .success,
    ).toBe(false);
  });

  it('requires support groups to contain unique bounded candidate references', () => {
    expect(
      ObjectiveAuthoritySemanticEvaluationProposalSchema.safeParse(passProposal()).success,
    ).toBe(true);
    const malformed = structuredClone(passProposal()) as {
      evaluations: Array<{ supportGroups: Array<{ evidenceRefs: string[] }> }>;
    };
    malformed.evaluations[0]!.supportGroups[0]!.evidenceRefs = ['evidence_1', 'evidence_1'];
    expect(ObjectiveAuthoritySemanticEvaluationProposalSchema.safeParse(malformed).success).toBe(
      false,
    );
  });

  it('requires a bounded blind subject-dependency attestation on new evaluator output', () => {
    const missing = structuredClone(passProposal()) as {
      evaluations: Array<{
        subjectDependency?: string;
        subjectDependencyRationale?: string;
      }>;
    };
    delete missing.evaluations[0]!.subjectDependency;
    delete missing.evaluations[0]!.subjectDependencyRationale;
    expect(ObjectiveAuthoritySemanticEvaluationProposalSchema.safeParse(missing).success).toBe(
      false,
    );

    const invalid = structuredClone(passProposal()) as {
      evaluations: Array<{
        subjectDependency: string;
        subjectDependencyRationale: string;
      }>;
    };
    invalid.evaluations[0]!.subjectDependency = 'uncertain';
    expect(ObjectiveAuthoritySemanticEvaluationProposalSchema.safeParse(invalid).success).toBe(
      false,
    );
    invalid.evaluations[0]!.subjectDependency = 'general_sufficient';
    invalid.evaluations[0]!.subjectDependencyRationale = '';
    expect(ObjectiveAuthoritySemanticEvaluationProposalSchema.safeParse(invalid).success).toBe(
      false,
    );
  });

  it('reads historical persisted support without fabricating a subject attestation', () => {
    const historical = structuredClone(persistedPass()) as {
      subjectDependency?: string;
      subjectDependencyRationale?: string;
    };
    delete historical.subjectDependency;
    delete historical.subjectDependencyRationale;
    const parsed = ObjectiveAuthoritySemanticSupportSchema.parse(historical);
    expect(parsed.subjectDependency).toBeUndefined();
    expect(parsed.subjectDependencyRationale).toBeUndefined();

    const partial = structuredClone(historical);
    partial.subjectDependency = 'general_sufficient';
    expect(ObjectiveAuthoritySemanticSupportSchema.safeParse(partial).success).toBe(false);
  });

  it('requires an exact ordered original-capability partition', () => {
    const requirement = {
      originalProposition: 'Explain A and B.',
      originalFragments: [
        { fragmentId: 'original_1', text: 'Explain A ' },
        { fragmentId: 'original_2', text: 'and B.' },
      ],
    };
    expect(
      ObjectiveAuthorityRequiredCapabilityPreservationSchema.safeParse(requirement).success,
    ).toBe(true);
    expect(
      ObjectiveAuthorityRequiredCapabilityPreservationSchema.safeParse({
        ...requirement,
        originalFragments: requirement.originalFragments.slice(0, 1),
      }).success,
    ).toBe(false);
    expect(
      ObjectiveAuthorityRequiredCapabilityPreservationSchema.safeParse({
        ...requirement,
        originalFragments: [requirement.originalFragments[0], requirement.originalFragments[0]],
      }).success,
    ).toBe(false);
  });

  it('keeps capability-preservation loss lists and overall verdicts structurally consistent', () => {
    const preserved = structuredClone(passProposal()) as {
      evaluations: Array<Record<string, unknown>>;
    };
    preserved.evaluations[0]!.fragments = [
      {
        fragmentId: 'fragment_1',
        text: 'Explain the integrated-system positioning.',
        status: 'supported',
        supportType: 'positioning',
        evidenceRefs: ['evidence_1'],
        rationale: 'The complete repaired proposition remains represented.',
      },
    ];
    preserved.evaluations[0]!.capabilityPreservation = {
      originalProposition: 'Explain the original integrated-system positioning.',
      mappings: [
        {
          originalFragmentId: 'original_1',
          originalText: 'Explain the original integrated-system positioning.',
          repairedFragmentIds: ['fragment_1'],
          status: 'preserved',
          rationale: 'The complete original capability remains.',
        },
      ],
      lostOriginalFragmentIds: [],
      verdict: 'pass',
      rationale: 'No original capability was lost.',
    };
    expect(ObjectiveAuthoritySemanticEvaluationProposalSchema.safeParse(preserved).success).toBe(
      true,
    );

    const inconsistentLoss = structuredClone(preserved) as {
      evaluations: Array<{
        capabilityPreservation: {
          mappings: Array<{ status: string }>;
          lostOriginalFragmentIds: string[];
          verdict: string;
        };
      }>;
    };
    inconsistentLoss.evaluations[0]!.capabilityPreservation.mappings[0]!.status = 'lost';
    expect(
      ObjectiveAuthoritySemanticEvaluationProposalSchema.safeParse(inconsistentLoss).success,
    ).toBe(false);

    const honestLoss = structuredClone(inconsistentLoss);
    honestLoss.evaluations[0]!.capabilityPreservation.lostOriginalFragmentIds = ['original_1'];
    honestLoss.evaluations[0]!.capabilityPreservation.verdict = 'fail';
    expect(ObjectiveAuthoritySemanticEvaluationProposalSchema.safeParse(honestLoss).success).toBe(
      true,
    );
  });

  it('forbids a model verdict and fragment partition on the normal path', () => {
    const authoritative = structuredClone(passProposal()) as {
      evaluations: Array<Record<string, unknown>>;
    };
    authoritative.evaluations[0]!.verdict = 'pass';
    expect(
      ObjectiveAuthoritySemanticEvaluationProposalSchema.safeParse(authoritative).success,
    ).toBe(false);
    delete authoritative.evaluations[0]!.verdict;
    authoritative.evaluations[0]!.fragments = [];
    expect(
      ObjectiveAuthoritySemanticEvaluationProposalSchema.safeParse(authoritative).success,
    ).toBe(false);
  });

  it('keeps persisted mappings nullable only at the support-type boundary', () => {
    expect(ObjectiveAuthoritySemanticSupportSchema.safeParse(persistedPass()).success).toBe(true);
    const unsupported = structuredClone(persistedPass()) as {
      fragments: Array<Record<string, unknown>>;
      unsupportedFragmentIds: string[];
      verdict: string;
      rationale: string;
    };
    unsupported.fragments[0] = {
      ...unsupported.fragments[0],
      status: 'unsupported',
      supportType: null,
      sourceBlockIds: [],
      authorityRecordIds: [],
      authorityClaimIds: [],
    };
    unsupported.unsupportedFragmentIds = ['fragment_1'];
    unsupported.verdict = 'fail';
    unsupported.rationale = 'The proposition is not supported.';
    expect(ObjectiveAuthoritySemanticSupportSchema.safeParse(unsupported).success).toBe(true);

    const unsupportedWithSupportType = structuredClone(unsupported) as {
      fragments: Array<{ supportType: string | null }>;
    };
    unsupportedWithSupportType.fragments[0]!.supportType = 'positioning';
    expect(
      ObjectiveAuthoritySemanticSupportSchema.safeParse(unsupportedWithSupportType).success,
    ).toBe(false);

    const unsupportedWithEvidence = structuredClone(unsupported) as {
      fragments: Array<{ sourceBlockIds: string[]; authorityRecordIds: string[] }>;
    };
    unsupportedWithEvidence.fragments[0]!.sourceBlockIds = ['block_1'];
    unsupportedWithEvidence.fragments[0]!.authorityRecordIds = ['authority_1'];
    expect(ObjectiveAuthoritySemanticSupportSchema.safeParse(unsupportedWithEvidence).success).toBe(
      false,
    );

    const conflicted = structuredClone(persistedPass()) as {
      fragments: Array<{ status: string; supportType: string | null }>;
      verdict: string;
      rationale: string;
    };
    conflicted.fragments[0]!.status = 'conflicted';
    conflicted.fragments[0]!.supportType = null;
    conflicted.verdict = 'fail';
    conflicted.rationale = 'The exact evidence conflicts with the proposition.';
    expect(ObjectiveAuthoritySemanticSupportSchema.safeParse(conflicted).success).toBe(true);
    conflicted.fragments[0]!.supportType = 'positioning';
    expect(ObjectiveAuthoritySemanticSupportSchema.safeParse(conflicted).success).toBe(false);
  });

  it('requires persisted fragments to exactly partition the proposition', () => {
    const incomplete = structuredClone(persistedPass()) as {
      fragments: Array<{ text: string }>;
    };
    incomplete.fragments[0]!.text = 'integrated-system positioning';
    expect(ObjectiveAuthoritySemanticSupportSchema.safeParse(incomplete).success).toBe(false);
  });

  it('rejects duplicate identities inside persisted findings', () => {
    const duplicateConflict = structuredClone(persistedPass()) as {
      fragments: Array<{ status: string; supportType: string | null }>;
      conflicts: Array<Record<string, unknown>>;
      verdict: string;
      rationale: string;
    };
    duplicateConflict.fragments[0]!.status = 'conflicted';
    duplicateConflict.fragments[0]!.supportType = null;
    duplicateConflict.conflicts = [
      {
        kind: 'contradiction',
        fragmentIds: ['fragment_1', 'fragment_1'],
        sourceBlockIds: ['block_1'],
        authorityRecordIds: ['authority_1'],
        authorityClaimIds: ['claim_1'],
        rationale: 'The same fragment must not be repeated in one finding.',
      },
    ];
    duplicateConflict.verdict = 'fail';
    duplicateConflict.rationale = 'The evidence conflicts with the proposition.';
    expect(ObjectiveAuthoritySemanticSupportSchema.safeParse(duplicateConflict).success).toBe(
      false,
    );
  });

  it('rejects persisted mappings to authority outside the objective binding', () => {
    const foreign = structuredClone(persistedPass()) as {
      fragments: Array<{ sourceBlockIds: string[] }>;
    };
    foreign.fragments[0]!.sourceBlockIds = ['block_unbound'];
    expect(ObjectiveAuthoritySemanticSupportSchema.safeParse(foreign).success).toBe(false);
  });

  it('accepts complete local recovery lineage and rejects missing or unknown lineage fields', () => {
    const recovered = structuredClone(persistedPass()) as Record<string, unknown>;
    recovered.capabilityPreservation = {
      originalProposition: 'Explain the integrated-system positioning.',
      originalPropositionFingerprint: 'sha256:original-proposition',
      mappings: [
        {
          originalFragmentId: 'original_1',
          originalText: 'Explain the integrated-system positioning.',
          repairedFragmentIds: ['fragment_1'],
          status: 'preserved',
          rationale: 'The complete predecessor capability remains.',
        },
      ],
      lostOriginalFragmentIds: [],
      verdict: 'pass',
      rationale: 'Every predecessor capability fragment remains.',
      recoveryOrigin: {
        predecessorCurriculumId: 'curriculum_predecessor',
        predecessorCurriculumVersion: 3,
        predecessorLearningUnitId: 'unit_predecessor',
        predecessorObjectiveId: 'objective_predecessor',
        predecessorPriority: 'required',
        contractVersionId: 'contract_version_1',
        executionSourceManifestFingerprint: 'manifest_fingerprint_1',
        sourceEnvelopeFingerprint: 'source_envelope_fingerprint_1',
      },
    };
    expect(ObjectiveAuthoritySemanticSupportSchema.safeParse(recovered).success).toBe(true);

    const missingLineage = structuredClone(recovered) as {
      capabilityPreservation: { recoveryOrigin: Record<string, unknown> };
    };
    delete missingLineage.capabilityPreservation.recoveryOrigin.predecessorObjectiveId;
    expect(ObjectiveAuthoritySemanticSupportSchema.safeParse(missingLineage).success).toBe(false);

    const unknownLineage = structuredClone(recovered) as {
      capabilityPreservation: { recoveryOrigin: Record<string, unknown> };
    };
    unknownLineage.capabilityPreservation.recoveryOrigin.providerAuthoredLineage = true;
    expect(ObjectiveAuthoritySemanticSupportSchema.safeParse(unknownLineage).success).toBe(false);
  });

  it('accepts failed-objective repair input and exact replacement output', () => {
    const critique: Record<string, unknown> = {
      fragments: [
        {
          fragmentId: 'fragment_1',
          text: 'integrated-system positioning',
          status: 'unsupported',
          supportType: null,
          evidenceRefs: [],
          rationale: 'The selected procedure does not state the positioning.',
        },
      ],
      unsupportedFragmentIds: ['fragment_1'],
      conflicts: [],
      overreach: [],
      verdict: 'fail',
      rationale: 'The selected authority supports a different proposition.',
    };
    const input = {
      schemaVersion: 1,
      policyVersion: 'objective-authority-semantic-support-v1',
      objectives: [
        {
          objectiveRef: 'objective_1',
          title: 'Explain the integrated system',
          description: 'Explain the integrated-system positioning.',
          subjectClass: 'source_specific',
          scopeOrigin: 'anchored',
          construct: 'explain',
          priority: 'required',
          currentEvidenceRefs: ['evidence_2'],
          allowedEvidence: [
            { ...evidenceOffer, selected: false },
            {
              ...evidenceOffer,
              evidenceRef: 'evidence_2',
              text: 'Upload, parse, chunk, embed, store.',
              selected: true,
            },
          ],
          fragments: critique.fragments,
          unsupportedFragmentIds: critique.unsupportedFragmentIds,
          conflicts: critique.conflicts,
          overreach: critique.overreach,
          verdict: critique.verdict,
          rationale: critique.rationale,
          requiredCapabilityPreservation: {
            originalProposition:
              'Explain the integrated system\nExplain the integrated-system positioning.',
            originalFragments: [
              {
                fragmentId: 'original_1',
                text: 'Explain the integrated system\nExplain the integrated-system positioning.',
              },
            ],
          },
        },
      ],
    };
    expect(ObjectiveAuthoritySemanticRepairInputSchema.safeParse(input).success).toBe(true);
    const attestationAsRepairInput = structuredClone(input) as {
      objectives: Array<Record<string, unknown>>;
    };
    attestationAsRepairInput.objectives[0]!.subjectDependency = 'general_sufficient';
    expect(
      ObjectiveAuthoritySemanticRepairInputSchema.safeParse(attestationAsRepairInput).success,
    ).toBe(false);
    expect(
      ObjectiveAuthoritySemanticRepairProposalSchema.safeParse({
        schemaVersion: 1,
        replacements: [
          {
            objectiveRef: 'objective_1',
            title: 'Explain the integrated system',
            description: 'Explain the integrated-system positioning.',
            subjectClass: 'source_specific',
            scopeOrigin: 'anchored',
            construct: 'explain',
            evidenceRefs: ['evidence_1'],
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      ObjectiveAuthoritySemanticRepairProposalSchema.safeParse({
        schemaVersion: 1,
        replacements: [
          {
            objectiveRef: 'objective_1',
            title: 'Explain the integrated system',
            description: 'Explain the integrated-system positioning.',
            subjectClass: 'source_specific',
            scopeOrigin: 'anchored',
            construct: 'explain',
            evidenceRefs: ['evidence_1'],
            subjectDependency: 'general_sufficient',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('keeps legacy Curriculum objectives readable only when both classifications are absent', () => {
    const legacyObjective = {
      id: 'objective_legacy',
      title: 'Identify the concept',
      description: 'Identify it in the accepted material.',
      truthPremiseStatus: 'unverified',
      truthAuthorityRecordIds: [],
    };
    expect(CurriculumObjectiveSchema.safeParse(legacyObjective).success).toBe(true);
    expect(
      CurriculumObjectiveSchema.safeParse({
        ...legacyObjective,
        subjectClass: 'general',
      }).success,
    ).toBe(false);
    expect(
      CurriculumObjectiveSchema.safeParse({
        ...legacyObjective,
        scopeOrigin: 'anchored',
      }).success,
    ).toBe(false);
  });

  it('accepts valid persisted classifications and rejects source-specific supplemental scope', () => {
    const objective = {
      id: 'objective_current',
      title: 'Identify the concept',
      description: 'Identify it in the accepted material.',
      truthPremiseStatus: 'unverified',
      truthAuthorityRecordIds: [],
    };
    for (const [subjectClass, scopeOrigin] of [
      ['source_specific', 'anchored'],
      ['general', 'anchored'],
      ['general', 'supplemental'],
    ] as const) {
      expect(
        CurriculumObjectiveSchema.safeParse({ ...objective, subjectClass, scopeOrigin }).success,
      ).toBe(true);
    }
    expect(
      CurriculumObjectiveSchema.safeParse({
        ...objective,
        subjectClass: 'source_specific',
        scopeOrigin: 'supplemental',
      }).success,
    ).toBe(false);
  });
});
