import { describe, it, expect } from 'vitest';
import { fixture, cmd } from '../testing/clinicFixture.js';
import { CourseFakeProvider } from '../llm/courseFakeProvider.js';
import type {
  LessonInput,
  KnowledgeInput,
  KnowledgeReviewInput,
  KnowledgeOutput,
} from '../llm/courseContract.js';
import { ProviderError } from '../llm/errors.js';
import { KnowledgeOutputSchema } from '../llm/courseContract.js';
import { sha256 } from '../util/canonical.js';
import { CourseValidationError } from './courseValidation.js';

describe('scope恢复与执行权 A07/A11/A12', () => {
  it('提取语义失败只返回指定K的修正版，服务器保留同包健康知识和来源，不扩大审核轮数', async () => {
    class Located extends CourseFakeProvider {
      first: KnowledgeOutput | null = null;
      local: string[] = [];
      extractionReviews = 0;
      override async extractCourseKnowledge(input: KnowledgeInput) {
        if (input.revision?.localRefs) {
          this.local = input.revision.localRefs;
          const draft = input.revision.draft as KnowledgeOutput;
          this.calls.extractCourseKnowledge = (this.calls.extractCourseKnowledge ?? 0) + 1;
          return {
            ...draft,
            knowledge: draft.knowledge
              .filter((k) => this.local.includes(k.localRef))
              .map((k) => ({ ...k, statement: '正确命题。' })),
          };
        }
        const value = await super.extractCourseKnowledge(input);
        value.knowledge[0]!.statement = '被定位的假命题。';
        value.knowledge[0]!.uncertaintyCodes = ['suspected_textbook_error'];
        this.first = structuredClone(value);
        return value;
      }
      override async reviewKnowledgeScope(input: KnowledgeReviewInput) {
        if (input.findings.includes('提取明确不确定')) this.extractionReviews++;
        const value = await super.reviewKnowledgeScope(input);
        const wrong = input.knowledge.find((k) => k.statement === '被定位的假命题。');
        return wrong
          ? {
              ...value,
              accepted: false,
              findings: ['首项陈述与来源相反'],
              issues: [
                {
                  target: 'knowledge' as const,
                  code: 'false_statement' as const,
                  knowledgeIds: [wrong.id],
                  lessonIds: [],
                  message: '首项陈述与来源相反',
                },
              ],
            }
          : value;
      }
    }
    const provider = new Located(),
      f = fixture(provider);
    try {
      await f.c.sources.import(f.workspace.id, {
        content: '# 教材\n\n正确命题。\n\n另一条健康命题。',
      });
      await f.settle(
        f.c.operations.start(f.workspace.id, cmd(), 'preparePlan', 'plan', 'curriculum', {
          sourceScopeHash: f.c.sources.scopeHash(f.workspace.id),
        }),
      );
      const inv = f.c.planning.inventory(f.c.planning.get(f.workspace.id)!);
      expect(provider.local).toEqual(['k0']);
      expect(inv.knowledge).toHaveLength(provider.first!.knowledge.length);
      expect(inv.knowledge[1]!.statement).toBe(provider.first!.knowledge[1]!.statement);
      expect(inv.dispositions).toHaveLength(provider.first!.dispositions.length);
      expect(provider.calls.extractCourseKnowledge).toBe(2);
      expect(provider.extractionReviews).toBe(2);
    } finally {
      await f.close();
    }
  });
  it('完整历史知识仅漏重复登记时本地恢复物理候选，仍拒绝真正未处理来源，不重新买作者', async () => {
    const provider = new CourseFakeProvider(),
      f = fixture(provider);
    try {
      await f.c.sources.import(f.workspace.id, { content: '# 范围\n\n正文命题。\n\n应核对原件。' });
      const blocks = f.c.sources.blocks(f.workspace.id);
      const input = { blocks };
      const ctx = {
        workspaceId: f.workspace.id,
        operationId: null,
        provider,
        signal: new AbortController().signal,
        check() {},
      };
      const candidate = await f.c.generation.stage(
        ctx,
        'extractCourseKnowledge',
        input,
        sha256(blocks),
        KnowledgeOutputSchema,
        async (opts) => {
          const value = await provider.extractCourseKnowledge(input, opts);
          const final = value.dispositions.at(-1)!;
          return {
            ...value,
            dispositions: [
              {
                ...final,
                exclusion: {
                  kind: 'frontmatter' as const,
                  reason: '仅为核对提示',
                },
              },
            ],
          };
        },
      );
      // Construct a genuine completed old-contract fixture; no synthetic accepted inventory.
      const mapping = new Map(candidate.value.knowledge.map((k) => [k.localRef, k.localRef]));
      const old = {
        knowledge: candidate.value.knowledge.map((k) => ({ ...k, id: mapping.get(k.localRef)! })),
        dispositions: candidate.value.dispositions,
      };
      let findings: string[] = [];
      try {
        (
          f.c.knowledge as unknown as {
            validatePacket(w: string, b: typeof blocks, p: typeof old): void;
          }
        ).validatePacket(f.workspace.id, blocks, old);
      } catch (error) {
        if (error instanceof CourseValidationError) findings = error.findings;
        else throw error;
      }
      expect(findings.length).toBeGreaterThan(0);
      f.c.generation.reject(candidate.callId, findings);
      await f.settle(
        f.c.operations.start(f.workspace.id, cmd(), 'preparePlan', 'plan', 'curriculum', {
          sourceScopeHash: f.c.sources.scopeHash(f.workspace.id),
        }),
      );
      expect(provider.calls.extractCourseKnowledge).toBe(1);
      const plan = f.c.planning.get(f.workspace.id)!;
      expect(f.c.planning.inventory(plan).dispositions).toHaveLength(blocks.length);
      expect(f.c.planning.inventory(plan).knowledge).toHaveLength(candidate.value.knowledge.length);
      expect(
        f.c.repo.payload<{ contentRejected: boolean }>(
          'SELECT payload FROM llm_calls WHERE id=?',
          candidate.callId,
        )?.contentRejected,
      ).toBe(true);
    } finally {
      await f.close();
    }
  });
  it('原稿结构失败后修订稿语义失败，显式retry即使分包估计变化也继续最新修订及其原因', async () => {
    class Revised extends CourseFakeProvider {
      attempts: KnowledgeInput[] = [];
      knowledgePacketFits(blocks: unknown[], single = false) {
        return single || this.attempts.length < 2 || blocks.length === 1;
      }
      override async extractCourseKnowledge(input: KnowledgeInput) {
        this.attempts.push(structuredClone(input));
        const output = await super.extractCourseKnowledge(input);
        const attempt = this.attempts.length;
        output.knowledge[0]!.title =
          attempt === 1 ? '结构旧稿' : attempt === 2 ? '语义修订稿' : '语义已修复';
        output.knowledge[0]!.uncertaintyCodes = ['suspected_textbook_error'];
        if (attempt === 1) {
          output.knowledge[0]!.sourceSpans = [];
          output.dispositions[0]!.knowledgeIds = [];
        }
        return output;
      }
      override async reviewKnowledgeScope(input: KnowledgeReviewInput) {
        const result = await super.reviewKnowledgeScope(input);
        return input.knowledge.some((k) => k.title === '语义修订稿')
          ? { ...result, accepted: false, findings: ['最新修订稿标题错误，需要语义修复'] }
          : result;
      }
    }
    const provider = new Revised();
    const f = fixture(provider);
    try {
      await f.c.sources.import(f.workspace.id, {
        content: '# 方法\n\n定义：速度含有方向。\n\n条件：取相同坐标。',
      });
      const operation = f.c.operations.start(
        f.workspace.id,
        cmd(),
        'preparePlan',
        'plan',
        'curriculum',
        { sourceScopeHash: f.c.sources.scopeHash(f.workspace.id) },
      );
      await f.c.operations.idle(operation.id);
      const failed = f.c.operations.get(f.workspace.id, operation.id);
      expect(failed.status).toBe('failed');
      expect(provider.attempts).toHaveLength(2);
      await f.settle(f.c.operations.retry(f.workspace.id, failed.id, cmd(), failed.version));
      const retry = provider.attempts[2]!;
      expect((retry.revision?.draft as KnowledgeOutput).knowledge[0]!.title).toBe('语义修订稿');
      expect(retry.revision?.findings).toEqual(['最新修订稿标题错误，需要语义修复']);
      expect(retry.blocks).toEqual(provider.attempts[0]!.blocks);
      expect(provider.attempts).toHaveLength(3);
    } finally {
      await f.close();
    }
  });
  it('租约在慢模型期间续约，owner变化后拒绝迟到发布，重启不自动调用模型', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    class Slow extends CourseFakeProvider {
      override async generateLesson(input: LessonInput) {
        const output = await super.generateLesson(input);
        await gate;
        return output;
      }
    }
    const provider = new Slow();
    const f = fixture(provider);
    try {
      const plan = f.accept(await f.prepare());
      const { CourseOperationRunner } = await import('./courseOperationRunner.js');
      const runner = new CourseOperationRunner(f.c.repo, () => provider, 300, 50);
      runner.register('prepareLesson', (ctx, request) =>
        f.c.lessons.prepare(ctx, request as { curriculumId: string; lessonId: string }),
      );
      const op = runner.start(f.workspace.id, cmd(), 'prepareLesson', 'slow', 'lesson', {
        curriculumId: plan.id,
        lessonId: plan.lessons[0]!.id,
      });
      await new Promise((r) => setTimeout(r, 450));
      expect(runner.get(f.workspace.id, op.id).status).toBe('running');
      f.c.repo.run('UPDATE agent_operations SET owner=? WHERE id=?', 'replacement-owner', op.id);
      release();
      await runner.idle();
      expect(
        f.c.repo.row<{ n: number }>('SELECT COUNT(*) AS n FROM course_lesson_versions')!.n,
      ).toBe(0);
      runner.close();
    } finally {
      release();
      await f.close();
    }
  });
  it('两次技术失败后第三次显式retry成功，不设终身两候选门，同scope并发只买一次', async () => {
    class Flaky extends CourseFakeProvider {
      n = 0;
      override async generateLesson(input: LessonInput) {
        if (this.n++ < 2) throw ProviderError.timeout(1);
        return super.generateLesson(input);
      }
    }
    const provider = new Flaky();
    const f = fixture(provider);
    try {
      const plan = f.accept(await f.prepare());
      const req = { curriculumId: plan.id, lessonId: plan.lessons[0]!.id };
      const op = f.c.operations.start(
        f.workspace.id,
        cmd(),
        'prepareLesson',
        'lesson:one',
        'lesson',
        req,
      );
      const same = f.c.operations.start(
        f.workspace.id,
        cmd(),
        'prepareLesson',
        'lesson:one',
        'lesson',
        req,
      );
      expect(same.id).toBe(op.id);
      await f.c.operations.idle();
      let current = f.c.operations.get(f.workspace.id, op.id);
      expect(current.status).toBe('failed');
      for (let i = 0; i < 2; i++) {
        current = f.c.operations.retry(f.workspace.id, current.id, cmd(), current.version);
        await f.c.operations.idle(current.id);
        current = f.c.operations.get(f.workspace.id, current.id);
      }
      expect(current.status).toBe('completed');
      expect(provider.n).toBe(3);
    } finally {
      await f.close();
    }
  });
  it('取消后late完整候选保管但不发布；新命令重用候选不重买', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    class Late extends CourseFakeProvider {
      override async generateLesson(input: LessonInput) {
        const value = await super.generateLesson(input);
        await gate;
        return value;
      }
    }
    const provider = new Late();
    const f = fixture(provider);
    try {
      const plan = f.accept(await f.prepare());
      const req = { curriculumId: plan.id, lessonId: plan.lessons[0]!.id };
      const op = f.c.operations.start(
        f.workspace.id,
        cmd(),
        'prepareLesson',
        'lesson:one',
        'lesson',
        req,
      );
      await new Promise((r) => setTimeout(r, 10));
      const running = f.c.operations.get(f.workspace.id, op.id);
      f.c.operations.cancel(f.workspace.id, op.id, cmd(), running.version);
      release();
      await f.c.operations.idle();
      expect(
        f.c.repo.row<{ n: number }>('SELECT COUNT(*) AS n FROM course_lesson_versions')!.n,
      ).toBe(0);
      expect(
        f.c.repo.row<{ n: number }>(
          "SELECT COUNT(*) AS n FROM semantic_cache WHERE kind='retained_candidate_v2'",
        )!.n,
      ).toBeGreaterThan(0);
      const next = f.c.operations.start(
        f.workspace.id,
        cmd(),
        'prepareLesson',
        'lesson:one',
        'lesson',
        req,
      );
      await f.settle(next);
      expect(provider.calls.generateLesson).toBe(1);
    } finally {
      release();
      await f.close();
    }
  });
  it('来源改变后late候选只保管，不产生课文或课程正式支持', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    class Late extends CourseFakeProvider {
      override async generateLesson(input: LessonInput) {
        const output = await super.generateLesson(input);
        await gate;
        return output;
      }
    }
    const provider = new Late();
    const f = fixture(provider);
    try {
      const plan = f.accept(await f.prepare());
      const op = f.c.operations.start(
        f.workspace.id,
        cmd(),
        'prepareLesson',
        'source-fence',
        'lesson',
        { curriculumId: plan.id, lessonId: plan.lessons[0]!.id },
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      const material = f.c.sources.materials(f.workspace.id)[0]!;
      await f.c.sources.import(
        f.workspace.id,
        { content: '新资料改变原命题和适用条件。' },
        material.id,
      );
      release();
      await f.c.operations.idle();
      expect(f.c.operations.get(f.workspace.id, op.id).status).toBe('failed');
      expect(
        f.c.repo.row<{ n: number }>('SELECT COUNT(*) AS n FROM course_lesson_versions')!.n,
      ).toBe(0);
      expect(f.c.repo.row<{ n: number }>('SELECT COUNT(*) AS n FROM evidence')!.n).toBe(0);
    } finally {
      release();
      await f.close();
    }
  });
  it('failed Repair直接新轮并发收敛，旧retry不能复活', async () => {
    class Broken extends CourseFakeProvider {
      override async generateRepairRound() {
        throw ProviderError.timeout(1);
      }
    }
    const f = fixture(new Broken());
    try {
      const plan = f.accept(await f.prepare());
      const { content, session } = await f.open(plan);
      f.complete(content, session);
      const quiz = await f.practice(plan, content);
      const wrong = await f.submit(quiz, false);
      const input = {
        originKind: 'submission' as const,
        originId: wrong.id,
        targetItemIds: wrong.itemGrades.map((g) => g.questionId),
      };
      const first = f.c.repairs.start(f.workspace.id, cmd(), input);
      await f.c.operations.idle();
      expect(f.c.repairs.get(f.workspace.id, first.id).status).toBe('failed');
      const second = f.c.repairs.start(f.workspace.id, cmd(), input);
      const third = f.c.repairs.start(f.workspace.id, cmd(), input);
      expect(second.id).toBe(third.id);
      expect(second.ordinal).toBe(2);
      const oldOp = f.c.operations.get(f.workspace.id, first.operationId);
      expect(() => f.c.operations.retry(f.workspace.id, oldOp.id, cmd(), oldOp.version)).toThrow(
        '正在执行',
      );
      await f.c.operations.idle();
      const resumed = f.c.operations.retry(f.workspace.id, oldOp.id, cmd(), oldOp.version);
      await f.c.operations.idle();
      expect(f.c.operations.get(f.workspace.id, resumed.id).status).toBe('failed');
      expect(
        f.c.repo.row<{ n: number }>('SELECT COUNT(*) AS n FROM successor_review_events')!.n,
      ).toBe(1);
    } finally {
      await f.close();
    }
  });
  it('补救讲解的坏quote不入库，显式恢复会拒绝旧作者缓存；不自动增加轮次或调用', async () => {
    class BadRepair extends CourseFakeProvider {
      bad = true;
      override async generateRepairRound(
        input: Parameters<CourseFakeProvider['generateRepairRound']>[0],
      ) {
        const value = await super.generateRepairRound(input);
        if (this.bad)
          value.teaching.teachingCoverage[0]!.teachingQuote = '不存在于实际课文的省略讲解';
        return value;
      }
    }
    const provider = new BadRepair();
    const f = fixture(provider);
    try {
      const plan = f.accept(await f.prepare());
      const { content, session } = await f.open(plan);
      f.complete(content, session);
      const quiz = await f.practice(plan, content);
      const wrong = await f.submit(quiz, false);
      const round = f.c.repairs.start(f.workspace.id, cmd(), {
        originKind: 'submission',
        originId: wrong.id,
        targetItemIds: wrong.itemGrades.map((g) => g.questionId),
      });
      await f.c.operations.idle();
      const old = f.c.operations.get(f.workspace.id, round.operationId);
      expect(old.status).toBe('failed');
      expect(provider.calls.generateRepairRound).toBe(1);
      expect(f.c.repairs.get(f.workspace.id, round.id).retestQuizId).toBeNull();
      provider.bad = false;
      await f.settle(f.c.operations.retry(f.workspace.id, old.id, cmd(), old.version));
      expect(provider.calls.generateRepairRound).toBe(2);
      expect(f.c.repairs.get(f.workspace.id, round.id).status).toBe('ready');
      expect(f.c.repairs.get(f.workspace.id, round.id).ordinal).toBe(1);
      expect(
        f.c.repo.payload<{ contentRejected: boolean }>(
          "SELECT payload FROM llm_calls WHERE method='generateRepairRound' ORDER BY created_at LIMIT 1",
        )!.contentRejected,
      ).toBe(true);
    } finally {
      await f.close();
    }
  });
  it('提取成功兄弟在输出cap变化后保留K身份，仅补未完成原文', async () => {
    class Partial extends CourseFakeProvider {
      cap = 1300;
      fail = true;
      processed: string[][] = [];
      override get outputCap() {
        return this.cap;
      }
      override async extractCourseKnowledge(input: KnowledgeInput) {
        this.processed.push(input.blocks.map((b) => b.id));
        if (this.fail && this.processed.length === 2) throw ProviderError.timeout(1);
        return super.extractCourseKnowledge(input);
      }
    }
    const provider = new Partial();
    const f = fixture(provider);
    try {
      await f.c.sources.import(f.workspace.id, {
        content: Array.from(
          { length: 15 },
          (_, i) => `# 章节${i}\n\n这是知识${i}的完整命题，说明该定义用于当前情境。`,
        ).join('\n\n'),
      });
      const req = { sourceScopeHash: f.c.sources.scopeHash(f.workspace.id) };
      const op = f.c.operations.start(
        f.workspace.id,
        cmd(),
        'preparePlan',
        'plan',
        'curriculum',
        req,
      );
      await f.c.operations.idle();
      const old = f.c.operations.get(f.workspace.id, op.id);
      expect(old.status).toBe('failed');
      const first = provider.processed[0]!;
      provider.cap = 64000;
      provider.fail = false;
      const next = f.c.operations.retry(f.workspace.id, old.id, cmd(), old.version);
      await f.settle(next);
      expect(
        provider.processed
          .slice(2)
          .flat()
          .some((id) => first.includes(id)),
      ).toBe(false);
      const plan = f.c.planning.get(f.workspace.id)!;
      expect(f.c.planning.inventory(plan).dispositions).toHaveLength(15);
    } finally {
      await f.close();
    }
  });
});
