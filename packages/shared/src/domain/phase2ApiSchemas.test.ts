import { describe, expect, it } from 'vitest';
import {
  ActiveCourseRouteSchema,
  CourseActionLaunchResultSchema,
  CourseExecutionOverviewSchema,
  CreateLearningContractDraftRequestSchema,
  CurriculumHierarchyViewSchema,
  LearningContractFeasibilitySchema,
  StudyPlanDecisionResponseSchema,
  StudyPlanDraftEditSchema,
  TransitionLearningContractRequestSchema,
} from '../index.js';

const T0 = '2026-01-01T00:00:00.000Z';

const command = {
  commandId: 'cmd_1',
  idempotencyKey: 'idem_1',
  workspaceId: 'ws_1',
  actor: 'learner' as const,
};

const contractFields = {
  intent: 'Prepare for the probability exam',
  targetOutcome: { description: 'Score at least 90', targetScore: 90, credential: null },
  deadline: { at: '2026-01-08T00:00:00.000Z', timeZone: 'Asia/Shanghai' },
  studyBudget: {
    minutesPerDay: 60,
    minutesPerWeek: null,
    preferredSessionMinutes: 30,
    unavailablePeriods: [],
  },
  desiredDepth: 'high_performance' as const,
  courseScope: {
    subjectBoundaries: ['Probability'],
    materials: [
      {
        materialId: 'mat_1',
        materialRoleAssignmentId: 'role_1',
        materialRoleAssignmentVersion: 1,
        role: 'course_material' as const,
        disposition: 'included' as const,
      },
    ],
    includedTopics: [],
    excludedTopics: [],
  },
  learnerSelfReport: null,
  examContext: null,
  riskTolerance: null,
};

const contract = {
  id: 'lc_1',
  workspaceId: 'ws_1',
  version: 1,
  predecessorId: null,
  ...contractFields,
  status: 'active' as const,
  proposedBy: 'learner' as const,
  learnerConfirmedAt: T0,
  createdAt: T0,
};

const manifest = {
  fingerprint: 'manifest_1',
  revisions: [
    {
      materialId: 'mat_1',
      materialRevisionId: 'mrev_1',
      parserVersion: null,
      parserFingerprint: null,
      sourceBlockRevisionIds: ['blk_1@rev_1'],
    },
  ],
};

const objective = {
  id: 'obj_1',
  title: 'Apply Bayes theorem',
  description: 'Solve one-step Bayes problems',
  truthPremiseStatus: 'unverified' as const,
  truthAuthorityRecordIds: [],
};

