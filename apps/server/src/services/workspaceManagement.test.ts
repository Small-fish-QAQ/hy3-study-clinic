import { describe, it, expect } from 'vitest';
import { fixture, cmd } from '../testing/clinicFixture.js';
import { deleteWorkspaces } from './workspaceManagement.js';
import { CourseFakeProvider } from '../llm/courseFakeProvider.js';
import type { LessonInput } from '../llm/courseContract.js';
describe('显式选择的课程删除', () => {
  it('完整课程含成绩/Evidence/反思可删除，未选课程逐行不变，重启不恢复已删除数据', async () => {
    const f = fixture();
    try {
      const plan = f.accept(await f.prepare()),
        { content, session } = await f.open(plan);
      f.c.repo.run(
        'INSERT INTO lesson_reflections VALUES(?,?,?,?,?)',
        f.workspace.id,
        content.id,
        'manual',
        JSON.stringify({ status: 'deferred' }),
        f.c.repo.now(),
      );
      f.complete(content, session);
      const op = await f.settle(
        f.c.operations.start(f.workspace.id, cmd(), 'prepareFormal', 'formal:delete', 'formal', {
          curriculumId: plan.id,
          blueprintId: plan.assessmentBlueprint.id,
          paperRequestId: 'delete',
        }),
      );
      const quiz = f.c.questions.get(f.workspace.id, op.resourceId!);
      f.c.grading.startFormal(f.workspace.id, quiz.id, cmd());
      await f.submit(quiz, true);
      expect(
        f.c.repo.rows('SELECT id FROM evidence WHERE workspace_id=?', f.workspace.id).length,
      ).toBeGreaterThan(0);
      const kept = f.c.sources.createWorkspace('未选择课程');
      await f.c.sources.import(kept.id, { content: '# 教材\n\n保留资料。' });
      const before = f.c.repo.rows('SELECT * FROM materials WHERE workspace_id=?', kept.id);
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/workspaces/delete',
        payload: { command: cmd(), workspaceIds: [f.workspace.id], confirmed: true },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(f.c.repo.rows('SELECT * FROM materials WHERE workspace_id=?', kept.id)).toEqual(
        before,
      );
      expect(f.c.repo.rows('PRAGMA foreign_key_check')).toEqual([]);
      for (const table of [
        'workspaces',
        'lesson_reflections',
        'evidence',
        'assessment_grade_records',
        'study_sessions',
        'llm_calls',
      ])
        expect(
          f.c.repo.row(
            `SELECT COUNT(*) AS n FROM ${table} WHERE ${table === 'workspaces' ? 'id' : 'workspace_id'}=?`,
            f.workspace.id,
          ),
        ).toEqual({ n: 0 });
    } finally {
      await f.close();
    }
  });
  it('空选择、未确认、重复ID和不存在的选择不触发部分删除', async () => {
    const f = fixture();
    try {
      for (const body of [
        { workspaceIds: [], confirmed: true },
        { workspaceIds: [f.workspace.id], confirmed: false },
        { workspaceIds: [f.workspace.id, f.workspace.id], confirmed: true },
      ]) {
        const r = await f.app.inject({
          method: 'POST',
          url: '/api/workspaces/delete',
          payload: { command: cmd(), ...body },
        });
        expect(r.statusCode).toBe(400);
      }
      expect(() =>
        deleteWorkspaces(f.c.repo, f.c.operations, [f.workspace.id, 'missing']),
      ).toThrow();
      expect(f.c.sources.workspaces().map((w) => w.id)).toContain(f.workspace.id);
    } finally {
      await f.close();
    }
  });
  it('运行中课程先撤销发布权，模型迟到结果不会写入已删除课程', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started!: () => void;
    const entered = new Promise<void>((r) => {
      started = r;
    });
    class Slow extends CourseFakeProvider {
      override async generateLesson(input: LessonInput) {
        const value = await super.generateLesson(input);
        started();
        await gate;
        return value;
      }
    }
    const f = fixture(new Slow());
    try {
      const plan = f.accept(await f.prepare()),
        lesson = plan.lessons[0]!;
      const op = f.c.operations.start(
        f.workspace.id,
        cmd(),
        'prepareLesson',
        `lesson:${lesson.id}`,
        'lesson',
        { curriculumId: plan.id, lessonId: lesson.id },
      );
      await entered;
      deleteWorkspaces(f.c.repo, f.c.operations, [f.workspace.id]);
      release();
      await f.c.operations.idle(op.id);
      expect(f.c.repo.rows('SELECT * FROM course_lesson_versions')).toEqual([]);
      expect(f.c.repo.rows('SELECT * FROM llm_calls')).toEqual([]);
      expect(f.c.repo.rows('PRAGMA foreign_key_check')).toEqual([]);
    } finally {
      release();
      await f.close();
    }
  });
});
