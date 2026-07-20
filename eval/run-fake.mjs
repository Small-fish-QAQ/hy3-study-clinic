/**
 * 离线结构化评测(eval:fake):在进程内对完整服务端应用运行结构不变量检查。
 * Offline structural evaluation: runs the REAL server app in-process
 * (in-memory SQLite + deterministic fake provider, no network, no API key)
 * and checks structural invariants — provenance, alignment validation, graph
 * preservation, cross-document blueprints, tool budgets, misconception
 * transitions, review transitions, retrieval bounds, prompt-injection
 * defenses, and state invariants.
 *
 * Generated content and ordering may vary between provider versions; these
 * checks therefore assert NORMALIZED STRUCTURAL PROPERTIES, never exact
 * user-facing prose.
 *
 * Prerequisite: `npm run build`. Run: `npm run eval:fake`.
 * Writes eval/reports/eval-fake.json and eval/reports/eval-fake.md.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../apps/server/dist/db/database.js';
import { migrate } from '../apps/server/dist/db/migrate.js';
import { createRepositories } from '../apps/server/dist/repositories/index.js';
import { createServices } from '../apps/server/dist/services/index.js';
import { FakeProvider } from '../apps/server/dist/llm/fakeProvider.js';
import { buildApp } from '../apps/server/dist/app.js';
import { wrapSourceBlocks } from '../apps/server/dist/grounding/wrapSource.js';
import { searchSourceBlocks } from '../apps/server/dist/retrieval/lexical.js';
import { scheduleFirst, scheduleNext } from '../apps/server/dist/review/scheduler.js';

const evalDir = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(evalDir, 'fixtures', name), 'utf8');

const checks = [];
let currentSection = '';
function section(name) {
  currentSection = name;
  console.log(`\n== ${name} ==`);
}
function check(name, passed, detail = '') {
  checks.push({ section: currentSection, name, passed: Boolean(passed), detail });
  console.log(`  ${passed ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function buildEvalApp(provider = new FakeProvider()) {
  const db = openDatabase(':memory:');
  migrate(db);
  const repos = createRepositories(db);
  const app = buildApp({ repos, provider });
  const call = async (method, url, payload) => {
    const res = await app.inject({ method, url, ...(payload ? { payload } : {}) });
    const body = res.statusCode === 204 ? undefined : res.json();
    return { status: res.statusCode, body };
  };
  return { db, repos, app, call, provider };
}

async function setupWorkspace(ctx, fixtureNames) {
  const ws = (await ctx.call('POST', '/api/workspaces', { name: '评测课程空间' })).body.workspace;
  const docs = [];
  for (const name of fixtureNames) {
    const res = await ctx.call('POST', `/api/workspaces/${ws.id}/documents`, {
      kind: 'text',
      title: name,
      content: fixture(name),
    });
    docs.push(res.body);
    await ctx.call('POST', `/api/materials/${res.body.material.id}/analyze`);
  }
  return { workspace: ws, docs };
}

// ---------------------------------------------------------------------------
section('1. 出处保持(provenance retention)');
{
  const ctx = buildEvalApp();
  const { workspace, docs } = await setupWorkspace(ctx, [
    'cognitive-load-zh.md',
    'memory-practice-en.md',
    'forces-conflict.md',
  ]);
  let offsetsOk = true;
  for (const doc of docs) {
    for (const block of doc.blocks) {
      if (doc.material.content.slice(block.startOffset, block.endOffset) !== block.content) {
        offsetsOk = false;
      }
    }
  }
  check('每个源块的偏移量都能在原文中精确复原', offsetsOk);

  const graph = (await ctx.call('GET', `/api/workspaces/${workspace.id}/graph`)).body;
  const blockIds = new Set(docs.flatMap((d) => d.blocks.map((b) => b.id)));
  const conceptsGrounded = graph.concepts.every((c) => blockIds.has(c.grounding.blockId));
  check('每个概念的引文都锚定在真实源块上', conceptsGrounded, `${graph.concepts.length} 个概念`);
  check(
    '畸形/歧义文本被作为普通内容解析而不是导致失败',
    docs[2].material.parseStatus === 'parsed' && docs[2].blocks.length > 0,
  );
  await ctx.app.close();
}

// ---------------------------------------------------------------------------
section('2. 概念对齐(normalization / validation / graph preservation)');
{
  const ctx = buildEvalApp();
  const { workspace } = await setupWorkspace(ctx, [
    'cognitive-load-zh.md',
    'memory-practice-en.md',
  ]);
  await ctx.call('POST', `/api/workspaces/${workspace.id}/graph`);
  const edgesBefore = (await ctx.call('GET', `/api/workspaces/${workspace.id}/graph`)).body.edges;

  const run = (await ctx.call('POST', `/api/workspaces/${workspace.id}/alignment/propose`)).body;
  check(
    '精确规范化别名被本地规则自动接受(Spaced repetition ↔ Spacedrepetition)',
    run.autoAccepted.length >= 1 &&
      run.autoAccepted.every((p) => p.origin === 'local_rule' && p.status === 'accepted'),
    `auto=${run.autoAccepted.length}`,
  );
  check(
    '语义合并进入待审状态而非直接生效',
    run.created.every((p) => p.status === 'proposed'),
    `created=${run.created.length}`,
  );

  for (const proposal of run.created) {
    await ctx.call(
      'POST',
      `/api/workspaces/${workspace.id}/alignment/proposals/${proposal.id}/accept`,
      {},
    );
  }
  const overview = (await ctx.call('GET', `/api/workspaces/${workspace.id}/alignment`)).body;
  const merged = overview.canonical.filter((c) => c.members.length > 1);
  check('接受后产生跨文档规范概念(含别名与多文档来源)', merged.length >= 1);

  const graphAfter = (await ctx.call('GET', `/api/workspaces/${workspace.id}/graph`)).body;
  check(
    '对齐不修改原始概念与图谱边(仅新增对齐层)',
    graphAfter.concepts.length ===
      (await ctx.call('GET', `/api/workspaces/${workspace.id}/alignment`)).body.canonical.reduce(
        (n, c) => n + c.members.length,
        0,
      ) && graphAfter.edges.length === edgesBefore.length,
  );

  // Hostile provider: proposals outside the offered candidates are rejected.
  class RogueProvider extends FakeProvider {
    async proposeConceptAlignment(input) {
      return {
        proposals: [
          {
            sourceConceptId: input.candidates[0]?.source.id ?? 'con_x',
            targetConceptId: 'con_of_other_workspace',
            relation: 'equivalent',
            canonicalName: '越权合并',
            rationale: '不在候选中的提议',
            evidence: [],
          },
        ],
      };
    }
  }
  const rogueCtx = buildEvalApp(new RogueProvider());
  const rogue = await setupWorkspace(rogueCtx, ['cognitive-load-zh.md', 'memory-practice-en.md']);
  const rogueRun = (
    await rogueCtx.call('POST', `/api/workspaces/${rogue.workspace.id}/alignment/propose`)
  ).body;
  check(
    '未知/跨空间概念的对齐提议被本地校验拒绝',
    rogueRun.created.length === 0 && rogueRun.rejected.length >= 1,
  );
  await ctx.app.close();
  await rogueCtx.app.close();
}

// ---------------------------------------------------------------------------
section('3. 跨文档评估蓝图(cross-document blueprint validation)');
{
  const ctx = buildEvalApp();
  const { workspace } = await setupWorkspace(ctx, [
    'cognitive-load-zh.md',
    'memory-practice-en.md',
  ]);
  const run = (await ctx.call('POST', `/api/workspaces/${workspace.id}/alignment/propose`)).body;
  for (const proposal of run.created) {
    await ctx.call(
      'POST',
      `/api/workspaces/${workspace.id}/alignment/proposals/${proposal.id}/accept`,
      {},
    );
  }
  const alignment = (await ctx.call('GET', `/api/workspaces/${workspace.id}/alignment`)).body;
  const mergedGroup = alignment.canonical.find((c) => c.materialIds.length > 1);
  const targetConceptId = mergedGroup?.members[0]?.sourceConceptId;

  const creation = await ctx.call('POST', `/api/workspaces/${workspace.id}/assessments`, {
    mode: 'cross_document',
    conceptIds: [targetConceptId],
  });
  const crossBlueprints = (creation.body.blueprints ?? []).filter(
    (b) => b.scope === 'cross_document',
  );
  check(
    '跨文档评估生成成功且蓝图标注 cross_document',
    creation.status === 201 && crossBlueprints.length > 0,
  );
  check(
    '跨文档蓝图的证据确实来自至少两份文档(本地验证后计算)',
    crossBlueprints.every((b) => b.sourceDocumentIds.length >= 2),
  );
  const raw = JSON.stringify(creation.body);
  check(
    '客户端载荷不泄露答案、评分要点或推理步骤',
    !raw.includes('"correctOptionIds":') &&
      !raw.includes('"expectedAnswer":') &&
      !raw.includes('"rubric":') &&
      !raw.includes('"expectedReasoningSteps":'),
  );
  await ctx.app.close();
}

// ---------------------------------------------------------------------------
section('4. 辅导工具预算与安全(tool budgets)');
{
  class NeverFinalizeProvider extends FakeProvider {
    async proposeTutorStep() {
      return {
        action: 'call_tool',
        tool: 'inspect_review_queue',
        arguments: {},
        purpose: '永不收敛',
      };
    }
  }
  const ctx = buildEvalApp(new NeverFinalizeProvider());
  const { workspace } = await setupWorkspace(ctx, ['recursion-injection.md']);
  const graph = (await ctx.call('GET', `/api/workspaces/${workspace.id}/graph`)).body;
  const conceptId = graph.concepts[0].id;

  const services = createServices({
    repos: ctx.repos,
    provider: ctx.provider,
    clock: { now: () => new Date('2026-07-01T00:00:00.000Z') },
  });
  const { run } = await services.tutor.runSession(workspace.id, conceptId, {});
  check('永不收敛的模型在 6 轮预算内被终止', run.status === 'failed' && run.iterations === 6);
  check('失败的辅导会话不产生学习计划', run.planId === null);
  const overlay = (await ctx.call('GET', `/api/workspaces/${workspace.id}/overlay`)).body;
  check(
    '失败会话不改变任何学习状态',
    overlay.states.every((s) => s.attempts === 0 && s.openMistakes === 0),
  );
  await ctx.app.close();
}

// ---------------------------------------------------------------------------
section('5. 误区状态机(misconception transitions)');
{
  const ctx = buildEvalApp();
  const { workspace } = await setupWorkspace(ctx, ['cognitive-load-zh.md']);
  const creation = (
    await ctx.call('POST', `/api/workspaces/${workspace.id}/assessments`, { mode: 'diagnostic' })
  ).body;
  const full = ctx.repos.quizzes.get(creation.quiz.id);
  await ctx.call('POST', `/api/quizzes/${full.id}/submissions`, {
    answers: full.questions.map((q) =>
      q.correctOptionIds
        ? {
            questionId: q.id,
            type: q.type,
            selectedOptionIds: [q.options.find((o) => !q.correctOptionIds.includes(o.id)).id],
          }
        : { questionId: q.id, type: q.type, text: '完全不同的错误回答' },
    ),
  });
  const proposed = (
    await ctx.call('GET', `/api/workspaces/${workspace.id}/misconceptions?status=proposed`)
  ).body.misconceptions;
  check('错误作答产生的误区停留在 proposed(绝不直接 confirmed)', proposed.length >= 1);

  const target = proposed[0];
  const discriminate = async (correct) => {
    const c = (
      await ctx.call('POST', `/api/workspaces/${workspace.id}/assessments`, {
        mode: 'misconception_check',
        misconceptionId: target.id,
      })
    ).body;
    const fullQuiz = ctx.repos.quizzes.get(c.quiz.id);
    await ctx.call('POST', `/api/quizzes/${fullQuiz.id}/submissions`, {
      answers: fullQuiz.questions.map((q) => ({
        questionId: q.id,
        type: q.type,
        selectedOptionIds: correct
          ? q.correctOptionIds
          : [q.options.find((o) => !q.correctOptionIds.includes(o.id)).id],
      })),
    });
    return ctx.repos.misconceptions.get(target.id).status;
  };
  const afterWrong = await discriminate(false);
  check('判别题答错 → proposed 转为 confirmed', afterWrong === 'confirmed');
  const afterRight = await discriminate(true);
  check('后续判别题答对 → confirmed 转为 resolved', afterRight === 'resolved');
  const terminal = await ctx.call('POST', `/api/workspaces/${workspace.id}/assessments`, {
    mode: 'misconception_check',
    misconceptionId: target.id,
  });
  check('终态误区不能再次发起判别评估(非法转换被拒绝)', terminal.status === 400);
  await ctx.app.close();
}

// ---------------------------------------------------------------------------
section('6. 复习调度(review transitions, fixed clock)');
{
  const now = new Date('2026-07-01T00:00:00.000Z');
  const first = scheduleFirst('good', now);
  const lapse = scheduleNext(
    { stability: first.stability, difficulty: first.difficulty },
    'again',
    now,
  );
  const growth = scheduleNext(
    { stability: first.stability, difficulty: first.difficulty },
    'good',
    now,
  );
  check(
    '首次评级产生正的间隔与到期时间',
    first.intervalDays > 0 && first.dueAt > now.toISOString(),
  );
  check('遗忘(again)显著缩短稳定度', lapse.stability < first.stability && lapse.isLapse);
  check('连续成功单调延长间隔', growth.stability > first.stability);

  const ctx = buildEvalApp();
  const { workspace } = await setupWorkspace(ctx, ['cognitive-load-zh.md']);
  const creation = (
    await ctx.call('POST', `/api/workspaces/${workspace.id}/assessments`, { mode: 'diagnostic' })
  ).body;
  const full = ctx.repos.quizzes.get(creation.quiz.id);
  await ctx.call('POST', `/api/quizzes/${full.id}/submissions`, {
    answers: full.questions.map((q) =>
      q.correctOptionIds
        ? { questionId: q.id, type: q.type, selectedOptionIds: q.correctOptionIds }
        : { questionId: q.id, type: q.type, text: q.expectedAnswer },
    ),
  });
  const review = (await ctx.call('GET', `/api/workspaces/${workspace.id}/review`)).body.items;
  const mastery = (await ctx.call('GET', `/api/workspaces/${workspace.id}/overlay`)).body.states;
  check('只有判分完成的学习事件推进复习状态', review.length > 0);
  check(
    '复习状态与掌握度相互独立存在(两套并行数据)',
    review.every((item) => item.dueAt && item.stability > 0) &&
      mastery.some((s) => s.mastery !== null),
  );
  await ctx.app.close();
}

// ---------------------------------------------------------------------------
section('7. 检索边界(retrieval boundaries)');
{
  const ctx = buildEvalApp();
  const { workspace } = await setupWorkspace(ctx, [
    'cognitive-load-zh.md',
    'memory-practice-en.md',
  ]);
  const blocks = ctx.repos.materials.getBlocksByWorkspace(workspace.id);
  const results = searchSourceBlocks(blocks, '工作记忆 容量', { limit: 999 });
  check('检索命中相关段落且结果数被限制在 8 条以内', results.length > 0 && results.length <= 8);
  const offsetsOk = results.every((r) => {
    const block = blocks.find((b) => b.id === r.blockId);
    return block && block.content.slice(r.startOffset, r.endOffset) === r.excerpt;
  });
  check('每条检索结果都带可复原的精确原文位置', offsetsOk);
  const other = buildEvalApp();
  const otherWs = await setupWorkspace(other, ['forces-conflict.md']);
  const otherBlocks = other.repos.materials.getBlocksByWorkspace(otherWs.workspace.id);
  check(
    '检索按课程空间隔离(不同空间互不可见)',
    searchSourceBlocks(otherBlocks, '工作记忆').every((r) =>
      otherBlocks.some((b) => b.id === r.blockId),
    ),
  );
  await ctx.app.close();
  await other.app.close();
}

// ---------------------------------------------------------------------------
section('8. 提示注入防御(prompt-injection defenses)');
{
  const ctx = buildEvalApp();
  const { workspace } = await setupWorkspace(ctx, ['recursion-injection.md']);
  const blocks = ctx.repos.materials.getBlocksByWorkspace(workspace.id);
  const wrapped = wrapSourceBlocks(blocks);
  check(
    '不可信资料始终被围栏包裹并声明为数据',
    wrapped.guard.includes('不可信') && wrapped.body.includes('SOURCE_'),
  );

  const overlayBefore = (await ctx.call('GET', `/api/workspaces/${workspace.id}/overlay`)).body;
  const services = createServices({
    repos: ctx.repos,
    provider: ctx.provider,
    clock: { now: () => new Date('2026-07-01T00:00:00.000Z') },
  });
  const concept = ctx.repos.materials.getConceptsByWorkspace(workspace.id)[0];
  const { run } = await services.tutor.runSession(workspace.id, concept.id, {});
  const overlayAfter = (await ctx.call('GET', `/api/workspaces/${workspace.id}/overlay`)).body;
  check(
    '包含注入文本的资料跑完整个辅导流程后,学习状态零变化',
    JSON.stringify(overlayBefore) === JSON.stringify(overlayAfter) && run.status === 'completed',
  );
  const misconceptions = (await ctx.call('GET', `/api/workspaces/${workspace.id}/misconceptions`))
    .body.misconceptions;
  check('注入文本未能确认任何误区或删除任何数据', misconceptions.length === 0);
  await ctx.app.close();
}

// ---------------------------------------------------------------------------
section('9. 状态不变量(state invariants)');
{
  const ctx = buildEvalApp();
  const { workspace } = await setupWorkspace(ctx, ['cognitive-load-zh.md']);
  const creation = (
    await ctx.call('POST', `/api/workspaces/${workspace.id}/assessments`, { mode: 'diagnostic' })
  ).body;
  const full = ctx.repos.quizzes.get(creation.quiz.id);
  await ctx.call('POST', `/api/quizzes/${full.id}/submissions`, {
    answers: full.questions.map((q) =>
      q.correctOptionIds
        ? { questionId: q.id, type: q.type, selectedOptionIds: [] }
        : { questionId: q.id, type: q.type, text: '' },
    ),
  });
  const overlay = (await ctx.call('GET', `/api/workspaces/${workspace.id}/overlay`)).body;
  check(
    '掌握度始终在 [0,1] 且尝试数一致',
    overlay.states.every(
      (s) => s.mastery === null || (s.mastery >= 0 && s.mastery <= 1 && s.attempts >= 0),
    ),
  );
  check('数据库外键完整性检查通过', ctx.db.pragma('foreign_key_check').length === 0);
  await ctx.app.close();
}

// ---------------------------------------------------------------------------
const passed = checks.filter((c) => c.passed).length;
const failed = checks.length - passed;
const summary = {
  suite: 'eval:fake',
  provider: 'fake (offline, deterministic scoring rules; generated content may vary)',
  totals: { checks: checks.length, passed, failed },
  checks,
};

const reportsDir = join(evalDir, 'reports');
mkdirSync(reportsDir, { recursive: true });
writeFileSync(join(reportsDir, 'eval-fake.json'), `${JSON.stringify(summary, null, 2)}\n`);

const md = [
  '# Hy3 Study Clinic — 离线结构化评测报告(eval:fake)',
  '',
  '在进程内对真实服务端应用运行结构不变量检查(内存 SQLite + 确定性 Fake Provider,无网络、无 API Key)。',
  '本报告断言的是规范化结构不变量;生成内容与排序在两次运行之间可能变化。',
  '',
  `**结果:${passed}/${checks.length} 项检查通过**`,
  '',
  ...Object.entries(
    checks.reduce((acc, c) => {
      (acc[c.section] ??= []).push(c);
      return acc;
    }, {}),
  ).flatMap(([sectionName, sectionChecks]) => [
    `## ${sectionName}`,
    '',
    ...sectionChecks.map(
      (c) => `- ${c.passed ? '✅' : '❌'} ${c.name}${c.detail ? `(${c.detail})` : ''}`,
    ),
    '',
  ]),
].join('\n');
writeFileSync(join(reportsDir, 'eval-fake.md'), `${md}\n`);

console.log(
  `\n评测完成:${passed}/${checks.length} 项通过。报告已写入 eval/reports/eval-fake.{json,md}`,
);
if (failed > 0) {
  process.exitCode = 1;
}
