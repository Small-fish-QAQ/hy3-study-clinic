/**
 * 真实 Hy3 评测(eval:hy3)— OPTIONAL, never run by tests or CI.
 *
 * Requires explicit real credentials (HY3_BASE_URL / HY3_API_KEY /
 * HY3_MODEL, from the environment or the repo-root .env). If they are
 * missing the script REFUSES to run — it never silently falls back to the
 * fake provider while claiming real results.
 *
 * Measures against the hand-authored labels in eval/labels/:
 * - first-pass schema success vs. bounded-repair usage (per operation);
 * - grounding acceptance rate of proposed evidence;
 * - alignment proposal agreement with alignment-pairs.json;
 * - short-answer grading agreement with grading-samples.json;
 * - cross-document assessment local-validation acceptance;
 * - Tutor first-step validity (whitelisted tool or finalize);
 * - long-document semantic recall against hand-authored must-find labels;
 * - lesson anchor/conflict verification;
 * - request counts and wall-clock latency per operation.
 *
 * Prerequisite: `npm run build`. Run: `npm run eval:hy3`.
 * Writes eval/reports/eval-hy3.json and eval/reports/eval-hy3.md.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { Hy3Provider } from '../apps/server/dist/llm/hy3Provider.js';
import { segmentMaterial } from '../apps/server/dist/ingestion/segment.js';
import { ingestSource } from '../apps/server/dist/ingestion/ingest.js';
import { computeSections, conceptBudgetFor } from '../apps/server/dist/ingestion/sections.js';
import { verifyGrounding } from '../apps/server/dist/grounding/verify.js';
import { normalizeConceptKey } from '../packages/shared/dist/index.js';
import { assertEvaluationVisualProviderDisabled } from '../scripts/assert-fake-provider.mjs';

const evalDir = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: join(evalDir, '..', '.env') });
assertEvaluationVisualProviderDisabled(process.env, 'Hy3 evaluation');

const baseUrl = process.env.HY3_BASE_URL;
const apiKey = process.env.HY3_API_KEY;
const model = process.env.HY3_MODEL;
if (!baseUrl || !apiKey || !model) {
  console.error(
    [
      'eval:hy3 需要真实的 Hy3 凭证:HY3_BASE_URL、HY3_API_KEY、HY3_MODEL。',
      '本脚本绝不会在缺少凭证时退回 Fake Provider(那会伪造真实评测结果)。',
      '离线评测请使用 npm run eval:fake。',
    ].join('\n'),
  );
  process.exit(1);
}

// Run provenance: bind the report to the exact source version and runtime.
// Publication (eval:evidence) refuses reports without it or with a dirty tree.
const repoRoot = join(evalDir, '..');
const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
let gitInfo = null;
try {
  gitInfo = {
    commit: git('rev-parse', 'HEAD'),
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    worktreeState: git('status', '--porcelain') === '' ? 'clean' : 'dirty',
  };
} catch {
  gitInfo = null;
}
let endpointHost = null;
try {
  endpointHost = new URL(baseUrl).hostname;
} catch {
  endpointHost = null;
}

// Instrumented fetch: counts requests and accumulates latency per phase.
let phase = 'idle';
const phaseStats = new Map();
const instrumentedFetch = async (url, init) => {
  const stats = phaseStats.get(phase) ?? { requests: 0, latencyMs: 0 };
  const startedAt = Date.now();
  try {
    return await fetch(url, init);
  } finally {
    stats.requests += 1;
    stats.latencyMs += Date.now() - startedAt;
    phaseStats.set(phase, stats);
  }
};

const provider = new Hy3Provider({
  baseUrl,
  apiKey,
  model,
  timeoutMs: Number(process.env.HY3_TIMEOUT_MS ?? 60_000),
  fetchImpl: instrumentedFetch,
});

const fixture = (name) => readFileSync(join(evalDir, 'fixtures', name), 'utf8');
function blocksOf(name, materialId) {
  const normalized = ingestSource(fixture(name), { sourceType: 'md' });
  return segmentMaterial(materialId, normalized.content);
}

const results = [];
async function measure(name, fn) {
  phase = name;
  const startedAt = Date.now();
  try {
    const detail = await fn();
    const stats = phaseStats.get(name) ?? { requests: 0, latencyMs: 0 };
    results.push({ name, ok: true, ...detail, ...stats, wallMs: Date.now() - startedAt });
    console.log(`✓ ${name}`, JSON.stringify(detail));
  } catch (error) {
    const stats = phaseStats.get(name) ?? { requests: 0, latencyMs: 0 };
    results.push({
      name,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ...stats,
      wallMs: Date.now() - startedAt,
    });
    console.log(`✗ ${name} — ${error instanceof Error ? error.message : error}`);
  } finally {
    phase = 'idle';
  }
}

const blocksA = blocksOf('cognitive-load-zh.md', 'mat_eval_a');
const blocksB = blocksOf('memory-practice-en.md', 'mat_eval_b');

// --- 1. Concept analysis: schema success + grounding acceptance -------------
let conceptsA = [];
await measure('concept_analysis', async () => {
  const payload = await provider.analyzeConcepts({
    materialTitle: '认知负荷与工作记忆',
    blocks: blocksA,
  });
  const verified = payload.concepts.filter(
    (c) => verifyGrounding(blocksA, { blockId: c.blockId, quote: c.quote }).ok,
  );
  conceptsA = verified.map((c, i) => ({
    id: `con_eval_a${i}`,
    materialId: 'mat_eval_a',
    name: c.name,
    summary: c.summary,
    importance: c.importance,
    grounding: verifyGrounding(blocksA, { blockId: c.blockId, quote: c.quote }).grounding,
    createdAt: new Date().toISOString(),
  }));
  return {
    proposed: payload.concepts.length,
    groundingAccepted: verified.length,
    groundingAcceptanceRate: Number((verified.length / payload.concepts.length).toFixed(3)),
    // 1 request = first-pass schema success; 2 = bounded repair was needed.
    firstPassSchema: (phaseStats.get('concept_analysis')?.requests ?? 1) === 1,
  };
});

let conceptsB = [];
await measure('concept_analysis_doc_b', async () => {
  const payload = await provider.analyzeConcepts({
    materialTitle: 'Memory and Practice Notes',
    blocks: blocksB,
  });
  const verified = payload.concepts.filter(
    (c) => verifyGrounding(blocksB, { blockId: c.blockId, quote: c.quote }).ok,
  );
  conceptsB = verified.map((c, i) => ({
    id: `con_eval_b${i}`,
    materialId: 'mat_eval_b',
    name: c.name,
    summary: c.summary,
    importance: c.importance,
    grounding: verifyGrounding(blocksB, { blockId: c.blockId, quote: c.quote }).grounding,
    createdAt: new Date().toISOString(),
  }));
  return { proposed: payload.concepts.length, groundingAccepted: verified.length };
});

// --- 2. Alignment agreement with human labels -------------------------------
await measure('alignment_agreement', async () => {
  const labels = JSON.parse(readFileSync(join(evalDir, 'labels', 'alignment-pairs.json'), 'utf8'));
  const all = [...conceptsA, ...conceptsB];
  const findByName = (name) =>
    all.find(
      (c) => c.name.toLowerCase().replace(/\s+/g, '') === name.toLowerCase().replace(/\s+/g, ''),
    );
  const candidates = [];
  const expectations = [];
  for (const pair of labels.pairs) {
    const source = findByName(pair.sourceName);
    const target = findByName(pair.targetName);
    if (!source || !target) continue;
    candidates.push({
      source,
      target,
      sourceDocumentTitle:
        source.materialId === 'mat_eval_a' ? '认知负荷与工作记忆' : 'Memory notes',
      targetDocumentTitle:
        target.materialId === 'mat_eval_a' ? '认知负荷与工作记忆' : 'Memory notes',
      sourceLanguage: /[一-鿿]/u.test(source.name) ? 'zh' : 'en',
      targetLanguage: /[一-鿿]/u.test(target.name) ? 'zh' : 'en',
      signals: ['label_pair'],
    });
    expectations.push(pair.expected);
  }
  if (candidates.length === 0) {
    return { comparablePairs: 0, note: '模型提取的概念名与标签未能对上,无法比较。' };
  }
  const payload = await provider.proposeConceptAlignment({
    workspaceName: '评测空间',
    candidates,
    blocks: [...blocksA, ...blocksB],
  });
  let agree = 0;
  const detail = [];
  candidates.forEach((candidate, i) => {
    const proposal = payload.proposals.find(
      (p) =>
        (p.sourceConceptId === candidate.source.id && p.targetConceptId === candidate.target.id) ||
        (p.sourceConceptId === candidate.target.id && p.targetConceptId === candidate.source.id),
    );
    const modelSaysMerge =
      proposal !== undefined &&
      (proposal.relation === 'equivalent' || proposal.relation === 'alias');
    const humanSaysMerge = expectations[i] === 'merge';
    if (modelSaysMerge === humanSaysMerge) agree += 1;
    detail.push({
      pair: `${candidate.source.name} ↔ ${candidate.target.name}`,
      human: expectations[i],
      model: proposal ? proposal.relation : '(no proposal)',
      agree: modelSaysMerge === humanSaysMerge,
    });
  });
  return {
    comparablePairs: candidates.length,
    agreement: agree,
    agreementRate: Number((agree / candidates.length).toFixed(3)),
    detail,
  };
});

// --- 3. Grading agreement with human labels ---------------------------------
await measure('grading_agreement', async () => {
  const labels = JSON.parse(readFileSync(join(evalDir, 'labels', 'grading-samples.json'), 'utf8'));
  let total = 0;
  let agreeCorrect = 0;
  let keyPointExact = 0;
  const detail = [];
  for (const sample of labels.samples) {
    for (const answer of sample.answers) {
      total += 1;
      const grade = await provider.gradeShortAnswer({
        stem: sample.stem,
        expectedAnswer: sample.expectedAnswer,
        // Hand-authored labels use the legacy string form; they normalize to
        // required points exactly like persisted legacy rubrics do.
        rubricKeyPoints: sample.rubricKeyPoints.map((point) =>
          typeof point === 'string' ? { text: point, required: true } : point,
        ),
        quote: sample.quote,
        answerText: answer.text,
      });
      const modelCorrect = grade.score >= 0.6;
      if (modelCorrect === answer.humanCorrect) agreeCorrect += 1;
      const sortedModel = [...grade.matchedKeyPointIndexes].sort().join(',');
      const sortedHuman = [...answer.humanMatchedKeyPointIndexes].sort().join(',');
      if (sortedModel === sortedHuman) keyPointExact += 1;
      detail.push({
        answer: answer.text.slice(0, 30),
        humanCorrect: answer.humanCorrect,
        modelScore: grade.score,
        keyPointsAgree: sortedModel === sortedHuman,
      });
    }
  }
  return {
    samples: total,
    correctnessAgreement: Number((agreeCorrect / total).toFixed(3)),
    keyPointExactMatch: Number((keyPointExact / total).toFixed(3)),
    detail,
  };
});

// --- 4. Cross-document assessment answerability ------------------------------
await measure('cross_document_assessment', async () => {
  const zh = conceptsA.find((c) => /[一-鿿]/u.test(c.name));
  const en = conceptsB[0];
  if (!zh || !en) return { skipped: '概念不足,无法构造跨文档目标。' };
  const payload = await provider.proposeAssessment({
    workspaceName: '评测空间',
    mode: 'cross_document',
    targets: [
      {
        concept: zh,
        documentTitle: '认知负荷与工作记忆',
        alignedSiblings: [{ concept: en, documentTitle: 'Memory and Practice Notes' }],
        mastery: 0.4,
        openMistakes: 1,
      },
    ],
    blocks: [...blocksA, ...blocksB],
    allowedTypes: ['single_choice', 'concept_comparison'],
    questionCount: 2,
    misconception: null,
  });
  const allBlocks = [...blocksA, ...blocksB];
  let validEvidence = 0;
  let crossDocument = 0;
  for (const item of payload.items) {
    const primary = verifyGrounding(allBlocks, {
      blockId: item.question.blockId,
      quote: item.question.quote,
    });
    const extras = item.extraEvidence.map((e) => verifyGrounding(allBlocks, e));
    if (primary.ok) validEvidence += 1;
    const materials = new Set(
      [primary, ...extras]
        .filter((v) => v.ok)
        .map((v) => allBlocks.find((b) => b.id === v.grounding.blockId)?.materialId),
    );
    if (materials.size >= 2) crossDocument += 1;
  }
  return {
    items: payload.items.length,
    itemsWithVerifiedPrimaryEvidence: validEvidence,
    itemsTrulyCrossDocument: crossDocument,
  };
});

// --- 5. Tutor first step validity -------------------------------------------
await measure('tutor_first_step', async () => {
  const selected = conceptsA[0];
  if (!selected) return { skipped: '没有可用概念。' };
  const step = await provider.proposeTutorStep({
    workspaceName: '评测空间',
    selected,
    stateSummary: {
      mastery: 0.4,
      attempts: 2,
      openMistakes: 1,
      proposedMisconceptions: 0,
      confirmedMisconceptions: 0,
      reviewDue: false,
    },
    tools: [
      { name: 'inspect_learning_state', description: '查看概念学习状态。参数 {"conceptId":"..."}' },
      { name: 'search_source_blocks', description: '检索原文。参数 {"query":"..."}' },
    ],
    observations: [],
    remainingIterations: 6,
    remainingToolCalls: 12,
    allowedConceptIds: conceptsA.map((c) => c.id),
    reviewItems: [],
    // Executability contract: the model may only recommend modes the local
    // resolver marked launchable for the current state.
    launchableModes: [
      { mode: 'concept_practice', note: '围绕目标概念的针对练习。' },
      { mode: 'diagnostic', note: '对课程空间做一次诊断评估。' },
    ],
    actionableMisconceptions: [],
  });
  return {
    action: step.action,
    tool: step.action === 'call_tool' ? step.tool : null,
    schemaValid: true, // schema validation happened inside the provider
  };
});

// --- 6. Long-document semantic recall against hand-authored labels ----------
await measure('semantic_recall', async () => {
  const blocks = blocksOf('long-sectioned-zh.md', 'mat_eval_long');
  const sections = computeSections(blocks);
  const labels = JSON.parse(
    readFileSync(join(evalDir, 'labels', 'must-find-concepts.json'), 'utf8'),
  ).fixtures['long-sectioned-zh.md'];
  const names = [];
  let proposed = 0;
  let groundingAccepted = 0;

  for (const section of sections) {
    const payload = await provider.analyzeConcepts({
      materialTitle: '学习科学方法讲义(长文档评测夹具)',
      sectionTitle: section.title,
      blocks: section.blocks,
      maxConcepts: conceptBudgetFor(section),
    });
    proposed += payload.concepts.length;
    for (const concept of payload.concepts) {
      if (verifyGrounding(section.blocks, { blockId: concept.blockId, quote: concept.quote }).ok) {
        groundingAccepted += 1;
        names.push(concept.name);
      }
    }
  }

  const keys = names.map(normalizeConceptKey);
  const recalledLabels = labels.filter((label) => {
    const labelKey = normalizeConceptKey(label);
    return keys.some((key) => key.includes(labelKey) || labelKey.includes(key));
  });
  const requests = phaseStats.get('semantic_recall')?.requests ?? 0;
  return {
    sectionCount: sections.length,
    proposed,
    groundingAccepted,
    mustFind: labels.length,
    recalled: recalledLabels.length,
    recallRate: Number((recalledLabels.length / labels.length).toFixed(3)),
    firstPassSchema: requests === sections.length,
    detail: {
      recalledLabels,
      missingLabels: labels.filter((label) => !recalledLabels.includes(label)),
    },
  };
});

// --- 7. Lesson generation: anchored teaching with honest provenance ---------
await measure('lesson_generation', async () => {
  const concept = conceptsA[0];
  if (!concept) return { skipped: '没有可用概念。' };
  const payload = await provider.generateConceptLesson({
    concept,
    documentTitle: '认知负荷与工作记忆',
    sectionTitle: null,
    blocks: blocksA,
    neighbors: [],
  });
  // Mirror of the server-side deterministic validation: count how many
  // proposed anchors/conflict quotes actually verify against real blocks.
  let segments = 0;
  let anchoredProposed = 0;
  let anchorsVerified = 0;
  for (const sectionPayload of payload.sections) {
    for (const segment of sectionPayload.segments) {
      segments += 1;
      if (segment.anchor) {
        anchoredProposed += 1;
        if (verifyGrounding(blocksA, segment.anchor).ok) anchorsVerified += 1;
      }
    }
  }
  let conflictsVerified = 0;
  for (const conflict of payload.conflicts) {
    if (verifyGrounding(blocksA, { blockId: conflict.blockId, quote: conflict.quote }).ok) {
      conflictsVerified += 1;
    }
  }
  return {
    sections: payload.sections.length,
    segments,
    anchoredProposed,
    anchorsVerified,
    conflicts: payload.conflicts.length,
    conflictsVerified,
    firstPassSchema: (phaseStats.get('lesson_generation')?.requests ?? 1) === 1,
  };
});

// --- Report -----------------------------------------------------------------
const executedAt = new Date().toISOString();
const totals = {
  operations: results.length,
  passed: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).length,
  skippedChecks: results.filter((r) => typeof r.skipped === 'string').map((r) => r.name),
  requests: results.reduce((sum, r) => sum + (r.requests ?? 0), 0),
  latencyMs: results.reduce((sum, r) => sum + (r.latencyMs ?? 0), 0),
  wallMs: results.reduce((sum, r) => sum + (r.wallMs ?? 0), 0),
};
const summary = {
  suite: 'eval:hy3',
  executedAt,
  // This script constructs Hy3Provider directly and aborts without real
  // credentials; no fake-provider code path exists here.
  provider: 'hy3',
  fakeFallback: false,
  model,
  endpointHost,
  node: process.version,
  osFamily: process.platform,
  git: gitInfo,
  totals,
  overall:
    results.length > 0 && results.every((r) => r.ok && typeof r.skipped !== 'string')
      ? 'passed'
      : 'failed',
  note: '指标依赖所配置的模型与 API;样本量很小,结果仅供粗略参考,不构成基准测试。',
  results,
};
const reportsDir = join(evalDir, 'reports');
mkdirSync(reportsDir, { recursive: true });
writeFileSync(join(reportsDir, 'eval-hy3.json'), `${JSON.stringify(summary, null, 2)}\n`);
const md = [
  '# Hy3 Study Clinic — 真实 Hy3 评测报告(eval:hy3)',
  '',
  `执行时间:${executedAt} · 模型:${model} · 提交:${
    gitInfo ? `${gitInfo.commit.slice(0, 7)}(${gitInfo.worktreeState})` : '未知'
  } · 总体:${summary.overall}`,
  '',
  '样本量很小,指标仅供粗略参考;数值依赖所配置的模型与 API。',
  '',
  ...results.map(
    (r) =>
      `- ${r.ok ? '✅' : '❌'} **${r.name}** — 请求 ${r.requests ?? 0} 次,耗时 ${r.wallMs}ms${
        r.error ? `,错误:${r.error}` : ''
      }`,
  ),
  '',
  '完整数值见 eval-hy3.json。',
].join('\n');
writeFileSync(join(reportsDir, 'eval-hy3.md'), `${md}\n`);
console.log(`\n真实评测完成。报告已写入 eval/reports/eval-hy3.{json,md}`);
