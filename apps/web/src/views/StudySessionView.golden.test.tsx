import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CoursePreparationResponse,
  LessonExecutionProjection,
  StudySessionDetailResponse,
} from '@hy3-clinic/shared';
import { buildTestApp, type TestApp } from '../../../server/src/testing/testApp.js';
import {
  goldenOverview,
  goldenRequest,
  prepareGoldenCourse,
} from '../../../server/src/testing/courseWorkflow.js';
import { GOLDEN_ANSWERS, goldenProvider } from '../../../server/src/testing/goldenCourseFixture.js';
import { api } from '../api.js';
import { StudySessionView } from './StudySessionView.js';

let context: TestApp | undefined;
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await context?.app.close();
  context = undefined;
});

describe('StudySession learner controls against the real Fake server', () => {
  it('shows real Lesson, incorrect feedback, Repair and both Retests before the Formal handoff', async () => {
    const tracked = goldenProvider();
    context = buildTestApp({ provider: tracked.provider });
    const { app } = context;
    const course = await prepareGoldenCourse(app);
    const workspaceId = course.workspace.id;
    const { preparation } = await goldenRequest<CoursePreparationResponse>(
      app,
      `/api/workspaces/${workspaceId}/preparation`,
    );
    const route = course.overview;
    const item = route.nextAction!.item;
    const lessonResults: LessonExecutionProjection[] = [];
    const actions: string[] = [];
    // This flow uses only JSON API requests. Keep transport local; api.ts still
    // parses real status codes and server schemas. No authored response mocks.
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      if (!url.startsWith('/api/')) throw new Error(`Unexpected external request: ${url}`);
      const result = await app.inject({
        method: init.method as 'GET' | 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        payload: init.body ? String(init.body) : undefined,
      });
      if (url.endsWith('/lesson-execution/commands') && result.statusCode === 200) {
        lessonResults.push(result.json<LessonExecutionProjection>());
        actions.push((JSON.parse(String(init.body)) as { action: { kind: string } }).action.kind);
      }
      return new Response(result.body, {
        status: result.statusCode,
        headers: { 'content-type': 'application/json' },
      });
    });
    const user = userEvent.setup();
    render(
      <StudySessionView
        workspaceId={workspaceId}
        courseName={course.workspace.name}
        formalReadiness={preparation.formalReadiness}
        curriculumUnits={course.curriculum.nodes
          .filter((node) => node.learningUnit)
          .map(({ id, title }) => ({ id, title }))}
        route={{
          contractVersionId: course.contract.id,
          curriculumVersionId: course.curriculum.id,
          studyPlanVersionId: route.acceptedStudyPlan!.id,
          sessionAgendaId: route.activeAgenda!.id,
          executionVersion: route.courseExecutionVersion,
        }}
      />,
    );
    await user.click(await screen.findByRole('button', { name: '开始学习' }));
    await screen.findByRole('button', { name: '开始本节讲解' });
    const { sessions } = await api.listStudySessions(workspaceId);
    const session = sessions[0]!;
    let current = await api.getLessonExecution(workspaceId, session.id);
    expect(current.lesson!.objective.title).toBe('工作记忆');
    const click = async (label: string) => {
      const previous = lessonResults.length;
      await user.click(await screen.findByRole('button', { name: label }));
      await waitFor(() => expect(lessonResults).toHaveLength(previous + 1));
      current = lessonResults.at(-1)!;
    };
    await click('开始本节讲解');
    expect(screen.getAllByText(/工作记忆的容量有限/).length).toBeGreaterThan(0);
    for (let step = 0; step < 40 && !current.progress!.presentationCompletedAt; step += 1) {
      if (current.allowedActions.includes('complete_presentation')) {
        await click('完成本节讲解');
      } else if (current.allowedActions.includes('respond_to_worked_interaction')) {
        const stage =
          current.lesson!.segments[current.progress!.currentSegmentIndex]!.workedProcess!
            .interaction!.stage;
        if (stage === 'completed') throw new Error('Unexpected completed public task.');
        await click(GOLDEN_ANSWERS[stage]);
      } else if (current.allowedActions.includes('respond_to_informal_check')) {
        await click(GOLDEN_ANSWERS.informal);
      } else {
        expect(current.allowedActions).toContain('move_to_next_segment');
        await click('继续讲解');
      }
    }
    expect(current.practice!.status).not.toBe('completed');
    await click(GOLDEN_ANSWERS.wrongPractice);
    expect(current.practice!.attempts[0]).toMatchObject({ correct: false });
    expect(current.practice!.attempts[0]!.recovered).not.toBe(true);
    await screen.findByText(current.practice!.recovery!.feedback);
    expect(screen.queryByRole('button', { name: '用新情境检验' })).not.toBeInTheDocument();
    await click('学习针对性讲解');
    expect(current.practice!.recovery!.phase).toBe('repair');
    await screen.findByText(current.practice!.recovery!.teaching!.explanation);
    await click('用新情境检验');
    await screen.findByRole('heading', { name: '第 1/2 个新情境' });
    expect(screen.queryByText('补上关键一步')).not.toBeInTheDocument();
    await click(GOLDEN_ANSWERS.retest[0]);
    expect(current.practice!.status).not.toBe('completed');
    expect(current.practice!.attempts[0]!.recovered).not.toBe(true);
    await screen.findByRole('heading', { name: '第 2/2 个新情境' });
    expect((await goldenOverview(app, workspaceId)).formalProgress.completedPlanItemCount).toBe(0);
    await click(GOLDEN_ANSWERS.retest[1]);
    expect(current.practice!.status).toBe('completed');
    expect(current.practice!.attempts[0]).toMatchObject({ correct: false, recovered: true });
    const detail = await goldenRequest<StudySessionDetailResponse>(
      app,
      `/api/workspaces/${workspaceId}/study-sessions/${session.id}`,
    );
    expect(detail.agenda.items.find((entry) => entry.id === item.id)!.state).toBe('completed');
    expect(
      (await goldenOverview(app, workspaceId)).formalProgress.stateCreditingEvidenceCount,
    ).toBe(0);
    expect(actions.filter((action) => action === 'prepare_practice_repair')).toHaveLength(1);
    expect(actions.filter((action) => action === 'submit_practice_retest')).toHaveLength(2);
    await user.click(await screen.findByRole('button', { name: '继续课程' }));
    await waitFor(async () => {
      const continued = await api.getStudySession(workspaceId, session.id);
      const selected = continued.agenda.items.find(
        (entry) => entry.id === continued.session.currentAgendaItemId,
      );
      expect(selected?.kind).toBe('formal_checkpoint');
    });
    await screen.findByRole('button', { name: '准备正式检查' });
    expect(screen.queryByRole('button', { name: '学习针对性讲解' })).not.toBeInTheDocument();
    const calls = { ...tracked.calls };
    await api.getStudySession(workspaceId, session.id);
    expect(tracked.calls).toEqual(calls);
  }, 60_000);
});
