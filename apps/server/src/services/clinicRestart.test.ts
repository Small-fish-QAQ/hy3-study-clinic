import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, cmd } from '../testing/clinicFixture.js';
import { CourseFakeProvider } from '../llm/courseFakeProvider.js';
import type { CourseOperation, CourseSubmission } from '@hy3-clinic/shared';
import { canonical } from '../util/canonical.js';

describe('新版本同版本持久化和显式恢复 A10/A11', () => {
  it('冷重启把未完成queued标interrupted，sent记unknown；不自动调用Provider，显式retry沿冻结输入续学', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clinic-interrupted-'));
    const path = join(dir, 'clinic.sqlite');
    const f = fixture(new CourseFakeProvider(), path);
    try {
      const plan = f.accept(await f.prepare());
      const now = f.c.repo.now();
      const interrupted: CourseOperation = {
        id: 'restart-op',
        workspaceId: f.workspace.id,
        kind: 'prepareLesson',
        resourceKind: 'lesson',
        resourceId: null,
        status: 'running',
        version: 1,
        fence: 1,
        result: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      };
      f.c.repo.run(
        'INSERT INTO agent_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
        interrupted.id,
        f.workspace.id,
        'restart-lesson',
        'input-hash',
        canonical({ curriculumId: plan.id, lessonId: plan.lessons[0]!.id }),
        'prepareLesson',
        'running',
        1,
        1,
        'gone',
        now,
        canonical(interrupted),
        now,
      );
      f.c.repo.run(
        'INSERT INTO llm_calls VALUES(?,?,?,?,?,?,?,?,?)',
        'unknown-call',
        f.workspace.id,
        interrupted.id,
        'unknown-key',
        'generateLesson',
        '{}',
        'running',
        '{}',
        now,
      );
      f.c.repo.run(
        'INSERT INTO llm_physical_attempts VALUES(?,?,?,?,?)',
        'unknown-physical',
        'unknown-call',
        'sent',
        '{}',
        now,
      );
      const workspaceId = f.workspace.id;
      await f.close();
      const provider = new CourseFakeProvider();
      const restarted = fixture(provider, path);
      try {
        const op = restarted.c.operations.get(workspaceId, interrupted.id);
        expect(op.status).toBe('interrupted');
        expect(provider.calls).toEqual({});
        expect(
          restarted.c.repo.row<{ status: string }>(
            'SELECT status FROM llm_physical_attempts WHERE id=?',
            'unknown-physical',
          )!.status,
        ).toBe('outcome_unknown');
        const resumed = restarted.c.operations.retry(workspaceId, op.id, cmd(), op.version);
        await restarted.c.operations.idle(resumed.id);
        expect(restarted.c.operations.get(workspaceId, resumed.id).status).toBe('completed');
        expect(provider.calls.generateLesson).toBe(1);
      } finally {
        await restarted.close();
      }
    } finally {
      if (f.db.open) await f.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('当前题目/课文/完成课堂/评分/Review事件不可覆盖；归属FK有效', async () => {
    const f = fixture();
    try {
      const plan = f.accept(await f.prepare());
      const { content, session } = await f.open(plan);
      f.complete(content, session);
      const quiz = await f.practice(plan, content);
      const submission = await f.submit(quiz, true);
      for (const table of [
        'course_lesson_versions',
        'course_knowledge_inventories',
        'study_sessions',
        'quizzes',
        'submissions',
        'successor_review_events',
      ]) {
        const row = f.c.repo.row<{ id: string }>(
          `SELECT ${table === 'successor_review_events' ? 'id' : 'id'} FROM ${table} LIMIT 1`,
        )!;
        expect(() => f.c.repo.run(`UPDATE ${table} SET payload='{}' WHERE id=?`, row.id)).toThrow(
          'immutable',
        );
      }
      expect(() =>
        f.c.repo.run('UPDATE submissions SET responses=? WHERE id=?', '[]', submission.id),
      ).toThrow('immutable');
      expect(f.db.pragma('foreign_key_check')).toEqual([]);
      expect(f.c.repo.owned<CourseSubmission>('submissions', submission.id).score).toBe(1);
    } finally {
      await f.close();
    }
  });
});
