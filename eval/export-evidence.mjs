/**
 * eval:evidence — sanitized public evidence exporter for eval:hy3.
 *
 * Reads the gitignored raw report (eval/reports/eval-hy3.json) and publishes
 * docs/evidence/hy3-online-verification.{md,json}. Fail-closed: it refuses
 * fake-suite reports, missing provenance, dirty worktrees, failed/skipped/
 * incomplete runs, and any output that does not survive the secret and
 * local-path scan. The full base URL and API key are read only to make sure
 * they do NOT appear in the published artifact; they are never printed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import {
  deriveEvidence,
  EvidenceValidationError,
  renderEvidenceMarkdown,
  scanEvidenceValue,
} from '../apps/server/dist/eval/evidence.js';

const evalDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(evalDir, '..');
loadDotenv({ path: join(repoRoot, '.env') });

const rawPath = join(evalDir, 'reports', 'eval-hy3.json');
if (!existsSync(rawPath)) {
  console.error('缺少原始报告 eval/reports/eval-hy3.json。先运行 npm run eval:hy3。');
  process.exit(1);
}

let raw;
try {
  raw = JSON.parse(readFileSync(rawPath, 'utf8'));
} catch (error) {
  console.error(`原始报告不是合法 JSON:${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

let evidence;
try {
  evidence = deriveEvidence(raw, { generatedAt: new Date().toISOString() });
} catch (error) {
  if (error instanceof EvidenceValidationError) {
    console.error(error.message);
  } else {
    console.error(`派生证据失败:${error instanceof Error ? error.message : error}`);
  }
  process.exit(1);
}

// Values that must never appear in the published artifact. Read here solely
// for containment checking; never logged, never written.
const secretValues = [process.env.HY3_API_KEY, process.env.HY3_BASE_URL].filter(
  (value) => typeof value === 'string' && value.length >= 6,
);

const markdown = renderEvidenceMarkdown(evidence);
const findings = [
  ...scanEvidenceValue(evidence, secretValues),
  ...scanEvidenceValue(markdown, secretValues).map((f) => ({ ...f, path: `markdown ${f.path}` })),
];
if (findings.length > 0) {
  console.error('发布中止:证据内容未通过脱敏扫描(仅显示位置与规则,不显示命中内容):');
  for (const finding of findings) {
    console.error(`- ${finding.path}: ${finding.rule}`);
  }
  process.exit(1);
}

const outDir = join(repoRoot, 'docs', 'evidence');
mkdirSync(outDir, { recursive: true });
const jsonPath = join(outDir, 'hy3-online-verification.json');
const mdPath = join(outDir, 'hy3-online-verification.md');
writeFileSync(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`);
writeFileSync(mdPath, markdown);

console.log('已发布净化后的真实 Hy3 在线验证证据:');
console.log(`- docs/evidence/hy3-online-verification.md`);
console.log(`- docs/evidence/hy3-online-verification.json`);
console.log(
  `提交 ${evidence.source.shortCommit}(${evidence.source.worktreeState})· 模型 ${evidence.model} · ${evidence.totals.passed}/${evidence.totals.operations} 操作通过 · ${evidence.totals.requests} 次请求`,
);
