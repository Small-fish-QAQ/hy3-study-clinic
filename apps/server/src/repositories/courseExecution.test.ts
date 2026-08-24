import { beforeEach, describe, expect, it } from 'vitest';
import {
  FormalEvidenceRecordSchema,
  FormalQuestionContractSchema,
  GoalOutcomeSchema,
  LearningContractSchema,
  StudyPlanSchema,
  type CoverageRiskEntry,
  type Curriculum,
  type LearningContract,
  type LearningContractFeasibility,
  type SessionAgenda,
  type StudyPlan,
} from '@hy3-clinic/shared';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import {
  makeBlock,
  makeMaterial,
  makeQuestion,
  makeQuiz,
  makeSemanticallySupportedObjective,
  makeWorkspace,
  T0,
} from '../testing/fixtures.js';
import { createRepositories, type Repositories } from './index.js';
import type { CourseExecutionState } from './courseExecution.js';

const T1 = '2026-01-01T00:01:00.000Z';
const T2 = '2026-01-01T00:02:00.000Z';
const T3 = '2026-01-01T00:03:00.000Z';
const T4 = '2026-01-01T00:04:00.000Z';

let db: SqliteDb;
let repos: Repositories;
let revisionId: string;
let roleAssignmentId: string;
let authorityId: string;

interface RoutePredecessors {
  state: CourseExecutionState;
  contractId: string | null;
  curriculumId: string | null;
  planId: string | null;
}

interface StagedRoute {
  contract: LearningContract;
  curriculum: Curriculum;
  plan: StudyPlan;
  agenda: SessionAgenda;
}

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  repos = createRepositories(db);
  repos.workspaces.insert(makeWorkspace());
  repos.materials.insertWithBlocks(makeMaterial(), [makeBlock()]);
  revisionId = repos.materialRevisions.getActive('mat_1')!.id;

  const legacyRole = repos.materialRoles.getCurrent('mat_1')!;
  const proposedRole = repos.materialRoles.createVersion({
    id: 'role_course',
    materialId: 'mat_1',
    version: 2,
    predecessorId: legacyRole.id,
    role: 'course_material',
    status: 'proposed',
    proposedBy: 'learner',
    learnerConfirmedAt: null,
    createdAt: T0,
  });
  roleAssignmentId = repos.materialRoles.confirm(proposedRole.id, T1).id;

  authorityId = 'authority_1';
  const block = repos.materials.getBlock('blk_1')!;
  repos.sourceAuthority.createVersion({
    id: authorityId,
    workspaceId: 'ws_1',
    logicalSourceId: 'logical_truth_1',
    materialId: 'mat_1',
    materialRevisionId: revisionId,
    predecessorId: null,
    premiseScope: 'working-memory-capacity',
    policyBasis: {
      policyVersion: 'truth-v1',
      premiseKind: 'claim',
      basis: 'exact-source',
    },
    validationState: 'validated',
    conflictState: 'none',
    actor: 'local_validator',
    createdAt: T0,
    updatedAt: T0,
    claims: [
      {
        id: 'claim_1',
        sourceBlockId: block.id,
        claim: 'Working memory has limited capacity.',
        quote: block.content,
        startOffset: 0,
        endOffset: block.content.length,
        occurrenceCount: 1,
        createdAt: T0,
      },
    ],
    event: {
      id: 'authority_event_1',
      eventType: 'validated',
      actor: 'local_validator',
      payload: {},
      createdAt: T0,
    },
  });
});

function routePredecessors(): RoutePredecessors {
  const state = repos.courseExecution.get('ws_1');
  return {
    state,
    contractId: state.activeContractId,
    curriculumId: state.activeCurriculumId,
    planId: state.acceptedPlanId,
  };
}

