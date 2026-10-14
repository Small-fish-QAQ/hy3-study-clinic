import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildApp } from '../apps/server/dist/app.js';
import { openDatabase } from '../apps/server/dist/db/database.js';
import { CourseFakeProvider } from '../apps/server/dist/llm/courseFakeProvider.js';
globalThis.fetch = () => Promise.reject(new Error('Network disabled in offline regression.'));
const db = openDatabase(':memory:');
const provider = new CourseFakeProvider();
const app = buildApp({ db, provider });
const c = app.clinic;
const cmd = () => {
  const id = randomUUID();
  return { commandId: id, idempotencyKey: id };
};
const checks = [];
const check = (name, condition) => {
  assert.ok(condition, name);
  checks.push({ name, passed: true });
};
const settle = async (op) => {
  await c.operations.idle(op.id);
  const final = c.operations.get(op.workspaceId, op.id);
  assert.equal(final.status, 'completed', JSON.stringify(final.error));
  return final;
};
try {
  const workspace = c.sources.createWorkspace('新版离线课程');
  await c.sources.import(workspace.id, {
    content:
      '# 定义\n\n速率表示运动的快慢。\n\n# 关系\n\n速度还包含方向信息。\n\n# 条件\n\n时间间隔非零时才能计算平均速度。\n\n# 应用\n\n先检查坐标方向，再根据位移和时间解释速度。',
  });
  await settle(
    c.operations.start(workspace.id, cmd(), 'preparePlan', 'plan', 'curriculum', {
      sourceScopeHash: c.sources.scopeHash(workspace.id),
    }),
  );
  const draft = c.planning.get(workspace.id);
  const plan = c.planning.confirm(workspace.id, draft.id, draft.version);
  check(
    '完整知识提取与一次课程组织',
    provider.calls.extractCourseKnowledge === 1 && provider.calls.generateCoursePlan === 1,
  );
  check(
    '确认没有预生成Lesson或Practice',
    !provider.calls.generateLesson && !provider.calls.generateQuestions,
  );
  for (const lesson of plan.lessons) {
    const ready = await settle(
      c.operations.start(workspace.id, cmd(), 'prepareLesson', `lesson:${lesson.id}`, 'lesson', {
        curriculumId: plan.id,
        lessonId: lesson.id,
      }),
    );
    const visit = c.lessons.visit(workspace.id, cmd(), ready.resourceId, plan.id);
    c.lessons.complete(workspace.id, cmd(), lesson.id, visit.id, ready.resourceId);
  }
  check(
    '学习路线完成不依赖Practice或Formal',
    c.progress(workspace.id).learningRouteCompleted &&
      c.records(workspace.id).formalGrades.length === 0,
  );
  const op = await settle(
    c.operations.start(workspace.id, cmd(), 'prepareFormal', 'formal:offline', 'formal', {
      curriculumId: plan.id,
      blueprintId: plan.assessmentBlueprint.id,
      paperRequestId: 'offline-paper',
    }),
  );
  const quiz = c.questions.get(workspace.id, op.resourceId);
  const started = c.grading.startFormal(workspace.id, quiz.id, cmd());
  check(
    '正式公开试卷不泄答案或rubric',
    !JSON.stringify(started.quiz).includes('"answer"') &&
      !JSON.stringify(started.quiz).includes('"rubric"'),
  );
  const submitted = c.grading.submit(
    workspace.id,
    quiz.id,
    cmd(),
    quiz.items.map((q) => ({ questionId: q.id, response: q.answer, assistance: 'none' })),
    quiz.version,
  );
  await settle(submitted.operation);
  check('客观评分零模型调用', !provider.calls.gradeShortAnswer);
  check('成绩仅服务端签发', c.records(workspace.id).formalGrades.length === 1);
  check(
    '未抽到的教材知识仍未实测',
    c.progress(workspace.id).knowledge.some((k) => k.formalStatus === 'untested'),
  );
  const output = path.resolve('output/architecture-implementation');
  mkdirSync(output, { recursive: true });
  const result = {
    passed: true,
    mode: 'offline-fake',
    networkRequests: 0,
    checks,
    providerCalls: provider.calls,
    limitation: '离线工程合同验证；不证明真实模型的语义能力。',
  };
  writeFileSync(path.join(output, 'offline-regression.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await app.close();
  db.close();
}
