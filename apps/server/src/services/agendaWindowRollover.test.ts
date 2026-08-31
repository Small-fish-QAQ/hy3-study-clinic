import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionAgenda } from '@hy3-clinic/shared';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { FakeProvider } from '../llm/fakeProvider.js';
import type { StudyPlanProposalInput } from '../llm/provider.js';
import { createRepositories, type Repositories } from '../repositories/index.js';
import {
  seedMultiWindowTeachingRoute,
  type MultiWindowRouteFixture,
} from '../testing/multiWindowRouteFixture.js';
import { fixedClock } from '../util/ids.js';
import { createServices, type Services } from './index.js';

const AT = '2026-01-01T00:04:00.000Z';

/** Captures the exact planner input a real provider would receive. */
class CapturingProvider extends FakeProvider {
  captured: StudyPlanProposalInput | null = null;

  override async proposeStudyPlan(...args: Parameters<FakeProvider['proposeStudyPlan']>) {
    this.captured = args[0];
    return super.proposeStudyPlan(...args);
  }
}

let db: SqliteDb;
let repos: Repositories;
let services: Services;
let fixture: MultiWindowRouteFixture;

/** Installs the first Agenda window exactly as plan acceptance does. */
function activateFirstWindow(): SessionAgenda {
  const draft = services.sessionAgendasAgent.composeDraft(
    fixture.contract,
    fixture.curriculum,
    repos.studyPlans.get('plan_1')!,
  );
  const stored = repos.sessionAgendas.create(draft, {
    id: 'agenda_created',
    eventType: 'composed',
    actor: 'local',
    payload: {},
    createdAt: draft.createdAt,
  });
  repos.courseExecution.activateRoute({
    workspaceId: 'ws_1',
    contractId: 'contract_1',
    curriculumId: 'curriculum_1',
    planId: 'plan_1',
    agendaId: stored.id,
    expectedStateVersion: 0,
    expectedActiveContractId: null,
    expectedActiveCurriculumId: null,
    expectedAcceptedPlanId: null,
    expectedActiveAgendaId: null,
    eventId: 'route_activated',
    actor: 'learner',
    acceptedAt: AT,
  });
  return repos.sessionAgendas.get(stored.id)!;
}

/** Plan-item indexes an Agenda window covers, in plan order. */
function windowPlanIndexes(agenda: SessionAgenda): number[] {
  const plan = repos.studyPlans.get('plan_1')!;
  return agenda.items
    .map((item) => plan.items.find((candidate) => candidate.id === item.linkedPlanItemId)?.index)
    .filter((index): index is number => index !== undefined)
    .sort((a, b) => a - b);
}

/**
 * Completes every teaching item in the given window through the production
 * execution-bookkeeping path, without a Lesson provider call.
 */
function completeWindow(agenda: SessionAgenda, commandPrefix: string): void {
  for (const item of agenda.items.filter((candidate) => candidate.state === 'queued')) {
    const live = repos.sessionAgendas.get(agenda.id)!;
    const plan = repos.studyPlans.get('plan_1')!;
    services.agendaWindow.completeTeachingExecution({
      workspaceId: 'ws_1',
      sessionId: 'session_none',
      agenda: live,
      item: live.items.find((candidate) => candidate.id === item.id)!,
      plan,
      planItem: plan.items.find((candidate) => candidate.id === item.linkedPlanItemId)!,
      commandId: `${commandPrefix}-${item.id}`,
      at: AT,
    });
  }
}

/**
 * Completes exactly one teaching item through the production path, leaving the
 * rest of the window queued so it does not roll over.
 */
function completeTeachingItem(agendaId: string, planItemId: string, commandId: string): string {
  const live = repos.sessionAgendas.get(agendaId)!;
  const plan = repos.studyPlans.get('plan_1')!;
  const item = live.items.find((candidate) => candidate.linkedPlanItemId === planItemId)!;
  services.agendaWindow.completeTeachingExecution({
    workspaceId: 'ws_1',
    sessionId: 'session_none',
    agenda: live,
    item,
    plan,
    planItem: plan.items.find((candidate) => candidate.id === planItemId)!,
    commandId,
    at: AT,
  });
  return item.id;
}

