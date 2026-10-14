import { describe, it, expect } from 'vitest';
import { fixture, cmd } from '../testing/clinicFixture.js';
import type { CourseSubmission } from '@hy3-clinic/shared';
describe('持久草稿、提示曝光和历史答案边界', () => {
  it('保存草稿不签分；服务端提示标记不能被客户端none覆盖，评分后可查冻结题目/答案且不能改草稿', async () => {
    const f = fixture();
    try {
      const plan = f.accept(await f.prepare());
      const { content, session } = await f.open(plan);
      f.complete(content, session);
      const quiz = await f.practice(plan, content);
      const q = quiz.items[0]!;
      const base = `/api/workspaces/${f.workspace.id}/quizzes/${quiz.id}`;
      const saved = await f.app.inject({
        method: 'PUT',
        url: `${base}/draft`,
        payload: {
          answers: [{ questionId: q.id, response: q.answer }],
          expectedVersion: quiz.version,
        },
      });
      expect(saved.statusCode).toBe(200);
      expect((await f.app.inject({ url: `${base}/draft` })).json().answers[0].response).toEqual(
        q.answer,
      );
      expect(f.c.repo.row<{ n: number }>('SELECT COUNT(*) AS n FROM submissions')!.n).toBe(0);
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: `${base}/hints`,
            payload: { questionId: q.id },
          })
        ).statusCode,
      ).toBe(200);
      const result = f.c.grading.submit(
        f.workspace.id,
        quiz.id,
        cmd(),
        [{ questionId: q.id, response: q.answer, assistance: 'none' }],
        quiz.version,
      );
      await f.settle(result.operation!);
      const sub = f.c.repo.owned<CourseSubmission>('submissions', result.submission.id);
      expect(sub.responses[0]!.assistance).toBe('hint');
      expect(f.c.outcomes.list(f.workspace.id)[0]!.schedule).toBeNull();
      const detail = await f.app.inject({
        url: `/api/workspaces/${f.workspace.id}/submissions/${sub.id}/detail`,
      });
      expect(detail.json().solutions[0].answer).toEqual(q.answer);
      expect(detail.json().quiz.items[0].prompt).toBe(q.prompt);
      expect(detail.body).not.toContain('privateAnswerHash');
      expect(
        (
          await f.app.inject({
            method: 'PUT',
            url: `${base}/draft`,
            payload: { answers: [], expectedVersion: quiz.version },
          })
        ).statusCode,
      ).toBe(409);
      await expect(
        f.c.sources.import(f.workspace.id, { content: '# 只有标题' }),
      ).rejects.toMatchObject({ code: 'EMPTY_SOURCE' });
      const deleteResult = await f.app.inject({
        method: 'DELETE',
        url: `/api/workspaces/${f.workspace.id}`,
        payload: { command: cmd() },
      });
      expect(deleteResult.statusCode).toBe(200);
      expect(f.db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      await f.close();
    }
  });
});
