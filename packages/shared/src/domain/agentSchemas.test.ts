import { describe, expect, it } from 'vitest';
import {
  ContractCourseScopeSchema,
  ContractMaterialScopeSchema,
  CoverageRiskEntrySchema,
  CurriculumObjectiveSchema,
  EvidenceAdmissibilityTierSchema,
  LearningContractSchema,
  MaterialRevisionSchema,
  MaterialRoleAssignmentSchema,
  MonetaryCostPolicyConfigurationSchema,
  ModelUsageRecordSchema,
  PlanCompletionRequirementSchema,
  SessionAgendaStatusSchema,
  StudyExchangeSchema,
  StudyPlanSchema,
  StudyPlanStatusSchema,
  SourceAuthorityBundleSchema,
  isStateCreditingAdmissibility,
} from '../index.js';

const T0 = '2026-01-01T00:00:00.000Z';

const stableMaterialScope = {
  materialId: 'mat_1',
  materialRoleAssignmentId: 'mra_1',
  materialRoleAssignmentVersion: 1,
  role: 'course_material' as const,
  disposition: 'included' as const,
};

describe('stable Learning Contract scope', () => {
  it('accepts stable logical Material and role-assignment identity', () => {
    expect(ContractMaterialScopeSchema.parse(stableMaterialScope)).toEqual(stableMaterialScope);
  });

  it('rejects MaterialRevision and extraction identity in Contract scope', () => {
    expect(
      ContractMaterialScopeSchema.safeParse({
        ...stableMaterialScope,
        materialRevisionId: 'mrev_2',
      }).success,
    ).toBe(false);
    expect(
      ContractCourseScopeSchema.safeParse({
        subjectBoundaries: ['Probability'],
        materials: [stableMaterialScope],
        includedTopics: [],
        excludedTopics: [],
        executionSourceManifestFingerprint: 'manifest_1',
      }).success,
    ).toBe(false);
  });

  it('requires learner confirmation before a Contract can be active', () => {
    const contract = {
      id: 'lc_1',
      workspaceId: 'ws_1',
      version: 1,
      predecessorId: null,
      intent: 'Pass the probability exam',
      targetOutcome: { description: 'Pass', targetScore: 90, credential: null },
      deadline: null,
      studyBudget: {
        minutesPerDay: 60,
        minutesPerWeek: null,
        preferredSessionMinutes: 30,
        unavailablePeriods: [],
      },
      desiredDepth: 'high_performance',
      courseScope: {
        subjectBoundaries: ['Probability'],
        materials: [stableMaterialScope],
        includedTopics: [],
        excludedTopics: [],
      },
      learnerSelfReport: null,
      examContext: null,
      riskTolerance: null,
      status: 'active',
      proposedBy: 'model',
      learnerConfirmedAt: null,
      createdAt: T0,
    };
    expect(LearningContractSchema.safeParse(contract).success).toBe(false);
    expect(LearningContractSchema.safeParse({ ...contract, learnerConfirmedAt: T0 }).success).toBe(
      true,
    );
  });
});

describe('Material lineage and role assignment', () => {
  it('keeps role confirmation independent from parser revisions', () => {
    expect(
      MaterialRoleAssignmentSchema.safeParse({
        id: 'mra_1',
        materialId: 'mat_1',
        version: 1,
        predecessorId: null,
        role: 'past_exam',
        status: 'learner_confirmed',
        proposedBy: 'local',
        learnerConfirmedAt: T0,
        createdAt: T0,
      }).success,
    ).toBe(true);
  });

  it('permits honest unknown parser metadata on a migrated active revision', () => {
    expect(
      MaterialRevisionSchema.safeParse({
        id: 'mrev_1',
        materialId: 'mat_1',
        revision: 1,
        predecessorRevisionId: null,
        status: 'active',
        sourceType: 'txt',
        mediaType: 'text/plain',
        originalFilename: null,
        normalizedContent: 'Legacy source',
        charCount: 13,
        parseStatus: 'parsed',
        pageCount: null,
        extractionWarnings: [],
        parserVersion: null,
        parserFingerprint: null,
        sourceFingerprint: null,
        originalAssetFingerprint: null,
        createdAt: T0,
        activatedAt: T0,
        retiredAt: null,
        failureCode: null,
        failureMessage: null,
      }).success,
    ).toBe(true);
  });
});

