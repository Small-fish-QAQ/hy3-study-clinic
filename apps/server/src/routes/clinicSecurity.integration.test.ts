import { describe, it, expect } from 'vitest';
import { fixture, cmd } from '../testing/clinicFixture.js';
import { sha256 } from '../util/canonical.js';

describe('可信上层HTTP合同 A09/A13/A14', () => {
  it('关闭全部低层写口，public不泄露答案，拒绝客户端成绩/跨课程资源，GET纯读', async () => {
    const f = fixture();
    try {
      const plan = f.accept(await f.prepare());
      const { content, session } = await f.open(plan);
      f.complete(content, session);
      const quiz = await f.practice(plan, content);
      const retired = [
        '/api/formal-assessment-grades',
        '/api/formal-assessment-versions',
        '/api/evidence',
        '/api/repair-episodes',
        '/api/tutor/runs',
        '/api/materials/none/analyze',
      ];
      for (const url of retired)
        expect(
          (await f.app.inject({ method: 'POST', url, payload: { score: 1 } })).statusCode,
        ).toBe(404);
      const response = await f.app.inject({ url: `/api/quizzes/${quiz.id}` });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toMatch(
        /"answer"|"explanation"|"rubric"|"admission"|candidateStates/u,
      );
      const malicious = await f.app.inject({
        method: 'POST',
        url: `/api/quizzes/${quiz.id}/submissions`,
        payload: {
          command: cmd(),
          workspaceId: f.workspace.id,
          answers: quiz.items.map((q) => ({ questionId: q.id, response: q.answer })),
          expectedQuizVersion: quiz.version,
          score: 1,
          issuer: 'server',
        },
      });
      expect(malicious.statusCode).toBe(400);
      const stranger = f.c.sources.createWorkspace('other');
      const foreign = await f.app.inject({
        method: 'POST',
        url: `/api/quizzes/${quiz.id}/submissions`,
        payload: {
          command: cmd(),
          workspaceId: stranger.id,
          answers: quiz.items.map((q) => ({ questionId: q.id, response: q.answer })),
          expectedQuizVersion: quiz.version,
        },
      });
      expect(foreign.statusCode).toBe(404);
      const before = sha256(f.db.serialize());
      const classroomResponse = await f.app.inject({
        url: `/api/workspaces/${f.workspace.id}/study-sessions/${session.id}`,
      });
      expect(classroomResponse.statusCode).toBe(200);
      const classroom = classroomResponse.json<{
        sourceQuotes: {
          span: Parameters<typeof f.c.sources.validateSpan>[1];
          title: string;
          quote: string;
        }[];
      }>();
      expect(classroom.sourceQuotes.length).toBeGreaterThan(0);
      for (const source of classroom.sourceQuotes)
        expect(source.quote).toBe(f.c.sources.validateSpan(f.workspace.id, source.span));
      expect(
        (await f.app.inject({ url: `/api/workspaces/${stranger.id}/study-sessions/${session.id}` }))
          .statusCode,
      ).toBe(404);
      for (const path of [
        'course-plan',
        'lessons',
        'learning-records',
        'learning-progress',
        'review/queue',
      ])
        expect(
          (await f.app.inject({ url: `/api/workspaces/${f.workspace.id}/${path}` })).statusCode,
        ).toBe(200);
      expect(sha256(f.db.serialize())).toBe(before);
      const submitted = await f.app.inject({
        method: 'POST',
        url: `/api/quizzes/${quiz.id}/submissions`,
        payload: {
          command: cmd(),
          workspaceId: f.workspace.id,
          answers: quiz.items.map((q) => ({ questionId: q.id, response: q.answer })),
          expectedQuizVersion: quiz.version,
        },
      });
      expect(submitted.statusCode).toBe(202);
      await f.c.operations.idle();
      expect(
        f.c.repo.row<{ n: number }>('SELECT COUNT(*) AS n FROM assessment_grade_records')!.n,
      ).toBe(0);
      const otherAnswers = await f.app.inject({
        method: 'POST',
        url: `/api/quizzes/${quiz.id}/submissions`,
        payload: {
          command: cmd(),
          workspaceId: f.workspace.id,
          answers: quiz.items.map((q) => ({ questionId: q.id, response: ['B'] })),
          expectedQuizVersion: quiz.version,
        },
      });
      expect(otherAnswers.statusCode).toBe(409);
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/workspaces',
            headers: { origin: 'https://evil.test' },
            payload: { title: 'injected' },
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await f.close();
    }
  });
});
