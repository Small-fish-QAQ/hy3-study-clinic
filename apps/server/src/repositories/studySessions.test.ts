import { beforeEach, describe, expect, it } from 'vitest';
import type {
  SessionAgenda,
  SessionAgendaItem,
  StudyExchange,
  StudySession,
  StudySessionSummary,
  StudyTurn,
  StudyTurnEvent,
} from '@hy3-clinic/shared';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { makeWorkspace, T0 } from '../testing/fixtures.js';
import { createRepositories, type Repositories } from './index.js';

const T1 = '2026-01-01T00:01:00.000Z';
let db: SqliteDb;
let repos: Repositories;

function session(overrides: Partial<StudySession> = {}): StudySession {
  return {
    id: 'session_1',
    workspaceId: 'ws_1',
    contractVersionId: 'contract_1',
    curriculumVersionId: 'curriculum_1',
    studyPlanVersionId: 'plan_1',
    sessionAgendaId: 'agenda_1',
    executionSourceManifestFingerprint: 'manifest-1',
    version: 1,
    status: 'active',
    routeState: 'on_route',
    currentAgendaItemId: 'agenda_item_1',
    routeStack: [],
    transcriptWatermark: 0,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function turn(overrides: Partial<StudyTurn> = {}): StudyTurn {
  return {
    id: 'turn_1',
    sessionId: 'session_1',
    seq: 0,
    commandId: 'command_1',
    status: 'completed',
    contextManifest: {
      fingerprint: 'context-1',
      contractScopeFingerprint: 'scope-1',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      sessionAgendaVersionId: 'agenda_1',
      studySessionVersion: 1,
      executionSourceManifestFingerprint: 'manifest-1',
      transcriptWatermark: 0,
      sourceBlockRevisionIds: [],
      formalEvidenceIds: [],
      riskIds: [],
    },
    logicalCallId: null,
    errorMessage: null,
    createdAt: T0,
    completedAt: T1,
    ...overrides,
  };
}

function agendaPayload(overrides: Partial<SessionAgenda> = {}): SessionAgenda {
  const item: SessionAgendaItem = {
    id: 'agenda_item_1',
    index: 0,
    kind: 'learning_unit_teaching',
    origin: 'accepted_plan',
    reason: 'Teach the current unit.',
    estimatedMinutes: 10,
    linkedPlanItemId: null,
    learningUnitId: null,
    priority: 'medium',
    state: 'queued',
    launch: { status: 'launchable', capability: 'lesson', resourceId: null, reason: null },
    displacedAgendaItemIds: [],
    timeImpactMinutes: 0,
  };
  return {
    id: 'agenda_1',
    workspaceId: 'ws_1',
    contractVersionId: 'contract_1',
    curriculumVersionId: 'curriculum_1',
    studyPlanVersionId: 'plan_1',
    executionSourceManifestFingerprint: 'manifest-1',
    version: 1,
    status: 'active',
    availableMinutes: 30,
    items: [item],
    currentItemId: item.id,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  repos = createRepositories(db);
  repos.workspaces.insert(makeWorkspace());
  db.prepare(
    `INSERT INTO learning_contract_versions
       (id, workspace_id, version, status, payload, created_at)
     VALUES ('contract_1', 'ws_1', 1, 'active', '{}', ?)`,
  ).run(T0);
  db.prepare(
    `INSERT INTO execution_source_manifests (id, workspace_id, fingerprint, payload, created_at)
     VALUES ('manifest_1', 'ws_1', 'manifest-1', '{}', ?)`,
  ).run(T0);
  db.prepare(
    `INSERT INTO curriculum_versions
       (id, workspace_id, contract_id, manifest_id, manifest_fingerprint, version, status,
        validation_valid, payload, created_at)
     VALUES ('curriculum_1', 'ws_1', 'contract_1', 'manifest_1', 'manifest-1', 1, 'accepted',
        1, '{}', ?)`,
  ).run(T0);
  db.prepare(
    `INSERT INTO study_plan_versions
       (id, workspace_id, contract_id, curriculum_id, manifest_fingerprint, version, status,
        payload, created_at)
     VALUES ('plan_1', 'ws_1', 'contract_1', 'curriculum_1', 'manifest-1', 1, 'accepted', '{}', ?)`,
  ).run(T0);
  db.prepare(
    `INSERT INTO session_agendas
       (id, workspace_id, contract_id, curriculum_id, plan_id, manifest_fingerprint, version,
        status, payload, created_at, updated_at)
     VALUES ('agenda_1', 'ws_1', 'contract_1', 'curriculum_1', 'plan_1', 'manifest-1', 1,
        'active', ?, ?, ?)`,
  ).run(JSON.stringify(agendaPayload()), T0, T0);
  db.prepare(
    `INSERT INTO session_agenda_items
       (agenda_id, agenda_item_id, idx, kind, state, launch_status, launch_capability)
     VALUES ('agenda_1', 'agenda_item_1', 0, 'learning_unit_teaching', 'queued', 'launchable', 'lesson')`,
  ).run();
});

describe('studySessions repository', () => {
  it('keeps full records and selects the latest local relevant completed Tutor replies', () => {
    repos.studySessions.create(session());
    const cases = [
      { agenda: 'another_item', role: 'tutor' as const, status: 'completed' as const },
      { agenda: null, role: 'tutor' as const, status: 'completed' as const },
      { agenda: 'agenda_item_1', role: 'tutor' as const, status: 'completed' as const },
      { agenda: 'agenda_item_1', role: 'tutor' as const, status: 'failed' as const },
      { agenda: 'agenda_item_1', role: 'learner' as const, status: 'completed' as const },
      { agenda: 'agenda_item_1', role: 'tutor' as const, status: 'completed' as const },
    ];
    for (const [index, example] of cases.entries()) {
      const id = `exposure_turn_${index}`;
      repos.studySessions.insertTurn(
        turn({
          id,
          seq: index,
          commandId: id,
          status: example.status,
          tutorMetadata: {
            move: 'EXPLAIN_DEEPER',
            sourceRefs: [],
            routeSignal: 'stay_on_route',
            lessonSegmentIndex: null,
            policyVersion: 'fixture',
            studyContext: {
              agendaItemId: example.agenda,
              lessonTitle: '条件判断',
              phase: 'practice',
              anchor: null,
            },
          },
        }),
      );
      repos.studySessions.insertExchange({
        id: `exposure_exchange_${index}`,
        turnId: id,
        sessionId: 'session_1',
        seq: index,
        role: example.role,
        content: index === 2 ? 'x'.repeat(8500) + 'FULL_TAIL' : `teaching_${index}`,
        channel: 'conversation',
        createdAt: index < 5 ? T0 : T1,
      });
    }
    const complete = repos.studySessions.listTutorTeaching('ws_1', undefined, {
      agendaItemId: 'agenda_item_1',
      limit: 4,
    });
    expect(complete.map((entry) => entry.content)).toEqual([
      'teaching_1',
      'x'.repeat(8500) + 'FULL_TAIL',
      'teaching_5',
    ]);
    expect(
      repos.studySessions.listTutorTeaching('ws_1', undefined, {
        agendaItemId: 'agenda_item_1',
        limit: 2,
      }),
    ).toEqual(complete.slice(0, 2));
    expect(
      repos.studySessions.listTutorTeaching('ws_1', undefined, {
        agendaItemId: 'agenda_item_1',
        limit: 2,
        latest: true,
      }),
    ).toEqual(complete.slice(-2));
    expect(
      repos.studySessions.listTutorTeaching('ws_1', T1, {
        agendaItemId: 'agenda_item_1',
        limit: 4,
      }),
    ).toEqual(complete.slice(0, 2));
    expect(repos.studySessions.listTutorTeaching('other_workspace')).toEqual([]);
    repos.studySessions.insertTurn(
      turn({ id: 'latest_tutor', seq: 6, commandId: 'latest_tutor', status: 'completed' }),
    );
    repos.studySessions.insertExchange({
      id: 'aaa_latest_exchange',
      turnId: 'latest_tutor',
      sessionId: 'session_1',
      seq: 6,
      role: 'tutor',
      content: 'most_recent',
      channel: 'conversation',
      createdAt: T0,
    });
    // A clock tie/reversal or lexically smaller ID cannot hide newly published exposure.
    expect(
      repos.studySessions
        .listTutorTeaching('ws_1', undefined, {
          agendaItemId: 'agenda_item_1',
          limit: 2,
          latest: true,
        })
        .map(({ content }) => content),
    ).toEqual(['teaching_5', 'most_recent']);
  });

  it('round-trips session transcript, turn events, and rolling summary in sequence order', () => {
    expect(repos.studySessions.create(session())).toEqual(session());
    expect(repos.studySessions.insertTurn(turn())).toEqual(turn());
    expect(
      repos.studySessions.updateTurn(
        turn({ status: 'failed', errorMessage: 'provider failed' }),
        1,
      ),
    ).toMatchObject({ status: 'failed', errorMessage: 'provider failed' });

    const later: StudyExchange = {
      id: 'exchange_2',
      sessionId: 'session_1',
      turnId: 'turn_1',
      seq: 2,
      role: 'tutor',
      content: 'Try this example.',
      channel: 'conversation',
      createdAt: T1,
    };
    const first: StudyExchange = {
      id: 'exchange_1',
      sessionId: 'session_1',
      turnId: 'turn_1',
      seq: 1,
      role: 'learner',
      content: 'Explain it.',
      channel: 'conversation',
      createdAt: T0,
    };
    repos.studySessions.insertExchange(later);
    repos.studySessions.insertExchange(first);
    expect(repos.studySessions.listExchanges('session_1')).toEqual([first, later]);

    const event: StudyTurnEvent = {
      id: 'event_1',
      sessionId: 'session_1',
      turnId: 'turn_1',
      seq: 0,
      kind: 'completed',
      provisional: false,
      content: null,
      createdAt: T1,
    };
    expect(repos.studySessions.insertTurnEvent(event)).toEqual(event);

    const summary: StudySessionSummary = {
      id: 'summary_1',
      sessionId: 'session_1',
      version: 1,
      throughExchangeSeq: 2,
      contextFingerprint: 'context-1',
      learnerQuestions: ['Explain it.'],
      unresolvedConfusions: [],
      explanationsTried: [],
      provisionalUnderstanding: [],
      openActions: [],
      safetyFlags: [],
      createdAt: T1,
    };
    expect(repos.studySessions.insertSummary(summary)).toEqual(summary);
    expect(repos.studySessions.latestSummary('session_1')).toEqual(summary);
  });

  it('rejects cross-session records and stale session updates', () => {
    repos.studySessions.create(session());
    repos.studySessions.insertTurn(turn());
    expect(() =>
      repos.studySessions.insertExchange({
        id: 'foreign_exchange',
        sessionId: 'other_session',
        turnId: 'turn_1',
        seq: 0,
        role: 'learner',
        content: 'Wrong owner.',
        channel: 'conversation',
        createdAt: T0,
      }),
    ).toThrow('another Session');
    expect(() => repos.studySessions.update(session({ version: 3 }), 1)).toThrow('advance version');
    expect(
      repos.studySessions.update(session({ version: 2, status: 'paused', updatedAt: T1 }), 1),
    ).toMatchObject({
      version: 2,
      status: 'paused',
    });
    expect(() => repos.studySessions.update(session({ version: 2 }), 1)).toThrow('stale');
  });

  it('marks orphaned running turns interrupted after restart', () => {
    repos.studySessions.create(session());
    repos.studySessions.insertTurn(turn({ status: 'running', completedAt: null }));
    expect(repos.studySessions.markInterruptedTurns(T1)).toBe(1);
    expect(repos.studySessions.getTurn('turn_1')).toMatchObject({
      status: 'interrupted',
      completedAt: T1,
    });
    expect(repos.studySessions.listTurnEvents('turn_1')).toEqual([
      expect.objectContaining({ kind: 'interrupted', provisional: false }),
    ]);
  });

  it('updates Agenda execution state without changing its route identity', () => {
    const current = repos.sessionAgendas.get('agenda_1')!;
    const updated = repos.sessionAgendas.update(
      {
        ...current,
        version: 2,
        items: current.items.map((item) => ({ ...item, state: 'deferred' as const })),
        currentItemId: null,
        updatedAt: T1,
      },
      1,
      {
        id: 'agenda_event_1',
        eventType: 'agenda_item_deferred',
        actor: 'learner',
        payload: { reason: 'No time today.' },
        createdAt: T1,
      },
    );
    expect(updated).toMatchObject({ version: 2, status: 'active', currentItemId: null });
    expect(repos.sessionAgendas.get('agenda_1')?.items[0]?.state).toBe('deferred');
    expect(
      db
        .prepare('SELECT event_type FROM session_agenda_events WHERE agenda_id = ?')
        .get('agenda_1'),
    ).toEqual({ event_type: 'agenda_item_deferred' });
    expect(() =>
      repos.sessionAgendas.update({ ...updated, version: 3 }, 1, {
        id: 'agenda_event_stale',
        eventType: 'stale',
        actor: 'learner',
        payload: {},
        createdAt: T1,
      }),
    ).toThrow('stale');
  });
});