describe('scope authority and truth authority separation', () => {
  it('matches the persisted authority bundle and excludes learner scope actors', () => {
    const record = {
      id: 'auth_1',
      workspaceId: 'ws_1',
      logicalSourceId: 'mat_1',
      materialId: 'mat_1',
      materialRevisionId: 'mrev_1',
      version: 1,
      predecessorId: null,
      premiseScope: 'Conditional probability definition',
      policyBasis: {
        policyVersion: 'truth-v1',
        premiseKind: 'definition',
        basis: 'Exact accepted source passage and local validation',
      },
      validationState: 'validated',
      conflictState: 'none',
      actor: 'local_validator',
      createdAt: T0,
      updatedAt: T0,
    };
    const bundle = {
      record,
      claims: [
        {
          id: 'claim_1',
          authorityRecordId: record.id,
          sourceBlockId: 'blk_1',
          claim: 'Definition of conditional probability',
          quote: 'P(A|B) is conditional probability.',
          startOffset: 0,
          endOffset: 34,
          occurrenceCount: 1,
          createdAt: T0,
        },
      ],
      events: [
        {
          id: 'event_1',
          authorityRecordId: record.id,
          seq: 1,
          eventType: 'validated',
          actor: 'operator',
          payload: {},
          createdAt: T0,
        },
      ],
    };
    expect(SourceAuthorityBundleSchema.safeParse(bundle).success).toBe(true);
    expect(
      SourceAuthorityBundleSchema.safeParse({
        ...bundle,
        record: { ...record, actor: 'learner_source_selection' },
      }).success,
    ).toBe(false);
    expect(
      SourceAuthorityBundleSchema.safeParse({
        ...bundle,
        events: [{ ...bundle.events[0], actor: 'learner' }],
      }).success,
    ).toBe(false);
    expect(
      SourceAuthorityBundleSchema.safeParse({
        ...bundle,
        record: { ...record, conflictState: 'unresolved' },
      }).success,
    ).toBe(false);
  });

  it('does not let Curriculum label an objective verified without authority records', () => {
    const objective = {
      id: 'obj_1',
      title: 'Apply Bayes theorem',
      description: 'Solve one-step Bayes problems',
      truthPremiseStatus: 'independently_verified',
      truthAuthorityRecordIds: [],
    };
    expect(CurriculumObjectiveSchema.safeParse(objective).success).toBe(false);
    expect(
      CurriculumObjectiveSchema.safeParse({
        ...objective,
        truthPremiseStatus: 'unverified',
      }).success,
    ).toBe(true);
  });

  it('rejects model candidates that claim truth without independent authority', () => {
    const risk = {
      id: 'risk_1',
      workspaceId: 'ws_1',
      contractVersionId: 'lc_1',
      stableScopeFingerprint: 'scope_fp_1',
      materialId: 'mat_1',
      topicId: 'topic_1',
      objectiveId: null,
      facets: ['ai_suggested_supplement'],
      scopeAuthorityStatus: 'in_scope',
      truthPremiseStatus: 'independently_verified',
      truthAuthorityRecordIds: [],
      referencedCurriculumNodeIds: [],
      referencedConceptIds: [],
      referencedEvidenceIds: [],
      origin: 'model_candidate',
      status: 'planned',
      severity: 'medium',
      priority: 50,
      contractSensitive: true,
      claim: 'A possible supplementary topic',
      uncertainty: 'Not established by supplied material',
      observations: [],
      resolutionEvidenceIds: [],
      learnerDecisionId: 'decision_1',
      provider: 'fake',
      providerModel: null,
      promptVersion: 'risk-v1',
      firstObservedAt: T0,
      updatedAt: T0,
    };
    expect(CoverageRiskEntrySchema.safeParse(risk).success).toBe(false);
    expect(
      CoverageRiskEntrySchema.safeParse({
        ...risk,
        truthPremiseStatus: 'unverified',
        truthAuthorityRecordIds: [],
      }).success,
    ).toBe(true);
  });
});