function activeAgenda(): SessionAgenda {
  return repos.sessionAgendas.get(repos.courseExecution.get('ws_1').activeAgendaId!)!;
}

/** Starts a learner StudySession on the currently active Agenda window. */
function startSession(agendaId: string) {
  return services.studySessions.start('ws_1', {
    contractVersionId: 'contract_1',
    curriculumVersionId: 'curriculum_1',
    studyPlanVersionId: 'plan_1',
    sessionAgendaId: agendaId,
    expectedCourseExecutionVersion: repos.courseExecution.get('ws_1').version,
  }).session;
}

/**
 * Authoritative learning state that a refused command must leave untouched.
 * Command bookkeeping (`agent_operations` and friends) is deliberately excluded:
 * it is append-only by design and is asserted separately.
 */
const DOMAIN_TABLES = [
  'session_agendas',
  'session_agenda_items',
  'session_agenda_events',
  'study_plan_progress',
  'study_plan_progress_events',
  'coverage_risk_entries',
  'coverage_risk_events',
  'formal_evidence_records',
  'learning_unit_progress',
  'mastery_states',
  'progression_decisions',
  'progression_reconciliations',
  'mistakes',
  'goal_outcomes',
  'review_items',
  'study_sessions',
] as const;

/** Count of deferral events appended to an Agenda's own event log. */
function deferralEventCount(agendaId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM session_agenda_events
         WHERE agenda_id = ? AND event_type = 'agenda_item_deferred'`,
      )
      .get(agendaId) as { n: number }
  ).n;
}

/**
 * Runs a command that must be refused and returns its message. The state
 * assertions that follow stay reachable, so a lost refusal is reported as the
 * regression it causes rather than only as a missing throw.
 */
function refusalMessage(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function domainDigest(): Record<string, string[]> {
  return Object.fromEntries(
    DOMAIN_TABLES.map((table) => [
      table,
      (db.prepare(`SELECT * FROM ${table}`).all() as unknown[])
        .map((row) => JSON.stringify(row))
        .sort(),
    ]),
  );
}

function durableCreditState() {
  return {
    formalEvidence: repos.formalProgression.listEvidenceForWorkspace('ws_1'),
    decisions: repos.formalProgression.listDecisionsForWorkspace('ws_1'),
    unitProgress: repos.formalProgression.listUnitProgress('ws_1', 'curriculum_1'),
    goalOutcomes: repos.formalProgression.listGoalOutcomes('ws_1'),
    mastery: repos.mastery.listByWorkspace('ws_1'),
    openMistakes: repos.mistakes.listOpenByWorkspace('ws_1'),
  };
}

function planSnapshot() {
  const plan = repos.studyPlans.get('plan_1')!;
  return {
    id: plan.id,
    status: plan.status,
    version: plan.version,
    learnerAcceptedAt: plan.learnerAcceptedAt,
    items: JSON.stringify(plan.items),
    rationale: plan.rationale,
  };
}

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  repos = createRepositories(db);
  fixture = seedMultiWindowTeachingRoute(db, repos, {
    teachUnitCount: 5,
    preferredSessionMinutes: 30,
    estimatedMinutesPerItem: 15,
  });
  services = createServices({ repos, provider: new FakeProvider(), clock: fixedClock(AT) });
});

describe('same-plan Agenda window continuation', () => {
  it('T1/T5 completes teaching execution and continues the same Plan into window two', () => {
    const first = activateFirstWindow();
    expect(windowPlanIndexes(first)).toEqual([0, 1]);

    completeWindow(first, 'window-1');

    const retired = repos.sessionAgendas.get(first.id)!;
    expect(retired.status).toBe('completed');
    expect(retired.items.every((item) => item.state === 'completed')).toBe(true);
    expect(
      repos.studyPlans
        .listProgress('plan_1')
        .filter((entry) => entry.state === 'completed')
        .map((entry) => entry.planItemId),
    ).toEqual(['plan_item_1', 'plan_item_2']);

    const successor = activeAgenda();
    expect(successor.id).not.toBe(first.id);
    expect(successor.status).toBe('active');
    expect(windowPlanIndexes(successor)).toEqual([2, 3]);
    const overlap = successor.items.filter((item) =>
      retired.items.some((prior) => prior.linkedPlanItemId === item.linkedPlanItemId),
    );
    expect(overlap).toHaveLength(0);
  });

  it('T6 reaches the fifth teaching item through a third window', () => {
    const first = activateFirstWindow();
    completeWindow(first, 'window-1');
    const second = activeAgenda();
    expect(windowPlanIndexes(second)).toEqual([2, 3]);

    completeWindow(second, 'window-2');
    const third = activeAgenda();

    expect(windowPlanIndexes(third)).toEqual([4]);
    expect(repos.sessionAgendas.get(second.id)!.status).toBe('completed');
    expect(third.items.some((item) => item.linkedPlanItemId === 'plan_item_5')).toBe(true);
    expect(
      repos.sessionAgendas
        .list('ws_1')
        .map((agenda) => agenda.status)
        .filter((status) => status === 'active'),
    ).toHaveLength(1);
  });

  it('T3/T8/T9/T21/T22 keeps formal credit and the accepted Plan untouched across rollover', () => {
    const first = activateFirstWindow();
    const creditBefore = durableCreditState();
    const planBefore = planSnapshot();

    completeWindow(first, 'window-1');

    expect(durableCreditState()).toEqual(creditBefore);
    expect(durableCreditState().formalEvidence).toHaveLength(0);
    expect(durableCreditState().goalOutcomes).toHaveLength(0);
    expect(planSnapshot()).toEqual(planBefore);
    expect(planSnapshot().status).toBe('accepted');
    // No learner decision participated in the continuation.
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM course_execution_events
           WHERE workspace_id = 'ws_1' AND actor = 'learner' AND event_type <> 'route_activated'`,
        )
        .get(),
    ).toEqual({ n: 0 });
  });

  it('T7 retires the finished window as completed rather than abandoned', () => {
    const first = activateFirstWindow();
    completeWindow(first, 'window-1');

    expect(repos.sessionAgendas.get(first.id)!.status).toBe('completed');
    const events = db
      .prepare(`SELECT event_type FROM session_agenda_events WHERE agenda_id = ? ORDER BY seq`)
      .all(first.id) as Array<{ event_type: string }>;
    expect(events.map((event) => event.event_type)).toContain('agenda_window_completed');
    expect(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM course_execution_events
             WHERE workspace_id = 'ws_1' AND event_type = 'agenda_window_rolled_over'`,
          )
          .get() as { n: number }
      ).n,
    ).toBe(1);
  });

  it('T10 replays a completed drain without creating a second successor', () => {
    const first = activateFirstWindow();
    completeWindow(first, 'window-1');
    const successorId = activeAgenda().id;
    const agendaCount = repos.sessionAgendas.list('ws_1').length;

    // Re-offering the drain finds the successor window already installed and
    // still holding actionable work, so nothing further is created.
    const replay = services.agendaWindow.continueIfDrained('ws_1', 'window-1-replay');
    completeWindow(first, 'window-1');

    expect(replay).toEqual({ status: 'not_drained' });
    expect(activeAgenda().id).toBe(successorId);
    expect(repos.sessionAgendas.list('ws_1')).toHaveLength(agendaCount);
    expect(
      repos.sessionAgendas.list('ws_1').filter((agenda) => agenda.status === 'active'),
    ).toHaveLength(1);
  });

  it('T11 fences a concurrent installation on the same drained window', () => {
    const first = activateFirstWindow();
    const stateBefore = repos.courseExecution.get('ws_1');
    completeWindow(first, 'window-1');
    const successorId = activeAgenda().id;
    const agendaCount = repos.sessionAgendas.list('ws_1').length;

    // A racer that read the pre-rollover state now tries to install its own
    // successor against the same retired window.
    const rival = services.sessionAgendasAgent.composeDraft(
      fixture.contract,
      fixture.curriculum,
      repos.studyPlans.get('plan_1')!,
    );
    expect(() =>
      repos.transaction(() => {
        const stored = repos.sessionAgendas.create(rival, {
          id: 'rival_agenda',
          eventType: 'composed',
          actor: 'local',
          payload: {},
          createdAt: AT,
        });
        repos.courseExecution.rolloverAgendaWindow({
          workspaceId: 'ws_1',
          contractId: 'contract_1',
          curriculumId: 'curriculum_1',
          planId: 'plan_1',
          outgoingAgendaId: first.id,
          successorAgendaId: stored.id,
          expectedStateVersion: stateBefore.version,
          expectedOutgoingAgendaVersion: first.version,
          eventId: 'rival_course_evt',
          actor: 'local',
          at: AT,
        });
      }),
    ).toThrow(/stale|concurrently/i);

    expect(activeAgenda().id).toBe(successorId);
    expect(repos.sessionAgendas.list('ws_1')).toHaveLength(agendaCount);
    expect(
      repos.sessionAgendas.list('ws_1').filter((agenda) => agenda.status === 'active'),
    ).toHaveLength(1);
    expect(repos.formalProgression.listGoalOutcomes('ws_1')).toHaveLength(0);
  });

  it('T11 rolls back a successor draft when the pointer swap loses its race', () => {
    const first = activateFirstWindow();
    const drained = repos.sessionAgendas.get(first.id)!;
    repos.sessionAgendas.update(
      {
        ...drained,
        version: drained.version + 1,
        items: drained.items.map((item) => ({ ...item, state: 'completed' as const })),
        currentItemId: null,
        updatedAt: AT,
      },
      drained.version,
      { id: 'drain', eventType: 'drained', actor: 'local', payload: {}, createdAt: AT },
    );
    const retired = repos.sessionAgendas.get(first.id)!;
    const state = repos.courseExecution.get('ws_1');
    const draft = services.sessionAgendasAgent.composeDraft(
      fixture.contract,
      fixture.curriculum,
      repos.studyPlans.get('plan_1')!,
    );
    const agendaCount = repos.sessionAgendas.list('ws_1').length;

    expect(() =>
      repos.transaction(() => {
        const stored = repos.sessionAgendas.create(draft, {
          id: 'draft_agenda',
          eventType: 'composed',
          actor: 'local',
          payload: {},
          createdAt: AT,
        });
        repos.courseExecution.rolloverAgendaWindow({
          workspaceId: 'ws_1',
          contractId: 'contract_1',
          curriculumId: 'curriculum_1',
          planId: 'plan_1',
          outgoingAgendaId: first.id,
          successorAgendaId: stored.id,
          expectedStateVersion: state.version,
          expectedOutgoingAgendaVersion: retired.version,
          eventId: 'raced_course_evt',
          actor: 'local',
          // A rival commits the pointer move first.
          beforePointerSwap: () => {
            db.prepare(
              `UPDATE course_execution_state SET version = version + 1
               WHERE workspace_id = 'ws_1'`,
            ).run();
          },
          at: AT,
        });
      }),
    ).toThrow(/changed concurrently/i);

    // No orphan successor draft survived the failed installation.
    expect(repos.sessionAgendas.list('ws_1')).toHaveLength(agendaCount);
    expect(repos.sessionAgendas.get(first.id)!.status).toBe('active');
    expect(repos.formalProgression.listGoalOutcomes('ws_1')).toHaveLength(0);
  });

  it('T12 refuses to continue a stale route and installs nothing', () => {
    const first = activateFirstWindow();
    // Drain the window without letting the completion trigger continue it.
    const drained = repos.sessionAgendas.get(first.id)!;
    repos.sessionAgendas.update(
      {
        ...drained,
        version: drained.version + 1,
        items: drained.items.map((item) => ({ ...item, state: 'completed' as const })),
        currentItemId: null,
        updatedAt: AT,
      },
      drained.version,
      { id: 'drain', eventType: 'drained', actor: 'local', payload: {}, createdAt: AT },
    );
    db.prepare(
      `UPDATE course_execution_state SET route_validation_status = 'revalidation_required'
       WHERE workspace_id = 'ws_1'`,
    ).run();
    const agendaCount = repos.sessionAgendas.list('ws_1').length;

    const result = services.agendaWindow.continueIfDrained('ws_1', 'stale-route');

    expect(result).toEqual({ status: 'refused', reason: 'route_revalidation_required' });
    expect(repos.sessionAgendas.list('ws_1')).toHaveLength(agendaCount);
    expect(repos.courseExecution.get('ws_1').activeAgendaId).toBe(first.id);
    expect(repos.studyPlans.get('plan_1')!.status).toBe('accepted');
    expect(repos.formalProgression.listGoalOutcomes('ws_1')).toHaveLength(0);
  });

  it('T13 installs nothing when remaining work has no launchable successor item', () => {
    const first = activateFirstWindow();
    completeWindow(first, 'window-1');
    const second = activeAgenda();
    // Remaining plan items exist but none can launch.
    // A teach_unit launches on a current concept or visual; removing both
    // leaves genuine remaining work that cannot be launched.
    db.prepare(`DELETE FROM concepts WHERE id = 'con_1'`).run();
    const agendaCount = repos.sessionAgendas.list('ws_1').length;

    completeWindow(second, 'window-2');
    const result = services.agendaWindow.continueIfDrained('ws_1', 'blocked-successor');

    expect(['blocked_successor', 'refused']).toContain(result.status);
    expect(repos.sessionAgendas.list('ws_1')).toHaveLength(agendaCount);
    expect(repos.courseExecution.get('ws_1').activeAgendaId).toBe(second.id);
    expect(repos.formalProgression.listGoalOutcomes('ws_1')).toHaveLength(0);
  });

  it('T14/T15 creates no successor for the last window and still refuses achieved', () => {
    let window = activateFirstWindow();
    for (let index = 0; index < 3; index += 1) {
      completeWindow(window, `window-${index + 1}`);
      window = activeAgenda();
    }
    const agendaCount = repos.sessionAgendas.list('ws_1').length;

    const result = services.agendaWindow.continueIfDrained('ws_1', 'last-window');

    expect(result).toEqual({ status: 'no_remaining_work' });
    expect(repos.sessionAgendas.list('ws_1')).toHaveLength(agendaCount);
    expect(repos.formalProgression.listGoalOutcomes('ws_1')).toHaveLength(0);
    expect(
      repos.studyPlans.listProgress('plan_1').every((entry) => entry.state === 'completed'),
    ).toBe(true);

    // Teaching completion granted no formal LearningUnit credit, so the learner
    // cannot close the Course as achieved.
    expect(() =>
      services.formalProgression.recordGoalOutcome({
        command: {
          commandId: 'goal-achieved',
          idempotencyKey: 'goal-achieved',
          workspaceId: 'ws_1',
          actor: 'learner',
        },
        expectedCourseExecutionVersion: repos.courseExecution.get('ws_1').version,
        expectedContractVersionId: 'contract_1',
        expectedCurriculumVersionId: 'curriculum_1',
        expectedStudyPlanVersionId: 'plan_1',
        expectedAgendaVersionId: activeAgenda().id,
        status: 'achieved',
        unresolvedRiskIds: [],
        reason: 'Teaching finished, so the Course looks done.',
      }),
    ).toThrow(/incomplete|remains|deferred/i);
  });

  it('T2 rolls back the agenda half when the Plan-progress half fails', () => {
    const first = activateFirstWindow();
    const target = first.items[0]!;
    const plan = repos.studyPlans.get('plan_1')!;
    // Force the second write to fail on a stale progress version.
    const original = repos.studyPlans.updateProgress;
    repos.studyPlans.updateProgress = (() => {
      throw new Error('forced plan-progress failure');
    }) as unknown as typeof original;

    expect(() =>
      services.agendaWindow.completeTeachingExecution({
        workspaceId: 'ws_1',
        sessionId: 'session_none',
        agenda: first,
        item: target,
        plan,
        planItem: plan.items.find((item) => item.id === target.linkedPlanItemId)!,
        commandId: 'torn-write',
        at: AT,
      }),
    ).toThrow(/forced plan-progress failure/);
    repos.studyPlans.updateProgress = original;

    // Neither half survived: no torn state.
    expect(
      repos.sessionAgendas.get(first.id)!.items.find((item) => item.id === target.id)!.state,
    ).toBe('queued');
    expect(
      repos.studyPlans
        .listProgress('plan_1')
        .find((entry) => entry.planItemId === target.linkedPlanItemId)!.state,
    ).toBe('not_started');
    expect(repos.sessionAgendas.get(first.id)!.status).toBe('active');
    expect(repos.courseExecution.get('ws_1').activeAgendaId).toBe(first.id);
  });

  it('T4 never leaves an agenda item completed while its Plan item still needs scheduling', () => {
    const first = activateFirstWindow();
    completeWindow(first, 'window-1');

    const progress = new Map(
      repos.studyPlans.listProgress('plan_1').map((entry) => [entry.planItemId, entry.state]),
    );
    for (const agenda of repos.sessionAgendas.list('ws_1')) {
      for (const item of agenda.items) {
        if (item.state !== 'completed' || !item.linkedPlanItemId) continue;
        expect(progress.get(item.linkedPlanItemId)).toBe('completed');
      }
    }
  });

  it('does not continue a window that still has actionable work', () => {
    const first = activateFirstWindow();
    const plan = repos.studyPlans.get('plan_1')!;
    const target = first.items[0]!;

    const result = services.agendaWindow.completeTeachingExecution({
      workspaceId: 'ws_1',
      sessionId: 'session_none',
      agenda: first,
      item: target,
      plan,
      planItem: plan.items.find((item) => item.id === target.linkedPlanItemId)!,
      commandId: 'partial-window',
      at: AT,
    });

    expect(result.continuation).toEqual({ status: 'not_drained' });
    expect(activeAgenda().id).toBe(first.id);
    expect(repos.sessionAgendas.get(first.id)!.status).toBe('active');
  });

  it('T24 never calls an execution-completed Plan state formally_supported', async () => {
    const first = activateFirstWindow();
    completeWindow(first, 'window-1');
    expect(
      repos.studyPlans.listProgress('plan_1').find((e) => e.planItemId === 'plan_item_1')!.state,
    ).toBe('completed');

    const capturing = new CapturingProvider();
    const planner = createServices({
      repos,
      provider: capturing,
      clock: fixedClock(AT),
    });
    await planner.studyPlansAgent
      .propose({
        command: {
          commandId: 'label-probe',
          idempotencyKey: 'label-probe',
          workspaceId: 'ws_1',
          actor: 'local',
        },
        contractId: 'contract_1',
        expectedContractVersion: 1,
        curriculumId: 'curriculum_1',
        expectedCurriculumVersion: 1,
        expectedExecutionSourceManifestFingerprint: 'manifest-fp',
        predecessorStudyPlanId: 'plan_1',
        expectedAcceptedStudyPlanId: 'plan_1',
        proposalTrigger: 'Probe the learner-state vocabulary.',
      })
      .catch(() => undefined);

    const learnerState = capturing.captured?.learnerState ?? [];
    expect(learnerState.length).toBeGreaterThan(0);
    const taughtUnit = learnerState.find((entry) => entry.curriculumLearningUnitId === 'unit_1');
    expect(taughtUnit?.state).toBe('route_completed');
    expect(JSON.stringify(capturing.captured)).not.toContain('formally_supported');
  });

  it('T23 never adopts a merely proposed replacement Plan during continuation', () => {
    const first = activateFirstWindow();
    // A replacement Plan exists but the learner has not decided on it.
    const accepted = repos.studyPlans.get('plan_1')!;
    const successorPlan = {
      ...accepted,
      id: 'plan_2',
      version: 2,
      predecessorId: 'plan_1',
      status: 'proposed' as const,
      learnerAcceptedAt: null,
      paceBaseline: { ...accepted.paceBaseline!, id: 'pace_2', studyPlanVersionId: 'plan_2' },
    };
    repos.studyPlans.createVersion(
      successorPlan,
      successorPlan.items.map((item) => ({
        planItemId: item.id,
        launch: {
          status: 'launchable' as const,
          capability: 'lesson',
          resourceId: JSON.stringify({ learningUnitId: 'unit_1', conceptId: 'con_1' }),
          reason: null,
        },
        sourceFingerprint: 'manifest-fp',
        validatedAt: AT,
      })),
      { id: 'plan_2_created', eventType: 'proposed', actor: 'local', payload: {}, createdAt: AT },
    );

    completeWindow(first, 'window-1');

    // Continuation stayed on the accepted Plan and left the proposal untouched.
    const successorAgenda = activeAgenda();
    expect(successorAgenda.studyPlanVersionId).toBe('plan_1');
    expect(repos.courseExecution.get('ws_1').acceptedPlanId).toBe('plan_1');
    expect(repos.studyPlans.get('plan_2')!.status).toBe('proposed');
    expect(repos.studyPlans.get('plan_2')!.learnerAcceptedAt).toBeNull();
    expect(repos.studyPlans.get('plan_1')!.status).toBe('accepted');
    // Adopting it still requires the existing learner-decision path.
    expect(repos.studyPlans.list('ws_1').filter((plan) => plan.status === 'accepted')).toHaveLength(
      1,
    );
  });

  it('hands off a live StudySession bound to the retired window', () => {
    const first = activateFirstWindow();
    const execution = repos.courseExecution.get('ws_1');
    const session = services.studySessions.start('ws_1', {
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      sessionAgendaId: first.id,
      expectedCourseExecutionVersion: execution.version,
    }).session;

    completeWindow(first, 'window-1');

    const handedOff = repos.studySessions.get(session.id)!;
    expect(handedOff.status).toBe('completed');
    expect(handedOff.currentAgendaItemId).toBeNull();
    expect(handedOff.sessionAgendaId).toBe(first.id);
    // Starting work on the successor produces a session of its own.
    const successor = activeAgenda();
    const next = services.studySessions.start('ws_1', {
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      sessionAgendaId: successor.id,
      expectedCourseExecutionVersion: repos.courseExecution.get('ws_1').version,
    }).session;
    expect(next.id).not.toBe(session.id);
    expect(next.sessionAgendaId).toBe(successor.id);
  });
});

describe('learner defer never regresses completed execution bookkeeping', () => {
  it('T26 refuses a defer naming a teaching item already completed, writing nothing', () => {
    const first = activateFirstWindow();
    const taughtItemId = completeTeachingItem(first.id, 'plan_item_1', 'teach-1');
    // The window still holds its second teaching item, so nothing rolled over
    // and the completed item is still nameable in the active Agenda.
    expect(activeAgenda().id).toBe(first.id);
    expect(activeAgenda().items.find((item) => item.id === taughtItemId)!.state).toBe('completed');
    expect(
      repos.studyPlans.listProgress('plan_1').find((entry) => entry.planItemId === 'plan_item_1')!
        .state,
    ).toBe('completed');
    const session = startSession(first.id);
    const before = domainDigest();

    expect(
      refusalMessage(() =>
        services.studySessions.command('ws_1', session.id, {
          commandId: 'defer_completed_teaching',
          expectedSessionVersion: session.version,
          kind: 'defer',
          targetAgendaItemId: taughtItemId,
          reason: 'Not now.',
        }),
      ),
    ).toBe('Completed Agenda work cannot be deferred.');

    expect(domainDigest()).toEqual(before);
    expect(activeAgenda().items.find((item) => item.id === taughtItemId)!.state).toBe('completed');
    expect(
      repos.studyPlans.listProgress('plan_1').find((entry) => entry.planItemId === 'plan_item_1')!
        .state,
    ).toBe('completed');
    expect(repos.coverageRisks.list('ws_1', 'contract_1')).toHaveLength(0);
    expect(deferralEventCount(first.id)).toBe(0);

    // Replaying the same refusal under a fresh command id accumulates nothing.
    expect(
      refusalMessage(() =>
        services.studySessions.command('ws_1', session.id, {
          commandId: 'defer_completed_teaching_replay',
          expectedSessionVersion: session.version,
          kind: 'defer',
          targetAgendaItemId: taughtItemId,
          reason: 'Not now.',
        }),
      ),
    ).toBe('Completed Agenda work cannot be deferred.');
    expect(domainDigest()).toEqual(before);
  });

  it('T27 still defers an unfinished teaching item and records its risk', () => {
    const first = activateFirstWindow();
    completeTeachingItem(first.id, 'plan_item_1', 'teach-1');
    const unfinished = activeAgenda().items.find(
      (item) => item.linkedPlanItemId === 'plan_item_2',
    )!;
    expect(unfinished.state).toBe('queued');
    const session = startSession(first.id);
    const before = domainDigest();

    const deferred = services.studySessions.command('ws_1', session.id, {
      commandId: 'defer_unfinished_teaching',
      expectedSessionVersion: session.version,
      kind: 'defer',
      targetAgendaItemId: unfinished.id,
      reason: 'Not now.',
    });

    // The pre-existing deferral semantics are unchanged.
    expect(deferred.agenda.items.find((item) => item.id === unfinished.id)!.state).toBe('deferred');
    expect(
      repos.studyPlans.listProgress('plan_1').find((entry) => entry.planItemId === 'plan_item_2')!
        .state,
    ).toBe('deferred');
    expect(repos.coverageRisks.list('ws_1', 'contract_1')).toEqual([
      expect.objectContaining({ facets: ['intentionally_deferred'], status: 'deferred' }),
    ]);
    expect(deferralEventCount(first.id)).toBe(1);
    // The digest genuinely observes a legitimate deferral, so the unchanged
    // digest asserted for the refusal above is not blind.
    expect(domainDigest()).not.toEqual(before);
    // Completed work stayed completed regardless.
    expect(
      repos.studyPlans.listProgress('plan_1').find((entry) => entry.planItemId === 'plan_item_1')!
        .state,
    ).toBe('completed');
  });

  it('T28 fails closed when only the linked Plan progress is already completed', () => {
    const first = activateFirstWindow();
    const split = first.items.find((item) => item.linkedPlanItemId === 'plan_item_2')!;
    // Adversarial split state built through the repository writer: the Agenda
    // item still looks deferable while its durable Plan progress is completed.
    const progress = repos.studyPlans
      .listProgress('plan_1')
      .find((entry) => entry.planItemId === 'plan_item_2')!;
    repos.studyPlans.updateProgress(
      'plan_1',
      'plan_item_2',
      progress.version,
      'completed',
      'split_state_progress_event',
      'Legacy or adversarial completion without an Agenda state.',
      AT,
    );
    expect(split.state).toBe('queued');
    const session = startSession(first.id);
    const before = domainDigest();

    expect(
      refusalMessage(() =>
        services.studySessions.command('ws_1', session.id, {
          commandId: 'defer_split_state',
          expectedSessionVersion: session.version,
          kind: 'defer',
          targetAgendaItemId: split.id,
          reason: 'Not now.',
        }),
      ),
    ).toBe('Completed StudyPlan work cannot be deferred.');

    // No downgrade, and no half-written contradiction either.
    expect(
      repos.studyPlans.listProgress('plan_1').find((entry) => entry.planItemId === 'plan_item_2')!
        .state,
    ).toBe('completed');
    expect(activeAgenda().items.find((item) => item.id === split.id)!.state).toBe('queued');
    expect(repos.coverageRisks.list('ws_1', 'contract_1')).toHaveLength(0);
    expect(domainDigest()).toEqual(before);
  });
});
