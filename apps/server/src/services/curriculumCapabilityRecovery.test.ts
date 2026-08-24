import { describe, expect, it, vi } from 'vitest';
import type {
  CourseMapSourceAllocation,
  Curriculum,
  CurriculumObjective,
  CurriculumProposalPayload,
  ExecutionSourceManifest,
  LearningContract,
  SourceBlock,
} from '@hy3-clinic/shared';
import { AppError } from '../errors.js';
import type { CurriculumEvidenceOffer } from '../llm/provider.js';
import {
  allocateCurriculumCapabilityRecoveryFrontier,
  buildCurriculumCapabilityRecoveryFrontier,
  CURRICULUM_CAPABILITY_RECOVERY_MAX_EVIDENCE_PER_REQUIREMENT,
  CURRICULUM_CAPABILITY_RECOVERY_MAX_EVIDENCE_TOTAL,
  reserveCurriculumCapabilityRecoveryEvidence,
  validateCurriculumCapabilityRecoveryCandidate,
  type CurriculumCapabilityRecoveryFrontier,
} from './curriculumCapabilityRecovery.js';
import { curriculumSourceBlockFingerprint } from './curriculumValidation.js';

const NOW = '2026-08-24T00:00:00.000Z';
const WORKSPACE_ID = 'workspace_recovery';
const CONTRACT_ID = 'contract_recovery';
const MATERIAL_ID = 'material_recovery';
const REVISION_ID = 'revision_recovery';

function sourceBlock(id: string, index: number): SourceBlock {
  const content = `Exact authority for ${id}.`;
  return {
    id,
    materialId: MATERIAL_ID,
    materialRevisionId: REVISION_ID,
    index,
    heading: `Authority ${index + 1}`,
    headingPath: ['Recovery', `Authority ${index + 1}`],
    pageNumber: null,
    pageEnd: null,
    content,
    startOffset: index * 100,
    endOffset: index * 100 + content.length,
  };
}

function executionManifest(blocks: readonly SourceBlock[]): ExecutionSourceManifest {
  return {
    fingerprint: 'manifest_recovery',
    revisions: [
      {
        materialId: MATERIAL_ID,
        materialRevisionId: REVISION_ID,
        parserVersion: 'parser-1',
        parserFingerprint: 'parser-fingerprint-recovery',
        sourceBlockRevisionIds: blocks.map((block) => block.id),
      },
    ],
  };
}

