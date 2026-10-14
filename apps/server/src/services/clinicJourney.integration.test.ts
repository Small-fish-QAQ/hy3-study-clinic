import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, cmd } from '../testing/clinicFixture.js';
import { CourseFakeProvider } from '../llm/courseFakeProvider.js';

describe('新版完整学习旅程 R01–R46', () => {
  it('完整规划，按需Lesson，跳过Practice主动完成，回看新对话，十轮Repair，独立重考和冷重启', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clinic-v2-'));
    const path = join(dir, 'clinic.sqlite');
    const provider = new CourseFakeProvider();
    const f = fixture(provider, path);
    try {
      let draft = await f.prepare();
      expect(provider.calls.extractCourseKnowledge).toBe(1);
      expect(provider.calls.generateCoursePlan).toBe(1);
      expect(provider.calls.generateLesson ?? 0).toBe(0);
      const before = { ...provider.calls };
      draft = f.c.planning.patchDepth(f.workspace.id, draft.id, draft.version, [
        { lessonId: draft.lessons[0]!.id, depth: 'introductory' },
      ]);
      expect(provider.calls).toEqual(before);
      const plan = f.accept(draft);
      expect(provider.calls).toEqual(before);
      const future = await f.open(plan, plan.lessons.at(-1)!.id);
      expect(f.c.lessons.list(f.workspace.id).at(-1)!.prerequisiteWarnings.length).toBeGreaterThan(
        0,
      );
      f.complete(future.content, future.session);
      const first = await f.open(plan);
      const lessonsBefore = provider.calls.generateLesson;
      for (let i = 0; i < 65; i++)
        await f.c.lessons.tutor(f.workspace.id, first.session.id, `如何理解概念${i}？`, provider);
      expect(provider.calls.generateLesson).toBe(lessonsBefore);
      expect(provider.calls.respondToTutorTurn).toBe(65);
      expect(provider.calls.generateQuestions ?? 0).toBe(0);
      const formalCount = f.c.repo.row<{ n: number }>('SELECT COUNT(*) AS n FROM evidence')!.n;
      f.complete(first.content, first.session);
      await expect(
        f.c.lessons.tutor(f.workspace.id, first.session.id, '继续问', provider),
      ).rejects.toThrow('历史课堂');
      const revisit = f.c.lessons.visit(
        f.workspace.id,
        cmd(),
        first.content.id,
        plan.id,
        'revisit',
        first.session.id,
      );
      await f.c.lessons.tutor(f.workspace.id, revisit.id, '回看问题', provider);
      expect(f.c.lessons.classroom(f.workspace.id, first.session.id).turns.length).toBe(65);
      expect(f.c.lessons.classroom(f.workspace.id, revisit.id).turns.length).toBe(1);
      const quiz = await f.practice(plan, first.content);
      const wrong = await f.submit(quiz, false);
      expect(wrong.passed).toBe(false);
      expect(f.c.outcomes.list(f.workspace.id)[0]!.schedule?.repetitions).toBe(1);
      expect(f.c.repo.row<{ n: number }>('SELECT COUNT(*) AS n FROM evidence')!.n).toBe(
        formalCount,
      );
      for (let i = 1; i <= 10; i++) {
        const round = f.c.repairs.start(f.workspace.id, cmd(), {
          originKind: 'submission',
          originId: wrong.id,
          targetItemIds: wrong.itemGrades.map((g) => g.questionId),
        });
        await f.settle(f.c.operations.get(f.workspace.id, round.operationId));
        const ready = f.c.repairs.get(f.workspace.id, round.id);
        expect(ready.ordinal).toBe(i);
        expect(ready.status).toBe('ready');
        const retest = f.c.questions.get(f.workspace.id, ready.retestQuizId!);
        const result = f.c.repairs.submit(
          f.workspace.id,
          ready.id,
          cmd(),
          retest.items.map((q) => ({
            questionId: q.id,
            response: i === 10 ? q.answer : ['B'],
            assistance: 'none',
          })),
          ready.version,
        );
        await f.settle(result.operation!);
        const ended = f.c.repairs.get(f.workspace.id, round.id);
        expect(ended.status).toBe('completed');
        expect(ended.learnerOutcome).toBe(i === 10 ? 'passed' : 'not_yet');
      }
      for (const lesson of plan.lessons) {
        if (!f.c.lessons.list(f.workspace.id).find((l) => l.id === lesson.id)!.completed) {
          const visit = await f.open(plan, lesson.id);
          f.complete(visit.content, visit.session);
        }
      }
      expect(f.c.progress(f.workspace.id).learningRouteCompleted).toBe(true);
      expect(f.c.records(f.workspace.id).formalGrades.length).toBe(0);
      for (let i = 0; i < 2; i++) {
        const op = await f.settle(
          f.c.operations.start(f.workspace.id, cmd(), 'prepareFormal', `formal:${i}`, 'formal', {
            curriculumId: plan.id,
            blueprintId: plan.assessmentBlueprint.id,
            paperRequestId: `paper_${i}`,
          }),
        );
        const paper = f.c.questions.get(f.workspace.id, op.resourceId!);
        expect(paper.items.length).toBeLessThan(f.c.planning.inventory(plan).knowledge.length);
        const started = f.c.grading.startFormal(f.workspace.id, paper.id, cmd());
        expect(JSON.stringify(started.quiz)).not.toContain('"answer"');
        await f.submit(paper, true);
      }
      expect(f.c.records(f.workspace.id).formalGrades.length).toBe(2);
      expect(
        f.c.progress(f.workspace.id).knowledge.some((k) => k.formalStatus === 'untested'),
      ).toBe(true);
      const records = f.c.records(f.workspace.id);
      const calls = { ...provider.calls };
      const workspaceId = f.workspace.id;
      await f.close();
      const restarted = fixture(new CourseFakeProvider(), path);
      expect(restarted.c.records(workspaceId)).toEqual(records);
      expect(restarted.c.progress(workspaceId).learningRouteCompleted).toBe(true);
      expect((restarted.provider as CourseFakeProvider).calls).toEqual({});
      expect(provider.calls).toEqual(calls);
      await restarted.close();
    } finally {
      if (f.db.open) await f.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
