import { describe, it, expect } from 'vitest';
import { fixture, cmd } from '../testing/clinicFixture.js';
import { CourseFakeProvider } from '../llm/courseFakeProvider.js';
import { knowledgePackets } from './courseKnowledge.js';
import { validateCoursePlan } from './coursePlanning.js';
import { normalizeMarkdown, normalizedDocumentToSourceBlocks } from '../ingestion/normalized.js';
import { ingestSource } from '../ingestion/ingest.js';
import { checkPaperCoverage } from './courseQuestions.js';
import {
  CoursePlanSchema,
  type CoursePlan,
  type CourseKnowledgeInventory,
  type CourseQuiz,
} from '@hy3-clinic/shared';

describe('完整容量与人工golden分母 A02/A03/A08', () => {
  it('完整处理20001短段，超过旧100k字符/2k块/20k单元且资源配置仍保护内存', () => {
    const text = Array.from({ length: 20001 }, (_, i) => `知识${i}：这是一条完整的短命题。`).join(
      '\n\n',
    );
    const before = process.memoryUsage().heapUsed;
    const start = performance.now();
    const content = ingestSource(text, { sourceType: 'md' }).content;
    const doc = normalizeMarkdown({
      revisionId: 'r',
      sourceType: 'md',
      mediaType: 'text/markdown',
      content,
    });
    const blocks = normalizedDocumentToSourceBlocks('m', doc, { idSeed: 'r' });
    expect(content.length).toBeGreaterThan(100000);
    expect(doc.units.length).toBeGreaterThan(20000);
    expect(blocks).toHaveLength(20001);
    expect(blocks.at(-1)!.content).toContain('知识20000');
    console.log(
      JSON.stringify({
        fixture: '20001-short-paragraphs',
        characters: text.length,
        bytes: Buffer.byteLength(text),
        units: doc.units.length,
        blocks: blocks.length,
        elapsedMs: Math.round(performance.now() - start),
        heapDelta: process.memoryUsage().heapUsed - before,
      }),
    );
    const prior = process.env.IMPORT_TEXT_BYTES;
    process.env.IMPORT_TEXT_BYTES = '20';
    try {
      expect(() => ingestSource('知识'.repeat(30), { sourceType: 'md' })).toThrow(
        'IMPORT_TEXT_BYTES',
      );
    } finally {
      if (prior === undefined) delete process.env.IMPORT_TEXT_BYTES;
      else process.env.IMPORT_TEXT_BYTES = prior;
    }
  });
  it('有限遍历超过200个来源工作包不被累计transition门阻断', async () => {
    class Small extends CourseFakeProvider {
      override get outputCap() {
        return 500;
      }
    }
    const provider = new Small();
    const f = fixture(provider);
    try {
      await f.c.sources.import(f.workspace.id, {
        content: Array.from(
          { length: 481 },
          (_, i) =>
            `# 第${i}章\n\n知识${i}描述当前情境中的独立完整命题，说明对象之间的关系与含义。`,
        ).join('\n\n'),
      });
      const blocks = f.c.sources.blocks(f.workspace.id);
      expect(knowledgePackets(blocks, 500).length).toBeGreaterThan(200);
      f.c.operations.register('preparePlan', async (ctx) => {
        const inventory = await f.c.knowledge.extract(ctx, f.c.sources.scopeHash(f.workspace.id));
        return { resourceId: inventory.id };
      });
      const op = f.c.operations.start(f.workspace.id, cmd(), 'preparePlan', 'plan', 'inventory', {
        sourceScopeHash: f.c.sources.scopeHash(f.workspace.id),
      });
      await f.settle(op);
      const inventory = f.c.repo.payloads<CourseKnowledgeInventory>(
        'SELECT payload FROM course_knowledge_inventories',
      )[0]!;
      expect(inventory.knowledge).toHaveLength(481);
      expect(inventory.dispositions).toHaveLength(481);
      expect(provider.calls.extractCourseKnowledge).toBeGreaterThan(200);
    } finally {
      await f.close();
    }
  });
  it('人工黄金清单独立核对来源→K→规划→实际正文，条件/例外/表格/尾章不丢', async () => {
    const f = fixture();
    try {
      const plan = f.accept(await f.prepare());
      const inventory = f.c.planning.inventory(plan);
      const humanGold = [
        { id: 'definition', text: '速度是单位时间内位置的变化量' },
        { id: 'condition', text: '时间间隔非零' },
        { id: 'exception', text: '时间间隔为零时不能使用该公式' },
        { id: 'procedure', text: '先固定坐标方向' },
        { id: 'table', text: '向左移动' },
        { id: 'cross-chapter', text: '不能用速率替代速度的方向信息' },
      ];
      const delivered = [];
      for (const lesson of plan.lessons) {
        const { content } = await f.open(plan, lesson.id);
        delivered.push(content);
      }
      const rows = humanGold.map((g) => {
        const matches = inventory.knowledge.filter((k) => k.statement.includes(g.text));
        const allocated = plan.lessons.filter((l) =>
          matches.some((k) => l.knowledgeIds.includes(k.id)),
        );
        const anchors = delivered.flatMap((c) =>
          c.deliveryCheck.anchors
            .filter((a) => matches.some((k) => k.id === a.knowledgeId))
            .map((a) => ({
              lessonId: c.lessonId,
              quote: c.segments.find((s) => s.id === a.segmentId)!.text.slice(a.start, a.end),
            })),
        );
        return {
          goldId: g.id,
          extractedKnowledgeIds: matches.map((k) => k.id),
          plannedLessons: allocated.map((l) => l.id),
          anchors,
        };
      });
      expect(
        rows.every(
          (r) => r.extractedKnowledgeIds.length && r.plannedLessons.length && r.anchors.length,
        ),
      ).toBe(true);
      expect(
        humanGold.every((g) =>
          rows.find((r) => r.goldId === g.id)!.anchors.some((a) => a.quote.includes(g.text)),
        ),
      ).toBe(true);
      console.log(
        JSON.stringify({
          fixture: 'manual-golden-v1',
          denominator: humanGold.length,
          rows,
          semanticEvidence: '预先编写的黄金命题与离线夹具；不代表模型对新教材的语义覆盖率',
        }),
      );
    } finally {
      await f.close();
    }
  });
  it('真实超单请求规划走outline/subplan/compact join，合并后完整覆盖；课文context不足才分段', async () => {
    class Bounded extends CourseFakeProvider {
      cap = 3000;
      context: number | undefined;
      override get outputCap() {
        return this.cap;
      }
      get contextCap() {
        return this.context;
      }
    }
    const provider = new Bounded();
    const f = fixture(provider);
    try {
      await f.c.sources.import(f.workspace.id, {
        content: Array.from(
          { length: 65 },
          (_, i) => `# 单元${i}\n\n完整命题${i}说明本章对象之间的关系与适用范围。`,
        ).join('\n\n'),
      });
      const op = f.c.operations.start(f.workspace.id, cmd(), 'preparePlan', 'plan', 'curriculum', {
        sourceScopeHash: f.c.sources.scopeHash(f.workspace.id),
      });
      await f.settle(op);
      const draft = f.c.planning.get(f.workspace.id)!;
      const inventory = f.c.planning.inventory(draft);
      expect(inventory.knowledge).toHaveLength(65);
      expect(new Set(draft.lessons.flatMap((l) => l.knowledgeIds)).size).toBe(65);
      expect(provider.calls.generateCoursePlan).toBeGreaterThan(3);
      const plan = f.accept(draft);
      provider.context = 2000;
      await f.open(plan);
      expect(provider.calls.generateLesson).toBeGreaterThan(1);
    } finally {
      await f.close();
    }
  });
  it('大K集合和少量代表cell可合法考核，未考K不广播；漏必考领域或降低demand拒绝', async () => {
    const f = fixture();
    try {
      const plan = f.accept(await f.prepare());
      const inventory = f.c.planning.inventory(plan);
      const extended: CourseKnowledgeInventory = {
        ...inventory,
        knowledge: Array.from({ length: 300 }, (_, i) => ({
          ...inventory.knowledge[0]!,
          id: `k${i}`,
          title: `定义${i}`,
          statement: `定义${i}包含完整命题。`,
        })),
      };
      const large: CoursePlan = {
        ...plan,
        modules: Array.from({ length: 121 }, (_, i) => ({ id: `m${i}`, title: `教材区域${i}` })),
        lessons: Array.from({ length: 1001 }, (_, i) => ({
          ...plan.lessons[0]!,
          id: `l${i}`,
          moduleId: `m${i % 121}`,
          prerequisiteLessonIds: i ? [`l${i - 1}`] : [],
          knowledgeIds: extended.knowledge.map((k) => k.id),
          objectives: [
            {
              id: `o${i}`,
              title: '理解完整领域',
              knowledgeIds: extended.knowledge.map((k) => k.id),
              demand: 'understand',
            },
          ],
        })),
        teachingRequiredKnowledgeIds: extended.knowledge.map((k) => k.id),
        assessmentBlueprint: {
          ...plan.assessmentBlueprint,
          domains: [
            {
              id: 'd',
              title: '核心领域',
              knowledgeIds: extended.knowledge.map((k) => k.id),
              coreObjectiveIds: ['o0'],
              required: true,
              rationale: '核心',
            },
          ],
          cells: [
            {
              id: 'c',
              domainId: 'd',
              objectiveIds: ['o0'],
              demand: 'understand',
              difficultyBand: 'standard',
              mandatoryKnowledgeIds: ['k0'],
              representativeSets: [
                { id: 'set', candidateKnowledgeIds: extended.knowledge.slice(1).map((k) => k.id) },
              ],
              weight: 1,
              rationale: '代表性核心解释能力',
            },
          ],
          requiredCellIds: ['c'],
        },
      };
      expect(validateCoursePlan(CoursePlanSchema.parse(large), extended).lessons).toHaveLength(
        1001,
      );
      expect(large.modules).toHaveLength(121);
      expect(() =>
        validateCoursePlan(
          {
            ...large,
            assessmentBlueprint: { ...large.assessmentBlueprint, cells: [], requiredCellIds: [] },
          },
          extended,
        ),
      ).toThrow('核心');
      expect(() =>
        validateCoursePlan(
          {
            ...large,
            assessmentBlueprint: {
              ...large.assessmentBlueprint,
              cells: large.assessmentBlueprint.cells.map((c) => ({ ...c, demand: 'remember' })),
            },
          },
          extended,
        ),
      ).toThrow('降格');
      const empty: CourseQuiz = {
        id: 'q',
        workspaceId: f.workspace.id,
        curriculumId: large.id,
        purpose: 'formal',
        requestId: 'p',
        lessonVersionId: null,
        version: 1,
        status: 'draft',
        items: [],
        discarded: [],
        candidateStates: [],
        blueprint: large.assessmentBlueprint,
        paperCoverageSelection: [],
      };
      expect(checkPaperCoverage(empty)).toContain('缺少核心命题:k0');
    } finally {
      await f.close();
    }
  });
});
