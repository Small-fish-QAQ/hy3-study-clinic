import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Curriculum,
  type LearningContract,
  type SessionAgenda,
  type StudyPlan,
} from '@hy3-clinic/shared';
import { buildApp } from '../app.js';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { FakeProvider } from '../llm/fakeProvider.js';
import type { ProviderCallOptions, TutorTurnInput, TutorTurnPayload } from '../llm/provider.js';
import { createRepositories, type Repositories } from '../repositories/index.js';
import { makeWorkspace, T0 } from '../testing/fixtures.js';
import { fixedClock } from '../util/ids.js';
import { createStudySessionService, type StudySessionService } from './studySessions.js';

const T1 = '2026-01-01T00:01:00.000Z';
let db: SqliteDb;
let repos: Repositories;
let service: StudySessionService;

function operationStudySessionId(idempotencyKey: string): string | null | undefined {
  return (
    db
      .prepare(
        `SELECT study_session_id AS studySessionId
         FROM agent_operations WHERE workspace_id = ? AND idempotency_key = ?`,
      )
      .get('ws_1', idempotencyKey) as { studySessionId: string | null } | undefined
  )?.studySessionId;
}

function installRoute(): void {
  const contract: LearningContract = {
    id: 'contract_1',
    workspaceId: 'ws_1',
    version: 1,
    predecessorId: null,
    intent: 'Learn the accepted course route.',
    targetOutcome: { description: 'Working fluency', targetScore: null, credential: null },
    deadline: null,
    studyBudget: {
      minutesPerDay: 30,
      minutesPerWeek: null,
      preferredSessionMinutes: 20,
      unavailablePeriods: [],
    },
    desiredDepth: 'working_fluency',
    courseScope: {
      subjectBoundaries: ['Memory'],
      materials: [],
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
    status: 'active',
    proposedBy: 'learner',
    learnerConfirmedAt: T0,
    createdAt: T0,
  };
  const curriculum: Curriculum = {
    id: 'curriculum_1',
    workspaceId: 'ws_1',
    contractVersionId: contract.id,
    version: 1,
    predecessorId: null,
    status: 'accepted',
    executionSourceManifest: {
      fingerprint: 'manifest-1',
      revisions: [
        {
          materialId: 'legacy-material',
          materialRevisionId: 'legacy-revision',
          parserVersion: null,
          parserFingerprint: null,
          sourceBlockRevisionIds: [],
        },
      ],
    },
    nodes: [
      {
        id: 'course_node',
        parentId: null,
        kind: 'course',
        index: 0,
        title: 'Memory',
        sourceReferences: [],
        learningUnit: null,
      },
    ],
    synthesisGroups: [],
    validation: { valid: true, errors: [], warnings: [], unmappedStructuralUnitIds: [] },
    provider: 'fake',
    providerModel: null,
    createdAt: T0,
    acceptedAt: T0,
  };
  const plan: StudyPlan = {
    id: 'plan_1',
    workspaceId: 'ws_1',
    contractVersionId: contract.id,
    curriculumVersionId: curriculum.id,
    executionSourceManifestFingerprint: 'manifest-1',
    version: 1,
    predecessorId: null,
    proposalTrigger: 'Initial route.',
    status: 'accepted',
    rationale: 'Follow the accepted route.',
    items: [
      {
        id: 'plan_item_1',
        index: 0,
        phase: 'Learn',
        kind: 'teach_unit',
        curriculumLearningUnitId: null,
        rationale: 'Start with the current topic.',
        estimatedMinutes: 10,
        targetDepth: 'working_fluency',
        objectiveIds: [],
        prerequisitePlanItemIds: [],
        completionPolicy: null,
        completionRequirements: [],
      },
    ],
    deferrals: [],
    feasibility: {
      projectedMinutes: 10,
      availableMinutes: null,
      slackMinutes: null,
      state: 'unknown',
      assumptions: [],
    },
    paceBaseline: {
      id: 'pace_1',
      policyVersion: 'pace-v1',
      contractVersionId: contract.id,
      studyPlanVersionId: 'plan_1',
      timeZone: 'UTC',
      expectedSessionCadencePerWeek: null,
      explicitSlackMinutes: 0,
      estimateConfidence: 'low',
      estimateSource: 'local',
      milestones: [],
    },
    diff: [],
    provider: 'fake',
    providerModel: null,
    learnerAcceptedAt: T0,
    createdAt: T0,
  };
  const agenda: SessionAgenda = {
    id: 'agenda_1',
    workspaceId: 'ws_1',
    contractVersionId: contract.id,
    curriculumVersionId: curriculum.id,
    studyPlanVersionId: plan.id,
    executionSourceManifestFingerprint: 'manifest-1',
    version: 1,
    status: 'active',
    availableMinutes: 20,
    items: [
      {
        id: 'agenda_item_1',
        index: 0,
        kind: 'learning_unit_teaching',
        origin: 'accepted_plan',
        reason: 'Teach the current topic.',
        estimatedMinutes: 10,
        linkedPlanItemId: null,
        learningUnitId: null,
        priority: 'medium',
        state: 'queued',
        launch: {
          status: 'launchable',
          capability: 'lesson',
          resourceId: null,
          reason: null,
        },
        displacedAgendaItemIds: [],
        timeImpactMinutes: 0,
      },
      {
        id: 'agenda_item_checkpoint',
        index: 1,
        kind: 'formal_checkpoint',
        origin: 'accepted_plan',
        reason: 'Formally check the current topic.',
        estimatedMinutes: 10,
        linkedPlanItemId: null,
        learningUnitId: null,
        priority: 'high',
        state: 'queued',
        launch: {
          status: 'launchable',
          capability: 'assessment',
          resourceId: null,
          reason: null,
        },
        displacedAgendaItemIds: [],
        timeImpactMinutes: 0,
      },
    ],
    currentItemId: 'agenda_item_1',
    createdAt: T0,
    updatedAt: T0,
  };

  db.prepare(
    `INSERT INTO learning_contract_versions
       (id, workspace_id, version, status, payload, learner_confirmed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    contract.id,
    contract.workspaceId,
    contract.version,
    contract.status,
    JSON.stringify(contract),
    T0,
    T0,
  );
  db.prepare(
    `INSERT INTO execution_source_manifests (id, workspace_id, fingerprint, payload, created_at)
     VALUES ('manifest_1', 'ws_1', 'manifest-1', ?, ?)`,
  ).run(JSON.stringify(curriculum.executionSourceManifest), T0);
  db.prepare(
    `INSERT INTO curriculum_versions
       (id, workspace_id, contract_id, manifest_id, manifest_fingerprint, version, status,
        validation_valid, payload, created_at, accepted_at)
     VALUES (?, ?, ?, 'manifest_1', 'manifest-1', 1, 'accepted', 1, ?, ?, ?)`,
  ).run(curriculum.id, curriculum.workspaceId, contract.id, JSON.stringify(curriculum), T0, T0);
  db.prepare(
    `INSERT INTO study_plan_versions
       (id, workspace_id, contract_id, curriculum_id, manifest_fingerprint, version, status,
        payload, created_at, learner_accepted_at)
     VALUES (?, ?, ?, ?, 'manifest-1', 1, 'accepted', ?, ?, ?)`,
  ).run(plan.id, plan.workspaceId, contract.id, curriculum.id, JSON.stringify(plan), T0, T0);
  db.prepare(
    `INSERT INTO session_agendas
       (id, workspace_id, contract_id, curriculum_id, plan_id, manifest_fingerprint, version,
        status, payload, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'manifest-1', 1, 'active', ?, ?, ?)`,
  ).run(
    agenda.id,
    agenda.workspaceId,
    contract.id,
    curriculum.id,
    plan.id,
    JSON.stringify(agenda),
    T0,
    T0,
  );
  const insertAgendaItem = db.prepare(
    `INSERT INTO session_agenda_items
       (agenda_id, agenda_item_id, idx, linked_plan_item_id, kind, state,
        launch_status, launch_capability, launch_resource_id, launch_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const item of agenda.items) {
    insertAgendaItem.run(
      agenda.id,
      item.id,
      item.index,
      item.linkedPlanItemId,
      item.kind,
      item.state,
      item.launch.status,
      item.launch.capability,
      item.launch.resourceId,
      item.launch.reason,
    );
  }
  db.prepare(
    `INSERT INTO course_execution_state
       (workspace_id, active_contract_id, active_curriculum_id, accepted_plan_id,
        active_agenda_id, execution_status, route_validation_status, version, updated_at)
     VALUES ('ws_1', ?, ?, ?, ?, 'active', 'valid', 1, ?)`,
  ).run(contract.id, curriculum.id, plan.id, agenda.id, T0);
}

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  repos = createRepositories(db);
  repos.workspaces.insert(makeWorkspace());
  installRoute();
  service = createStudySessionService({
    repos,
    provider: new FakeProvider(),
    clock: fixedClock(T1),
    replanning: {
      qualifyReplanTrigger() {
        throw new Error('Replanning is not exercised by this isolated StudySession fixture.');
      },
      proposeQualifiedReplan() {
        throw new Error('Replanning is not exercised by this isolated StudySession fixture.');
      },
    },
  });
});