const curriculum = {
  id: 'cur_1',
  workspaceId: 'ws_1',
  contractVersionId: contract.id,
  version: 1,
  predecessorId: null,
  status: 'accepted' as const,
  executionSourceManifest: manifest,
  nodes: [
    {
      id: 'course_1',
      parentId: null,
      kind: 'course' as const,
      index: 0,
      title: 'Probability',
      sourceReferences: [],
      learningUnit: null,
    },
    {
      id: 'unit_1',
      parentId: 'course_1',
      kind: 'learning_unit' as const,
      index: 0,
      title: 'Bayes theorem',
      sourceReferences: [],
      learningUnit: {
        conceptIds: ['con_1'],
        canonicalConceptIds: [],
        objectives: [objective],
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

const plan = {
  id: 'sp_1',
  workspaceId: 'ws_1',
  contractVersionId: contract.id,
  curriculumVersionId: curriculum.id,
  executionSourceManifestFingerprint: manifest.fingerprint,
  version: 1,
  predecessorId: null,
  proposalTrigger: 'Initial route',
  status: 'accepted' as const,
  rationale: 'Start with the named objective',
  items: [
    {
      id: 'spi_1',
      index: 0,
      phase: 'Foundations',
      kind: 'teach_unit' as const,
      curriculumLearningUnitId: 'unit_1',
      rationale: 'Establish the core relationship',
      estimatedMinutes: 30,
      targetDepth: 'high_performance' as const,
      objectiveIds: ['obj_1'],
      prerequisitePlanItemIds: [],
      completionPolicy: null,
      completionRequirements: [],
    },
  ],
  deferrals: [],
  feasibility: {
    projectedMinutes: 30,
    availableMinutes: 420,
    slackMinutes: 390,
    state: 'feasible' as const,
    assumptions: [],
  },
  paceBaseline: {
    id: 'pace_1',
    policyVersion: 'pace-v1',
    contractVersionId: contract.id,
    studyPlanVersionId: 'sp_1',
    timeZone: 'Asia/Shanghai',
    expectedSessionCadencePerWeek: 7,
    explicitSlackMinutes: 390,
    estimateConfidence: 'medium' as const,
    estimateSource: 'local' as const,
    milestones: [],
  },
  diff: [],
  provider: 'fake',
  providerModel: null,
  learnerAcceptedAt: T0,
  createdAt: T0,
};

const agendaItem = {
  id: 'agi_1',
  index: 0,
  kind: 'learning_unit_teaching' as const,
  origin: 'accepted_plan' as const,
  reason: 'First prerequisite-valid Plan item',
  estimatedMinutes: 30,
  linkedPlanItemId: 'spi_1',
  learningUnitId: 'unit_1',
  priority: 'high' as const,
  state: 'active' as const,
  launch: {
    status: 'launchable' as const,
    capability: 'lesson',
    resourceId: 'con_1',
    reason: null,
  },
  displacedAgendaItemIds: [],
  timeImpactMinutes: 0,
};

const agenda = {
  id: 'agenda_1',
  workspaceId: 'ws_1',
  contractVersionId: contract.id,
  curriculumVersionId: curriculum.id,
  studyPlanVersionId: plan.id,
  executionSourceManifestFingerprint: manifest.fingerprint,
  version: 1,
  status: 'active' as const,
  availableMinutes: 30,
  items: [agendaItem],
  currentItemId: agendaItem.id,
  createdAt: T0,
  updatedAt: T0,
};

const hierarchy = {
  curriculumId: curriculum.id,
  curriculumVersion: 1,
  status: 'accepted' as const,
  rootNodeIds: ['course_1'],
  nodes: [
    {
      id: 'course_1',
      parentId: null,
      childIds: ['unit_1'],
      kind: 'course' as const,
      index: 0,
      depth: 0,
      title: 'Probability',
      breadcrumbTitles: [],
      learningUnit: null,
      sourceReferences: [],
      mappedPlanItemIds: [],
      progressState: null,
    },
    {
      id: 'unit_1',
      parentId: 'course_1',
      childIds: [],
      kind: 'learning_unit' as const,
      index: 0,
      depth: 1,
      title: 'Bayes theorem',
      breadcrumbTitles: ['Probability'],
      learningUnit: curriculum.nodes[1]!.learningUnit,
      sourceReferences: [],
      mappedPlanItemIds: ['spi_1'],
      progressState: 'not_started' as const,
    },
  ],
  synthesisGroups: [],
  validation: curriculum.validation,
  executionSourceManifest: manifest,
};

const activeRoute = { contract, curriculum, studyPlan: plan, agenda, activatedAt: T0 };

describe('Phase 2 command contracts', () => {
  it('keeps Contract scope stable and rejects revision identity at the request boundary', () => {
    const request = {
      command,
      fields: contractFields,
      predecessorContractId: null,
      expectedActiveContractId: null,
    };
    expect(CreateLearningContractDraftRequestSchema.safeParse(request).success).toBe(true);
    expect(
      CreateLearningContractDraftRequestSchema.safeParse({
        ...request,
        fields: {
          ...contractFields,
          courseScope: {
            ...contractFields.courseScope,
            materials: [
              { ...contractFields.courseScope.materials[0], materialRevisionId: 'mrev_1' },
            ],
          },
        },
      }).success,
    ).toBe(false);
  });

  it('requires learner authority for Contract confirmation', () => {
    const request = { command, contractId: 'lc_1', expectedVersion: 1, transition: 'confirm' };
    expect(TransitionLearningContractRequestSchema.safeParse(request).success).toBe(true);
    expect(
      TransitionLearningContractRequestSchema.safeParse({
        ...request,
        command: { ...command, actor: 'local' },
      }).success,
    ).toBe(false);
  });

  it('validates deterministic feasibility arithmetic and honest unknowns', () => {
    const known = {
      state: 'feasible',
      deadlineAt: contractFields.deadline.at,
      availableMinutes: 420,
      projectedMinutes: 300,
      slackMinutes: 120,
      reasonCodes: ['sufficient_slack'],
      assumptions: [],
      policyVersion: 'feasibility-v1',
      computedAt: T0,
    };
    expect(LearningContractFeasibilitySchema.safeParse(known).success).toBe(true);
    expect(
      LearningContractFeasibilitySchema.safeParse({ ...known, slackMinutes: 121 }).success,
    ).toBe(false);
    expect(
      LearningContractFeasibilitySchema.safeParse({
        ...known,
        state: 'unknown',
        projectedMinutes: null,
        slackMinutes: null,
        reasonCodes: ['effort_unknown'],
      }).success,
    ).toBe(true);
  });

  it('uses bounded typed Plan edits and rejects self-reordering', () => {
    expect(
      StudyPlanDraftEditSchema.safeParse({
        kind: 'defer',
        curriculumLearningUnitId: 'unit_1',
        objectiveIds: ['obj_1'],
        reason: 'Deadline tradeoff accepted by learner',
        riskIds: ['risk_1'],
      }).success,
    ).toBe(true);
    expect(
      StudyPlanDraftEditSchema.safeParse({
        kind: 'reorder',
        planItemId: 'spi_1',
        afterPlanItemId: 'spi_1',
      }).success,
    ).toBe(false);
  });
});

describe('Phase 2 read models and atomic route results', () => {
  it('validates the hierarchy index and rejects dangling children', () => {
    expect(CurriculumHierarchyViewSchema.safeParse(hierarchy).success).toBe(true);
    expect(
      CurriculumHierarchyViewSchema.safeParse({
        ...hierarchy,
        nodes: [{ ...hierarchy.nodes[0], childIds: ['unit_missing'] }, hierarchy.nodes[1]],
      }).success,
    ).toBe(false);
  });

  it('requires a compatible active Contract/Curriculum/Plan/Agenda transaction result', () => {
    expect(ActiveCourseRouteSchema.safeParse(activeRoute).success).toBe(true);
    expect(
      ActiveCourseRouteSchema.safeParse({
        ...activeRoute,
        studyPlan: { ...plan, contractVersionId: 'lc_other' },
      }).success,
    ).toBe(false);
    expect(
      StudyPlanDecisionResponseSchema.safeParse({
        decision: 'accepted',
        decidedPlan: plan,
        activeRoute: null,
        retainedRoute: null,
      }).success,
    ).toBe(false);
  });

  it('keeps Course Home active Contract and Plan pointers paired', () => {
    const overview = {
      workspaceId: 'ws_1',
      setupStage: 'route_active',
      executionStatus: 'active',
      courseExecutionVersion: 1,
      activeContract: contract,
      pendingContract: null,
      contractFeasibility: {
        state: 'feasible',
        deadlineAt: contractFields.deadline.at,
        availableMinutes: 420,
        projectedMinutes: 30,
        slackMinutes: 390,
        reasonCodes: ['sufficient_slack'],
        assumptions: [],
        policyVersion: 'feasibility-v1',
        computedAt: T0,
      },
      acceptedCurriculum: curriculum,
      planningCurriculum: curriculum,
      proposedCurriculum: null,
      curriculumHierarchy: hierarchy,
      activeCurriculumHierarchy: hierarchy,
      acceptedStudyPlan: plan,
      proposedStudyPlan: null,
      activeAgenda: agenda,
      formalProgress: {
        planItemCount: 1,
        completedPlanItemCount: 0,
        startedPlanItemCount: 0,
        repairNeededPlanItemCount: 0,
        deferredPlanItemCount: 0,
        stateCreditingEvidenceCount: 0,
        advisoryEvidenceCount: 0,
      },
      nextAction: {
        agendaId: agenda.id,
        agendaVersion: 1,
        item: agendaItem,
        whyNext: agendaItem.reason,
      },
      riskSummary: {
        openCount: 0,
        deferredCount: 0,
        staleCount: 0,
        highestOpenSeverity: null,
        deterministicMappingGapCount: 0,
        explicitDeferralCount: 0,
        highlights: [],
        analysisState: 'available',
        computedAt: T0,
      },
      capabilities: {
        canEditContract: false,
        canConfirmContract: false,
        canProposeCurriculum: false,
        canAcceptCurriculum: false,
        canProposeStudyPlan: true,
        canEditStudyPlan: false,
        canAcceptStudyPlan: false,
        canContinueStudy: true,
      },
      contractHistory: [],
      curriculumHistory: [],
      studyPlanHistory: [],
      generatedAt: T0,
    };
    expect(CourseExecutionOverviewSchema.safeParse(overview).success).toBe(true);
    expect(
      CourseExecutionOverviewSchema.safeParse({ ...overview, acceptedStudyPlan: null }).success,
    ).toBe(false);
    expect(
      CourseExecutionOverviewSchema.safeParse({
        ...overview,
        planningCurriculum: { ...curriculum, contractVersionId: 'lc_other' },
      }).success,
    ).toBe(false);
    expect(
      CourseExecutionOverviewSchema.safeParse({
        ...overview,
        acceptedCurriculum: { ...curriculum, id: 'curriculum_other' },
      }).success,
    ).toBe(false);
  });

  it('returns explicit blocked launch state instead of a dead or fabricated action', () => {
    expect(
      CourseActionLaunchResultSchema.safeParse({
        kind: 'blocked',
        agendaItemId: 'agi_1',
        reason: 'Exact source manifest changed; Agenda recomposition is required.',
        stale: true,
        recomposedAgenda: null,
      }).success,
    ).toBe(true);
    expect(
      CourseActionLaunchResultSchema.safeParse({
        kind: 'completed_from_tutor_message',
        agendaItemId: 'agi_1',
      }).success,
    ).toBe(false);
  });
});