describe('Plan, execution, and evidence boundaries', () => {
  it('has no paused StudyPlan status while Agenda supports execution pause', () => {
    expect(StudyPlanStatusSchema.safeParse('paused').success).toBe(false);
    expect(SessionAgendaStatusSchema.safeParse('paused').success).toBe(true);
  });

  it('never permits tier-3 advisory evidence to block completion', () => {
    expect(
      PlanCompletionRequirementSchema.safeParse({
        id: 'req_1',
        objectiveIds: ['obj_1'],
        description: 'Pass a model-only probe',
        blocking: true,
        admissibilityTier: 'tier_3_advisory',
      }).success,
    ).toBe(false);
    expect(isStateCreditingAdmissibility('tier_3_advisory')).toBe(false);
    expect(isStateCreditingAdmissibility('tier_1_authorized_truth')).toBe(true);
    expect(EvidenceAdmissibilityTierSchema.options).toHaveLength(3);
  });

  it('requires learner acceptance and PaceBaseline for an accepted StudyPlan', () => {
    const plan = {
      id: 'sp_1',
      workspaceId: 'ws_1',
      contractVersionId: 'lc_1',
      curriculumVersionId: 'cur_1',
      executionSourceManifestFingerprint: 'manifest_1',
      version: 1,
      predecessorId: null,
      proposalTrigger: 'initial route',
      status: 'accepted',
      rationale: 'Prerequisites first',
      items: [
        {
          id: 'spi_1',
          index: 0,
          phase: 'Foundations',
          kind: 'teach_unit',
          curriculumLearningUnitId: 'unit_1',
          rationale: 'First prerequisite',
          estimatedMinutes: 30,
          targetDepth: 'working_fluency',
          objectiveIds: ['obj_1'],
          prerequisitePlanItemIds: [],
          completionPolicy: null,
          completionRequirements: [],
        },
      ],
      deferrals: [],
      feasibility: {
        projectedMinutes: 30,
        availableMinutes: 60,
        slackMinutes: 30,
        state: 'feasible',
        assumptions: [],
      },
      paceBaseline: null,
      diff: [],
      provider: 'fake',
      providerModel: null,
      learnerAcceptedAt: null,
      createdAt: T0,
    };
    expect(StudyPlanSchema.safeParse(plan).success).toBe(false);
  });

  it('keeps transcript exchanges non-formal and rejects embedded completion claims', () => {
    const exchange = {
      id: 'ex_1',
      sessionId: 'ss_1',
      turnId: 'turn_1',
      seq: 1,
      role: 'tutor',
      content: 'That explanation is correct.',
      channel: 'conversation',
      createdAt: T0,
    };
    expect(StudyExchangeSchema.safeParse(exchange).success).toBe(true);
    expect(
      StudyExchangeSchema.safeParse({ ...exchange, completedLearningUnitId: 'unit_1' }).success,
    ).toBe(false);
  });
});

describe('cost semantics', () => {
  it('represents no configured monetary cap explicitly without a default cap', () => {
    expect(MonetaryCostPolicyConfigurationSchema.parse({ policy: null })).toEqual({
      policy: null,
    });
  });

  it('represents unknown cost as null rather than zero', () => {
    expect(
      ModelUsageRecordSchema.safeParse({
        id: 'usage_1',
        attemptId: 'attempt_1',
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        estimatedCostMicrounits: null,
        currency: null,
        pricingSource: null,
        pricingVersion: null,
        recordedAt: T0,
      }).success,
    ).toBe(true);
  });
});
