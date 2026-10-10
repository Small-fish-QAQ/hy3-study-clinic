import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CourseLearningProgress } from '@hy3-clinic/shared';
import { ProviderError } from '../../../server/src/llm/errors.js';
import { buildTestApp, type TestApp } from '../../../server/src/testing/testApp.js';
import {
  goldenLessonCommand,
  goldenOverview,
  goldenRequest,
  prepareGoldenCourse,
  prepareGoldenLesson,
  presentGoldenLesson,
  startGoldenStudy,
} from '../../../server/src/testing/courseWorkflow.js';
import {
  GOLDEN_ANSWERS,
  goldenProvider,
  publicOptionId,
  type GoldenGenerationHooks,
} from '../../../server/src/testing/goldenCourseFixture.js';
import { api } from '../api.js';
import { StudySessionView } from './StudySessionView.js';

let context: TestApp | undefined;
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await context?.app.close();
  context = undefined;
});

async function setup(hooks: GoldenGenerationHooks = {}) {
  const tracked = goldenProvider(hooks);
  context = buildTestApp({ provider: tracked.provider });
  const { app } = context;
  const course = await prepareGoldenCourse(app);
  const { session, item } = await startGoldenStudy(app, course);
  // Reuse the Phase 3A local transport; api.ts still handles real server schemas/errors.
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    if (!url.startsWith('/api/')) throw new Error(`Unexpected external request: ${url}`);
    const result = await app.inject({
      method: (init.method ?? 'GET') as 'GET' | 'POST',
      url,
      headers: { 'content-type': 'application/json' },
      payload: init.body ? String(init.body) : undefined,
    });
    return new Response(result.body, {
      status: result.statusCode,
      headers: { 'content-type': 'application/json' },
    });
  });
  const workspaceId = course.workspace.id;
  const show = () =>
    render(
      <StudySessionView
        workspaceId={workspaceId}
        courseName={course.workspace.name}
        curriculumUnits={course.curriculum.nodes
          .filter((node) => node.learningUnit)
          .map(({ id, title }) => ({ id, title }))}
        route={{
          contractVersionId: course.contract.id,
          curriculumVersionId: course.curriculum.id,
          studyPlanVersionId: course.overview.acceptedStudyPlan!.id,
          sessionAgendaId: course.overview.activeAgenda!.id,
          executionVersion: course.overview.courseExecutionVersion,
        }}
      />,
    );
  return { app, tracked, course, session, item, workspaceId, show };
}