function stageRoute(
  suffix: string,
  version: number,
  predecessors: RoutePredecessors,
  options: { omitSecondObjective?: boolean; deferSecondObjective?: boolean } = {},
): StagedRoute {
  const contractId = `contract_${suffix}`;
  const curriculumId = `curriculum_${suffix}`;
  const planId = `plan_${suffix}`;
  const agendaId = `agenda_${suffix}`;
  const unitId = `unit_${suffix}`;
  const objectiveOne = `objective_${suffix}_1`;
  const objectiveTwo = `objective_${suffix}_2`;
  const manifestFingerprint = `manifest-${suffix}`;

  const contract: LearningContract = {
    id: contractId,
    workspaceId: 'ws_1',
    version,
    predecessorId: predecessors.contractId,
    intent: `Learn route ${suffix}`,
    targetOutcome: { description: 'Working fluency', targetScore: 90, credential: null },
    deadline: null,
    studyBudget: {
      minutesPerDay: 60,
      minutesPerWeek: null,
      preferredSessionMinutes: 30,
      unavailablePeriods: [],
    },
    desiredDepth: 'working_fluency',
    courseScope: {
      subjectBoundaries: ['Memory'],
      materials: [
        {
          materialId: 'mat_1',
          materialRoleAssignmentId: roleAssignmentId,
          materialRoleAssignmentVersion: 2,
          role: 'course_material',
          disposition: 'included',
        },
      ],
      includedTopics: [],
      excludedTopics: [],
    },
    learnerSelfReport: null,
    examContext: null,
    riskTolerance: {
      description: null,
      allowExplicitDeferral: true,
      maximumUnresolvedPriority: 'high',
    },
    status: 'draft',
    proposedBy: 'learner',
    learnerConfirmedAt: null,
    createdAt: T0,
  };
  const feasibility: LearningContractFeasibility = {
    state: 'unknown',
    deadlineAt: null,
    availableMinutes: null,
    projectedMinutes: 30,
    slackMinutes: null,
    reasonCodes: ['deadline_absent'],
    assumptions: ['No deadline supplied.'],
    policyVersion: 'feasibility-v1',
    computedAt: T0,
  };
  repos.learningContracts.createVersion(contract, feasibility, {
    id: `contract_created_${suffix}`,
    eventType: 'created',
    actor: 'learner',
    payload: {},
    createdAt: T0,
  });
  repos.learningContracts.transition(contractId, 'draft', 'proposed', T1, {
    id: `contract_proposed_${suffix}`,
    eventType: 'proposed',
    actor: 'learner',
    payload: {},
    createdAt: T1,
  });
  const confirmedContract = repos.learningContracts.transition(
    contractId,
    'proposed',
    'learner_confirmed',
    T2,
    {
      id: `contract_confirmed_${suffix}`,
      eventType: 'learner_confirmed',
      actor: 'learner',
      payload: {},
      createdAt: T2,
    },
  );

  const manifest = {
    fingerprint: manifestFingerprint,
    revisions: [
      {
        materialId: 'mat_1',
        materialRevisionId: revisionId,
        parserVersion: 'text-v1',
        parserFingerprint: null,
        sourceBlockRevisionIds: ['blk_1'],
      },
    ],
  };
  repos.curricula.createManifest(`manifest_${suffix}`, 'ws_1', manifest, T0);
  const objectives = [
    makeSemanticallySupportedObjective(
      {
        id: objectiveOne,
        title: 'Explain capacity',
        description:
          'Explain the source-stated relationship that working-memory capacity is limited.',
        truthPremiseStatus: 'independently_verified' as const,
        truthAuthorityRecordIds: [authorityId],
        authorityClaimIds: ['claim_1'],
        priority: 'required',
        formalAssessmentReady: true,
        formalAssessmentReadinessRationale: 'The exact source states the capacity relationship.',
        formalAssessmentConstruct: 'explain',
        authorityEnvelopeTier: 'formal_sufficient',
        authoritySourceBlockIds: ['blk_1'],
        formalEvidenceSourceBlockIds: ['blk_1'],
      },
      'relationship',
    ),
    makeSemanticallySupportedObjective(
      {
        id: objectiveTwo,
        title: 'Identify capacity',
        description: 'Identify the source-stated limit on working-memory capacity.',
        truthPremiseStatus: 'independently_verified' as const,
        truthAuthorityRecordIds: [authorityId],
        authorityClaimIds: ['claim_1'],
        priority: 'normal',
        formalAssessmentReady: true,
        formalAssessmentReadinessRationale: 'The exact source states the capacity limit.',
        formalAssessmentConstruct: 'identify',
        authorityEnvelopeTier: 'formal_sufficient',
        authoritySourceBlockIds: ['blk_1'],
        formalEvidenceSourceBlockIds: ['blk_1'],
      },
      'recognition',
    ),
  ];
  const curriculum: Curriculum = {
    id: curriculumId,
    workspaceId: 'ws_1',
    contractVersionId: contractId,
    version,
    predecessorId: predecessors.curriculumId,
    status: 'proposed',
    executionSourceManifest: manifest,
    nodes: [
      {
        id: `root_${suffix}`,
        parentId: null,
        kind: 'course',
        index: 0,
        title: 'Memory course',
        sourceReferences: [],
        learningUnit: null,
      },
      {
        id: unitId,
        parentId: `root_${suffix}`,
        kind: 'learning_unit',
        index: 0,
        title: 'Working-memory capacity',
        sourceReferences: [
          {
            materialId: 'mat_1',
            materialRevisionId: revisionId,
            structuralUnitId: null,
            sourceBlockId: 'blk_1',
            sourceBlockRevisionFingerprint: 'block-fingerprint-1',
          },
        ],
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
    validation: { valid: true, errors: [], warnings: [], unmappedStructuralUnitIds: [] },
    provider: 'fake',
    providerModel: null,
    createdAt: T0,
    acceptedAt: null,
  };
  repos.curricula.createVersion(
    curriculum,
    {
      id: `curriculum_created_${suffix}`,
      eventType: 'proposed',
      actor: 'local',
      payload: {},
      createdAt: T0,
    },
    { capabilityRecoveryPredecessorId: null },
  );
  const acceptedCurriculum = repos.curricula.accept(curriculumId, T2, {
    id: `curriculum_accepted_${suffix}`,
    eventType: 'accepted',
    actor: 'learner',
    payload: {},
    createdAt: T2,
  });

  let deferrals: StudyPlan['deferrals'] = [];
  if (options.deferSecondObjective) {
    const risk: CoverageRiskEntry = {
      id: `risk_${suffix}`,
      workspaceId: 'ws_1',
      contractVersionId: contractId,
      stableScopeFingerprint: `scope-${suffix}`,
      materialId: 'mat_1',
      topicId: null,
      objectiveId: objectiveTwo,
      facets: ['intentionally_deferred'],
      scopeAuthorityStatus: 'in_scope',
      truthPremiseStatus: 'independently_verified',
      truthAuthorityRecordIds: [authorityId],
      referencedCurriculumNodeIds: [unitId],
      referencedConceptIds: [],
      referencedEvidenceIds: [],
      origin: 'deterministic',
      status: 'deferred',
      severity: 'medium',
      priority: 50,
      contractSensitive: true,
      claim: 'A known objective is explicitly deferred.',
      uncertainty: 'The accepted route will retain this visible gap.',
      observations: [
        {
          id: `risk_observation_${suffix}`,
          materialRevisionId: revisionId,
          sourceBlockId: 'blk_1',
          sourceBlockRevisionFingerprint: 'block-fingerprint-1',
          executionSourceManifestFingerprint: manifestFingerprint,
          reconciliationStatus: 'current',
          observedAt: T2,
          lastVerifiedAt: T2,
        },
      ],
      resolutionEvidenceIds: [],
      learnerDecisionId: `decision_${suffix}`,
      provider: null,
      providerModel: null,
      promptVersion: null,
      firstObservedAt: T2,
      updatedAt: T2,
    };
    repos.coverageRisks.create(risk, {
      id: `risk_created_${suffix}`,
      eventType: 'explicit_deferral_recorded',
      actor: 'learner',
      payload: {},
      createdAt: T2,
    });
    deferrals = [
      {
        curriculumLearningUnitId: unitId,
        objectiveIds: [objectiveTwo],
        reason: 'Learner explicitly deferred this objective.',
        riskIds: [risk.id],
      },
    ];
  }

  const routedObjectives =
    options.omitSecondObjective || options.deferSecondObjective
      ? [objectiveOne]
      : [objectiveOne, objectiveTwo];
  const plan: StudyPlan = {
    id: planId,
    workspaceId: 'ws_1',
    contractVersionId: contractId,
    curriculumVersionId: curriculumId,
    executionSourceManifestFingerprint: manifestFingerprint,
    version,
    predecessorId: predecessors.planId,
    proposalTrigger: 'Initial accepted route',
    status: 'proposed',
    rationale: 'Follow the accepted Curriculum in source order.',
    items: [
      {
        id: `plan_item_${suffix}`,
        index: 0,
        phase: 'Foundations',
        kind: 'teach_unit',
        curriculumLearningUnitId: unitId,
        rationale: 'This is the first prerequisite-valid unit.',
        estimatedMinutes: 30,
        targetDepth: 'working_fluency',
        objectiveIds: routedObjectives,
        prerequisitePlanItemIds: [],
        completionPolicy: { id: 'completion-policy', version: 1 },
        completionRequirements: routedObjectives.map((objectiveId) => ({
          id: `requirement_${objectiveId}`,
          objectiveIds: [objectiveId],
          description: `Formally verify ${objectiveId}`,
          blocking: true,
          admissibilityTier: 'tier_1_authorized_truth',
        })),
      },
    ],
    deferrals,
    feasibility: {
      projectedMinutes: 30,
      availableMinutes: null,
      slackMinutes: null,
      state: 'unknown',
      assumptions: ['No deadline supplied.'],
    },
    paceBaseline: {
      id: `pace_${suffix}`,
      policyVersion: 'pace-v1',
      contractVersionId: contractId,
      studyPlanVersionId: planId,
      timeZone: 'Asia/Shanghai',
      expectedSessionCadencePerWeek: 3,
      explicitSlackMinutes: 0,
      estimateConfidence: 'medium',
      estimateSource: 'local',
      milestones: [],
    },
    diff: [],
    provider: 'fake',
    providerModel: null,
    learnerAcceptedAt: null,
    createdAt: T0,
  };
  repos.studyPlans.createVersion(
    plan,
    [
      {
        planItemId: plan.items[0]!.id,
        launch: {
          status: 'launchable',
          capability: 'study_session',
          resourceId: unitId,
          reason: null,
        },
        sourceFingerprint: manifestFingerprint,
        validatedAt: T2,
      },
    ],
    {
      id: `plan_created_${suffix}`,
      eventType: 'proposed',
      actor: 'local',
      payload: {},
      createdAt: T2,
    },
  );

  const agenda: SessionAgenda = {
    id: agendaId,
    workspaceId: 'ws_1',
    contractVersionId: contractId,
    curriculumVersionId: curriculumId,
    studyPlanVersionId: planId,
    executionSourceManifestFingerprint: manifestFingerprint,
    version,
    status: 'draft',
    availableMinutes: 30,
    items: [
      {
        id: `agenda_item_${suffix}`,
        index: 0,
        kind: 'learning_unit_teaching',
        origin: 'accepted_plan',
        reason: 'First prerequisite-valid accepted Plan item.',
        estimatedMinutes: 30,
        linkedPlanItemId: plan.items[0]!.id,
        learningUnitId: unitId,
        priority: 'high',
        state: 'queued',
        launch: {
          status: 'launchable',
          capability: 'study_session',
          resourceId: unitId,
          reason: null,
        },
        displacedAgendaItemIds: [],
        timeImpactMinutes: 0,
      },
    ],
    currentItemId: null,
    createdAt: T2,
    updatedAt: T2,
  };
  repos.sessionAgendas.create(agenda, {
    id: `agenda_created_${suffix}`,
    eventType: 'composed',
    actor: 'local',
    payload: {},
    createdAt: T2,
  });
  return {
    contract: confirmedContract,
    curriculum: acceptedCurriculum,
    plan,
    agenda,
  };
}

function activate(
  route: StagedRoute,
  predecessors: RoutePredecessors,
  beforePointerSwap?: () => void,
) {
  return repos.courseExecution.activateRoute({
    workspaceId: 'ws_1',
    contractId: route.contract.id,
    curriculumId: route.curriculum.id,
    planId: route.plan.id,
    agendaId: route.agenda.id,
    expectedStateVersion: predecessors.state.version,
    expectedActiveContractId: predecessors.state.activeContractId,
    expectedActiveCurriculumId: predecessors.state.activeCurriculumId,
    expectedAcceptedPlanId: predecessors.state.acceptedPlanId,
    expectedActiveAgendaId: predecessors.state.activeAgendaId,
    eventId: `route_activated_${route.plan.id}`,
    actor: 'learner',
    acceptedAt: T3,
    beforePointerSwap,
  });
}

function turnContextManifest(route: StagedRoute, studySessionVersion = 1) {
  return {
    fingerprint: `turn-context-${route.plan.id}`,
    contractScopeFingerprint: `turn-scope-${route.contract.id}`,
    contractVersionId: route.contract.id,
    curriculumVersionId: route.curriculum.id,
    studyPlanVersionId: route.plan.id,
    sessionAgendaVersionId: `${route.agenda.id}:v${route.agenda.version}`,
    studySessionVersion,
    executionSourceManifestFingerprint: route.plan.executionSourceManifestFingerprint,
    transcriptWatermark: 0,
    sourceBlockRevisionIds: ['blk_1'],
    formalEvidenceIds: [],
    riskIds: [],
  };
}

function insertGoalOutcomeSnapshotFixtures(
  predecessor: StagedRoute,
  excludedSuccessor: StagedRoute,
): { formalEvidenceIds: string[]; unresolvedRiskIds: string[] } {
  const quizId = 'quiz_goal_outcome_snapshot';
  const gradingResultId = 'grading_goal_outcome_snapshot';
  const questionSpecs = [
    { suffix: 'z', route: predecessor, evidenceId: 'evidence_outcome_z' },
    { suffix: 'excluded', route: excludedSuccessor, evidenceId: 'evidence_outcome_excluded' },
    { suffix: 'a', route: predecessor, evidenceId: 'evidence_outcome_a' },
  ];
  const questions = questionSpecs.map(({ suffix }, index) =>
    makeQuestion({
      id: `question_goal_outcome_${suffix}`,
      quizId,
      index,
      type: 'short_answer',
      options: undefined,
      correctOptionIds: undefined,
      expectedAnswer: `Grounded answer ${suffix}.`,
      rubric: { keyPoints: [{ text: `Grounded point ${suffix}.`, required: true }] },
    }),
  );
  repos.quizzes.insert(
    makeQuiz({
      id: quizId,
      materialId: null,
      workspaceId: 'ws_1',
      kind: 'adaptive',
      assessmentMode: 'formal_checkpoint',
      questions,
    }),
  );
  repos.submissions.insertSubmission({
    id: 'submission_goal_outcome_snapshot',
    quizId,
    answers: questions.map((question) => ({
      questionId: question.id,
      type: 'short_answer' as const,
      text: question.expectedAnswer!,
    })),
    createdAt: T2,
  });
  repos.submissions.insertGradingResult({
    id: gradingResultId,
    submissionId: 'submission_goal_outcome_snapshot',
    quizId,
    grades: questions.map((question) => ({
      questionId: question.id,
      type: 'short_answer' as const,
      gradedBy: 'model' as const,
      correct: true,
      awardedPoints: 1,
      maxPoints: 1,
      normalizedScore: 1,
      needsReview: false,
    })),
    totalAwarded: questions.length,
    totalPossible: questions.length,
    overallScore: 1,
    createdAt: T2,
  });

  const contracts = repos.formalProgression.insertQuestionContracts(
    questionSpecs.map(({ suffix, route }, index) =>
      FormalQuestionContractSchema.parse({
        id: `formal_goal_outcome_${suffix}`,
        workspaceId: 'ws_1',
        quizId,
        questionId: questions[index]!.id,
        studySessionId: null,
        agendaItemId: route.agenda.items[0]!.id,
        assessmentKind: 'formal_checkpoint',
        primaryObjectiveId: route.plan.items[0]!.objectiveIds[0]!,
        scoredSecondaryObjectiveIds: [],
        curriculumLearningUnitId: route.plan.items[0]!.curriculumLearningUnitId!,
        difficulty: 'medium',
        targetDepth: 'working_fluency',
        representation: 'recognition',
        admissibilityTier: 'tier_3_advisory',
        stableScopeFingerprint: `scope-goal-outcome-${suffix}`,
        contractVersionId: route.contract.id,
        curriculumVersionId: route.curriculum.id,
        studyPlanVersionId: route.plan.id,
        executionSourceManifestFingerprint: route.plan.executionSourceManifestFingerprint,
        provenance: [],
        assessmentPremiseBindings: [],
        limitations: ['Advisory snapshot fixture.'],
        createdAt: T2,
      }),
    ),
  );
  for (const [index, spec] of questionSpecs.entries()) {
    repos.formalProgression.insertEvidence(
      FormalEvidenceRecordSchema.parse({
        id: spec.evidenceId,
        formalQuestionContractId: contracts[index]!.id,
        gradingResultId,
        questionId: questions[index]!.id,
        primaryObjectiveId: spec.route.plan.items[0]!.objectiveIds[0]!,
        curriculumLearningUnitId: spec.route.plan.items[0]!.curriculumLearningUnitId!,
        admissibilityTier: 'tier_3_advisory',
        normalizedScore: 1,
        correct: true,
        needsReview: false,
        stateCreditable: false,
        assessmentPremiseBindingIds: [],
        limitations: ['Advisory only.'],
        createdAt: T2,
      }),
    );
  }

  const makeRisk = (
    route: StagedRoute,
    id: string,
    status: CoverageRiskEntry['status'],
    firstObservedAt: string,
  ): CoverageRiskEntry => ({
    id,
    workspaceId: 'ws_1',
    contractVersionId: route.contract.id,
    stableScopeFingerprint: `scope-${id}`,
    materialId: null,
    topicId: null,
    objectiveId: null,
    facets: ['planning_recommendation'],
    scopeAuthorityStatus: 'in_scope',
    truthPremiseStatus: 'not_applicable',
    truthAuthorityRecordIds: [],
    referencedCurriculumNodeIds: [],
    referencedConceptIds: [],
    referencedEvidenceIds: [],
    origin: 'deterministic',
    status,
    severity: 'low',
    priority: 10,
    contractSensitive: false,
    claim: `Snapshot risk ${id}.`,
    uncertainty: `Snapshot uncertainty ${id}.`,
    observations: [],
    resolutionEvidenceIds: [],
    learnerDecisionId: null,
    provider: null,
    providerModel: null,
    promptVersion: null,
    firstObservedAt,
    updatedAt: T2,
  });
  const risks = [
    makeRisk(predecessor, 'risk_outcome_z', 'open', T2),
    makeRisk(predecessor, 'risk_outcome_resolved', 'resolved', T0),
    makeRisk(excludedSuccessor, 'risk_outcome_excluded', 'open', T0),
    makeRisk(predecessor, 'risk_outcome_a', 'acknowledged', T2),
  ];
  for (const risk of risks) {
    repos.coverageRisks.create(risk, {
      id: `risk_event_${risk.id}`,
      eventType: 'snapshot_fixture_created',
      actor: 'local',
      payload: {},
      createdAt: T2,
    });
  }

  return {
    formalEvidenceIds: ['evidence_outcome_a', 'evidence_outcome_z'],
    unresolvedRiskIds: ['risk_outcome_a', 'risk_outcome_z'],
  };
}

describe('accepted Course execution persistence', () => {
  it('discovers independently eligible source authority by exact block without mutating it', () => {
    const before = db.prepare('SELECT COUNT(*) AS count FROM truth_authority_events').get();

    const matches = repos.sourceAuthority.findEligibleByBlock('ws_1', revisionId, 'blk_1');

    expect(matches.map((match) => match.record.id)).toEqual([authorityId]);
    expect(matches[0]?.claims.map((claim) => claim.sourceBlockId)).toContain('blk_1');
    expect(db.prepare('SELECT COUNT(*) AS count FROM truth_authority_events').get()).toEqual(
      before,
    );
    expect(repos.sourceAuthority.findEligibleByBlock('ws_1', revisionId, 'missing')).toEqual([]);
  });

  it('atomically activates a compatible Contract/Curriculum/Plan/Agenda route', () => {
    const predecessors = routePredecessors();
    const route = stageRoute('one', 1, predecessors);
    const state = activate(route, predecessors);

    expect(state).toMatchObject({
      activeContractId: route.contract.id,
      activeCurriculumId: route.curriculum.id,
      acceptedPlanId: route.plan.id,
      activeAgendaId: route.agenda.id,
      executionStatus: 'active',
      routeValidationStatus: 'valid',
      version: 1,
    });
    expect(repos.learningContracts.get(route.contract.id)?.status).toBe('active');
    expect(repos.studyPlans.get(route.plan.id)?.status).toBe('accepted');
    expect(repos.sessionAgendas.get(route.agenda.id)?.status).toBe('active');
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('keeps mutable Plan progress separate from the immutable accepted snapshot', () => {
    const predecessors = routePredecessors();
    const route = stageRoute('progress', 1, predecessors);
    activate(route, predecessors);
    const acceptedBefore = repos.studyPlans.get(route.plan.id)!;

    repos.studyPlans.updateProgress(
      route.plan.id,
      route.plan.items[0]!.id,
      1,
      'started',
      'progress_event_1',
      'StudySession started.',
      T3,
    );

    expect(repos.studyPlans.get(route.plan.id)).toEqual(acceptedBefore);
    expect(repos.studyPlans.listProgress(route.plan.id)[0]).toMatchObject({
      state: 'started',
      version: 2,
    });
  });

  it('rejects activation when known Curriculum work silently disappears', () => {
    const predecessors = routePredecessors();
    const route = stageRoute('omission', 1, predecessors, { omitSecondObjective: true });

    expect(() => activate(route, predecessors)).toThrow(/disappeared from the proposed route/);
    expect(repos.courseExecution.get('ws_1').activeContractId).toBeNull();
    expect(repos.learningContracts.get(route.contract.id)?.status).toBe('learner_confirmed');
    expect(repos.studyPlans.get(route.plan.id)?.status).toBe('proposed');
  });

  it('allows explicit deferral only when a stable visible risk accounts for it', () => {
    const predecessors = routePredecessors();
    const route = stageRoute('deferred', 1, predecessors, { deferSecondObjective: true });

    expect(activate(route, predecessors).acceptedPlanId).toBe(route.plan.id);
    const risk = repos.coverageRisks.get('risk_deferred');
    expect(risk?.facets).toContain('intentionally_deferred');
    expect(risk?.observations[0]).toMatchObject({
      materialRevisionId: revisionId,
      sourceBlockId: 'blk_1',
    });
  });

  it('rolls back a failed successor handoff and preserves the old executable route', () => {
    const initialPredecessors = routePredecessors();
    const first = stageRoute('first', 1, initialPredecessors);
    const firstState = activate(first, initialPredecessors);
    const predecessorSession = repos.studySessions.create({
      id: 'rollback_predecessor_session',
      workspaceId: 'ws_1',
      contractVersionId: first.contract.id,
      curriculumVersionId: first.curriculum.id,
      studyPlanVersionId: first.plan.id,
      sessionAgendaId: first.agenda.id,
      executionSourceManifestFingerprint: first.plan.executionSourceManifestFingerprint,
      version: 1,
      status: 'paused',
      routeState: 'execution_paused',
      currentAgendaItemId: null,
      routeStack: [],
      transcriptWatermark: 0,
      createdAt: T2,
      updatedAt: T2,
    });
    const rollbackOperation = repos.operations.createOrGet({
      id: 'rollback_predecessor_operation',
      workspaceId: 'ws_1',
      studySessionId: predecessorSession.id,
      commandId: 'rollback_predecessor_operation_command',
      idempotencyKey: 'rollback_predecessor_operation_command',
      logicalOperationId: 'rollback_predecessor_operation_command',
      operationType: 'prepare_teaching_brief',
      expectedFingerprint: 'rollback-predecessor-operation-fingerprint',
      createdAt: T2,
      updatedAt: T2,
    }).operation;
    const rollbackClaim = repos.operations.claim(rollbackOperation.id, 'rollback-worker', T4, T2)!;
    repos.telemetry.insertLogicalCall({
      id: 'rollback_predecessor_logical_call',
      operationId: rollbackOperation.id,
      workspaceId: 'ws_1',
      studySessionId: predecessorSession.id,
      learningUnitId: null,
      assessmentId: null,
      operationType: 'prepare_teaching_brief',
      cacheKey: null,
      cacheStatus: 'not_checked',
      promptFingerprint: null,
      schemaFingerprint: 'rollback-predecessor-v1',
      policyFingerprint: null,
      sourceFingerprint: first.plan.executionSourceManifestFingerprint,
      status: 'open',
      createdAt: T2,
      completedAt: null,
    });
    for (const [id, attemptNumber, status] of [
      ['rollback_predecessor_sent_attempt', 1, 'sent'],
      ['rollback_predecessor_queued_attempt', 2, 'queued'],
    ] as const) {
      repos.telemetry.insertAttempt({
        id,
        logicalCallId: 'rollback_predecessor_logical_call',
        attemptNumber,
        attemptKind: attemptNumber === 1 ? 'original' : 'retry',
        provider: 'fake',
        model: null,
        fencingToken: rollbackClaim.fencingToken,
        status,
        startedAt: T2,
        sentAt: status === 'sent' ? T2 : null,
        firstTokenAt: null,
        completedAt: null,
        latencyMs: null,
        timeToFirstTokenMs: null,
        errorCode: null,
        errorMessage: null,
      });
    }
    repos.studySessions.insertTurn({
      id: 'rollback_predecessor_turn',
      sessionId: predecessorSession.id,
      seq: 0,
      commandId: 'rollback_predecessor_turn_command',
      status: 'running',
      contextManifest: turnContextManifest(first),
      logicalCallId: 'rollback_predecessor_logical_call',
      errorMessage: null,
      createdAt: T2,
      completedAt: null,
    });
    repos.studySessions.insertTurnEvent({
      id: 'rollback_predecessor_turn_started',
      sessionId: predecessorSession.id,
      turnId: 'rollback_predecessor_turn',
      seq: 0,
      kind: 'started',
      provisional: true,
      content: null,
      createdAt: T2,
    });
    const rollbackTurnBefore = repos.studySessions.getTurn('rollback_predecessor_turn')!;
    const rollbackTurnEventsBefore = repos.studySessions.listTurnEvents(
      'rollback_predecessor_turn',
    );
    const rollbackLogicalCallBefore = repos.telemetry.getLogicalCall(
      'rollback_predecessor_logical_call',
    );
    const rollbackSentAttemptBefore = repos.telemetry.getAttempt(
      'rollback_predecessor_sent_attempt',
    );
    const rollbackQueuedAttemptBefore = repos.telemetry.getAttempt(
      'rollback_predecessor_queued_attempt',
    );
    const successorPredecessors = routePredecessors();
    const second = stageRoute('second', 2, successorPredecessors);

    expect(() =>
      activate(second, successorPredecessors, () => {
        throw new Error('injected handoff failure');
      }),
    ).toThrow('injected handoff failure');

    expect(repos.courseExecution.get('ws_1')).toEqual(firstState);
    expect(repos.learningContracts.get(first.contract.id)?.status).toBe('active');
    expect(repos.studyPlans.get(first.plan.id)?.status).toBe('accepted');
    expect(repos.learningContracts.get(second.contract.id)?.status).toBe('learner_confirmed');
    expect(repos.studyPlans.get(second.plan.id)?.status).toBe('proposed');
    expect(repos.studySessions.get(predecessorSession.id)).toEqual(predecessorSession);
    expect(repos.studySessions.getTurn('rollback_predecessor_turn')).toEqual(rollbackTurnBefore);
    expect(repos.studySessions.listTurnEvents('rollback_predecessor_turn')).toEqual(
      rollbackTurnEventsBefore,
    );
    expect(repos.telemetry.getLogicalCall('rollback_predecessor_logical_call')).toEqual(
      rollbackLogicalCallBefore,
    );
    expect(repos.telemetry.getAttempt('rollback_predecessor_sent_attempt')).toEqual(
      rollbackSentAttemptBefore,
    );
    expect(repos.telemetry.getAttempt('rollback_predecessor_queued_attempt')).toEqual(
      rollbackQueuedAttemptBefore,
    );
    expect(repos.operations.get(rollbackOperation.id)).toEqual(rollbackClaim);
    expect(repos.operations.getResult(rollbackOperation.id)).toBeUndefined();
    expect(repos.operations.listEvents(rollbackOperation.id)).toEqual([]);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM goal_outcomes
           WHERE contract_id = ? AND plan_id = ?`,
        )
        .get(first.contract.id, first.plan.id),
    ).toEqual({ count: 0 });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM course_execution_events
           WHERE id = ? AND event_type = 'route_activated'`,
        )
        .get(`route_activated_${second.plan.id}`),
    ).toEqual({ count: 0 });
  });

  it('rolls back the entire successor handoff when the predecessor already has a GoalOutcome', () => {
    const initialPredecessors = routePredecessors();
    const first = stageRoute('outcome_old', 1, initialPredecessors);
    const firstState = activate(first, initialPredecessors);
    repos.workspaces.insert(makeWorkspace({ id: 'ws_other', name: 'Other course' }));
    const existingOutcome = GoalOutcomeSchema.parse({
      id: 'existing_predecessor_outcome',
      workspaceId: 'ws_other',
      contractVersionId: first.contract.id,
      studyPlanVersionId: first.plan.id,
      status: 'abandoned',
      formalEvidenceIds: [],
      unresolvedRiskIds: [],
      reason: 'A predecessor outcome already exists.',
      actor: 'learner',
      createdAt: T2,
    });
    db.prepare(
      `INSERT INTO goal_outcomes
         (id, workspace_id, contract_id, plan_id, status, payload, created_at)
       VALUES (@id, @workspaceId, @contractVersionId, @studyPlanVersionId,
         @status, @payload, @createdAt)`,
    ).run({ ...existingOutcome, payload: JSON.stringify(existingOutcome) });
    const successorPredecessors = routePredecessors();
    const second = stageRoute('outcome_new', 2, successorPredecessors);

    expect(() => activate(second, successorPredecessors)).toThrow(/already has a GoalOutcome/);

    expect(repos.courseExecution.get('ws_1')).toEqual(firstState);
    expect(repos.learningContracts.get(first.contract.id)?.status).toBe('active');
    expect(repos.curricula.get(first.curriculum.id)?.status).toBe('accepted');
    expect(repos.studyPlans.get(first.plan.id)?.status).toBe('accepted');
    expect(repos.sessionAgendas.get(first.agenda.id)?.status).toBe('active');
    expect(repos.learningContracts.get(second.contract.id)?.status).toBe('learner_confirmed');
    expect(repos.curricula.get(second.curriculum.id)?.status).toBe('accepted');
    expect(repos.studyPlans.get(second.plan.id)?.status).toBe('proposed');
    expect(repos.sessionAgendas.get(second.agenda.id)?.status).toBe('draft');
    expect(db.prepare('SELECT COUNT(*) AS count FROM goal_outcomes').get()).toEqual({ count: 1 });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM course_execution_events WHERE event_type = 'route_activated'",
        )
        .get(),
    ).toEqual({ count: 1 });
  });

  it('atomically swaps every pointer on a successful successor activation', () => {
    const initialPredecessors = routePredecessors();
    const first = stageRoute('old', 1, initialPredecessors);
    activate(first, initialPredecessors);
    const successorPredecessors = routePredecessors();
    const second = stageRoute('new', 2, successorPredecessors);
    const expectedOutcomeSnapshot = insertGoalOutcomeSnapshotFixtures(first, second);

    const state = activate(second, successorPredecessors);

    expect(state).toMatchObject({
      activeContractId: second.contract.id,
      activeCurriculumId: second.curriculum.id,
      acceptedPlanId: second.plan.id,
      activeAgendaId: second.agenda.id,
      version: 2,
    });
    expect(repos.learningContracts.get(first.contract.id)?.status).toBe('superseded');
    expect(repos.curricula.get(first.curriculum.id)?.status).toBe('superseded');
    expect(repos.studyPlans.get(first.plan.id)?.status).toBe('superseded');
    expect(repos.sessionAgendas.get(first.agenda.id)?.status).toBe('abandoned');
    const predecessorOutcome = db
      .prepare(
        `SELECT payload FROM goal_outcomes
         WHERE workspace_id = ? AND contract_id = ? AND plan_id = ?`,
      )
      .get('ws_1', first.contract.id, first.plan.id) as { payload: string };
    expect(GoalOutcomeSchema.parse(JSON.parse(predecessorOutcome.payload))).toEqual({
      id: `goal_outcome_route_activated_${second.plan.id}`,
      workspaceId: 'ws_1',
      contractVersionId: first.contract.id,
      studyPlanVersionId: first.plan.id,
      status: 'superseded',
      formalEvidenceIds: expectedOutcomeSnapshot.formalEvidenceIds,
      unresolvedRiskIds: expectedOutcomeSnapshot.unresolvedRiskIds,
      reason: `Superseded by learner-accepted StudyPlan ${second.plan.id}.`,
      actor: 'learner',
      createdAt: T3,
    });
  });

  it('terminally closes and fences predecessor StudySession work during successor activation', () => {
    const initialPredecessors = routePredecessors();
    const first = stageRoute('session_old', 1, initialPredecessors);
    activate(first, initialPredecessors);
    const session = repos.studySessions.create({
      id: 'predecessor_session',
      workspaceId: 'ws_1',
      contractVersionId: first.contract.id,
      curriculumVersionId: first.curriculum.id,
      studyPlanVersionId: first.plan.id,
      sessionAgendaId: first.agenda.id,
      executionSourceManifestFingerprint: first.plan.executionSourceManifestFingerprint,
      version: 1,
      status: 'active',
      routeState: 'on_route',
      currentAgendaItemId: null,
      routeStack: [],
      transcriptWatermark: 0,
      createdAt: T2,
      updatedAt: T2,
    });
    const operation = repos.operations.createOrGet({
      id: 'predecessor_operation',
      workspaceId: 'ws_1',
      commandId: 'predecessor_turn_command',
      idempotencyKey: 'predecessor_turn_command',
      logicalOperationId: 'predecessor_turn_command',
      operationType: 'study_session_turn',
      expectedFingerprint: 'predecessor-turn-fingerprint',
      createdAt: T2,
      updatedAt: T2,
    }).operation;
    const claim = repos.operations.claim(operation.id, 'old-worker', T4, T2)!;
    const queuedOwnedOperations = [
      {
        id: 'queued_lesson_operation',
        operationType: 'prepare_lesson_execution',
      },
      {
        id: 'queued_teaching_operation',
        operationType: 'prepare_teaching_brief',
      },
    ].map(
      ({ id, operationType }) =>
        repos.operations.createOrGet({
          id,
          workspaceId: 'ws_1',
          studySessionId: session.id,
          commandId: `${id}_command`,
          idempotencyKey: `${id}_command`,
          logicalOperationId: `${id}_command`,
          operationType,
          expectedFingerprint: `${id}-fingerprint`,
          createdAt: T2,
          updatedAt: T2,
        }).operation,
    );
    const interruptedOwnedOperation = repos.operations.createOrGet({
      id: 'interrupted_owned_operation',
      workspaceId: 'ws_1',
      studySessionId: session.id,
      commandId: 'interrupted_owned_command',
      idempotencyKey: 'interrupted_owned_command',
      logicalOperationId: 'interrupted_owned_command',
      operationType: 'prepare_lesson_execution',
      expectedFingerprint: 'interrupted-owned-fingerprint',
      createdAt: T2,
      updatedAt: T2,
    }).operation;
    const interruptedClaim = repos.operations.claim(
      interruptedOwnedOperation.id,
      'expired-worker',
      T3,
      T2,
    )!;
    expect(
      repos.operations.recoverExpiredForWorkspace('ws_1', 'prepare_lesson_execution', T3),
    ).toBe(1);
    expect(repos.operations.get(interruptedOwnedOperation.id)).toMatchObject({
      status: 'interrupted',
      leaseOwner: null,
      leaseExpiresAt: null,
      fencingToken: interruptedClaim.fencingToken,
    });
    expect(repos.operations.getResult(interruptedOwnedOperation.id)).toBeUndefined();
    expect(repos.operations.listEvents(interruptedOwnedOperation.id)).toMatchObject([
      {
        fencingToken: interruptedClaim.fencingToken,
        kind: 'operation_interrupted',
        payload: { reason: 'lease_expired' },
      },
    ]);
    const unrelatedOperation = repos.operations.createOrGet({
      id: 'unrelated_queued_operation',
      workspaceId: 'ws_1',
      commandId: 'unrelated_queued_command',
      idempotencyKey: 'unrelated_queued_command',
      logicalOperationId: 'unrelated_queued_command',
      operationType: 'prepare_teaching_brief',
      expectedFingerprint: 'unrelated-queued-fingerprint',
      createdAt: T2,
      updatedAt: T2,
    }).operation;
    repos.telemetry.insertLogicalCall({
      id: 'predecessor_logical_call',
      operationId: operation.id,
      workspaceId: 'ws_1',
      studySessionId: session.id,
      learningUnitId: null,
      assessmentId: null,
      operationType: 'study_session_tutor_turn',
      cacheKey: null,
      cacheStatus: 'not_checked',
      promptFingerprint: null,
      schemaFingerprint: 'tutor-turn-v1',
      policyFingerprint: null,
      sourceFingerprint: first.plan.executionSourceManifestFingerprint,
      status: 'open',
      createdAt: T2,
      completedAt: null,
    });
    repos.telemetry.insertAttempt({
      id: 'predecessor_attempt',
      logicalCallId: 'predecessor_logical_call',
      attemptNumber: 1,
      attemptKind: 'original',
      provider: 'fake',
      model: null,
      fencingToken: claim.fencingToken,
      status: 'sent',
      startedAt: T2,
      sentAt: T2,
      firstTokenAt: null,
      completedAt: null,
      latencyMs: null,
      timeToFirstTokenMs: null,
      errorCode: null,
      errorMessage: null,
    });
    repos.telemetry.insertAttempt({
      id: 'predecessor_queued_attempt',
      logicalCallId: 'predecessor_logical_call',
      attemptNumber: 2,
      attemptKind: 'retry',
      provider: 'fake',
      model: null,
      fencingToken: claim.fencingToken,
      status: 'queued',
      startedAt: T2,
      sentAt: null,
      firstTokenAt: null,
      completedAt: null,
      latencyMs: null,
      timeToFirstTokenMs: null,
      errorCode: null,
      errorMessage: null,
    });
    repos.studySessions.insertTurn({
      id: 'predecessor_turn',
      sessionId: session.id,
      seq: 0,
      commandId: 'predecessor_turn_command',
      status: 'running',
      contextManifest: {
        fingerprint: 'predecessor-context',
        contractScopeFingerprint: 'predecessor-scope',
        contractVersionId: first.contract.id,
        curriculumVersionId: first.curriculum.id,
        studyPlanVersionId: first.plan.id,
        sessionAgendaVersionId: `${first.agenda.id}:v${first.agenda.version}`,
        studySessionVersion: session.version,
        executionSourceManifestFingerprint: first.plan.executionSourceManifestFingerprint,
        transcriptWatermark: 0,
        sourceBlockRevisionIds: ['blk_1'],
        formalEvidenceIds: [],
        riskIds: [],
      },
      logicalCallId: 'predecessor_logical_call',
      errorMessage: null,
      createdAt: T2,
      completedAt: null,
    });
    repos.studySessions.insertExchange({
      id: 'predecessor_exchange',
      sessionId: session.id,
      turnId: 'predecessor_turn',
      seq: 0,
      role: 'learner',
      content: 'Preserve this learner transcript.',
      channel: 'conversation',
      createdAt: T2,
    });
    repos.studySessions.update(
      { ...session, version: 2, transcriptWatermark: 1, updatedAt: T2 },
      session.version,
    );

    const successorPredecessors = routePredecessors();
    const second = stageRoute('session_new', 2, successorPredecessors);
    activate(second, successorPredecessors);

    expect(repos.studySessions.get(session.id)).toMatchObject({
      status: 'abandoned',
      routeState: 'on_route',
      currentAgendaItemId: null,
      version: 3,
      transcriptWatermark: 1,
    });
    expect(repos.studySessions.getTurn('predecessor_turn')).toMatchObject({
      status: 'cancelled',
      errorMessage: expect.stringContaining('route_superseded'),
      completedAt: T3,
    });
    expect(repos.studySessions.listExchanges(session.id)).toMatchObject([
      { id: 'predecessor_exchange', role: 'learner' },
    ]);
    expect(repos.studySessions.listTurnEvents('predecessor_turn')).toMatchObject([
      { kind: 'cancelled', content: 'route_superseded' },
    ]);
    expect(repos.telemetry.getLogicalCall('predecessor_logical_call')).toMatchObject({
      status: 'cancelled',
      completedAt: T3,
    });
    expect(repos.telemetry.getAttempt('predecessor_attempt')).toMatchObject({
      status: 'outcome_unknown',
      errorCode: 'ROUTE_SUPERSEDED',
    });
    expect(repos.telemetry.getAttempt('predecessor_queued_attempt')).toMatchObject({
      status: 'interrupted',
      errorCode: 'ROUTE_SUPERSEDED',
    });
    expect(repos.operations.get(operation.id)).toMatchObject({
      status: 'cancelled',
      leaseOwner: null,
      leaseExpiresAt: null,
      fencingToken: claim.fencingToken,
    });
    expect(repos.operations.getResult(operation.id)).toMatchObject({
      status: 'cancelled',
      payload: { reason: 'route_superseded', successorPlanId: second.plan.id },
    });
    expect(repos.operations.listEvents(operation.id)).toMatchObject([
      { kind: 'operation_interrupted', payload: { reason: 'route_superseded' } },
    ]);
    for (const ownedOperation of queuedOwnedOperations) {
      expect(repos.operations.get(ownedOperation.id)).toMatchObject({
        status: 'cancelled',
        leaseOwner: null,
        leaseExpiresAt: null,
        fencingToken: 1,
      });
      expect(repos.operations.getResult(ownedOperation.id)).toMatchObject({
        fencingToken: 1,
        status: 'cancelled',
        payload: { reason: 'route_superseded', successorPlanId: second.plan.id },
      });
      const interruptionEvents = repos.operations.listEvents(ownedOperation.id);
      expect(interruptionEvents).toHaveLength(1);
      expect(interruptionEvents[0]).toMatchObject({
        fencingToken: 1,
        kind: 'operation_interrupted',
        payload: { reason: 'route_superseded' },
      });
      expect(repos.operations.claim(ownedOperation.id, 'late-worker', T3, T2)).toBeUndefined();
      expect(
        repos.operations.finalize(
          {
            operationId: ownedOperation.id,
            status: 'completed',
            payload: { stale: true },
            createdAt: T3,
          },
          'late-worker',
          1,
        ),
      ).toBe(false);
    }
    expect(repos.operations.get(interruptedOwnedOperation.id)).toMatchObject({
      status: 'cancelled',
      leaseOwner: null,
      leaseExpiresAt: null,
      fencingToken: interruptedClaim.fencingToken,
    });
    expect(repos.operations.getResult(interruptedOwnedOperation.id)).toMatchObject({
      fencingToken: interruptedClaim.fencingToken,
      status: 'cancelled',
      payload: { reason: 'route_superseded', successorPlanId: second.plan.id },
    });
    const interruptedOperationEvents = repos.operations.listEvents(interruptedOwnedOperation.id);
    expect(interruptedOperationEvents).toHaveLength(2);
    expect(interruptedOperationEvents[0]).toMatchObject({
      fencingToken: interruptedClaim.fencingToken,
      kind: 'operation_interrupted',
      payload: { reason: 'lease_expired' },
    });
    expect(interruptedOperationEvents[1]).toMatchObject({
      fencingToken: interruptedClaim.fencingToken,
      kind: 'operation_interrupted',
      payload: { reason: 'route_superseded', successorPlanId: second.plan.id },
    });
    expect(
      repos.operations.finalize(
        {
          operationId: interruptedOwnedOperation.id,
          status: 'completed',
          payload: { stale: true },
          createdAt: T3,
        },
        'expired-worker',
        interruptedClaim.fencingToken,
      ),
    ).toBe(false);
    expect(repos.operations.get(unrelatedOperation.id)).toEqual(unrelatedOperation);
    expect(repos.operations.getResult(unrelatedOperation.id)).toBeUndefined();
    expect(repos.operations.listEvents(unrelatedOperation.id)).toEqual([]);
    expect(
      repos.operations.finalize(
        {
          operationId: operation.id,
          status: 'completed',
          payload: { stale: true },
          createdAt: T3,
        },
        'old-worker',
        claim.fencingToken,
      ),
    ).toBe(false);
    const routeEvent = db
      .prepare(
        `SELECT payload FROM course_execution_events
         WHERE workspace_id = 'ws_1' AND event_type = 'route_activated'
         ORDER BY seq DESC LIMIT 1`,
      )
      .get() as { payload: string };
    expect(JSON.parse(routeEvent.payload)).toMatchObject({
      planId: second.plan.id,
      supersededSessionIds: [session.id],
    });
  });

  it('orders and isolates multiple predecessor Sessions while preserving terminal Turns exactly', () => {
    const initialPredecessors = routePredecessors();
    const first = stageRoute('multi_session_old', 1, initialPredecessors);
    activate(first, initialPredecessors);
    const openSessionSpecs = [
      {
        id: 'predecessor_session_late_b',
        createdAt: T2,
        status: 'paused' as const,
        routeState: 'execution_paused' as const,
      },
      {
        id: 'predecessor_session_early',
        createdAt: T1,
        status: 'active' as const,
        routeState: 'on_route' as const,
      },
      {
        id: 'predecessor_session_late_a',
        createdAt: T2,
        status: 'interrupted' as const,
        routeState: 'on_route' as const,
      },
    ];
    const openSessions = openSessionSpecs.map((spec) =>
      repos.studySessions.create({
        id: spec.id,
        workspaceId: 'ws_1',
        contractVersionId: first.contract.id,
        curriculumVersionId: first.curriculum.id,
        studyPlanVersionId: first.plan.id,
        sessionAgendaId: first.agenda.id,
        executionSourceManifestFingerprint: first.plan.executionSourceManifestFingerprint,
        version: 1,
        status: spec.status,
        routeState: spec.routeState,
        currentAgendaItemId: null,
        routeStack: [],
        transcriptWatermark: spec.id === 'predecessor_session_early' ? 2 : 0,
        createdAt: spec.createdAt,
        updatedAt: spec.createdAt,
      }),
    );
    const completedSession = repos.studySessions.create({
      id: 'predecessor_session_completed_control',
      workspaceId: 'ws_1',
      contractVersionId: first.contract.id,
      curriculumVersionId: first.curriculum.id,
      studyPlanVersionId: first.plan.id,
      sessionAgendaId: first.agenda.id,
      executionSourceManifestFingerprint: first.plan.executionSourceManifestFingerprint,
      version: 4,
      status: 'completed',
      routeState: 'on_route',
      currentAgendaItemId: null,
      routeStack: [],
      transcriptWatermark: 0,
      createdAt: T0,
      updatedAt: T2,
    });
    const abandonedSession = repos.studySessions.create({
      id: 'predecessor_session_abandoned_control',
      workspaceId: 'ws_1',
      contractVersionId: first.contract.id,
      curriculumVersionId: first.curriculum.id,
      studyPlanVersionId: first.plan.id,
      sessionAgendaId: first.agenda.id,
      executionSourceManifestFingerprint: first.plan.executionSourceManifestFingerprint,
      version: 5,
      status: 'abandoned',
      routeState: 'on_route',
      currentAgendaItemId: null,
      routeStack: [],
      transcriptWatermark: 0,
      createdAt: T0,
      updatedAt: T2,
    });

    const terminalTurnSpecs = [
      {
        id: 'terminal_turn_completed',
        sessionId: 'predecessor_session_early',
        status: 'completed' as const,
        errorMessage: null,
        eventKind: 'completed' as const,
        eventContent: null,
      },
      {
        id: 'terminal_turn_failed',
        sessionId: 'predecessor_session_late_a',
        status: 'failed' as const,
        errorMessage: 'Preserve this terminal failure.',
        eventKind: 'failed' as const,
        eventContent: 'preserved_failure',
      },
      {
        id: 'terminal_turn_cancelled',
        sessionId: 'predecessor_session_late_b',
        status: 'cancelled' as const,
        errorMessage: 'Preserve this prior cancellation.',
        eventKind: 'cancelled' as const,
        eventContent: 'prior_cancellation',
      },
    ];
    for (const terminal of terminalTurnSpecs) {
      repos.studySessions.insertTurn({
        id: terminal.id,
        sessionId: terminal.sessionId,
        seq: 0,
        commandId: `${terminal.id}_command`,
        status: terminal.status,
        contextManifest: turnContextManifest(first),
        logicalCallId: null,
        errorMessage: terminal.errorMessage,
        createdAt: T1,
        completedAt: T2,
      });
      repos.studySessions.insertTurnEvent({
        id: `${terminal.id}_event`,
        sessionId: terminal.sessionId,
        turnId: terminal.id,
        seq: 0,
        kind: terminal.eventKind,
        provisional: false,
        content: terminal.eventContent,
        createdAt: T2,
      });
    }
    repos.studySessions.insertExchange({
      id: 'terminal_completed_learner_exchange',
      sessionId: 'predecessor_session_early',
      turnId: 'terminal_turn_completed',
      seq: 0,
      role: 'learner',
      content: 'Preserve this completed learner exchange.',
      channel: 'conversation',
      createdAt: T1,
    });
    repos.studySessions.insertExchange({
      id: 'terminal_completed_tutor_exchange',
      sessionId: 'predecessor_session_early',
      turnId: 'terminal_turn_completed',
      seq: 1,
      role: 'tutor',
      content: 'Preserve this completed Tutor exchange.',
      channel: 'conversation',
      createdAt: T2,
    });
    const terminalSnapshots = terminalTurnSpecs.map((terminal) => ({
      id: terminal.id,
      turn: repos.studySessions.getTurn(terminal.id),
      events: repos.studySessions.listTurnEvents(terminal.id),
    }));
    const completedExchangesBefore = repos.studySessions.listExchanges('predecessor_session_early');

    const openTurnSpecs = [
      {
        id: 'open_turn_running',
        sessionId: 'predecessor_session_early',
        status: 'running' as const,
        eventKind: 'started' as const,
        errorMessage: null,
        completedAt: null,
      },
      {
        id: 'open_turn_queued',
        sessionId: 'predecessor_session_late_a',
        status: 'queued' as const,
        eventKind: 'queued' as const,
        errorMessage: null,
        completedAt: null,
      },
      {
        id: 'open_turn_interrupted',
        sessionId: 'predecessor_session_late_b',
        status: 'interrupted' as const,
        eventKind: 'interrupted' as const,
        errorMessage: 'Prior lease interruption.',
        completedAt: T2,
      },
      {
        id: 'open_turn_completed_session',
        sessionId: completedSession.id,
        status: 'queued' as const,
        eventKind: 'queued' as const,
        errorMessage: null,
        completedAt: null,
      },
      {
        id: 'open_turn_abandoned_session',
        sessionId: abandonedSession.id,
        status: 'running' as const,
        eventKind: 'started' as const,
        errorMessage: null,
        completedAt: null,
      },
    ];
    for (const openTurn of openTurnSpecs) {
      repos.studySessions.insertTurn({
        id: openTurn.id,
        sessionId: openTurn.sessionId,
        seq: 1,
        commandId: `${openTurn.id}_command`,
        status: openTurn.status,
        contextManifest: turnContextManifest(first),
        logicalCallId: null,
        errorMessage: openTurn.errorMessage,
        createdAt: T2,
        completedAt: openTurn.completedAt,
      });
      repos.studySessions.insertTurnEvent({
        id: `${openTurn.id}_event`,
        sessionId: openTurn.sessionId,
        turnId: openTurn.id,
        seq: 0,
        kind: openTurn.eventKind,
        provisional: openTurn.eventKind === 'started',
        content: null,
        createdAt: T2,
      });
    }

    const ownedOperations = openSessions.map(
      (session) =>
        repos.operations.createOrGet({
          id: `operation_${session.id}`,
          workspaceId: 'ws_1',
          studySessionId: session.id,
          commandId: `command_${session.id}`,
          idempotencyKey: `command_${session.id}`,
          logicalOperationId: `command_${session.id}`,
          operationType: 'prepare_teaching_brief',
          expectedFingerprint: `fingerprint-${session.id}`,
          createdAt: T2,
          updatedAt: T2,
        }).operation,
    );
    const completedSessionOperation = repos.operations.createOrGet({
      id: 'operation_completed_session_control',
      workspaceId: 'ws_1',
      studySessionId: completedSession.id,
      commandId: 'command_completed_session_control',
      idempotencyKey: 'command_completed_session_control',
      logicalOperationId: 'command_completed_session_control',
      operationType: 'prepare_teaching_brief',
      expectedFingerprint: 'fingerprint-completed-session-control',
      createdAt: T2,
      updatedAt: T2,
    }).operation;
    const abandonedSessionOperation = repos.operations.createOrGet({
      id: 'operation_abandoned_session_control',
      workspaceId: 'ws_1',
      studySessionId: abandonedSession.id,
      commandId: 'command_abandoned_session_control',
      idempotencyKey: 'command_abandoned_session_control',
      logicalOperationId: 'command_abandoned_session_control',
      operationType: 'prepare_lesson_execution',
      expectedFingerprint: 'fingerprint-abandoned-session-control',
      createdAt: T2,
      updatedAt: T2,
    }).operation;

    const successorPredecessors = routePredecessors();
    const second = stageRoute('multi_session_new', 2, successorPredecessors);
    activate(second, successorPredecessors);

    for (const session of openSessions) {
      expect(repos.studySessions.get(session.id)).toMatchObject({
        status: 'abandoned',
        version: 2,
        transcriptWatermark: session.transcriptWatermark,
      });
    }
    expect(repos.studySessions.get(completedSession.id)).toEqual(completedSession);
    expect(repos.studySessions.get(abandonedSession.id)).toEqual(abandonedSession);
    for (const terminal of terminalSnapshots) {
      expect(repos.studySessions.getTurn(terminal.id)).toEqual(terminal.turn);
      expect(repos.studySessions.listTurnEvents(terminal.id)).toEqual(terminal.events);
    }
    expect(repos.studySessions.listExchanges('predecessor_session_early')).toEqual(
      completedExchangesBefore,
    );
    for (const openTurn of openTurnSpecs) {
      expect(repos.studySessions.getTurn(openTurn.id)).toMatchObject({
        status: 'cancelled',
        errorMessage: expect.stringContaining('route_superseded'),
        completedAt: T3,
      });
      expect(repos.studySessions.listTurnEvents(openTurn.id)).toMatchObject([
        { kind: openTurn.eventKind },
        { kind: 'cancelled', content: 'route_superseded' },
      ]);
    }
    for (const operation of ownedOperations) {
      expect(repos.operations.get(operation.id)).toMatchObject({
        status: 'cancelled',
        fencingToken: 1,
      });
      expect(repos.operations.getResult(operation.id)).toMatchObject({
        status: 'cancelled',
        payload: { reason: 'route_superseded', successorPlanId: second.plan.id },
      });
      expect(repos.operations.listEvents(operation.id)).toHaveLength(1);
    }
    expect(repos.operations.get(completedSessionOperation.id)).toMatchObject({
      status: 'cancelled',
      fencingToken: 1,
    });
    expect(repos.operations.getResult(completedSessionOperation.id)).toMatchObject({
      status: 'cancelled',
      payload: { reason: 'route_superseded', successorPlanId: second.plan.id },
    });
    expect(repos.operations.listEvents(completedSessionOperation.id)).toMatchObject([
      {
        fencingToken: 1,
        kind: 'operation_interrupted',
        payload: { reason: 'route_superseded', successorPlanId: second.plan.id },
      },
    ]);
    expect(repos.operations.get(abandonedSessionOperation.id)).toMatchObject({
      status: 'cancelled',
      fencingToken: 1,
    });
    expect(repos.operations.getResult(abandonedSessionOperation.id)).toMatchObject({
      status: 'cancelled',
      payload: { reason: 'route_superseded', successorPlanId: second.plan.id },
    });
    expect(repos.operations.listEvents(abandonedSessionOperation.id)).toHaveLength(1);
    const routeEvent = db
      .prepare(
        `SELECT payload FROM course_execution_events
         WHERE workspace_id = 'ws_1' AND event_type = 'route_activated'
         ORDER BY seq DESC LIMIT 1`,
      )
      .get() as { payload: string };
    expect(JSON.parse(routeEvent.payload).supersededSessionIds).toEqual([
      'predecessor_session_early',
      'predecessor_session_late_a',
      'predecessor_session_late_b',
    ]);
  });

  it('uses only fully valid unambiguous legacy ownership signals during route cleanup', () => {
    const initialPredecessors = routePredecessors();
    const first = stageRoute('legacy_cleanup_old', 1, initialPredecessors);
    activate(first, initialPredecessors);
    repos.workspaces.insert(makeWorkspace({ id: 'ws_other', name: 'Other course' }));

    const createSession = (
      id: string,
      status: 'active' | 'completed' | 'abandoned',
      version: number,
    ) =>
      repos.studySessions.create({
        id,
        workspaceId: 'ws_1',
        contractVersionId: first.contract.id,
        curriculumVersionId: first.curriculum.id,
        studyPlanVersionId: first.plan.id,
        sessionAgendaId: first.agenda.id,
        executionSourceManifestFingerprint: first.plan.executionSourceManifestFingerprint,
        version,
        status,
        routeState: 'on_route',
        currentAgendaItemId: null,
        routeStack: [],
        transcriptWatermark: 0,
        createdAt: T2,
        updatedAt: T2,
      });
    const sessionA = createSession('legacy_cleanup_session_a', 'active', 1);
    const sessionB = createSession('legacy_cleanup_session_b', 'completed', 2);
    const sessionC = createSession('legacy_cleanup_session_c', 'abandoned', 3);

    const createLegacyOperation = (id: string, operationType: string, commandId = id) =>
      repos.operations.createOrGet({
        id,
        workspaceId: 'ws_1',
        commandId,
        idempotencyKey: id,
        logicalOperationId: id,
        operationType,
        expectedFingerprint: `fingerprint-${id}`,
        createdAt: T2,
        updatedAt: T2,
      }).operation;
    const insertLogicalCall = (
      id: string,
      operationId: string,
      studySessionId: string,
      workspaceId = 'ws_1',
    ) =>
      repos.telemetry.insertLogicalCall({
        id,
        operationId,
        workspaceId,
        studySessionId,
        learningUnitId: null,
        assessmentId: null,
        operationType: 'legacy_ownership_probe',
        cacheKey: null,
        cacheStatus: 'not_checked',
        promptFingerprint: null,
        schemaFingerprint: 'legacy-ownership-probe-v1',
        policyFingerprint: null,
        sourceFingerprint: first.plan.executionSourceManifestFingerprint,
        status: 'open',
        createdAt: T2,
        completedAt: null,
      });
    const createLessonState = (id: string, sessionId: string, preparationOperationId: string) =>
      repos.lessonExecution.create({
        id,
        sessionId,
        agendaItemId: first.agenda.items[0]!.id,
        curriculumVersionId: first.curriculum.id,
        studyPlanVersionId: first.plan.id,
        learningUnitId: first.plan.items[0]!.curriculumLearningUnitId!,
        teachingBriefId: null,
        acceptedLessonCheckpointId: null,
        executionSourceManifestFingerprint: first.plan.executionSourceManifestFingerprint,
        sourceContextFingerprint: null,
        preparationStatus: 'preparing',
        preparationOperationId,
        version: 1,
        currentSegmentIndex: 0,
        presentedSegmentIndexes: [],
        informalInteractions: [],
        presentationCompletedAt: null,
        practiceInteractions: [],
        practiceCompletedAt: null,
        createdAt: T2,
        updatedAt: T2,
      });

    const workspaceMismatch = createLegacyOperation(
      'legacy_workspace_mismatch',
      'prepare_teaching_brief',
    );
    insertLogicalCall(
      'legacy_workspace_mismatch_call',
      workspaceMismatch.id,
      sessionA.id,
      'ws_other',
    );

    const staleLogicalWithLesson = createLegacyOperation(
      'legacy_stale_logical_with_lesson',
      'prepare_lesson_execution',
    );
    insertLogicalCall(
      'legacy_stale_logical_with_lesson_call',
      staleLogicalWithLesson.id,
      'missing_legacy_session',
    );
    const lessonA = createLessonState(
      'legacy_lesson_state_a',
      sessionA.id,
      staleLogicalWithLesson.id,
    );

    const nestedConflict = createLegacyOperation(
      'legacy_nested_conflict',
      'prepare_teaching_brief',
      `teaching-brief:${lessonA.learningUnitId}:${staleLogicalWithLesson.id}`,
    );
    insertLogicalCall('legacy_nested_conflict_call', nestedConflict.id, sessionB.id);

    const lessonEventConflict = createLegacyOperation(
      'legacy_lesson_event_conflict',
      'lesson_execution_command',
      'legacy_lesson_event_conflict_command',
    );
    insertLogicalCall('legacy_lesson_event_conflict_call', lessonEventConflict.id, sessionB.id);
    repos.lessonExecution.appendEvent({
      id: 'legacy_lesson_event_conflict_event',
      lessonExecutionStateId: lessonA.id,
      seq: 1,
      commandId: lessonEventConflict.commandId,
      kind: 'preparation_started',
      payload: {},
      createdAt: T2,
    });

    const wrongTypeLesson = createLegacyOperation(
      'legacy_wrong_type_lesson',
      'prepare_teaching_brief',
    );
    insertLogicalCall('legacy_wrong_type_lesson_call', wrongTypeLesson.id, sessionB.id);
    const wrongTypeState = createLessonState(
      'legacy_wrong_type_lesson_state',
      sessionB.id,
      wrongTypeLesson.id,
    );
    const invalidNestedOuter = createLegacyOperation(
      'legacy_invalid_nested_outer',
      'prepare_teaching_brief',
      `teaching-brief:${wrongTypeState.learningUnitId}:${wrongTypeLesson.id}`,
    );

    const validLesson = createLegacyOperation('legacy_valid_lesson', 'prepare_lesson_execution');
    const lessonC = createLessonState('legacy_lesson_state_c', sessionC.id, validLesson.id);
    const validNested = createLegacyOperation(
      'legacy_valid_nested',
      'prepare_teaching_brief',
      `teaching-brief:${lessonC.learningUnitId}:${validLesson.id}`,
    );
    const validLessonEvent = createLegacyOperation(
      'legacy_valid_lesson_event',
      'lesson_execution_command',
      'legacy_valid_lesson_event_command',
    );
    repos.lessonExecution.appendEvent({
      id: 'legacy_valid_lesson_event_event',
      lessonExecutionStateId: lessonC.id,
      seq: 1,
      commandId: validLessonEvent.commandId,
      kind: 'preparation_started',
      payload: {},
      createdAt: T2,
    });

    const invalidPrefix = createLegacyOperation(
      'legacy_invalid_prefix',
      'study_session_turn',
      'study-turn:missing_legacy_session:command',
    );
    insertLogicalCall('legacy_invalid_prefix_call', invalidPrefix.id, sessionA.id);
    const validLogical = createLegacyOperation('legacy_valid_logical', 'prepare_teaching_brief');
    insertLogicalCall('legacy_valid_logical_call', validLogical.id, sessionA.id);

    const preservedOperations = [
      workspaceMismatch,
      staleLogicalWithLesson,
      nestedConflict,
      lessonEventConflict,
      wrongTypeLesson,
      invalidNestedOuter,
      invalidPrefix,
    ];
    const cancelledOperations = [validLesson, validNested, validLessonEvent, validLogical];
    for (const operation of [...preservedOperations, ...cancelledOperations]) {
      expect(
        db
          .prepare('SELECT study_session_id AS studySessionId FROM agent_operations WHERE id = ?')
          .get(operation.id),
      ).toEqual({ studySessionId: null });
    }

    const successorPredecessors = routePredecessors();
    const second = stageRoute('legacy_cleanup_new', 2, successorPredecessors);
    activate(second, successorPredecessors);

    for (const operation of preservedOperations) {
      expect(repos.operations.get(operation.id)).toEqual(operation);
      expect(repos.operations.getResult(operation.id)).toBeUndefined();
      expect(repos.operations.listEvents(operation.id)).toEqual([]);
    }
    for (const operation of cancelledOperations) {
      expect(repos.operations.get(operation.id)).toMatchObject({
        status: 'cancelled',
        fencingToken: 1,
      });
      expect(repos.operations.getResult(operation.id)).toMatchObject({
        fencingToken: 1,
        status: 'cancelled',
        payload: { reason: 'route_superseded', successorPlanId: second.plan.id },
      });
      expect(repos.operations.listEvents(operation.id)).toMatchObject([
        {
          fencingToken: 1,
          kind: 'operation_interrupted',
          payload: { reason: 'route_superseded', successorPlanId: second.plan.id },
        },
      ]);
    }
  });

  it('rejects a pending successor Curriculum without disturbing the active Curriculum', () => {
    const initialPredecessors = routePredecessors();
    const first = stageRoute('active_curriculum', 1, initialPredecessors);
    const activeState = activate(first, initialPredecessors);
    const successorPredecessors = routePredecessors();
    const second = stageRoute('rejected_curriculum', 2, successorPredecessors);

    const rejected = repos.curricula.reject(
      second.curriculum.id,
      'Learner rejected the proposed structure.',
      {
        id: 'curriculum_rejected_event',
        eventType: 'rejected',
        actor: 'learner',
        payload: {},
        createdAt: T3,
      },
    );

    expect(rejected.status).toBe('rejected');
    expect(repos.courseExecution.get('ws_1')).toEqual(activeState);
    expect(repos.curricula.get(first.curriculum.id)?.status).toBe('accepted');
  });

  it('rejects stale expected pointers without mutating the accepted route', () => {
    const predecessors = routePredecessors();
    const route = stageRoute('stale', 1, predecessors);
    const accepted = activate(route, predecessors);

    expect(() => activate(route, predecessors)).toThrow(/stale/);
    expect(repos.courseExecution.get('ws_1')).toEqual(accepted);
  });

  it('pauses and resumes execution without changing the accepted Plan lifecycle or pointer', () => {
    const predecessors = routePredecessors();
    const route = stageRoute('pause_resume', 1, predecessors);
    const active = activate(route, predecessors);

    const paused = repos.courseExecution.transitionExecution({
      workspaceId: 'ws_1',
      expectedVersion: active.version,
      expectedAcceptedPlanId: route.plan.id,
      expectedAgendaId: route.agenda.id,
      transition: 'pause',
      eventId: 'pause_event',
      reason: 'Learner is taking a break.',
      actor: 'learner',
      at: T2,
    });
    expect(paused).toMatchObject({
      acceptedPlanId: route.plan.id,
      executionStatus: 'paused',
      version: active.version + 1,
    });
    expect(repos.studyPlans.get(route.plan.id)?.status).toBe('accepted');

    const resumed = repos.courseExecution.transitionExecution({
      workspaceId: 'ws_1',
      expectedVersion: paused.version,
      expectedAcceptedPlanId: route.plan.id,
      expectedAgendaId: route.agenda.id,
      transition: 'resume',
      eventId: 'resume_event',
      reason: null,
      actor: 'learner',
      at: T3,
    });
    expect(resumed).toMatchObject({
      acceptedPlanId: route.plan.id,
      executionStatus: 'active',
      version: paused.version + 1,
    });
    expect(repos.studyPlans.get(route.plan.id)?.status).toBe('accepted');
    expect(() =>
      repos.courseExecution.transitionExecution({
        workspaceId: 'ws_1',
        expectedVersion: paused.version,
        expectedAcceptedPlanId: route.plan.id,
        expectedAgendaId: route.agenda.id,
        transition: 'pause',
        eventId: 'stale_pause_event',
        reason: null,
        actor: 'learner',
        at: T3,
      }),
    ).toThrow('stale');
  });

  it('marks execution source stale after reprocessing without rewriting Contract intention', () => {
    const predecessors = routePredecessors();
    const route = stageRoute('revision', 1, predecessors);
    activate(route, predecessors);
    const material = repos.materials.get('mat_1')!;
    const staged = repos.materialRevisions.stage({
      revisionId: 'revision_2',
      material: { ...material, content: 'Improved extraction.', charCount: 20, updatedAt: T3 },
      blocks: [
        makeBlock({
          id: 'blk_revision_2',
          content: 'Improved extraction.',
          startOffset: 0,
          endOffset: 20,
        }),
      ],
      originalData: null,
      parserFingerprint: 'parser-v2',
      contentFingerprint: 'content-v2',
      parserAttemptId: 'parser_attempt_2',
      createdAt: T3,
    });

    repos.materialRevisions.activate('mat_1', staged.id, T3);

    expect(repos.courseExecution.get('ws_1')).toMatchObject({
      activeContractId: route.contract.id,
      acceptedPlanId: route.plan.id,
      routeValidationStatus: 'revalidation_required',
      version: 2,
    });
    expect(repos.learningContracts.list('ws_1')).toHaveLength(1);
    expect(repos.learningContracts.get(route.contract.id)?.courseScope.materials[0]).toEqual({
      materialId: 'mat_1',
      materialRoleAssignmentId: roleAssignmentId,
      materialRoleAssignmentVersion: 2,
      role: 'course_material',
      disposition: 'included',
    });
  });

  it('hydrates normalized structural units from honest revision-owned metadata', () => {
    db.prepare(
      `INSERT INTO normalized_structural_units
         (id, material_revision_id, parent_id, unit_type, idx, title,
          start_offset, end_offset, page_number, metadata)
       VALUES ('structural_1', ?, NULL, 'section', 0, 'Capacity', 0, 4, NULL, ?)`,
    ).run(revisionId, JSON.stringify({ derivation: 'source_text', confidence: 0.9 }));

    expect(repos.materialRevisions.getStructuralUnits(revisionId)).toEqual([
      {
        id: 'structural_1',
        materialRevisionId: revisionId,
        parentUnitId: null,
        kind: 'section',
        index: 0,
        title: 'Capacity',
        content: makeMaterial().content.slice(0, 4),
        sourceLocator: 'offsets:0-4',
        derivation: 'source_text',
        confidence: 0.9,
      },
    ]);
  });

  it('rejects revision-coupled Contract scope and tier-3 blocking requirements', () => {
    const predecessors = routePredecessors();
    const route = stageRoute('authority', 1, predecessors);
    const invalidContract = structuredClone(route.contract) as LearningContract & {
      courseScope: LearningContract['courseScope'] & {
        materials: Array<
          LearningContract['courseScope']['materials'][number] & { materialRevisionId: string }
        >;
      };
    };
    invalidContract.courseScope.materials[0]!.materialRevisionId = revisionId;
    expect(() => LearningContractSchema.parse(invalidContract)).toThrow();

    const invalidPlan = structuredClone(route.plan);
    invalidPlan.items[0]!.completionRequirements[0]!.admissibilityTier = 'tier_3_advisory';
    expect(() => StudyPlanSchema.parse(invalidPlan)).toThrow(/tier-3 advisory evidence/);
  });

  it('prevents partial active route pointers at the database boundary', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO course_execution_state
             (workspace_id, active_contract_id, execution_status,
              route_validation_status, version, updated_at)
           VALUES ('ws_1', NULL, 'active', 'valid', 1, ?)`,
        )
        .run(T3),
    ).toThrow();
  });
});
