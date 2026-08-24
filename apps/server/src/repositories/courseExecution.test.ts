import { beforeEach, describe, expect, it } from 'vitest';
import {
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
  makeSemanticallySupportedObjective,
  makeWorkspace,
  T0,
} from '../testing/fixtures.js';
import { createRepositories, type Repositories } from './index.js';
import type { CourseExecutionState } from './courseExecution.js';

const T1 = '2026-01-01T00:01:00.000Z';
const T2 = '2026-01-01T00:02:00.000Z';
const T3 = '2026-01-01T00:03:00.000Z';

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
  repos.curricula.createVersion(curriculum, {
    id: `curriculum_created_${suffix}`,
    eventType: 'proposed',
    actor: 'local',
    payload: {},
    createdAt: T0,
  });
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
  });

  it('atomically swaps every pointer on a successful successor activation', () => {
    const initialPredecessors = routePredecessors();
    const first = stageRoute('old', 1, initialPredecessors);
    activate(first, initialPredecessors);
    const successorPredecessors = routePredecessors();
    const second = stageRoute('new', 2, successorPredecessors);

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
    const claim = repos.operations.claim(operation.id, 'old-worker', T3, T2)!;
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
