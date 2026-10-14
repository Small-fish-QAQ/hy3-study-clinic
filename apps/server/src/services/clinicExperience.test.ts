import { describe, it, expect, vi } from 'vitest';
import { CourseFakeProvider } from '../llm/courseFakeProvider.js';
import { fixture, cmd } from '../testing/clinicFixture.js';
import { assessmentScope } from './unitAssessment.js';
import { sha256 } from '../util/canonical.js';
import type { LessonInput, CourseTutorInput, PlanInput } from '../llm/courseContract.js';
import type { CourseOperation } from '@hy3-clinic/shared';
import { openDatabase } from '../db/database.js';
import { initializeClinic, SCHEMA_VERSION } from '../db/schema.js';

class InteractiveProvider extends CourseFakeProvider {
  override async generateLesson(input: LessonInput) {
    const result = await super.generateLesson(input);
    return {
      ...result,
      segments: [
        ...result.segments,
        {
          id: 'think',
          kind: 'optional_prompt' as const,
          text: '若方向改变，速度的符号一定改变吗？请说明条件。',
          origin: 'extension' as const,
          sourceRefs: [],
          uncertaintyCodes: [],
        },
      ],
    };
  }
  override async generateCoursePlan(input: PlanInput) {
    const result = await super.generateCoursePlan(input);
    if ('lessons' in result && result.lessons.length > 1) {
      result.modules.push({ id: 'second', title: '另一学习单元' });
      result.lessons.slice(1).forEach((l) => {
        l.moduleId = 'second';
      });
    }
    return result;
  }
}
describe('课堂体验、真实范围与轻量记录', () => {
  it('自由问题和服务器校验的引用分别进 Provider/历史，伪造引用在调用前拒绝', async () => {
    const provider = new InteractiveProvider(),
      f = fixture(provider);
    try {
      const plan = f.accept(await f.prepare()),
        { content, session } = await f.open(plan);
      const tutor = vi.spyOn(provider, 'respondToTutorTurn');
      const anchor = {
        lessonVersionId: content.id,
        segmentIds: [content.segments[0]!.id],
        selectedText: content.segments[0]!.text.slice(0, 12),
      };
      const url = `/api/workspaces/${f.workspace.id}/study-sessions/${session.id}/turns`;
      const response = await f.app.inject({
        method: 'POST',
        url,
        payload: { question: '这个条件改变后还有哪些情况？', anchor },
      });
      expect(response.statusCode).toBe(200);
      const input: CourseTutorInput = tutor.mock.calls[0]![0];
      expect(input.question).toBe('这个条件改变后还有哪些情况？');
      expect(input.anchor).toEqual(anchor);
      expect(input.anchorContext?.[0]?.text).toBe(content.segments[0]!.text);
      expect(f.c.lessons.classroom(f.workspace.id, session.id).turns[0]?.anchor).toEqual(anchor);
      for (const bad of [
        { ...anchor, selectedText: '这不是保存的讲解' },
        { ...anchor, lessonVersionId: 'foreign' },
        { ...anchor, segmentIds: [anchor.segmentIds[0]!, anchor.segmentIds[0]!] },
      ]) {
        expect(
          (await f.app.inject({ method: 'POST', url, payload: { question: '解释', anchor: bad } }))
            .statusCode,
        ).toBe(400);
      }
      expect(tutor).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });
  it('思考可延后/跳过/恢复/作答，保存幂等与版本冲突保护，不阻塞完成且不写成绩或诊断', async () => {
    const f = fixture(new InteractiveProvider());
    try {
      const plan = f.accept(await f.prepare()),
        { content, session } = await f.open(plan);
      const url = `/api/workspaces/${f.workspace.id}/lesson-versions/${content.id}/reflections/think`;
      const write = async (status: string, version: number) =>
        f.app.inject({
          method: 'PUT',
          url,
          payload: {
            command: cmd(),
            status,
            response: '要看原坐标约定和位移。',
            expectedVersion: version,
          },
        });
      expect((await write('deferred', 0)).statusCode).toBe(200);
      f.complete(content, session);
      expect((await write('skipped', 1)).statusCode).toBe(200);
      expect((await write('open', 2)).statusCode).toBe(200);
      expect((await write('answered', 3)).statusCode).toBe(200);
      expect((await write('skipped', 3)).statusCode).toBe(409);
      const room = f.c.lessons.classroom(f.workspace.id, session.id);
      expect(room.reflections[0]).toMatchObject({ status: 'answered', version: 4 });
      expect(f.c.progress(f.workspace.id).classroomTasks[0]?.status).toBe('answered');
      expect(f.c.progress(f.workspace.id).completedLessonIds).toContain(content.lessonId);
      for (const table of ['submissions', 'evidence', 'assessment_grade_records', 'review_targets'])
        expect(f.c.repo.row<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n).toBe(0);
      const forged = await f.app.inject({
        method: 'PUT',
        url: url.replace('/think', `/${content.segments[0]!.id}`),
        payload: { command: cmd(), status: 'answered', response: 'a', expectedVersion: 0 },
      });
      expect(forged.statusCode).toBe(400);
      expect(f.c.reflections.list(f.workspace.id)[0]?.response).toBe('要看原坐标约定和位移。');
    } finally {
      await f.close();
    }
  });
  it('单元 Formal 不要求学习或练习，冻结局部蓝图/权重并只签发实际单元知识证据', async () => {
    const provider = new InteractiveProvider(),
      f = fixture(provider);
    try {
      const plan = f.accept(await f.prepare());
      expect(plan.modules.length).toBe(2);
      const before = sha256(plan),
        selected = assessmentScope(plan, plan.modules[0]!.id);
      expect(selected.blueprint.requiredCellIds.length).toBeLessThan(
        plan.assessmentBlueprint.requiredCellIds.length,
      );
      expect(
        selected.blueprint.cells.every((c) =>
          [
            ...c.mandatoryKnowledgeIds,
            ...c.representativeSets.flatMap((s) => s.candidateKnowledgeIds),
          ].every((id) => selected.scope.knowledgeIds.includes(id)),
        ),
      ).toBe(true);
      const author = vi.spyOn(provider, 'generateQuestions');
      const result = await f.app.inject({
        method: 'POST',
        url: `/api/workspaces/${f.workspace.id}/formal-exams`,
        payload: {
          command: cmd(),
          curriculumId: plan.id,
          blueprintId: plan.assessmentBlueprint.id,
          paperRequestId: 'unit',
          moduleId: plan.modules[0]!.id,
        },
      });
      const op = await f.settle(result.json<CourseOperation>());
      const quiz = f.c.questions.get(f.workspace.id, op.resourceId!);
      expect(quiz.assessmentScope).toEqual(selected.scope);
      expect(quiz.blueprint).toEqual(selected.blueprint);
      expect(
        author.mock.calls[0]?.[0].teachingIntent?.lessons.every((l) =>
          selected.scope.lessonIds.includes(l.id),
        ),
      ).toBe(true);
      await f.app.inject({
        method: 'POST',
        url: `/api/formal-assessment-versions/${quiz.id}/execution`,
        payload: { workspaceId: f.workspace.id, command: cmd() },
      });
      await f.submit(quiz);
      const grade = f.c.repo.payloads<{ assessmentScope: unknown }>(
        'SELECT payload FROM assessment_grade_records',
      )[0]!;
      expect(grade.assessmentScope).toEqual(selected.scope);
      const evidence = f.c.repo.payloads<{ knowledgeId: string }>('SELECT payload FROM evidence');
      expect(evidence.every((e) => selected.scope.knowledgeIds.includes(e.knowledgeId))).toBe(true);
      const untouched = f.c
        .progress(f.workspace.id)
        .knowledge.filter((k) => !selected.scope.knowledgeIds.includes(k.id));
      expect(untouched.every((k) => k.formalStatus === 'untested')).toBe(true);
      expect(sha256(f.c.planning.get(f.workspace.id))).toBe(before);
      expect(f.c.progress(f.workspace.id).completedLessons).toBe(0);
      expect(assessmentScope(plan).blueprint).toBe(plan.assessmentBlueprint);
      expect(() => assessmentScope(plan, 'foreign')).toThrow('不属于');
      expect(f.c.questions.public(quiz)).not.toHaveProperty('blueprint');
    } finally {
      await f.close();
    }
  });
  it('V2 additive schema preserves immutable grades and completed classrooms when adding reflections', () => {
    const db = openDatabase(':memory:');
    try {
      initializeClinic(db);
      db.exec('DROP TABLE lesson_reflections');
      db.exec('DROP TABLE course_plan_candidates');
      db.pragma('user_version=4');
      db.prepare('INSERT INTO workspaces VALUES(?,?,?)').run(
        'w',
        'protected',
        '2026-10-12T00:00:00.000Z',
      );
      const before = db
        .prepare("SELECT sql FROM sqlite_master WHERE name='immutable_ready_quiz'")
        .get();
      initializeClinic(db);
      expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
      expect(db.prepare('SELECT title FROM workspaces').get()).toEqual({ title: 'protected' });
      expect(
        db.prepare("SELECT sql FROM sqlite_master WHERE name='immutable_ready_quiz'").get(),
      ).toEqual(before);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });
});