describe('StudySession service', () => {
  it('persists conversation, telemetry, and replays a completed turn idempotently', async () => {
    const started = service.start('ws_1', {
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      sessionAgendaId: 'agenda_1',
      expectedCourseExecutionVersion: 1,
    });
    const input = {
      commandId: 'turn_1',
      expectedSessionVersion: started.session.version,
      content: 'Explain the current topic.',
    };
    const completed = await service.submitTurn('ws_1', started.session.id, input);
    const replayed = await service.submitTurn('ws_1', started.session.id, input);

    expect(replayed).toEqual(completed);
    expect(completed.exchanges.map((exchange) => exchange.role)).toEqual(['learner', 'tutor']);
    expect(completed.turn.tutorMetadata).toMatchObject({
      move: 'EXPLAIN_DEEPER',
      routeSignal: 'stay_on_route',
      policyVersion: 'lesson-aware-v1',
    });
    expect(repos.studySessions.listTurns(started.session.id)).toHaveLength(1);
    expect(operationStudySessionId(`study-turn:${started.session.id}:${input.commandId}`)).toBe(
      started.session.id,
    );
    expect(repos.telemetry.usageSummary('ws_1')).toMatchObject({
      logicalCalls: 1,
      physicalAttempts: 1,
      attemptsWithKnownCost: 1,
    });
  });

  it('retries a real sent turn after restart without duplicating the logical request', async () => {
    let providerReached!: () => void;
    let interruptProvider!: (error: Error) => void;
    const reachedProvider = new Promise<void>((resolve) => {
      providerReached = resolve;
    });
    class InterruptedProvider extends FakeProvider {
      override async respondToTutorTurn(
        _input: TutorTurnInput,
        _opts?: ProviderCallOptions,
      ): Promise<TutorTurnPayload> {
        providerReached();
        return new Promise<TutorTurnPayload>((_resolve, reject) => {
          interruptProvider = reject;
        });
      }
    }

    const firstApp = buildApp({
      repos,
      provider: new InterruptedProvider(),
      clock: fixedClock(T1),
    });
    const startResponse = await firstApp.inject({
      method: 'POST',
      url: '/api/workspaces/ws_1/study-sessions',
      payload: {
        contractVersionId: 'contract_1',
        curriculumVersionId: 'curriculum_1',
        studyPlanVersionId: 'plan_1',
        sessionAgendaId: 'agenda_1',
        expectedCourseExecutionVersion: 1,
      },
    });
    expect(startResponse.statusCode).toBe(201);
    const started = startResponse.json<{ session: { id: string; version: number } }>().session;
    const input = {
      commandId: 'turn_after_restart',
      expectedSessionVersion: started.version,
      content: 'Resume this explanation.',
    };
    const firstRequest = firstApp.inject({
      method: 'POST',
      url: `/api/workspaces/ws_1/study-sessions/${started.id}/turns`,
      payload: input,
    });
    await reachedProvider;

    const reserved = repos.studySessions.get(started.id)!;
    const originalTurn = repos.studySessions.getTurnByCommand(started.id, input.commandId)!;
    const logicalCallId = originalTurn.logicalCallId!;
    expect(reserved).toMatchObject({ version: started.version + 1, transcriptWatermark: 1 });
    expect(originalTurn.contextManifest).toMatchObject({
      studySessionVersion: started.version,
      transcriptWatermark: 0,
    });
    expect(repos.telemetry.listAttempts(logicalCallId)).toMatchObject([
      { attemptNumber: 1, status: 'sent', fencingToken: 1 },
    ]);

    const restartedApp = buildApp({ repos, provider: new FakeProvider(), clock: fixedClock(T1) });
    expect(repos.studySessions.getTurn(originalTurn.id)).toMatchObject({ status: 'interrupted' });
    expect(repos.telemetry.listAttempts(logicalCallId)).toMatchObject([
      { attemptNumber: 1, status: 'outcome_unknown', fencingToken: 1 },
    ]);

    const changedRetry = await restartedApp.inject({
      method: 'POST',
      url: `/api/workspaces/ws_1/study-sessions/${started.id}/turns`,
      payload: { ...input, content: 'Changed retry content.' },
    });
    expect(changedRetry.statusCode).toBe(409);
    expect(repos.studySessions.getTurn(originalTurn.id)).toMatchObject({
      status: 'interrupted',
      contextManifest: originalTurn.contextManifest,
    });
    expect(repos.telemetry.listAttempts(logicalCallId)).toHaveLength(1);

    const retryResponse = await restartedApp.inject({
      method: 'POST',
      url: `/api/workspaces/ws_1/study-sessions/${started.id}/turns`,
      payload: input,
    });
    expect(retryResponse.statusCode).toBe(200);
    const completed = retryResponse.json<{ turn: { id: string } }>();
    expect(completed.turn.id).toBe(originalTurn.id);
    expect(repos.studySessions.listTurns(started.id)).toHaveLength(1);
    expect(repos.studySessions.listExchanges(started.id).map((item) => item.role)).toEqual([
      'learner',
      'tutor',
    ]);
    expect(repos.studySessions.get(started.id)).toMatchObject({
      version: started.version + 2,
      transcriptWatermark: 2,
    });
    expect(repos.telemetry.listAttempts(logicalCallId)).toMatchObject([
      { attemptNumber: 1, status: 'outcome_unknown', fencingToken: 1 },
      { attemptNumber: 2, attemptKind: 'retry', status: 'completed', fencingToken: 2 },
    ]);

    const staleFreshTurn = await restartedApp.inject({
      method: 'POST',
      url: `/api/workspaces/ws_1/study-sessions/${started.id}/turns`,
      payload: {
        commandId: 'fresh_turn_with_stale_version',
        expectedSessionVersion: started.version,
        content: 'This is a distinct logical request.',
      },
    });
    expect(staleFreshTurn.statusCode).toBe(409);
    expect(repos.studySessions.listTurns(started.id)).toHaveLength(1);

    interruptProvider(new Error('Simulated process exit.'));
    expect((await firstRequest).statusCode).toBe(500);
    expect(repos.studySessions.listExchanges(started.id)).toHaveLength(2);
    await Promise.all([firstApp.close(), restartedApp.close()]);
  });

  it('recovers an expired sent turn on identical retry without restarting the process', async () => {
    let providerReached!: () => void;
    let expireOldWorker!: (error: Error) => void;
    const reachedProvider = new Promise<void>((resolve) => {
      providerReached = resolve;
    });
    class ExpiringProvider extends FakeProvider {
      calls = 0;

      override async respondToTutorTurn(
        input: TutorTurnInput,
        opts?: ProviderCallOptions,
      ): Promise<TutorTurnPayload> {
        this.calls += 1;
        if (this.calls > 1) return super.respondToTutorTurn(input, opts);
        providerReached();
        return new Promise<TutorTurnPayload>((_resolve, reject) => {
          expireOldWorker = reject;
        });
      }
    }

    let now = new Date(T0);
    const provider = new ExpiringProvider();
    const app = buildApp({ repos, provider, clock: { now: () => new Date(now) } });
    const startResponse = await app.inject({
      method: 'POST',
      url: '/api/workspaces/ws_1/study-sessions',
      payload: {
        contractVersionId: 'contract_1',
        curriculumVersionId: 'curriculum_1',
        studyPlanVersionId: 'plan_1',
        sessionAgendaId: 'agenda_1',
        expectedCourseExecutionVersion: 1,
      },
    });
    const started = startResponse.json<{ session: { id: string; version: number } }>().session;
    const input = {
      commandId: 'turn_after_live_lease_expiry',
      expectedSessionVersion: started.version,
      content: 'Retry this exact learner turn after the lease expires.',
    };
    const firstRequest = app.inject({
      method: 'POST',
      url: `/api/workspaces/ws_1/study-sessions/${started.id}/turns`,
      payload: input,
    });
    await reachedProvider;
    const originalTurn = repos.studySessions.getTurnByCommand(started.id, input.commandId)!;
    const logicalCallId = originalTurn.logicalCallId!;
    const operationId = repos.telemetry.getLogicalCall(logicalCallId)!.operationId!;
    expect(repos.operations.get(operationId)).toMatchObject({
      status: 'running',
      fencingToken: 1,
    });
    expect(repos.telemetry.listAttempts(logicalCallId)).toMatchObject([
      { attemptNumber: 1, status: 'sent', fencingToken: 1 },
    ]);

    now = new Date('2026-01-01T00:06:00.000Z');
    const retryResponse = await app.inject({
      method: 'POST',
      url: `/api/workspaces/ws_1/study-sessions/${started.id}/turns`,
      payload: input,
    });

    expect(retryResponse.statusCode).toBe(200);
    expect(provider.calls).toBe(2);
    expect(repos.studySessions.listTurns(started.id)).toHaveLength(1);
    expect(repos.studySessions.listExchanges(started.id).map((exchange) => exchange.role)).toEqual([
      'learner',
      'tutor',
    ]);
    expect(repos.telemetry.listAttempts(logicalCallId)).toMatchObject([
      { attemptNumber: 1, status: 'outcome_unknown', fencingToken: 1 },
      { attemptNumber: 2, attemptKind: 'retry', status: 'completed', fencingToken: 2 },
    ]);
    expect(repos.operations.listEvents(operationId)).toMatchObject([
      { kind: 'operation_interrupted', payload: { reason: 'lease_expired' }, fencingToken: 1 },
    ]);
    expect(repos.operations.get(operationId)).toMatchObject({
      status: 'completed',
      fencingToken: 2,
      leaseOwner: null,
    });

    expireOldWorker(new Error('Late result from expired worker.'));
    expect((await firstRequest).statusCode).toBe(500);
    expect(repos.operations.getResult(operationId)).toMatchObject({
      status: 'completed',
      fencingToken: 2,
    });
    expect(repos.studySessions.listExchanges(started.id)).toHaveLength(2);
    await app.close();
  });

  it('persists detour/return and pause/resume without changing the accepted Plan', () => {
    let session = service.start('ws_1', {
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      sessionAgendaId: 'agenda_1',
      expectedCourseExecutionVersion: 1,
    }).session;
    const detour = service.command('ws_1', session.id, {
      commandId: 'detour_1',
      expectedSessionVersion: session.version,
      kind: 'detour',
      targetAgendaItemId: session.currentAgendaItemId,
      requestedMinutes: 5,
      reason: 'Review a prerequisite first.',
    });
    session = detour.session;
    expect(session).toMatchObject({ routeState: 'detour_active' });
    expect(operationStudySessionId(`study-command:${session.id}:detour_1`)).toBe(session.id);
    expect(session.routeStack).toHaveLength(1);
    expect(detour.agenda.items.at(-1)).toMatchObject({ origin: 'learner_detour', state: 'active' });

    const returned = service.command('ws_1', session.id, {
      commandId: 'return_1',
      expectedSessionVersion: session.version,
      kind: 'return',
      targetAgendaItemId: session.currentAgendaItemId,
      reason: 'Return to the accepted route.',
    });
    session = returned.session;
    expect(session.routeStack).toEqual([]);
    expect(session.currentAgendaItemId).toBe('agenda_item_1');

    const paused = service.pause('ws_1', session.id, {
      commandId: 'pause_1',
      expectedSessionVersion: session.version,
    });
    expect(paused.session.status).toBe('paused');
    expect(paused.agenda.status).toBe('paused');
    expect(operationStudySessionId(`study-lifecycle:${session.id}:pause_1`)).toBe(session.id);
    expect(repos.courseExecution.get('ws_1')).toMatchObject({
      executionStatus: 'paused',
      acceptedPlanId: 'plan_1',
    });
    expect(repos.studyPlans.get('plan_1')?.status).toBe('accepted');
    expect(
      service.pause('ws_1', session.id, {
        commandId: 'pause_1',
        expectedSessionVersion: session.version,
      }),
    ).toEqual(paused);

    const resumed = service.resume('ws_1', session.id, {
      commandId: 'resume_1',
      expectedSessionVersion: paused.session.version,
    });
    expect(resumed.session.status).toBe('active');
    expect(resumed.agenda.status).toBe('active');
    expect(operationStudySessionId(`study-lifecycle:${session.id}:resume_1`)).toBe(session.id);
    expect(repos.courseExecution.get('ws_1')).toMatchObject({
      executionStatus: 'active',
      acceptedPlanId: 'plan_1',
    });
  });

  it('targets a distinct accepted-Curriculum unit without rewriting the Plan', () => {
    const curriculum = repos.curricula.get('curriculum_1')!;
    db.prepare('UPDATE curriculum_versions SET payload = ? WHERE id = ?').run(
      JSON.stringify({
        ...curriculum,
        nodes: [
          ...curriculum.nodes,
          {
            id: 'unit_detour',
            parentId: 'course_node',
            kind: 'learning_unit',
            index: 0,
            title: 'Bayes review',
            sourceReferences: [],
            learningUnit: {
              conceptIds: [],
              canonicalConceptIds: [],
              objectives: [
                {
                  id: 'objective_detour',
                  title: 'Review Bayes',
                  description: 'Explore a learner-selected Curriculum topic.',
                  truthPremiseStatus: 'unverified',
                  truthAuthorityRecordIds: [],
                },
              ],
              prerequisiteUnitIds: [],
              graphRelationIds: [],
              riskIds: [],
            },
          },
        ],
      }),
      curriculum.id,
    );
    const planBefore = repos.studyPlans.get('plan_1');
    const session = service.start('ws_1', {
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      sessionAgendaId: 'agenda_1',
      expectedCourseExecutionVersion: 1,
    }).session;

    const detour = service.command('ws_1', session.id, {
      commandId: 'detour_distinct_unit',
      expectedSessionVersion: session.version,
      kind: 'detour',
      targetAgendaItemId: session.currentAgendaItemId,
      targetLearningUnitId: 'unit_detour',
      requestedMinutes: 10,
      reason: 'Review Bayes before returning.',
    });

    expect(detour.agenda.items.at(-1)).toMatchObject({
      origin: 'learner_detour',
      learningUnitId: 'unit_detour',
      linkedPlanItemId: null,
      state: 'active',
    });
    expect(detour.session.routeStack.at(-1)).toMatchObject({
      originAgendaItemId: 'agenda_item_1',
      originPlanItemId: null,
    });
    expect(repos.studyPlans.get('plan_1')).toEqual(planBefore);
  });

  it('executes an inserted Agenda activity, returns to the route, and keeps the Plan immutable', async () => {
    let session = service.start('ws_1', {
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      sessionAgendaId: 'agenda_1',
      expectedCourseExecutionVersion: 1,
    }).session;
    const acceptedPlanBefore = repos.studyPlans.get('plan_1');
    const inserted = service.command('ws_1', session.id, {
      commandId: 'insert_1',
      expectedSessionVersion: session.version,
      kind: 'agenda_insert',
      targetAgendaItemId: session.currentAgendaItemId,
      requestedMinutes: 8,
      reason: 'Add a short review before continuing.',
    });
    session = inserted.session;
    const insertedItem = inserted.agenda.items.at(-1)!;
    expect(insertedItem).toMatchObject({
      origin: 'learner_insert',
      estimatedMinutes: 8,
      timeImpactMinutes: 8,
      state: 'active',
      launch: { status: 'launchable', capability: 'conversation' },
      displacedAgendaItemIds: ['agenda_item_1'],
    });
    expect(inserted.session).toMatchObject({
      routeState: 'detour_active',
      currentAgendaItemId: insertedItem.id,
      studyPlanVersionId: 'plan_1',
    });
    expect(inserted.agenda.currentItemId).toBe(insertedItem.id);
    expect(inserted.session.routeStack).toMatchObject([
      { originAgendaItemId: 'agenda_item_1', studyPlanVersionId: 'plan_1' },
    ]);
    expect(repos.studyPlans.list('ws_1')).toHaveLength(1);

    const executed = await service.submitTurn('ws_1', session.id, {
      commandId: 'insert_turn_1',
      expectedSessionVersion: session.version,
      content: 'Run the inserted review now.',
    });
    session = executed.session;
    expect(executed.exchanges.map((exchange) => exchange.role)).toEqual(['learner', 'tutor']);
    expect(session.currentAgendaItemId).toBe(insertedItem.id);

    const returned = service.command('ws_1', session.id, {
      commandId: 'insert_return_1',
      expectedSessionVersion: session.version,
      kind: 'return',
      targetAgendaItemId: insertedItem.id,
      reason: 'The inserted review is complete.',
    });
    session = returned.session;
    expect(returned.session).toMatchObject({
      routeState: 'on_route',
      currentAgendaItemId: 'agenda_item_1',
      routeStack: [],
      studyPlanVersionId: 'plan_1',
    });
    expect(returned.agenda.currentItemId).toBe('agenda_item_1');
    expect(returned.agenda.items.find((item) => item.id === insertedItem.id)?.state).toBe(
      'completed',
    );
    expect(repos.studyPlans.get('plan_1')).toEqual(acceptedPlanBefore);

    expect(() =>
      service.command('ws_1', session.id, {
        commandId: 'invalid_checkpoint',
        expectedSessionVersion: session.version,
        kind: 'direct_checkpoint',
        targetAgendaItemId: 'agenda_item_1',
        reason: 'Skip directly to a check.',
      }),
    ).toThrow('launchable formal Agenda item');

    const checkpoint = service.command('ws_1', session.id, {
      commandId: 'checkpoint_1',
      expectedSessionVersion: session.version,
      kind: 'direct_checkpoint',
      targetAgendaItemId: 'agenda_item_checkpoint',
      reason: 'I already know this topic.',
    });
    session = checkpoint.session;
    expect(checkpoint.session.currentAgendaItemId).toBe('agenda_item_checkpoint');
    expect(checkpoint.agenda.currentItemId).toBe('agenda_item_checkpoint');

    const deferred = service.command('ws_1', session.id, {
      commandId: 'defer_1',
      expectedSessionVersion: session.version,
      kind: 'defer',
      targetAgendaItemId: 'agenda_item_checkpoint',
      reason: 'Defer this formal check until tomorrow.',
    });
    session = deferred.session;
    expect(deferred.agenda.items.find((item) => item.id === 'agenda_item_checkpoint')?.state).toBe(
      'deferred',
    );
    expect(repos.coverageRisks.list('ws_1', 'contract_1')).toEqual([
      expect.objectContaining({
        facets: ['intentionally_deferred'],
        status: 'deferred',
        origin: 'learner',
      }),
    ]);

    expect(repos.courseExecution.get('ws_1').acceptedPlanId).toBe('plan_1');
    expect(repos.studyPlans.list('ws_1')).toHaveLength(1);
  });

  it('stops only the StudySession and leaves the accepted route immediately reusable', () => {
    const started = service.start('ws_1', {
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      sessionAgendaId: 'agenda_1',
      expectedCourseExecutionVersion: 1,
    }).session;
    const stopped = service.stop('ws_1', started.id, {
      commandId: 'stop_1',
      expectedSessionVersion: started.version,
    });

    expect(stopped.session).toMatchObject({ status: 'abandoned', routeState: 'on_route' });
    expect(stopped.agenda.status).toBe('active');
    expect(repos.courseExecution.get('ws_1')).toMatchObject({
      executionStatus: 'active',
      acceptedPlanId: 'plan_1',
      activeAgendaId: 'agenda_1',
      version: 1,
    });
    expect(repos.studyPlans.get('plan_1')?.status).toBe('accepted');

    const restarted = service.start('ws_1', {
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      sessionAgendaId: 'agenda_1',
      expectedCourseExecutionVersion: 1,
    }).session;
    expect(restarted.id).not.toBe(started.id);
    expect(restarted.status).toBe('active');
  });

  it('applies only explicitly configured monetary caps and supports confirm policy acknowledgement', async () => {
    const session = service.start('ws_1', {
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      sessionAgendaId: 'agenda_1',
      expectedCourseExecutionVersion: 1,
    }).session;
    repos.telemetry.upsertCostPolicy({
      id: 'cost_policy_1',
      policyKey: 'session-confirm',
      workspaceId: 'ws_1',
      scopeType: 'session',
      scopeKey: session.id,
      limitMicrounits: 0,
      currency: 'USD',
      onExceed: 'confirm',
      enabled: true,
      createdAt: T0,
      updatedAt: T0,
    });

    await expect(
      service.submitTurn('ws_1', session.id, {
        commandId: 'cost_unconfirmed',
        expectedSessionVersion: session.version,
        content: 'Explain this.',
      }),
    ).rejects.toThrow('explicit confirmation');
    expect(repos.telemetry.usageSummary('ws_1')).toMatchObject({
      logicalCalls: 0,
      physicalAttempts: 0,
    });

    const confirmed = await service.submitTurn('ws_1', session.id, {
      commandId: 'cost_confirmed',
      expectedSessionVersion: session.version,
      content: 'Explain this.',
      confirmedCostPolicyIds: ['cost_policy_1'],
    });
    expect(confirmed.turn.status).toBe('completed');
    expect(repos.telemetry.usageSummary('ws_1')).toMatchObject({
      logicalCalls: 1,
      physicalAttempts: 1,
      attemptsWithKnownCost: 1,
    });
  });
});
