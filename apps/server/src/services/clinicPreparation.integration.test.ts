import { describe, it, expect, vi } from 'vitest';
import { fixture, cmd, GOLDEN_TEXT } from '../testing/clinicFixture.js';
import { CourseFakeProvider } from '../llm/courseFakeProvider.js';
import {
  CourseOperationSchema,
  type CourseOperation,
  type CoursePreferences,
} from '@hy3-clinic/shared';
import { sha256 } from '../util/canonical.js';

describe('V2 课程准备设置、真实进度与资料身份', () => {
  it('四档具有不同的教学内容和目标，逐课调整同步冻结蓝图但不购买新规划或强制考试', async () => {
    const provider = new CourseFakeProvider();
    const f = fixture(provider);
    try {
      let plan = await f.prepare();
      const procedure = plan.lessons.find((l) =>
        f.c.planning
          .inventory(plan)
          .knowledge.some((k) => k.kind === 'procedure' && l.knowledgeIds.includes(k.id)),
      )!;
      const expected = {
        introductory: 'understand',
        standard: 'apply',
        proficient: 'evaluate',
        advanced: 'design',
      } as const;
      const lessonInputs: Parameters<CourseFakeProvider['generateLesson']>[0][] = [];
      const original = provider.generateLesson.bind(provider);
      vi.spyOn(provider, 'generateLesson').mockImplementation(async (input, options) => {
        lessonInputs.push(input);
        return original(input, options);
      });
      const texts: string[] = [];
      for (const depth of ['introductory', 'standard', 'proficient', 'advanced'] as const) {
        plan = f.c.planning.patchDepth(f.workspace.id, plan.id, plan.version, [
          { lessonId: procedure.id, depth },
        ]);
        const lesson = plan.lessons.find((l) => l.id === procedure.id)!;
        expect(lesson.objectives.every((o) => o.demand === expected[depth])).toBe(true);
        expect(
          plan.assessmentBlueprint.cells
            .filter((c) => c.objectiveIds.some((id) => lesson.objectives.some((o) => o.id === id)))
            .every((c) => c.demand === expected[depth]),
        ).toBe(true);
        const inventory = f.c.planning.inventory(plan);
        const output = await provider.generateLesson({
          lesson,
          knowledge: inventory.knowledge.filter((k) => lesson.knowledgeIds.includes(k.id)),
          sources: f.c.sources.references(
            f.workspace.id,
            inventory.knowledge
              .filter((k) => lesson.knowledgeIds.includes(k.id))
              .flatMap((k) => k.sourceSpans),
          ),
        });
        texts.push(output.segments.map((s) => s.text).join('\n'));
      }
      expect(new Set(texts).size).toBe(4);
      expect(texts[2]).toContain('约束取舍');
      expect(texts[3]).toContain('陌生情境');
      expect(lessonInputs.map((i) => i.lesson.selectedDepth)).toEqual([
        'introductory',
        'standard',
        'proficient',
        'advanced',
      ]);
      expect(provider.calls.generateCoursePlan).toBe(1);
      expect(provider.calls.generateQuestions).toBeUndefined();
    } finally {
      await f.close();
    }
  });
  it('深度与重点进入同一次规划和按需课文，保留全集与核心考核，改重点不会复用旧课文', async () => {
    const provider = new CourseFakeProvider();
    const planCall = vi.spyOn(provider, 'generateCoursePlan');
    const lessonCall = vi.spyOn(provider, 'generateLesson');
    const f = fixture(provider);
    try {
      await f.c.sources.import(f.workspace.id, { content: GOLDEN_TEXT });
      const sourceScopeHash = f.c.sources.scopeHash(f.workspace.id);
      const preferences: CoursePreferences = {
        desiredDepth: 'advanced',
        focusRequest: '解释方向与条件变化',
      };
      const prepare = (value: CoursePreferences) =>
        f.settle(
          f.c.operations.start(f.workspace.id, cmd(), 'preparePlan', 'plan', 'curriculum', {
            sourceScopeHash,
            preferences: value,
          }),
        );
      const completed = await prepare(preferences);
      expect(completed.preferences).toEqual(preferences);
      expect(completed.progress).toMatchObject({
        phase: 'ready',
        completedSourceBlocks: f.c.sources.blocks(f.workspace.id).length,
        totalSourceBlocks: f.c.sources.blocks(f.workspace.id).length,
      });
      expect(CourseOperationSchema.parse(completed).status).toBe('completed');
      const draft = f.c.planning.get(f.workspace.id)!;
      expect(draft.preferences).toEqual(preferences);
      expect(draft.lessons.every((l) => l.selectedDepth === 'advanced')).toBe(true);
      expect(
        draft.lessons
          .flatMap((l) => l.objectives)
          .every((o) => ['analyze', 'evaluate', 'design'].includes(o.demand)),
      ).toBe(true);
      expect(draft.assessmentBlueprint.cells.every((c) => c.difficultyBand === 'advanced')).toBe(
        true,
      );
      expect(new Set(draft.lessons.flatMap((l) => l.knowledgeIds))).toEqual(
        new Set(draft.teachingRequiredKnowledgeIds),
      );
      expect(planCall).toHaveBeenCalledTimes(1);
      expect(planCall.mock.calls[0]![0].preferences).toEqual(preferences);
      expect(provider.calls.generateLesson).toBeUndefined();
      expect(provider.calls.generateQuestions).toBeUndefined();
      // Both lessons carry an explicit condition/exception. Each uses one
      // necessary scope check, reused on preparation recovery.
      expect(provider.calls.reviewKnowledgeScope).toBe(2);
      expect(provider.calls.extractCourseKnowledge).toBe(1);
      await prepare(preferences);
      expect(planCall).toHaveBeenCalledTimes(1);
      const first = f.accept(draft);
      const room = await f.open(first);
      f.complete(room.content, room.session);
      expect(lessonCall.mock.calls[0]![0].preferences).toEqual(preferences);
      const revised = { ...preferences, focusRequest: '特别比较速度与速率' };
      await prepare(revised);
      const second = f.c.planning.get(f.workspace.id)!;
      expect(second.id).not.toBe(first.id);
      expect(second.inventoryId).toBe(first.inventoryId);
      expect(provider.calls.extractCourseKnowledge).toBe(1);
      expect(planCall).toHaveBeenCalledTimes(2);
      expect(provider.calls.reviewKnowledgeScope).toBe(2);
      const newRoom = await f.open(f.accept(second));
      expect(newRoom.content.id).not.toBe(room.content.id);
      expect(lessonCall).toHaveBeenCalledTimes(2);
      expect(lessonCall.mock.calls[1]![0].preferences).toEqual(revised);
      expect(f.c.lessons.classroom(f.workspace.id, room.session.id).session.status).toBe(
        'completed',
      );
      expect(f.c.sources.scopeHash(f.workspace.id)).toBe(sourceScopeHash);
      // Returning to an earlier preference must publish a visible new draft,
      // while cached author output still avoids another planning purchase.
      await prepare(preferences);
      const returned = f.c.planning.get(f.workspace.id)!;
      expect(returned.id).not.toBe(second.id);
      expect(returned.status).toBe('draft');
      expect(returned.preferences).toEqual(preferences);
      expect(provider.calls.extractCourseKnowledge).toBe(1);
      expect(planCall).toHaveBeenCalledTimes(2);
    } finally {
      await f.close();
    }
  });
  it('运行中公开已保存事实；取消后迟到结果不能覆盖停止状态或发布规划', async () => {
    const provider = new CourseFakeProvider();
    const original = provider.extractCourseKnowledge.bind(provider);
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(provider, 'extractCourseKnowledge').mockImplementationOnce(async (input) => {
      started();
      await gate;
      return original(input);
    });
    const f = fixture(provider);
    try {
      await f.c.sources.import(f.workspace.id, { content: GOLDEN_TEXT });
      const op = f.c.operations.start(f.workspace.id, cmd(), 'preparePlan', 'plan', 'curriculum', {
        sourceScopeHash: f.c.sources.scopeHash(f.workspace.id),
        preferences: { desiredDepth: 'introductory', focusRequest: '' },
      });
      await entered;
      const running = f.c.operations.get(f.workspace.id, op.id);
      expect(running.status).toBe('running');
      expect(running.progress).toMatchObject({
        phase: 'knowledge',
        completedSourceBlocks: 0,
        knowledgeCount: 0,
      });
      expect(running.progress!.totalSourceBlocks).toBeGreaterThan(0);
      const cancelled = f.c.operations.cancel(f.workspace.id, op.id, cmd(), running.version);
      release();
      await f.c.operations.idle(op.id);
      expect(f.c.operations.get(f.workspace.id, op.id)).toEqual(cancelled);
      expect(f.c.planning.get(f.workspace.id)).toBeNull();
    } finally {
      release();
      await f.close();
    }
  });
  it('资料标题独立于编码文件名；摘要 GET 不写库、重命名不改来源或重新购买模型，跨课程被拒绝', async () => {
    const f = fixture();
    try {
      const filename = '%E7%94%A8%E6%88%B7%E8%AE%BF%E8%B0%88.md';
      const material = await f.c.sources.import(f.workspace.id, {
        content: '# 用户访谈\n\n先追问真实经历，再区分事实与推断。',
        filename,
      });
      expect(material.title).toBe('用户访谈');
      expect(material.filename).toBe(filename);
      const scope = f.c.sources.scopeHash(f.workspace.id);
      const before = sha256(f.db.serialize());
      const list = await f.app.inject({ url: `/api/workspaces/${f.workspace.id}/materials` });
      expect(list.statusCode).toBe(200);
      expect(list.json().materials[0]).toMatchObject({
        filename,
        title: '用户访谈',
        revisionId: material.revisionId,
        blockCount: 1,
      });
      expect(sha256(f.db.serialize())).toBe(before);
      const other = f.c.sources.createWorkspace('另一门课程');
      const url = `/api/workspaces/${f.workspace.id}/materials/${material.id}`;
      expect(
        (
          await f.app.inject({
            method: 'PATCH',
            url: `/api/workspaces/${other.id}/materials/${material.id}`,
            payload: { command: cmd(), title: '错误' },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (await f.app.inject({ method: 'PATCH', url, payload: { command: cmd(), title: ' ' } }))
          .statusCode,
      ).toBe(400);
      expect(
        (
          await f.app.inject({
            method: 'PATCH',
            url,
            payload: { command: cmd(), title: '访谈教材 · 阅读版' },
          })
        ).statusCode,
      ).toBe(200);
      expect(f.c.sources.materials(f.workspace.id)[0]).toMatchObject({
        filename,
        revisionId: material.revisionId,
        title: '访谈教材 · 阅读版',
      });
      expect(f.c.sources.scopeHash(f.workspace.id)).toBe(scope);
      expect((f.provider as CourseFakeProvider).calls).toEqual({});
    } finally {
      await f.close();
    }
  });
  it('HTTP 拒绝退役深度、未知设置和跨课程深度修改，不自动确认', async () => {
    const f = fixture();
    try {
      await f.c.sources.import(f.workspace.id, { content: GOLDEN_TEXT });
      const url = `/api/workspaces/${f.workspace.id}/course-plan/prepare`;
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url,
            payload: {
              command: cmd(),
              preferences: { desiredDepth: 'deep_transfer', focusRequest: '' },
            },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url,
            payload: {
              command: cmd(),
              preferences: { desiredDepth: 'advanced', focusRequest: '', forceExam: true },
            },
          })
        ).statusCode,
      ).toBe(400);
      const response = await f.app.inject({
        method: 'POST',
        url,
        payload: {
          command: cmd(),
          preferences: { desiredDepth: 'introductory', focusRequest: '基础关系' },
        },
      });
      await f.settle(response.json<CourseOperation>());
      const plan = f.c.planning.get(f.workspace.id)!;
      expect(plan.status).toBe('draft');
      expect(plan.lessons.every((l) => l.selectedDepth === 'introductory')).toBe(true);
      expect(f.c.repo.rows('SELECT * FROM course_lesson_versions')).toHaveLength(0);
      const foreign = f.c.sources.createWorkspace('其他课程');
      expect(
        (
          await f.app.inject({
            method: 'PATCH',
            url: `/api/workspaces/${foreign.id}/course-plan/${plan.id}/lesson-depths`,
            payload: {
              command: cmd(),
              expectedVersion: plan.version,
              changes: [{ lessonId: plan.lessons[0]!.id, depth: 'advanced' }],
            },
          })
        ).statusCode,
      ).toBe(404);
    } finally {
      await f.close();
    }
  });
});