describe('Golden recovery controls connected to the production API', () => {
  it.each(['lesson', 'practice'] as const)(
    'shows a real %s failure and executes its retry control once',
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
      route.show();
      const retry = await screen.findByRole(
        'button',
        {
          name: phase === 'lesson' ? '重新准备本节讲解' : '重新准备非正式练习',
        },
        { timeout: 15_000 },
      );
      expect(retry).toBeEnabled();
      const failed = await api.getLessonExecution(route.workspaceId, route.session.id);
      expect(failed.status).toBe(
        phase === 'lesson' ? 'retry_available' : 'practice_retry_available',
      );
      expect(failed.allowedActions).toEqual(['retry_preparation']);
      expect(screen.queryByRole('button', { name: '开始本节讲解' })).not.toBeInTheDocument();
      if (phase === 'practice') {
        expect(
          screen.getByRole('heading', { name: '讲解已安全保存，练习还需要重试' }),
        ).toBeInTheDocument();
        expect(screen.getAllByRole('heading', { name: '工作记忆' }).length).toBeGreaterThan(0);
      } else {
        expect(screen.getByRole('heading', { name: '讲解还没有准备好' })).toBeInTheDocument();
      }
      const callsAtFailure = { ...route.tracked.calls };
      await goldenOverview(route.app, route.workspaceId);
      expect(route.tracked.calls).toEqual(callsAtFailure);
      const user = userEvent.setup();
      await user.click(retry);
      await screen.findByRole('button', { name: '开始本节讲解' }, { timeout: 15_000 });
      const ready = await api.getLessonExecution(route.workspaceId, route.session.id);
      expect(ready.status).toBe('ready');
      if (phase === 'practice') expect(ready.lesson).toEqual(failed.lesson);
      expect(route.tracked.calls.generateLessonSlotContent).toBe(phase === 'lesson' ? 2 : 1);
      expect(route.tracked.calls.generatePracticeContent).toBe(phase === 'practice' ? 2 : 1);
      const callsAtRetry = { ...route.tracked.calls };
      await user.click(screen.getByRole('button', { name: '开始本节讲解' }));
      await waitFor(async () => {
        expect(
          (await api.getLessonExecution(route.workspaceId, route.session.id)).progress!
            .presentationStatus,
        ).toBe('in_progress');
      });
      expect(
        (await goldenOverview(route.app, route.workspaceId)).formalProgress
          .stateCreditingEvidenceCount,
      ).toBe(0);
      expect(route.tracked.calls).toEqual(callsAtRetry);
    },
    120_000,
  );

  it('shows failed Retest feedback and lets the learner request a further Repair without credit', async () => {
    const route = await setup();
    let current = await prepareGoldenLesson(
      route.app,
      route.workspaceId,
      route.session.id,
      route.item.id,
      'ui-retest-prepare',
    );
    current = await presentGoldenLesson(
      route.app,
      route.workspaceId,
      route.session,
      route.item.id,
      current,
    );
    const act = async (id: string, action: Parameters<typeof goldenLessonCommand>[6]) => {
      current = await goldenLessonCommand(
        route.app,
        route.workspaceId,
        route.session.id,
        route.item.id,
        current,
        id,
        action,
      );
    };
    const task = current.practice!.item!;
    await act('ui-wrong-practice', {
      kind: 'submit_practice_response',
      itemIndex: task.index,
      optionId: publicOptionId(task.options, GOLDEN_ANSWERS.wrongPractice),
    });
    await act('ui-first-repair', { kind: 'prepare_practice_repair', learnerNote: '' });
    await act('ui-first-retest', { kind: 'start_practice_retest' });
    const beforeAnswer = { ...route.tracked.calls };
    route.show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: GOLDEN_ANSWERS.wrongRetest }));
    await waitFor(async () => {
      current = await api.getLessonExecution(route.workspaceId, route.session.id);
      expect(current.practice!.recovery!.phase).toBe('diagnosis');
    });
    await screen.findByText(current.practice!.recovery!.feedback);
    expect(current.practice!.attempts[0]!.correct).toBe(false);
    expect(current.practice!.attempts[0]!.recovered).not.toBe(true);
    expect(current.practice!.completedAt).toBeNull();
    expect(screen.queryByText('修补后已通过两个新情境的检验')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '继续课程' })).not.toBeInTheDocument();
    expect(route.tracked.calls).toEqual(beforeAnswer);
    await user.click(await screen.findByRole('button', { name: '换一种方式补上缺口' }));
    await screen.findByRole('button', { name: '用新情境检验' }, { timeout: 15_000 });
    current = await api.getLessonExecution(route.workspaceId, route.session.id);
    expect(current.practice!.recovery).toMatchObject({ phase: 'repair', round: 2 });
    expect(current.practice!.attempts[0]!.correct).toBe(false);
    expect(current.practice!.attempts[0]!.recovered).not.toBe(true);
    expect(route.tracked.calls.generatePracticeRepair).toBe(2);
    const overview = await goldenOverview(route.app, route.workspaceId);
    expect(overview.formalProgress).toMatchObject({
      completedPlanItemCount: 0,
      stateCreditingEvidenceCount: 0,
    });
  }, 120_000);

  it('executes learner Defer and displays the remaining accepted-route work', async () => {
    const route = await setup();
    let current = await prepareGoldenLesson(
      route.app,
      route.workspaceId,
      route.session.id,
      route.item.id,
      'ui-defer-prepare',
    );
    current = await presentGoldenLesson(
      route.app,
      route.workspaceId,
      route.session,
      route.item.id,
      current,
    );
    const task = current.practice!.item!;
    await goldenLessonCommand(
      route.app,
      route.workspaceId,
      route.session.id,
      route.item.id,
      current,
      'ui-defer-wrong',
      {
        kind: 'submit_practice_response',
        itemIndex: task.index,
        optionId: publicOptionId(task.options, GOLDEN_ANSWERS.wrongPractice),
      },
    );
    const callsBefore = { ...route.tracked.calls };
    vi.spyOn(window, 'prompt').mockReturnValue('明天继续，保留本节缺口。');
    route.show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '延期本节内容，保留缺口' }));
    await waitFor(async () => {
      const detail = await api.getStudySession(route.workspaceId, route.session.id);
      expect(detail.agenda.items.find((item) => item.id === route.item.id)!.state).toBe('deferred');
    });
    await screen.findByRole('button', { name: '准备正式检查' });
    expect(screen.getByRole('status', { name: '保留的学习缺口' })).toHaveTextContent(
      '已延期，保留缺口',
    );
    const overview = await goldenOverview(route.app, route.workspaceId);
    expect(overview.formalProgress).toMatchObject({
      deferredPlanItemCount: 1,
      completedPlanItemCount: 0,
      stateCreditingEvidenceCount: 0,
    });
    expect(overview.riskSummary.deferredCount).toBe(1);
    const learning = await goldenRequest<CourseLearningProgress>(
      route.app,
      `/api/workspaces/${route.workspaceId}/learning-progress`,
    );
    expect(learning.summary.teachingCompleted).toBe(0);
    expect(learning.units.every((unit) => unit.formalState !== 'complete')).toBe(true);
    expect(route.tracked.calls).toEqual(callsBefore);
    // This visible support operation is available after postponing the lesson.
    await user.click(screen.getAllByRole('button', { name: '问 Tutor' })[0]!);
    await user.type(
      screen.getByRole('textbox', { name: '向 Tutor 提问' }),
      '工作记忆的容量有限是什么意思？',
    );
    await user.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(async () => {
      expect(
        (await api.getStudySession(route.workspaceId, route.session.id)).turns.at(-1)?.status,
      ).toBe('completed');
    });
    await screen.findByText(/直接回答你的问题/);
    expect(
      (await goldenOverview(route.app, route.workspaceId)).formalProgress
        .stateCreditingEvidenceCount,
    ).toBe(0);
    expect(route.tracked.calls).toEqual({ ...callsBefore, respondToTutorTurn: 1 });
  }, 120_000);
});
