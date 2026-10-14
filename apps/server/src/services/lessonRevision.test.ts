import { describe, expect, it } from 'vitest';
import type { LessonAuthor } from '@hy3-clinic/shared';
import { mergeLessonRevision } from './lessonRevision.js';
import { fixture, cmd } from '../testing/clinicFixture.js';
import { CourseFakeProvider } from '../llm/courseFakeProvider.js';
import type { LessonInput } from '../llm/courseContract.js';
import { validateLessonDelivery } from './lessonDelivery.js';

const segment = (id: string, text: string) => ({
  id,
  text,
  kind: 'explanation' as const,
  origin: 'extension' as const,
  sourceRefs: [],
  uncertaintyCodes: [],
});
describe('Lesson局部身份与手动恢复', () => {
  it('引用仅末尾标点不同可定位，改词和重复正文仍拒绝', async () => {
    const f = fixture();
    try {
      const plan = f.accept(await f.prepare());
      const lesson = plan.lessons[0]!;
      const knowledge = f.c.planning
        .inventory(plan)
        .knowledge.filter((k) => lesson.knowledgeIds.includes(k.id));
      const author = await f.provider.generateLesson({ lesson, knowledge, sources: [] });
      const c = author.teachingCoverage[0]!,
        s = author.segments[0]!;
      c.teachingQuote = '真实讲解。';
      s.text = '真实讲解：这里继续解释。';
      expect(validateLessonDelivery(lesson, knowledge, author).anchors[0]?.end).toBe(4);
      c.teachingQuote = '不存在的讲解。';
      expect(() => validateLessonDelivery(lesson, knowledge, author)).toThrow('quote');
      c.teachingQuote = '真实讲解。';
      s.text = '真实讲解：真实讲解：';
      expect(() => validateLessonDelivery(lesson, knowledge, author)).toThrow('quote');
    } finally {
      await f.close();
    }
  });
  it('局部新增段ID撞上健康段时只规范新增身份，正文和来源不改写', () => {
    const original: LessonAuthor = {
      title: '课文',
      segments: [segment('one', '坏范围'), segment('two', '健康范围')],
      teachingCoverage: [
        { knowledgeId: 'k', objectiveIds: ['o'], segmentId: 'one', teachingQuote: '坏范围' },
      ],
    };
    const fixed: LessonAuthor = {
      title: '局部',
      segments: [segment('one', '正确范围'), segment('two', '局部新增例子')],
      teachingCoverage: [
        { knowledgeId: 'k', objectiveIds: ['o'], segmentId: 'two', teachingQuote: '局部新增例子' },
      ],
    };
    const merged = mergeLessonRevision(original, fixed, ['one'], original.teachingCoverage);
    expect(merged.segments.find((s) => s.id === 'two')).toEqual(original.segments[1]);
    const added = merged.segments.find((s) => s.text === '局部新增例子')!;
    expect(added.id).not.toBe('two');
    expect(merged.teachingCoverage[0]!.segmentId).toBe(added.id);
    expect(mergeLessonRevision(original, fixed, ['one'], original.teachingCoverage)).toEqual(
      merged,
    );
    expect(() =>
      mergeLessonRevision(
        original,
        { ...fixed, teachingCoverage: [{ ...fixed.teachingCoverage[0]!, knowledgeId: 'foreign' }] },
        ['one'],
        original.teachingCoverage,
      ),
    ).toThrow('超出指定');
  });
  it.each([false, true])(
    '已拒绝局部候选作下一次修订草稿，健康段保留；持续坏候选有界停止=%s',
    async (neverFix) => {
      class Local extends CourseFakeProvider {
        inputs: LessonInput[] = [];
        healthy = segment('healthy_added', '这一段是健康的可选拓展。');
        override async generateLesson(input: LessonInput) {
          this.inputs.push(structuredClone(input));
          const v = await super.generateLesson(input);
          if (!input.revision) {
            v.segments.push(this.healthy);
            v.teachingCoverage[0]!.teachingQuote = '这段引文在正文中不存在。';
          } else {
            v.segments[0]!.text += `\n局部稿${this.inputs.length}`;
            v.segments.push(segment('healthy_added', '局部新增的可选例子。'));
            if (neverFix || this.inputs.length === 2)
              v.teachingCoverage[0]!.teachingQuote = '局部引文仍不存在。';
          }
          return v;
        }
      }
      const provider = new Local(),
        f = fixture(provider);
      try {
        const plan = f.accept(await f.prepare());
        const request = { curriculumId: plan.id, lessonId: plan.lessons[0]!.id };
        const first = f.c.operations.start(
          f.workspace.id,
          cmd(),
          'prepareLesson',
          `lesson:${request.lessonId}`,
          'lesson',
          request,
        );
        await f.c.operations.idle(first.id);
        const failed = f.c.operations.get(f.workspace.id, first.id);
        expect(failed.status).toBe('failed');
        expect(provider.inputs).toHaveLength(2);
        const next = f.c.operations.retry(f.workspace.id, failed.id, cmd(), failed.version);
        await f.c.operations.idle(next.id);
        const result = f.c.operations.get(f.workspace.id, next.id);
        expect(provider.inputs).toHaveLength(3);
        expect(provider.inputs[2]!.revision!.draft.segments[0]!.text).toContain('局部稿2');
        expect(provider.inputs[2]!.revision!.findings.join(' ')).toContain('quote');
        if (!neverFix) {
          expect(result.error, JSON.stringify(result.error)).toBeNull();
          expect(result.status).toBe('completed');
          const content = f.c.lessons.content(plan, request.lessonId)!;
          expect(content.segments.find((s) => s.id === 'healthy_added')).toEqual(provider.healthy);
        } else {
          expect(result.status).toBe('failed');
          const stop = f.c.operations.retry(f.workspace.id, result.id, cmd(), result.version);
          await f.c.operations.idle(stop.id);
          const blocked = f.c.operations.get(f.workspace.id, stop.id);
          expect(blocked.error?.retryable).toBe(false);
          expect(provider.inputs).toHaveLength(3);
          expect(() =>
            f.c.operations.retry(f.workspace.id, blocked.id, cmd(), blocked.version),
          ).toThrow('不能重试');
        }
      } finally {
        await f.close();
      }
    },
  );
});
