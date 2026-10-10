import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CourseLearningProgress,
  FormalProgressionOverview,
  LessonExecutionProjection,
  MixedInitiativeCommandResponse,
  SessionExecutionCommandResponse,
  StudySessionDetailResponse,
  SubmitTutorTurnResponse,
} from '@hy3-clinic/shared';
import { ProviderError } from '../llm/errors.js';
import { buildTestApp, type TestApp } from '../testing/testApp.js';
import {
  goldenCommand,
  goldenLessonCommand,
  goldenOverview,
  goldenRequest,
  prepareGoldenCourse,
  prepareGoldenLesson,
  presentGoldenLesson,
  startGoldenStudy,
} from '../testing/courseWorkflow.js';
import {
  GOLDEN_ANSWERS,
  goldenProvider,
  publicOptionId,
  type GoldenGenerationHooks,
} from '../testing/goldenCourseFixture.js';

let context: TestApp | undefined;
let directory: string | undefined;
afterEach(async () => {
  await context?.app.close();
  context = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

async function setup(hooks: GoldenGenerationHooks = {}, databasePath?: string) {
  const tracked = goldenProvider(hooks);
  context = buildTestApp({ provider: tracked.provider, databasePath });
  const course = await prepareGoldenCourse(context.app);
  const { session, item } = await startGoldenStudy(context.app, course);
  const workspaceId = course.workspace.id;
  const base = `/api/workspaces/${workspaceId}`;
  const sessionBase = `${base}/study-sessions/${session.id}`;
  return { tracked, course, session, item, workspaceId, base, sessionBase };
}

type Route = Awaited<ReturnType<typeof setup>>;

async function savedState(route: Route) {
  const active = context!;
  return {
    detail: await goldenRequest<StudySessionDetailResponse>(active.app, route.sessionBase),
    lesson: await goldenRequest<LessonExecutionProjection>(
      active.app,
      `${route.sessionBase}/lesson-execution`,
    ),
    overview: await goldenOverview(active.app, route.workspaceId),
    learning: await goldenRequest<CourseLearningProgress>(
      active.app,
      `${route.base}/learning-progress`,
    ),
    progression: await goldenRequest<FormalProgressionOverview>(
      active.app,
      `${route.base}/progression`,
    ),
    curriculum: active.repos.curricula.get(route.course.curriculum.id),
    plan: active.repos.studyPlans.get(route.course.overview.acceptedStudyPlan!.id),
    planProgress: active.repos.studyPlans.listProgress(route.course.overview.acceptedStudyPlan!.id),
    mastery: active.repos.mastery.listByWorkspace(route.workspaceId),
  };
}

function expectNoCredit(route: Route, saved: Awaited<ReturnType<typeof savedState>>) {
  expect(saved.curriculum).toEqual(route.course.curriculum);
  expect(saved.plan).toEqual(route.course.overview.acceptedStudyPlan);
  expect(saved.overview.formalProgress.completedPlanItemCount).toBe(0);
  expect(saved.progression.evidence).toEqual([]);
  expect(saved.progression.goalOutcomes).toEqual([]);
  expect(saved.learning.summary).toMatchObject({ teachingCompleted: 0, supportedObjectives: 0 });
  expect(saved.learning.units.every((unit) => unit.formalState !== 'complete')).toBe(true);
  expect(saved.mastery).toEqual([]);
}

function artifacts(route: Route) {
  const repos = context!.repos;
  const state = repos.lessonExecution.getForSession(route.session.id, route.item.id)!;
  // During a gated composition the checkpoint already exists, while its ID
  // reaches the outer execution state only on completion/failure cleanup.
  const checkpointRow = context!.db
    .prepare(
      'SELECT id FROM accepted_lesson_checkpoints WHERE study_session_id = ? AND agenda_item_id = ?',
    )
    .get(route.session.id, route.item.id) as { id: string } | undefined;
  return {
    checkpoint: checkpointRow ? repos.acceptedLessonCheckpoints.get(checkpointRow.id) : null,
    brief: state.teachingBriefId ? repos.teachingBriefs.get(state.teachingBriefId) : null,
  };
}

function logCalls(label: string, route: Route) {
  console.info(`Golden Recovery ${label} Provider calls:`, JSON.stringify(route.tracked.calls));
}

describe('Golden Course representative recovery journeys', () => {
  it('keeps a failed Retest unresolved and executes another offered Repair', async () => {
    const route = await setup();
    const { app } = context!;
    let current = await prepareGoldenLesson(
      app,
      route.workspaceId,
      route.session.id,
      route.item.id,
      'retest-prepare',
    );
    current = await presentGoldenLesson(
      app,
      route.workspaceId,
      route.session,
      route.item.id,
      current,
    );
    const accepted = artifacts(route);
    const act = async (id: string, action: Parameters<typeof goldenLessonCommand>[6]) => {
      current = await goldenLessonCommand(
        app,
        route.workspaceId,
        route.session.id,
        route.item.id,
        current,
        id,
        action,
      );
    };
    const task = current.practice!.item!;
    await act('wrong-practice', {
      kind: 'submit_practice_response',
      itemIndex: task.index,
      optionId: publicOptionId(task.options, GOLDEN_ANSWERS.wrongPractice),
    });
    await act('first-repair', {
      kind: 'prepare_practice_repair',
      learnerNote: '我忽略了必要条件。',
    });
    await act('first-retest', { kind: 'start_practice_retest' });
    const retest = current.practice!.recovery!.retest!;
    const beforeAnswer = { ...route.tracked.calls };
    await act('wrong-retest', {
      kind: 'submit_practice_retest',
      index: retest.index,
      optionId: publicOptionId(retest.options, GOLDEN_ANSWERS.wrongRetest),
    });
    expect(route.tracked.calls).toEqual(beforeAnswer);
    expect(current.practice).toMatchObject({
      status: 'in_progress',
      completedAt: null,
      credit: 'none',
      recovery: { phase: 'diagnosis', selectedAnswer: GOLDEN_ANSWERS.wrongRetest, retest: null },
    });
    expect(current.practice!.attempts[0]!.correct).toBe(false);
    expect(current.practice!.attempts[0]!.recovered).not.toBe(true);
    expect(current.allowedActions).toEqual(['prepare_practice_repair']);
    expect(current.practice!.recovery!.feedback).toContain('阀门');
    const failed = await savedState(route);
    expectNoCredit(route, failed);
    expect(failed.detail.agenda.items.find((item) => item.id === route.item.id)!.state).toBe(
      route.item.state,
    );
    expect(failed.learning.repairs).toEqual([
      expect.objectContaining({ kind: 'practice', resolved: false, current: true }),
    ]);
    expect(artifacts(route)).toEqual(accepted);
    expect(route.tracked.calls).toEqual(beforeAnswer);
    // Use the offered next round, without rewriting the original failed answer.
    await act('second-repair', {
      kind: 'prepare_practice_repair',
      learnerNote: '水源充足不能代替对应阀门开启。',
    });
    expect(current.practice!.recovery).toMatchObject({ phase: 'repair', round: 2 });
    expect(current.allowedActions).toEqual(['start_practice_retest']);
    expect(current.practice!.attempts[0]!.correct).toBe(false);
    expect(current.practice!.attempts[0]!.recovered).not.toBe(true);
    const state = context!.repos.lessonExecution.getForSession(route.session.id, route.item.id)!;
    expect(state.practiceInteractions[0]!.recovery!.rounds).toHaveLength(2);
    expect(state.practiceInteractions[0]!.recovery!.rounds[0]!.responses[0]!.correct).toBe(false);
    expectNoCredit(route, await savedState(route));
    expect(artifacts(route)).toEqual(accepted);
    expect(route.tracked.calls.generatePracticeRepair).toBe(2);
    expect(route.tracked.calls.generateLessonSlotContent).toBe(1);
    expect(route.tracked.calls.generatePracticeContent).toBe(1);
    logCalls('failed Retest', route);
  }, 120_000);

  it.each(['lesson', 'practice'] as const)(
    'retries a controlled %s generation failure without replacing accepted content',
    async (phase) => {
      let failOnce = true;
      const route = await setup({
        [phase]: () => {
          if (failOnce) {
            failOnce = false;
            throw ProviderError.network();
          }
        },
      });
      const { app } = context!;
      const failed = await prepareGoldenLesson(
        app,
        route.workspaceId,
        route.session.id,
        route.item.id,
        `${phase}-failure`,
      );
      expect(failed.status).toBe(
        phase === 'lesson' ? 'retry_available' : 'practice_retry_available',
      );
      expect(failed.allowedActions).toEqual(['retry_preparation']);
      expect(failed.practice ?? null).toBeNull();
      const accepted = artifacts(route);
      expect(accepted.brief).toBeNull();
      if (phase === 'lesson') {
        expect(failed.lesson).toBeNull();
        expect(accepted.checkpoint).toBeNull();
      } else {
        expect(failed.lesson).not.toBeNull();
        expect(accepted.checkpoint!.executionSourceManifestFingerprint).toBe(
          route.course.curriculum.executionSourceManifest.fingerprint,
        );
      }
      const failedOperation = context!.repos.operations
        .listForWorkspace(route.workspaceId, 'prepare_teaching_brief')
        .find((operation) => operation.status === 'failed')!;
      expect(context!.repos.operations.getResult(failedOperation.id)).toMatchObject({
        status: 'failed',
        payload: {
          preparationFailure: {
            phase,
            failureClass: 'TRANSPORT',
            checkpointPreserved: phase === 'practice',
          },
        },
      });
      const callsAtFailure = { ...route.tracked.calls };
      const saved = await savedState(route);
      expect(saved.lesson).toEqual(failed);
      expectNoCredit(route, saved);
      expect(route.tracked.calls).toEqual(callsAtFailure);
      const ready = await prepareGoldenLesson(
        app,
        route.workspaceId,
        route.session.id,
        route.item.id,
        `${phase}-retry`,
      );
      expect(ready.status).toBe('ready');
      expect(ready.allowedActions).toContain('start_lesson');
      if (phase === 'practice') {
        expect(ready.lesson).toEqual(failed.lesson);
        expect(artifacts(route).checkpoint).toEqual(accepted.checkpoint);
        expect(artifacts(route).brief!.composition!.acceptedLessonCheckpointId).toBe(
          accepted.checkpoint!.id,
        );
      }
      expect(route.tracked.calls.generateLessonSlotContent).toBe(phase === 'lesson' ? 2 : 1);
      expect(route.tracked.calls.generatePracticeContent).toBe(phase === 'practice' ? 2 : 1);
      const callsAtRetry = { ...route.tracked.calls };
      expect(
        await prepareGoldenLesson(
          app,
          route.workspaceId,
          route.session.id,
          route.item.id,
          `${phase}-reuse`,
        ),
      ).toEqual(ready);
      await goldenLessonCommand(
        app,
        route.workspaceId,
        route.session.id,
        route.item.id,
        ready,
        `${phase}-continue`,
        { kind: 'start_lesson' },
      );
      expectNoCredit(route, await savedState(route));
      expect(route.tracked.calls).toEqual(callsAtRetry);
      logCalls(`${phase} failure`, route);
    },
    120_000,
  );

  it('defers unfinished teaching through a learner command, retains the gap and rejects achieved', async () => {
    const route = await setup();
    const { app } = context!;
    let lesson = await prepareGoldenLesson(
      app,
      route.workspaceId,
      route.session.id,
      route.item.id,
      'defer-prepare',
    );
    lesson = await goldenLessonCommand(
      app,
      route.workspaceId,
      route.session.id,
      route.item.id,
      lesson,
      'defer-start',
      { kind: 'start_lesson' },
    );
    const accepted = artifacts(route);
    const callsBefore = { ...route.tracked.calls };
    const input = {
      commandId: 'learner-defer',
      expectedSessionVersion: lesson.session.version,
      kind: 'defer',
      targetAgendaItemId: route.item.id,
      reason: '今天先暂停这部分，明天补上。',
    };
    const deferred = await goldenRequest<MixedInitiativeCommandResponse>(
      app,
      `${route.sessionBase}/commands`,
      input,
    );
    expect(deferred.agenda.items.find((item) => item.id === route.item.id)!.state).toBe('deferred');
    expect(deferred.session.currentAgendaItemId).not.toBe(route.item.id);
    const saved = await savedState(route);
    expectNoCredit(route, saved);
    expect(saved.overview.formalProgress.deferredPlanItemCount).toBe(1);
    expect(
      saved.planProgress.find((entry) => entry.planItemId === route.item.linkedPlanItemId)!.state,
    ).toBe('deferred');
    expect(saved.learning.lessons[0]!.completedAt).toBeNull();
    const risks = context!.repos.coverageRisks.list(route.workspaceId, route.course.contract.id);
    expect(risks).toEqual([
      expect.objectContaining({
        status: 'deferred',
        origin: 'learner',
        facets: ['intentionally_deferred'],
        topicId: route.item.learningUnitId,
        learnerDecisionId: input.commandId,
        resolutionEvidenceIds: [],
      }),
    ]);
    expect(saved.overview.riskSummary).toMatchObject({ deferredCount: 1 });
    // Deferral cannot satisfy the next Formal checkpoint's teaching prerequisite.
    expect(saved.overview.nextAction).toBeNull();
    expect(artifacts(route)).toEqual(accepted);
    const achieved = await app.inject({
      method: 'POST',
      url: `${route.base}/goal-outcomes`,
      payload: {
        command: goldenCommand(route.workspaceId, 'invalid-achieved'),
        expectedCourseExecutionVersion: saved.overview.courseExecutionVersion,
        expectedContractVersionId: route.course.contract.id,
        expectedCurriculumVersionId: route.course.curriculum.id,
        expectedStudyPlanVersionId: saved.plan!.id,
        expectedAgendaVersionId: saved.overview.activeAgenda!.id,
        status: 'achieved',
        unresolvedRiskIds: [],
        reason: '尝试结束课程。',
      },
    });
    expect(achieved.statusCode).toBe(400);
    expect(achieved.json()).toMatchObject({
      error: {
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('incomplete or deferred'),
      },
    });
    expect(await goldenRequest(app, `${route.sessionBase}/commands`, input)).toEqual(deferred);
    expect(context!.repos.coverageRisks.list(route.workspaceId, route.course.contract.id)).toEqual(
      risks,
    );
    expect(await savedState(route)).toEqual(saved);
    expect(route.tracked.calls).toEqual(callsBefore);
    // The learner can still use the visible Tutor support path while this
    // accepted-route obligation remains deferred, without manufacturing credit.
    const support = await goldenRequest<SubmitTutorTurnResponse>(
      app,
      `${route.sessionBase}/turns`,
      {
        commandId: 'deferred-support',
        expectedSessionVersion: deferred.session.version,
        content: '工作记忆的容量有限是什么意思？',
      },
    );
    expect(support.turn.status).toBe('completed');
    expect(
      support.exchanges.some(
        (exchange) => exchange.role === 'tutor' && exchange.content.length > 0,
      ),
    ).toBe(true);
    expect(support.turn.tutorMetadata!.sourceRefs.length).toBeGreaterThan(0);
    expectNoCredit(route, await savedState(route));
    expect(artifacts(route)).toEqual(accepted);
    expect(context!.repos.coverageRisks.list(route.workspaceId, route.course.contract.id)).toEqual(
      risks,
    );
    expect(route.tracked.calls).toEqual({ ...callsBefore, respondToTutorTurn: 1 });
    logCalls('Defer', route);
  }, 120_000);

  it('closes file SQLite mid-Lesson, restores the paused position and resumes without generation', async () => {
    directory = mkdtempSync(join(tmpdir(), 'hy3-golden-recovery-'));
    const databasePath = join(directory, 'clinic.sqlite');
    const route = await setup({}, databasePath);
    let { app } = context!;
    let current = await prepareGoldenLesson(
      app,
      route.workspaceId,
      route.session.id,
      route.item.id,
      'restart-prepare',
    );
    current = await goldenLessonCommand(
      app,
      route.workspaceId,
      route.session.id,
      route.item.id,
      current,
      'restart-start',
      { kind: 'start_lesson' },
    );
    expect(current.progress!.presentationStatus).toBe('in_progress');
    const allowedBeforePause = current.allowedActions;
    await goldenRequest<SessionExecutionCommandResponse>(app, `${route.sessionBase}/pause`, {
      commandId: 'pause-before-close',
      expectedSessionVersion: current.session.version,
    });
    const saved = await savedState(route);
    const accepted = artifacts(route);
    expect(saved.detail.session.status).toBe('paused');
    expect(saved.lesson.allowedActions).toEqual(['resume_study_session']);
    expectNoCredit(route, saved);
    const callsBeforeClose = { ...route.tracked.calls };
    await app.close();
    const restarted = goldenProvider();
    context = buildTestApp({ databasePath, provider: restarted.provider });
    app = context.app;
    expect(await savedState(route)).toEqual(saved);
    expect(artifacts(route)).toEqual(accepted);
    expect(restarted.calls).toEqual({});
    const resumed = await goldenRequest<SessionExecutionCommandResponse>(
      app,
      `${route.sessionBase}/resume`,
      {
        commandId: 'resume-after-open',
        expectedSessionVersion: saved.detail.session.version,
      },
    );
    expect(resumed.session.status).toBe('active');
    current = await prepareGoldenLesson(
      app,
      route.workspaceId,
      route.session.id,
      route.item.id,
      'restart-accepted-reuse',
    );
    expect(current.progress).toEqual(saved.lesson.progress);
    expect(current.lesson).toEqual(saved.lesson.lesson);
    expect(current.allowedActions).toEqual(allowedBeforePause);
    current = await presentGoldenLesson(
      app,
      route.workspaceId,
      route.session,
      route.item.id,
      current,
    );
    const task = current.practice!.item!;
    current = await goldenLessonCommand(
      app,
      route.workspaceId,
      route.session.id,
      route.item.id,
      current,
      'restart-practice',
      {
        kind: 'submit_practice_response',
        itemIndex: task.index,
        optionId: publicOptionId(task.options, GOLDEN_ANSWERS.practice),
      },
    );
    expect(current.practice!.status).toBe('completed');
    expect((await savedState(route)).learning.summary.teachingCompleted).toBe(1);
    expect(artifacts(route)).toEqual(accepted);
    expect(restarted.calls).toEqual({});
    expect(route.tracked.calls).toEqual(callsBeforeClose);
    logCalls('pause / restart / resume (before close)', route);
    console.info('Golden Recovery restarted Provider calls:', JSON.stringify(restarted.calls));
  }, 120_000);

  it('fences a late Practice result after pausing and recovers using the accepted Lesson', async () => {
    // Same deterministic started/gate pattern as teachingBriefPreparation concurrency tests.
    let started!: () => void;
    let release!: () => void;
    const practiceStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const practiceGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gated = false;
    const route = await setup({
      practice: async () => {
        if (!gated) {
          gated = true;
          started();
          await practiceGate;
        }
      },
    });
    const { app } = context!;
    const pending = prepareGoldenLesson(
      app,
      route.workspaceId,
      route.session.id,
      route.item.id,
      'delayed-practice',
    ).then(
      (result) => ({ result, error: null }),
      (error: unknown) => ({ result: null, error }),
    );
    try {
      await practiceStarted;
      const accepted = artifacts(route);
      expect(accepted.checkpoint).not.toBeNull();
      expect(accepted.brief).toBeNull();
      const beforePause = await goldenRequest<StudySessionDetailResponse>(app, route.sessionBase);
      const paused = await goldenRequest<SessionExecutionCommandResponse>(
        app,
        `${route.sessionBase}/pause`,
        {
          commandId: 'pause-delayed-practice',
          expectedSessionVersion: beforePause.session.version,
        },
      );
      release();
      const settled = await pending;
      expect(settled.result).toBeNull();
      expect(String(settled.error)).toContain('409');
      const saved = await savedState(route);
      expect(saved.detail.session).toEqual(paused.session);
      expect(saved.detail.agenda).toEqual(paused.agenda);
      expect(saved.lesson.status).toBe('retry_available');
      expect(saved.lesson.practice ?? null).toBeNull();
      expect(saved.lesson.allowedActions).toEqual(['retry_preparation']);
      expectNoCredit(route, saved);
      expect(artifacts(route)).toEqual(accepted);
      await goldenRequest(app, `${route.sessionBase}/resume`, {
        commandId: 'resume-delayed-practice',
        expectedSessionVersion: paused.session.version,
      });
      const ready = await prepareGoldenLesson(
        app,
        route.workspaceId,
        route.session.id,
        route.item.id,
        'late-practice-retry',
      );
      expect(ready.status).toBe('ready');
      expect(ready.allowedActions).toContain('start_lesson');
      expect(ready.lesson!.objective.title).toBe('工作记忆');
      expect(artifacts(route).checkpoint).toEqual(accepted.checkpoint);
      expect(artifacts(route).brief!.composition!.acceptedLessonCheckpointId).toBe(
        accepted.checkpoint!.id,
      );
      expect(route.tracked.calls.generateLessonSlotContent).toBe(1);
      expect(route.tracked.calls.generatePracticeContent).toBe(2);
      const afterRetry = { ...route.tracked.calls };
      await savedState(route);
      expect(route.tracked.calls).toEqual(afterRetry);
      logCalls('late Practice', route);
    } finally {
      release();
      await pending;
    }
  }, 120_000);
});
