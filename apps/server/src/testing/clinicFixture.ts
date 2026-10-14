import { randomUUID } from 'node:crypto';
import { buildApp } from '../app.js';
import { openDatabase } from '../db/database.js';
import { CourseFakeProvider } from '../llm/courseFakeProvider.js';
import type { CourseProvider } from '../llm/courseContract.js';
import type {
  CourseCommand,
  CourseOperation,
  CoursePlan,
  CourseLessonContent,
  CourseSession,
  CourseQuiz,
  CourseSubmission,
} from '@hy3-clinic/shared';
import { expect } from 'vitest';

export const GOLDEN_TEXT =
  '# 概念\n\n速度是单位时间内位置的变化量，方向取决于坐标约定。\n\n# 条件与例外\n\n如果时间间隔非零，平均速度等于位移除以时间；时间间隔为零时不能使用该公式。\n\n# 步骤\n\n步骤：先固定坐标方向，再测量位移与时间，最后检查单位和除数。\n\n# 表格\n\n|情形|条件|\n|---|---|\n|向右移动|位移为正|\n|向左移动|位移为负|\n\n# 跨章关系\n\n速率只有大小，速度包含方向，不能用速率替代速度的方向信息。';
export const cmd = (): CourseCommand => {
  const id = randomUUID();
  return { commandId: id, idempotencyKey: id };
};
export function fixture(provider: CourseProvider = new CourseFakeProvider(), path = ':memory:') {
  const db = openDatabase(path);
  const app = buildApp({ db, provider });
  const c = app.clinic;
  const workspace = c.sources.createWorkspace('运动学基础');
  const settle = async (op: CourseOperation) => {
    await c.operations.idle(op.id);
    const final = c.operations.get(workspace.id, op.id);
    expect(final.error, JSON.stringify(final)).toBeNull();
    expect(final.status).toBe('completed');
    return final;
  };
  const prepare = async () => {
    await c.sources.import(workspace.id, { title: 'golden讲义', content: GOLDEN_TEXT });
    await settle(
      c.operations.start(workspace.id, cmd(), 'preparePlan', 'plan', 'curriculum', {
        sourceScopeHash: c.sources.scopeHash(workspace.id),
      }),
    );
    return c.planning.get(workspace.id)!;
  };
  const accept = (draft: CoursePlan) => c.planning.confirm(workspace.id, draft.id, draft.version);
  const open = async (plan: CoursePlan, lessonId = plan.lessons[0]!.id) => {
    const final = await settle(
      c.operations.start(workspace.id, cmd(), 'prepareLesson', `lesson:${lessonId}`, 'lesson', {
        curriculumId: plan.id,
        lessonId,
      }),
    );
    const content = c.repo.owned<CourseLessonContent>(
      'course_lesson_versions',
      final.resourceId!,
      workspace.id,
    );
    const session = c.lessons.visit(workspace.id, cmd(), content.id, plan.id);
    return { content, session };
  };
  const complete = (content: CourseLessonContent, session: CourseSession) =>
    c.lessons.complete(workspace.id, cmd(), content.lessonId, session.id, content.id);
  const practice = async (plan: CoursePlan, content: CourseLessonContent) => {
    const final = await settle(
      c.operations.start(
        workspace.id,
        cmd(),
        'preparePractice',
        `practice:${randomUUID()}`,
        'quiz',
        { curriculumId: plan.id, lessonVersionId: content.id, requestId: randomUUID() },
      ),
    );
    return c.questions.get(workspace.id, final.resourceId!);
  };
  const submit = async (quiz: CourseQuiz, correct = true) => {
    const result = c.grading.submit(
      workspace.id,
      quiz.id,
      cmd(),
      quiz.items.map((q) => ({
        questionId: q.id,
        response:
          q.type === 'short_answer'
            ? q.answer[0]!
            : correct
              ? q.answer
              : [q.options.find((o) => !q.answer.includes(o.id))!.id],
        assistance: 'none',
      })),
      quiz.version,
    );
    if (result.operation) await settle(result.operation);
    return c.repo.owned<CourseSubmission>('submissions', result.submission.id, workspace.id);
  };
  return {
    db,
    app,
    c,
    workspace,
    provider,
    settle,
    prepare,
    accept,
    open,
    complete,
    practice,
    submit,
    close: async () => {
      await app.close();
      db.close();
    },
  };
}
