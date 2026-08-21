/**
 * 离线一键演示:在进程内完整走通两条核心闭环(无网络、无端口、无 API Key)。
 * Offline end-to-end demo: runs BOTH core flows in-process against the real
 * server application (in-memory SQLite + deterministic fake provider).
 *
 * 保证的是"流程可离线复现":整个工作流可以在离线环境下重复运行。本地判分
 * 规则(客观题判分、EMA 掌握度)是确定性的;但具体生成内容与排序(概念顺序、
 * 选中的薄弱概念、生成的题目)在两次运行之间可能变化,不承诺逐字节一致的输出。
 *
 * Prerequisite: `npm run build` (imports the compiled server from dist/).
 * Run: `node scripts/demo-offline.mjs`
 */
import { openDatabase } from '../apps/server/dist/db/database.js';
import { migrate } from '../apps/server/dist/db/migrate.js';
import { createRepositories } from '../apps/server/dist/repositories/index.js';
import { FakeProvider } from '../apps/server/dist/llm/fakeProvider.js';
import { buildApp } from '../apps/server/dist/app.js';
import { assertResolvedFakeProvider } from './assert-fake-provider.mjs';

const db = openDatabase(':memory:');
migrate(db);
const repos = createRepositories(db);
const app = buildApp({ repos, provider: new FakeProvider() });

const call = async (method, url, payload) => {
  const res = await app.inject({ method, url, ...(payload ? { payload } : {}) });
  const body = res.json();
  if (res.statusCode >= 400) {
    throw new Error(`${method} ${url} -> ${res.statusCode} ${JSON.stringify(body)}`);
  }
  return body;
};

assertResolvedFakeProvider(await call('GET', '/api/config'), 'Offline demo');

console.log('==== Flow A: 导入 → 切分 → 概念分析 → 溯源出题 ====');

const sample = await call('GET', '/api/sample-material');
console.log(`[1] 载入示例资料《${sample.title}》(${sample.content.length} 字,自创内容)`);

const imported = await call('POST', '/api/materials', {
  content: sample.content,
  filename: sample.filename,
});
const materialId = imported.material.id;
console.log(`[2] 导入完成:切分为 ${imported.blocks.length} 个源块(确定性切分,含偏移量)`);

const { concepts } = await call('POST', `/api/materials/${materialId}/analyze`);
console.log(`[3] 概念分析:${concepts.length} 个概念,全部通过服务器端引文校验`);
for (const c of concepts) {
  const block = imported.blocks.find((b) => b.id === c.grounding.blockId);
  const sliced = block.content.slice(c.grounding.startOffset, c.grounding.endOffset);
  const verified = sliced === c.grounding.quote ? '✓' : '✗';
  console.log(`    ${verified} ${c.name} ← 「${c.grounding.quote.slice(0, 24)}…」`);
}

const { quiz } = await call('POST', '/api/quizzes', {
  materialId,
  config: {
    difficulty: 'medium',
    types: ['single_choice', 'multiple_choice', 'short_answer'],
    countPerType: 2,
  },
});
const leaked =
  JSON.stringify(quiz).includes('correctOptionIds') ||
  JSON.stringify(quiz).includes('expectedAnswer');
console.log(
  `[4] 生成测验:${quiz.questions.length} 题;客户端载荷泄露答案:${leaked ? '是(异常!)' : '否'}`,
);

console.log('\n==== Flow B: 作答 → 判分 → 错题本 → 康复练习 → 掌握度 ====');

// 故意全部答错/留空,制造错题。
const wrongAnswers = quiz.questions.map((q) =>
  q.type === 'short_answer'
    ? { questionId: q.id, type: q.type, text: '' }
    : { questionId: q.id, type: q.type, selectedOptionIds: [] },
);
const firstGrading = await call('POST', `/api/quizzes/${quiz.id}/submissions`, {
  answers: wrongAnswers,
});
console.log(
  `[5] 第一次判分:总分 ${Math.round(firstGrading.grading.overallScore * 100)}%(判分方式:${[...new Set(firstGrading.grading.grades.map((g) => g.gradedBy))].join(' + ')})`,
);

const mistakes1 = await call('GET', `/api/materials/${materialId}/mistakes?status=open`);
console.log(
  `[6] 错题本:${mistakes1.mistakes.length} 条未解决;薄弱概念:${mistakes1.weakConcepts.map((w) => `${w.conceptName}(${w.openMistakes})`).join('、')}`,
);

const remediation = await call('POST', `/api/materials/${materialId}/remediation`);
console.log(
  `[7] 康复练习:${remediation.quiz.questions.length} 题,针对 ${remediation.quiz.targetConceptIds.length} 个薄弱概念(kind=${remediation.quiz.kind})`,
);

// 用服务器侧答案键正确作答康复练习(演示环境可直接读库)。
const remediationFull = repos.quizzes.get(remediation.quiz.id);
const correctAnswers = remediationFull.questions.map((q) =>
  q.type === 'short_answer'
    ? { questionId: q.id, type: q.type, text: q.expectedAnswer }
    : { questionId: q.id, type: q.type, selectedOptionIds: q.correctOptionIds },
);
const remGrading = await call('POST', `/api/quizzes/${remediation.quiz.id}/submissions`, {
  answers: correctAnswers,
});
console.log(`[8] 康复判分:总分 ${Math.round(remGrading.grading.overallScore * 100)}%`);

const mistakes2 = await call('GET', `/api/materials/${materialId}/mistakes?status=open`);
console.log(
  `[9] 错题回收:未解决错题 ${mistakes1.mistakes.length} → ${mistakes2.mistakes.length}(答对的康复题精确解决其来源错题)`,
);

const { mastery } = await call('GET', `/api/materials/${materialId}/mastery`);
console.log('[10] 掌握度(确定性 EMA 公式,初始 0.5):');
for (const m of mastery) {
  console.log(
    `    ${m.conceptName}: ${Math.round(m.mastery * 100)}%(作答 ${m.attempts} 次,达标 ${m.correctCount} 次)`,
  );
}

await app.close();
console.log('\n两条闭环均可在无网络、无 API Key 的环境下重复运行;具体生成内容与排序可能变化。');