function learningContract(overrides: Partial<LearningContract> = {}): LearningContract {
  return {
    id: CONTRACT_ID,
    workspaceId: WORKSPACE_ID,
    version: 1,
    predecessorId: null,
    intent: 'Preserve the accepted learning capabilities.',
    targetOutcome: {
      description: 'Explain and apply the exact source authority.',
      targetScore: null,
      credential: null,
    },
    deadline: null,
    studyBudget: {
      minutesPerDay: 30,
      minutesPerWeek: null,
      preferredSessionMinutes: 30,
      unavailablePeriods: [],
    },
    desiredDepth: 'working_fluency',
    courseScope: {
      subjectBoundaries: ['Recovery fixture'],
      materials: [
        {
          materialId: MATERIAL_ID,
          materialRoleAssignmentId: 'role_recovery',
          materialRoleAssignmentVersion: 1,
          role: 'course_material',
          disposition: 'included',
        },
      ],
      includedTopics: ['Recovery'],
      excludedTopics: [],
    },
    learnerSelfReport: null,
    examContext: null,
    riskTolerance: {
      description: null,
      allowExplicitDeferral: true,
      maximumUnresolvedPriority: null,
    },
    status: 'active',
    proposedBy: 'learner',
    learnerConfirmedAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

function curriculumObjective(
  id: string,
  overrides: Partial<CurriculumObjective> = {},
): CurriculumObjective {
  return {
    id,
    title: `Capability ${id}`,
    description: `Explain the exact proposition for ${id}.`,
    truthPremiseStatus: 'unverified',
    truthAuthorityRecordIds: [],
    formalAssessmentConstruct: 'explain',
    ...overrides,
  };
}

function evidenceOffer(block: SourceBlock, index: number): CurriculumEvidenceOffer {
  return {
    id: `E${index + 1}`,
    bindingId: `binding_${index + 1}`,
    materialId: block.materialId,
    materialRevisionId: REVISION_ID,
    blockId: block.id,
    startOffset: 0,
    endOffset: block.content.length,
    quote: block.content,
    headingPath: block.headingPath,
    pageNumber: block.pageNumber,
  };
}

interface RecoveryFixture {
  contract: LearningContract;
  manifest: ExecutionSourceManifest;
  blocks: SourceBlock[];
  evidenceCatalog: CurriculumEvidenceOffer[];
  predecessor: Curriculum;
}

function recoveryFixture(
  objectives: CurriculumObjective[] = [curriculumObjective('objective_1')],
): RecoveryFixture {
  const blocks = [sourceBlock('block_visible', 0), sourceBlock('block_hidden', 1)];
  const manifest = executionManifest(blocks);
  const contract = learningContract();
  const predecessor: Curriculum = {
    id: 'curriculum_predecessor',
    workspaceId: WORKSPACE_ID,
    contractVersionId: CONTRACT_ID,
    version: 3,
    predecessorId: 'curriculum_older',
    status: 'accepted',
    executionSourceManifest: manifest,
    nodes: [
      {
        id: 'course_predecessor',
        parentId: null,
        kind: 'course',
        index: 0,
        title: 'Recovery course',
        sourceReferences: [],
        learningUnit: null,
      },
      {
        id: 'unit_predecessor',
        parentId: 'course_predecessor',
        kind: 'learning_unit',
        index: 0,
        title: 'Recovery unit',
        sourceReferences: blocks.map((block) => ({
          materialId: MATERIAL_ID,
          materialRevisionId: REVISION_ID,
          structuralUnitId: null,
          sourceBlockId: block.id,
          sourceBlockRevisionFingerprint: curriculumSourceBlockFingerprint(block, REVISION_ID),
        })),
        learningUnit: {
          conceptIds: [],
          canonicalConceptIds: [],
          objectives,
          prerequisiteUnitIds: [],
          graphRelationIds: [],
          riskIds: [],
        },
      },
    ],
    synthesisGroups: [],
    validation: {
      valid: true,
      errors: [],
      warnings: [],
      unmappedStructuralUnitIds: [],
    },
    provider: 'fixture',
    providerModel: null,
    createdAt: NOW,
    acceptedAt: NOW,
  };
  return {
    contract,
    manifest,
    blocks,
    evidenceCatalog: blocks.map(evidenceOffer),
    predecessor,
  };
}

function buildFrontier(fixture: RecoveryFixture): CurriculumCapabilityRecoveryFrontier {
  const recoveryEvidenceIdsByLearningUnitId = new Map(
    fixture.predecessor.nodes.flatMap((node) => {
      const hasNonOptionalObjective =
        node.learningUnit?.objectives.some(
          (objective) => (objective.priority ?? 'normal') !== 'optional',
        ) ?? false;
      if (!hasNonOptionalObjective) return [];
      const sourceBlockIds = new Set(
        node.sourceReferences.flatMap((reference) =>
          reference.sourceBlockId ? [reference.sourceBlockId] : [],
        ),
      );
      return [
        [
          node.id,
          fixture.evidenceCatalog
            .filter((offer) => sourceBlockIds.has(offer.blockId))
            .map((offer) => offer.id),
        ] as const,
      ];
    }),
  );
  return buildCurriculumCapabilityRecoveryFrontier({
    predecessor: fixture.predecessor,
    contract: fixture.contract,
    manifest: fixture.manifest,
    sourceBlocks: fixture.blocks,
    evidenceCatalog: fixture.evidenceCatalog,
    recoveryEvidenceIdsByLearningUnitId,
  });
}

function expectRecoveryError(action: () => unknown, diagnosticCode: string): AppError {
  let thrown: unknown = null;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AppError);
  expect((thrown as AppError).details).toMatchObject({
    kind: 'curriculum_capability_recovery_invalid',
    diagnosticCode,
  });
  return thrown as AppError;
}

function exactCandidate(frontier: CurriculumCapabilityRecoveryFrontier): CurriculumProposalPayload {
  const requirement = frontier.requirements[0]!;
  return {
    nodes: [
      {
        key: 'chapter_1',
        parentKey: null,
        kind: 'chapter',
        index: 0,
        title: 'Recovery chapter',
        structuralUnitIds: [],
        sourceEvidence: [],
        conceptIds: [],
        canonicalConceptIds: [],
        objectives: [],
        prerequisiteUnitKeys: [],
        graphRelationIds: [],
      },
      {
        key: 'section_1',
        parentKey: 'chapter_1',
        kind: 'section',
        index: 0,
        title: 'Recovery section',
        structuralUnitIds: [],
        sourceEvidence: [],
        conceptIds: [],
        canonicalConceptIds: [],
        objectives: [],
        prerequisiteUnitKeys: [],
        graphRelationIds: [],
      },
      {
        key: 'unit_1',
        parentKey: 'section_1',
        kind: 'learning_unit',
        index: 0,
        title: 'Recovery unit',
        structuralUnitIds: [],
        sourceEvidence: [{ evidenceId: requirement.allowedEvidenceIds[0]! }],
        conceptIds: [],
        canonicalConceptIds: [],
        objectives: [
          {
            key: 'objective_1',
            title: requirement.title,
            description: requirement.description,
            construct: requirement.construct,
            evidence: [{ evidenceId: requirement.allowedEvidenceIds[0]! }],
            capabilityRequirementRef: requirement.capabilityRef,
            priority: requirement.priority,
          },
        ],
        prerequisiteUnitKeys: [],
        graphRelationIds: [],
      },
    ],
    synthesisGroups: [],
  };
}

function oneRegionAllocation(fixture: RecoveryFixture): CourseMapSourceAllocation {
  const visible = fixture.blocks[0]!;
  return {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    courseSourceMapFingerprint: 'course_source_map_fixture',
    fingerprint: `course_map_source_allocation_${'0'.repeat(40)}`,
    authority: 'planning_visibility_only',
    materialCount: 1,
    sourceSectionCount: 1,
    sourceBlockCount: fixture.blocks.length,
    limits: {
      maxRegions: 1,
      maxEvidenceOffers: 1,
      maxEvidenceOffersPerRegion: 1,
    },
    regions: [
      {
        id: `course_map_source_region_${'0'.repeat(24)}`,
        index: 0,
        materialId: MATERIAL_ID,
        materialRevisionId: REVISION_ID,
        title: 'Recovery region',
        firstCourseSourceIndex: 0,
        lastCourseSourceIndex: fixture.blocks.length - 1,
        charCount: fixture.blocks.reduce((sum, block) => sum + block.content.length, 0),
        sourceSectionIds: ['section_recovery'],
        sourceBlockIds: fixture.blocks.map((block) => block.id),
        conceptIds: [],
        evidence: [
          {
            evidenceId: fixture.evidenceCatalog[0]!.id,
            bindingId: fixture.evidenceCatalog[0]!.bindingId,
            blockId: visible.id,
            startOffset: 0,
            endOffset: visible.content.length,
            quote: visible.content,
          },
        ],
      },
    ],
  };
}

describe('Curriculum capability recovery frontier', () => {
  it('normalizes undefined priority to normal and excludes optional objectives', () => {
    const fixture = recoveryFixture([
      curriculumObjective('objective_normal'),
      curriculumObjective('objective_optional', {
        priority: 'optional',
        formalAssessmentConstruct: 'design',
      }),
    ]);

    const frontier = buildFrontier(fixture);

    expect(frontier.requirements).toEqual([
      expect.objectContaining({
        capabilityRef: 'recovery_capability_1',
        title: 'Capability objective_normal',
        priority: 'normal',
        construct: 'explain',
      }),
    ]);
    expect([...frontier.bindingsByCapabilityRef.values()]).toEqual([
      expect.objectContaining({
        predecessorObjectiveId: 'objective_normal',
        recoveryOrigin: expect.objectContaining({ predecessorPriority: 'normal' }),
      }),
    ]);
  });

  it('fails closed for missing, foreign, optional-only, duplicate, unknown, and escaped recovery reservations', () => {
    const missing = recoveryFixture();
    expectRecoveryError(
      () =>
        buildCurriculumCapabilityRecoveryFrontier({
          predecessor: missing.predecessor,
          contract: missing.contract,
          manifest: missing.manifest,
          sourceBlocks: missing.blocks,
          evidenceCatalog: missing.evidenceCatalog,
          recoveryEvidenceIdsByLearningUnitId: new Map(),
        }),
      'recovery_capability_evidence_reservation_missing',
    );

    const foreign = recoveryFixture();
    const foreignReservations = new Map<string, readonly string[]>([
      [foreign.predecessor.nodes[1]!.id, foreign.evidenceCatalog.map((offer) => offer.id)],
      ['unit_foreign', [foreign.evidenceCatalog[0]!.id]],
    ]);
    expectRecoveryError(
      () =>
        buildCurriculumCapabilityRecoveryFrontier({
          predecessor: foreign.predecessor,
          contract: foreign.contract,
          manifest: foreign.manifest,
          sourceBlocks: foreign.blocks,
          evidenceCatalog: foreign.evidenceCatalog,
          recoveryEvidenceIdsByLearningUnitId: foreignReservations,
        }),
      'recovery_capability_evidence_reservation_foreign',
    );

    const optionalOnly = recoveryFixture([
      curriculumObjective('objective_optional_only', { priority: 'optional' }),
    ]);
    expectRecoveryError(
      () =>
        buildCurriculumCapabilityRecoveryFrontier({
          predecessor: optionalOnly.predecessor,
          contract: optionalOnly.contract,
          manifest: optionalOnly.manifest,
          sourceBlocks: optionalOnly.blocks,
          evidenceCatalog: optionalOnly.evidenceCatalog,
          recoveryEvidenceIdsByLearningUnitId: new Map([
            [optionalOnly.predecessor.nodes[1]!.id, [optionalOnly.evidenceCatalog[0]!.id]],
          ]),
        }),
      'recovery_capability_evidence_reservation_unbound',
    );

    const duplicate = recoveryFixture();
    expectRecoveryError(
      () =>
        buildCurriculumCapabilityRecoveryFrontier({
          predecessor: duplicate.predecessor,
          contract: duplicate.contract,
          manifest: duplicate.manifest,
          sourceBlocks: duplicate.blocks,
          evidenceCatalog: duplicate.evidenceCatalog,
          recoveryEvidenceIdsByLearningUnitId: new Map([
            [
              duplicate.predecessor.nodes[1]!.id,
              [duplicate.evidenceCatalog[0]!.id, duplicate.evidenceCatalog[0]!.id],
            ],
          ]),
        }),
      'recovery_capability_evidence_reservation_duplicate',
    );

    const unknown = recoveryFixture();
    expectRecoveryError(
      () =>
        buildCurriculumCapabilityRecoveryFrontier({
          predecessor: unknown.predecessor,
          contract: unknown.contract,
          manifest: unknown.manifest,
          sourceBlocks: unknown.blocks,
          evidenceCatalog: unknown.evidenceCatalog,
          recoveryEvidenceIdsByLearningUnitId: new Map([
            [unknown.predecessor.nodes[1]!.id, ['E_unknown']],
          ]),
        }),
      'recovery_capability_evidence_unknown',
    );

    const escaped = recoveryFixture();
    escaped.predecessor.nodes[1]!.sourceReferences = [
      escaped.predecessor.nodes[1]!.sourceReferences[0]!,
    ];
    expectRecoveryError(
      () =>
        buildCurriculumCapabilityRecoveryFrontier({
          predecessor: escaped.predecessor,
          contract: escaped.contract,
          manifest: escaped.manifest,
          sourceBlocks: escaped.blocks,
          evidenceCatalog: escaped.evidenceCatalog,
          recoveryEvidenceIdsByLearningUnitId: new Map([
            [escaped.predecessor.nodes[1]!.id, [escaped.evidenceCatalog[1]!.id]],
          ]),
        }),
      'recovery_capability_evidence_outside_source_envelope',
    );
  });

  it.each([
    ['missing', undefined, 'recovery_capability_construct_missing'],
    ['design', 'design', 'recovery_capability_construct_prohibited'],
    ['evaluate', 'evaluate', 'recovery_capability_construct_prohibited'],
  ] as const)(
    'rejects a non-optional %s construct before any provider work',
    (_label, construct, diagnosticCode) => {
      const fixture = recoveryFixture([
        curriculumObjective('objective_invalid', {
          formalAssessmentConstruct: construct,
        }),
      ]);
      const provider = vi.fn();

      expectRecoveryError(() => provider(buildFrontier(fixture)), diagnosticCode);
      expect(provider).not.toHaveBeenCalled();
    },
  );

  it('rejects never-accepted, cross-contract, changed-manifest, and stale-envelope predecessors', () => {
    const neverAccepted = recoveryFixture();
    neverAccepted.predecessor.status = 'rejected';
    neverAccepted.predecessor.acceptedAt = null;
    expectRecoveryError(
      () => buildFrontier(neverAccepted),
      'recovery_predecessor_not_historically_accepted',
    );

    const historical = recoveryFixture();
    historical.predecessor.status = 'rejected';
    expect(buildFrontier(historical).predecessorCurriculumId).toBe(historical.predecessor.id);

    const crossContract = recoveryFixture();
    crossContract.predecessor.contractVersionId = 'contract_foreign';
    expectRecoveryError(
      () => buildFrontier(crossContract),
      'recovery_predecessor_contract_mismatch',
    );

    const changedManifest = recoveryFixture();
    changedManifest.manifest = {
      ...changedManifest.manifest,
      fingerprint: 'manifest_changed',
    };
    expectRecoveryError(
      () => buildFrontier(changedManifest),
      'recovery_predecessor_manifest_mismatch',
    );

    const staleEnvelope = recoveryFixture();
    staleEnvelope.blocks[1]!.content += ' Changed after predecessor acceptance.';
    expectRecoveryError(() => buildFrontier(staleEnvelope), 'recovery_source_envelope_stale');
  });

  it('produces a deterministic fingerprint that changes with the frozen capability', () => {
    const fixture = recoveryFixture();
    const first = buildFrontier(fixture);
    const again = buildFrontier(fixture);
    expect(again.fingerprint).toBe(first.fingerprint);

    const changed = recoveryFixture();
    changed.predecessor.nodes[1]!.learningUnit!.objectives[0]!.description =
      'Explain a different exact proposition.';
    expect(buildFrontier(changed).fingerprint).not.toBe(first.fingerprint);
  });

  it('aligns each capability with the unsplittable 29-offer detail budget', () => {
    expect(CURRICULUM_CAPABILITY_RECOVERY_MAX_EVIDENCE_PER_REQUIREMENT).toBe(29);
    const fixture = recoveryFixture();
    const template = fixture.evidenceCatalog[0]!;
    fixture.evidenceCatalog = Array.from({ length: 30 }, (_, index) => ({
      ...template,
      id: `over-budget-evidence-${index + 1}`,
      bindingId: `over-budget-binding-${index + 1}`,
    }));

    expectRecoveryError(
      () => buildFrontier(fixture),
      'recovery_capability_evidence_budget_exceeded',
    );
  });
});

describe('Curriculum capability recovery candidate validation', () => {
  it('accepts one exact capability placement inside its predecessor evidence envelope', () => {
    const frontier = buildFrontier(recoveryFixture());

    expect(
      validateCurriculumCapabilityRecoveryCandidate(exactCandidate(frontier), frontier),
    ).toEqual({
      valid: true,
      diagnostics: [],
      diagnosticCodes: [],
    });
  });

  it('fails closed for missing and foreign capability aliases', () => {
    const frontier = buildFrontier(recoveryFixture());
    const missing = exactCandidate(frontier);
    delete missing.nodes[2]!.objectives[0]!.capabilityRequirementRef;
    expect(
      validateCurriculumCapabilityRecoveryCandidate(missing, frontier).diagnosticCodes,
    ).toContain('recovery_capability_missing');

    const foreign = exactCandidate(frontier);
    foreign.nodes[2]!.objectives[0]!.capabilityRequirementRef = 'recovery_capability_foreign';
    const foreignCodes = validateCurriculumCapabilityRecoveryCandidate(
      foreign,
      frontier,
    ).diagnosticCodes;
    expect(foreignCodes).toContain('recovery_capability_unknown');
    expect(foreignCodes).toContain('recovery_capability_missing');
  });

  it('fails closed when a candidate duplicates a capability alias', () => {
    const frontier = buildFrontier(recoveryFixture());
    const duplicate = exactCandidate(frontier);
    duplicate.nodes[2]!.objectives.push({
      ...structuredClone(duplicate.nodes[2]!.objectives[0]!),
      key: 'objective_duplicate',
    });

    const validation = validateCurriculumCapabilityRecoveryCandidate(duplicate, frontier);

    expect(validation.valid).toBe(false);
    expect(validation.diagnosticCodes).toContain('recovery_capability_candidate_schema_invalid');
  });

  it('fails closed when a candidate weakens proposition, construct, or priority', () => {
    const frontier = buildFrontier(recoveryFixture());
    const cases: Array<{
      diagnosticCode: string;
      mutate: (candidate: CurriculumProposalPayload) => void;
    }> = [
      {
        diagnosticCode: 'recovery_capability_proposition_changed',
        mutate: (candidate) => {
          candidate.nodes[2]!.objectives[0]!.description = 'Explain only a narrower fragment.';
        },
      },
      {
        diagnosticCode: 'recovery_capability_construct_changed',
        mutate: (candidate) => {
          candidate.nodes[2]!.objectives[0]!.construct = 'identify';
        },
      },
      {
        diagnosticCode: 'recovery_capability_priority_changed',
        mutate: (candidate) => {
          candidate.nodes[2]!.objectives[0]!.priority = 'optional';
        },
      },
    ];

    for (const testCase of cases) {
      const candidate = exactCandidate(frontier);
      testCase.mutate(candidate);
      expect(
        validateCurriculumCapabilityRecoveryCandidate(candidate, frontier).diagnosticCodes,
      ).toContain(testCase.diagnosticCode);
    }
  });

  it('fails closed for evidence outside the predecessor envelope and unsolicited aliases', () => {
    const frontier = buildFrontier(recoveryFixture());
    const outsideEnvelope = exactCandidate(frontier);
    outsideEnvelope.nodes[2]!.objectives[0]!.evidence = [{ evidenceId: 'E_foreign' }];
    expect(
      validateCurriculumCapabilityRecoveryCandidate(outsideEnvelope, frontier).diagnosticCodes,
    ).toContain('recovery_capability_evidence_outside_envelope');

    const unsolicited = exactCandidate(frontier);
    expect(
      validateCurriculumCapabilityRecoveryCandidate(unsolicited, null).diagnosticCodes,
    ).toContain('recovery_capability_unsolicited');
  });
});

describe('Curriculum capability recovery source allocation', () => {
  it('reserves a first-source offer omitted by the ordinary selector and re-aliases bindings once', () => {
    const fixture = recoveryFixture();
    const selectedAlias = {
      ...fixture.evidenceCatalog[1]!,
      id: 'E1',
    };

    const reservation = reserveCurriculumCapabilityRecoveryEvidence({
      predecessor: fixture.predecessor,
      fullEvidenceCatalog: fixture.evidenceCatalog.map((offer, index) => ({
        ...offer,
        id: `cev_${index + 1}`,
      })),
      selectedEvidenceCatalog: [selectedAlias],
    });
    const reserved = reservation.evidenceCatalog;

    expect(reserved.map((offer) => offer.blockId)).toEqual([
      fixture.blocks[1]!.id,
      fixture.blocks[0]!.id,
    ]);
    expect(reserved.map((offer) => offer.id)).toEqual(['E1', 'E2']);
    expect(new Set(reserved.map((offer) => offer.bindingId)).size).toBe(reserved.length);
    const frontier = buildCurriculumCapabilityRecoveryFrontier({
      predecessor: fixture.predecessor,
      contract: fixture.contract,
      manifest: fixture.manifest,
      sourceBlocks: fixture.blocks,
      evidenceCatalog: reserved,
      recoveryEvidenceIdsByLearningUnitId: reservation.recoveryEvidenceIdsByLearningUnitId,
    });
    expect(frontier.requirements[0]!.allowedEvidenceIds).toEqual(['E1', 'E2']);
  });

  it('fairly bounds a multi-LearningUnit reserve below the global provider ceiling', () => {
    const fixture = recoveryFixture();
    const unitCount = 8;
    const blocksPerUnit = 40;
    fixture.blocks = Array.from({ length: unitCount * blocksPerUnit }, (_, index) =>
      sourceBlock(`block_scale_${index + 1}`, index),
    );
    fixture.manifest = executionManifest(fixture.blocks);
    fixture.predecessor.executionSourceManifest = fixture.manifest;
    fixture.predecessor.nodes = [
      fixture.predecessor.nodes[0]!,
      ...Array.from({ length: unitCount }, (_, unitIndex) => {
        const unitBlocks = fixture.blocks.slice(
          unitIndex * blocksPerUnit,
          (unitIndex + 1) * blocksPerUnit,
        );
        return {
          ...structuredClone(fixture.predecessor.nodes[1]!),
          id: `unit_scale_${unitIndex + 1}`,
          sourceReferences: unitBlocks.map((block) => ({
            materialId: MATERIAL_ID,
            materialRevisionId: REVISION_ID,
            structuralUnitId: null,
            sourceBlockId: block.id,
            sourceBlockRevisionFingerprint: curriculumSourceBlockFingerprint(block, REVISION_ID),
          })),
          learningUnit: {
            ...structuredClone(fixture.predecessor.nodes[1]!.learningUnit!),
            objectives: [curriculumObjective(`objective_scale_${unitIndex + 1}`)],
          },
        };
      }),
    ];
    fixture.evidenceCatalog = fixture.blocks.map(evidenceOffer);

    const reservation = reserveCurriculumCapabilityRecoveryEvidence({
      predecessor: fixture.predecessor,
      fullEvidenceCatalog: fixture.evidenceCatalog,
      selectedEvidenceCatalog: [],
    });
    const reserved = reservation.evidenceCatalog;
    const reservedFrontier = buildCurriculumCapabilityRecoveryFrontier({
      predecessor: fixture.predecessor,
      contract: fixture.contract,
      manifest: fixture.manifest,
      sourceBlocks: fixture.blocks,
      evidenceCatalog: reserved,
      recoveryEvidenceIdsByLearningUnitId: reservation.recoveryEvidenceIdsByLearningUnitId,
    });

    expect(reservedFrontier.requirements).toHaveLength(unitCount);
    expect(reserved).toHaveLength(
      unitCount * CURRICULUM_CAPABILITY_RECOVERY_MAX_EVIDENCE_PER_REQUIREMENT,
    );
    expect(reserved.length).toBeLessThanOrEqual(CURRICULUM_CAPABILITY_RECOVERY_MAX_EVIDENCE_TOTAL);
    expect(
      reservedFrontier.requirements.every(
        (requirement) =>
          requirement.allowedEvidenceIds.length > 0 &&
          requirement.allowedEvidenceIds.length <=
            CURRICULUM_CAPABILITY_RECOVERY_MAX_EVIDENCE_PER_REQUIREMENT,
      ),
    ).toBe(true);
    for (let unitIndex = 0; unitIndex < unitCount; unitIndex += 1) {
      expect(reserved.map((offer) => offer.blockId)).toContain(
        fixture.blocks[unitIndex * blocksPerUnit]!.id,
      );
    }
  });

  it('retains ordinary evidence outside nine rich recovery units at the global ceiling', () => {
    const fixture = recoveryFixture();
    const unitCount = 9;
    const blocksPerUnit = 40;
    const recoveryBlocks = Array.from({ length: unitCount * blocksPerUnit }, (_, index) =>
      sourceBlock(`block_rich_${index + 1}`, index),
    );
    const ordinaryBlocks = Array.from({ length: 2 }, (_, index) =>
      sourceBlock(`block_ordinary_outside_recovery_${index + 1}`, recoveryBlocks.length + index),
    );
    fixture.blocks = [...recoveryBlocks, ...ordinaryBlocks];
    fixture.manifest = executionManifest(fixture.blocks);
    fixture.predecessor.executionSourceManifest = fixture.manifest;
    fixture.predecessor.nodes = [
      fixture.predecessor.nodes[0]!,
      ...Array.from({ length: unitCount }, (_, unitIndex) => {
        const unitBlocks = recoveryBlocks.slice(
          unitIndex * blocksPerUnit,
          (unitIndex + 1) * blocksPerUnit,
        );
        return {
          ...structuredClone(fixture.predecessor.nodes[1]!),
          id: `unit_rich_${unitIndex + 1}`,
          sourceReferences: unitBlocks.map((block) => ({
            materialId: MATERIAL_ID,
            materialRevisionId: REVISION_ID,
            structuralUnitId: null,
            sourceBlockId: block.id,
            sourceBlockRevisionFingerprint: curriculumSourceBlockFingerprint(block, REVISION_ID),
          })),
          learningUnit: {
            ...structuredClone(fixture.predecessor.nodes[1]!.learningUnit!),
            objectives: [curriculumObjective(`objective_rich_${unitIndex + 1}`)],
          },
        };
      }),
    ];
    fixture.evidenceCatalog = fixture.blocks.map(evidenceOffer);
    const ordinaryOffers = fixture.evidenceCatalog.slice(-ordinaryBlocks.length);

    const reservation = reserveCurriculumCapabilityRecoveryEvidence({
      predecessor: fixture.predecessor,
      fullEvidenceCatalog: fixture.evidenceCatalog,
      selectedEvidenceCatalog: ordinaryOffers,
    });
    const reserved = reservation.evidenceCatalog;
    const reservedBindingIds = new Set(reserved.map((offer) => offer.bindingId));
    const reservedFrontier = buildCurriculumCapabilityRecoveryFrontier({
      predecessor: fixture.predecessor,
      contract: fixture.contract,
      manifest: fixture.manifest,
      sourceBlocks: fixture.blocks,
      evidenceCatalog: reserved,
      recoveryEvidenceIdsByLearningUnitId: reservation.recoveryEvidenceIdsByLearningUnitId,
    });
    const evidenceCounts = reservedFrontier.requirements.map(
      (requirement) => requirement.allowedEvidenceIds.length,
    );

    expect(reserved).toHaveLength(CURRICULUM_CAPABILITY_RECOVERY_MAX_EVIDENCE_TOTAL);
    expect(
      ordinaryOffers.every((ordinaryOffer) => reservedBindingIds.has(ordinaryOffer.bindingId)),
    ).toBe(true);
    expect(
      ordinaryOffers.map(
        (ordinaryOffer) =>
          reserved.find((offer) => offer.bindingId === ordinaryOffer.bindingId)?.blockId,
      ),
    ).toEqual(ordinaryBlocks.map((ordinaryBlock) => ordinaryBlock.id));
    expect(reservedFrontier.requirements).toHaveLength(unitCount);
    expect(Math.min(...evidenceCounts)).toBeGreaterThan(0);
    expect(Math.max(...evidenceCounts)).toBeLessThanOrEqual(
      CURRICULUM_CAPABILITY_RECOVERY_MAX_EVIDENCE_PER_REQUIREMENT,
    );
    expect(Math.max(...evidenceCounts) - Math.min(...evidenceCounts)).toBeLessThanOrEqual(1);
  });

  it('reuses ordinary in-envelope minima for a feasible saturated union', () => {
    const fixture = recoveryFixture();
    const unitCount = 120;
    const firstSourceBlocks = Array.from({ length: unitCount }, (_, index) =>
      sourceBlock(`block_recovery_first_${index + 1}`, index),
    );
    const ordinaryRecoveryBlocks = Array.from({ length: unitCount }, (_, index) =>
      sourceBlock(`block_recovery_ordinary_${index + 1}`, unitCount + index),
    );
    const ordinaryOutsideBlocks = Array.from({ length: unitCount }, (_, index) =>
      sourceBlock(`block_ordinary_outside_${index + 1}`, unitCount * 2 + index),
    );
    fixture.blocks = [...firstSourceBlocks, ...ordinaryRecoveryBlocks, ...ordinaryOutsideBlocks];
    fixture.manifest = executionManifest(fixture.blocks);
    fixture.predecessor.executionSourceManifest = fixture.manifest;
    fixture.predecessor.nodes = [
      fixture.predecessor.nodes[0]!,
      ...Array.from({ length: unitCount }, (_, unitIndex) => {
        const unitBlocks = [firstSourceBlocks[unitIndex]!, ordinaryRecoveryBlocks[unitIndex]!];
        return {
          ...structuredClone(fixture.predecessor.nodes[1]!),
          id: `unit_saturated_${unitIndex + 1}`,
          sourceReferences: unitBlocks.map((block) => ({
            materialId: MATERIAL_ID,
            materialRevisionId: REVISION_ID,
            structuralUnitId: null,
            sourceBlockId: block.id,
            sourceBlockRevisionFingerprint: curriculumSourceBlockFingerprint(block, REVISION_ID),
          })),
          learningUnit: {
            ...structuredClone(fixture.predecessor.nodes[1]!.learningUnit!),
            objectives: [curriculumObjective(`objective_saturated_${unitIndex + 1}`)],
          },
        };
      }),
    ];
    fixture.evidenceCatalog = fixture.blocks.map(evidenceOffer);
    const ordinaryOffers = fixture.evidenceCatalog.slice(unitCount);

    const reservation = reserveCurriculumCapabilityRecoveryEvidence({
      predecessor: fixture.predecessor,
      fullEvidenceCatalog: fixture.evidenceCatalog,
      selectedEvidenceCatalog: ordinaryOffers,
    });
    const reserved = reservation.evidenceCatalog;
    const reservedBindingIds = new Set(reserved.map((offer) => offer.bindingId));
    const reservedBlockIds = new Set(reserved.map((offer) => offer.blockId));
    const reservedFrontier = buildCurriculumCapabilityRecoveryFrontier({
      predecessor: fixture.predecessor,
      contract: fixture.contract,
      manifest: fixture.manifest,
      sourceBlocks: fixture.blocks,
      evidenceCatalog: reserved,
      recoveryEvidenceIdsByLearningUnitId: reservation.recoveryEvidenceIdsByLearningUnitId,
    });

    expect(ordinaryOffers).toHaveLength(CURRICULUM_CAPABILITY_RECOVERY_MAX_EVIDENCE_TOTAL);
    expect(reserved).toHaveLength(CURRICULUM_CAPABILITY_RECOVERY_MAX_EVIDENCE_TOTAL);
    expect(ordinaryOffers.every((offer) => reservedBindingIds.has(offer.bindingId))).toBe(true);
    expect(firstSourceBlocks.some((block) => reservedBlockIds.has(block.id))).toBe(false);
    expect(reservedFrontier.requirements).toHaveLength(unitCount);
    expect(
      reservedFrontier.requirements.every(
        (requirement) => requirement.allowedEvidenceIds.length === 1,
      ),
    ).toBe(true);
  });

  it('keeps 160 ordinary blocks visible while bounding a 102-block recovery envelope to 29', () => {
    const fixture = recoveryFixture();
    fixture.blocks = Array.from({ length: 160 }, (_, index) =>
      sourceBlock(`block_large_ordinary_${index + 1}`, index),
    );
    fixture.manifest = executionManifest(fixture.blocks);
    fixture.predecessor.executionSourceManifest = fixture.manifest;
    const largeUnitBlocks = fixture.blocks.slice(0, 102);
    fixture.predecessor.nodes[1] = {
      ...structuredClone(fixture.predecessor.nodes[1]!),
      id: 'unit_large_ordinary_recovery',
      sourceReferences: largeUnitBlocks.map((block) => ({
        materialId: MATERIAL_ID,
        materialRevisionId: REVISION_ID,
        structuralUnitId: null,
        sourceBlockId: block.id,
        sourceBlockRevisionFingerprint: curriculumSourceBlockFingerprint(block, REVISION_ID),
      })),
      learningUnit: {
        ...structuredClone(fixture.predecessor.nodes[1]!.learningUnit!),
        objectives: [
          curriculumObjective('objective_large_ordinary_recovery_1'),
          curriculumObjective('objective_large_ordinary_recovery_2'),
        ],
      },
    };
    fixture.evidenceCatalog = fixture.blocks.map(evidenceOffer);

    const reservation = reserveCurriculumCapabilityRecoveryEvidence({
      predecessor: fixture.predecessor,
      fullEvidenceCatalog: fixture.evidenceCatalog,
      selectedEvidenceCatalog: fixture.evidenceCatalog,
    });
    const repeatedReservation = reserveCurriculumCapabilityRecoveryEvidence({
      predecessor: fixture.predecessor,
      fullEvidenceCatalog: fixture.evidenceCatalog,
      selectedEvidenceCatalog: fixture.evidenceCatalog,
    });
    const recoveryEvidenceIds = reservation.recoveryEvidenceIdsByLearningUnitId.get(
      'unit_large_ordinary_recovery',
    );
    const reservedById = new Map(
      reservation.evidenceCatalog.map((offer) => [offer.id, offer] as const),
    );
    const largeUnitBlockIds = new Set(largeUnitBlocks.map((block) => block.id));
    const recoveryBindingIds = new Set(
      recoveryEvidenceIds?.map((evidenceId) => reservedById.get(evidenceId)!.bindingId),
    );
    const frontier = buildCurriculumCapabilityRecoveryFrontier({
      predecessor: fixture.predecessor,
      contract: fixture.contract,
      manifest: fixture.manifest,
      sourceBlocks: fixture.blocks,
      evidenceCatalog: reservation.evidenceCatalog,
      recoveryEvidenceIdsByLearningUnitId: reservation.recoveryEvidenceIdsByLearningUnitId,
    });

    expect(reservation.evidenceCatalog).toHaveLength(160);
    expect(repeatedReservation).toEqual(reservation);
    expect(
      fixture.evidenceCatalog.every((offer) =>
        reservation.evidenceCatalog.some((reserved) => reserved.bindingId === offer.bindingId),
      ),
    ).toBe(true);
    expect(recoveryEvidenceIds).toHaveLength(
      CURRICULUM_CAPABILITY_RECOVERY_MAX_EVIDENCE_PER_REQUIREMENT,
    );
    expect(new Set(recoveryEvidenceIds).size).toBe(recoveryEvidenceIds?.length);
    expect(
      recoveryEvidenceIds?.every((evidenceId) =>
        largeUnitBlockIds.has(reservedById.get(evidenceId)!.blockId),
      ),
    ).toBe(true);
    expect(
      reservation.evidenceCatalog.some(
        (offer) => largeUnitBlockIds.has(offer.blockId) && !recoveryBindingIds.has(offer.bindingId),
      ),
    ).toBe(true);
    expect(
      reservation.evidenceCatalog
        .filter((offer) => !largeUnitBlockIds.has(offer.blockId))
        .every((offer) => !recoveryBindingIds.has(offer.bindingId)),
    ).toBe(true);
    expect(frontier.requirements).toHaveLength(2);
    expect(
      frontier.requirements.every(
        (requirement) =>
          JSON.stringify(requirement.allowedEvidenceIds) === JSON.stringify(recoveryEvidenceIds),
      ),
    ).toBe(true);
  });

  it('fails closed when mandatory ordinary coverage plus recovery minima exceeds 240 offers', () => {
    const fixture = recoveryFixture();
    const ordinaryBlockCount = 160;
    const recoveryUnitCount =
      CURRICULUM_CAPABILITY_RECOVERY_MAX_EVIDENCE_TOTAL - ordinaryBlockCount + 1;
    const recoveryBlocks = Array.from({ length: recoveryUnitCount }, (_, index) =>
      sourceBlock(`block_global_recovery_${index + 1}`, index),
    );
    const ordinaryBlocks = Array.from({ length: ordinaryBlockCount }, (_, index) =>
      sourceBlock(`block_global_ordinary_${index + 1}`, recoveryUnitCount + index),
    );
    fixture.blocks = [...recoveryBlocks, ...ordinaryBlocks];
    fixture.manifest = executionManifest(fixture.blocks);
    fixture.predecessor.executionSourceManifest = fixture.manifest;
    fixture.predecessor.nodes = [
      fixture.predecessor.nodes[0]!,
      ...recoveryBlocks.map((block, index) => ({
        ...structuredClone(fixture.predecessor.nodes[1]!),
        id: `unit_global_recovery_${index + 1}`,
        sourceReferences: [
          {
            materialId: MATERIAL_ID,
            materialRevisionId: REVISION_ID,
            structuralUnitId: null,
            sourceBlockId: block.id,
            sourceBlockRevisionFingerprint: curriculumSourceBlockFingerprint(block, REVISION_ID),
          },
        ],
        learningUnit: {
          ...structuredClone(fixture.predecessor.nodes[1]!.learningUnit!),
          objectives: [curriculumObjective(`objective_global_recovery_${index + 1}`)],
        },
      })),
    ];
    fixture.evidenceCatalog = fixture.blocks.map(evidenceOffer);
    const ordinaryOffers = fixture.evidenceCatalog.slice(recoveryUnitCount);

    const error = expectRecoveryError(
      () =>
        reserveCurriculumCapabilityRecoveryEvidence({
          predecessor: fixture.predecessor,
          fullEvidenceCatalog: fixture.evidenceCatalog,
          selectedEvidenceCatalog: ordinaryOffers,
        }),
      'recovery_ordinary_evidence_coverage_budget_exceeded',
    );

    expect(recoveryUnitCount + ordinaryOffers.length).toBe(
      CURRICULUM_CAPABILITY_RECOVERY_MAX_EVIDENCE_TOTAL + 1,
    );
    expect(error.details).toMatchObject({
      evidenceLimit: CURRICULUM_CAPABILITY_RECOVERY_MAX_EVIDENCE_TOTAL,
    });
  });

  it('allocates by complete region block membership when allowed evidence is absent from the capped sample', () => {
    const fixture = recoveryFixture();
    fixture.predecessor.nodes[1]!.sourceReferences = [
      fixture.predecessor.nodes[1]!.sourceReferences[1]!,
    ];
    fixture.evidenceCatalog = [fixture.evidenceCatalog[1]!];
    const frontier = buildFrontier(fixture);
    const allocation = oneRegionAllocation(fixture);
    const hiddenBlockId = fixture.blocks[1]!.id;

    expect(allocation.regions[0]!.sourceBlockIds).toContain(hiddenBlockId);
    expect(allocation.regions[0]!.evidence.map((evidence) => evidence.blockId)).not.toContain(
      hiddenBlockId,
    );
    expect(
      allocateCurriculumCapabilityRecoveryFrontier(frontier, allocation, fixture.evidenceCatalog),
    ).toEqual([
      expect.objectContaining({
        capabilityRef: 'recovery_capability_1',
        allowedEvidenceIds: [fixture.evidenceCatalog[0]!.id],
        allowedSourceAllocationRegionIds: [allocation.regions[0]!.id],
      }),
    ]);
  });

  it('rejects a frontier that exceeds the fixed per-region capability capacity', () => {
    const fixture = recoveryFixture(
      Array.from({ length: 5 }, (_, index) => curriculumObjective(`objective_${index + 1}`)),
    );
    const frontier = buildFrontier(fixture);

    expectRecoveryError(
      () =>
        allocateCurriculumCapabilityRecoveryFrontier(
          frontier,
          oneRegionAllocation(fixture),
          fixture.evidenceCatalog,
        ),
      'recovery_capability_region_capacity_exceeded',
    );
  });
});
