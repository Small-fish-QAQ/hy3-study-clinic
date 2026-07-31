import { z } from 'zod';

/**
 * Sanitized public evidence for the real-provider evaluation (eval:hy3).
 * Backs eval/export-evidence.mjs and the committed-artifact regression test.
 *
 * Fail-closed publication rules:
 * - only a complete, passing `eval:hy3` report can be exported — the suite
 *   marker, `provider: 'hy3'`, and `fakeFallback: false` are all mandatory,
 *   so an eval:fake report can never masquerade as online evidence;
 * - Git provenance (full commit, branch, clean worktree) is mandatory;
 * - a failed, skipped, or incomplete run stays unpublishable — sanitization
 *   never upgrades a result;
 * - the public object is built by whitelisting named aggregate fields, so
 *   per-sample `detail` entries, prompts, and generated content are dropped
 *   by construction;
 * - the finished artifact must still survive `scanEvidenceValue`, which
 *   rejects credential patterns, credential-bearing URLs, and local user
 *   paths without ever echoing the matched text.
 */

export const EXPECTED_OPERATIONS = [
  'concept_analysis',
  'concept_analysis_doc_b',
  'alignment_agreement',
  'grading_agreement',
  'cross_document_assessment',
  'tutor_first_step',
] as const;

export type ExpectedOperation = (typeof EXPECTED_OPERATIONS)[number];

/** Provider calls each operation needs when no bounded repair happens. */
function minimumRequests(name: ExpectedOperation, result: Record<string, unknown>): number {
  if (name === 'grading_agreement') {
    const samples = result.samples;
    return typeof samples === 'number' && samples > 0 ? samples : 1;
  }
  return 1;
}

const RawResultSchema = z
  .object({
    name: z.string().min(1),
    ok: z.boolean(),
    requests: z.number().int().nonnegative(),
    latencyMs: z.number().nonnegative(),
    wallMs: z.number().nonnegative(),
    error: z.string().optional(),
    skipped: z.string().optional(),
  })
  .passthrough();

export const RawHy3ReportSchema = z
  .object({
    suite: z.literal('eval:hy3'),
    executedAt: z.string().datetime(),
    provider: z.literal('hy3'),
    fakeFallback: z.literal(false),
    model: z.string().min(1),
    endpointHost: z.string().min(1).nullable(),
    node: z.string().min(1),
    osFamily: z.string().min(1),
    git: z.object({
      commit: z.string().regex(/^[0-9a-f]{40}$/u, '需要完整的 40 位十六进制提交号'),
      branch: z.string().min(1),
      worktreeState: z.enum(['clean', 'dirty']),
    }),
    overall: z.enum(['passed', 'failed']),
    results: z.array(RawResultSchema).min(1),
  })
  .passthrough();

export type RawHy3Report = z.infer<typeof RawHy3ReportSchema>;
export type RawHy3Result = z.infer<typeof RawResultSchema>;

export class EvidenceValidationError extends Error {
  constructor(public readonly reasons: string[]) {
    super(`评测报告不可发布:\n- ${reasons.join('\n- ')}`);
    this.name = 'EvidenceValidationError';
  }
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Validates a raw eval:hy3 report for publication. Throws
 * EvidenceValidationError listing every violated rule; returns the typed
 * report when it is genuinely publishable.
 */
export function validateForPublication(raw: unknown): RawHy3Report {
  const parsed = RawHy3ReportSchema.safeParse(raw);
  if (!parsed.success) {
    throw new EvidenceValidationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  const report = parsed.data;
  const reasons: string[] = [];

  if (report.git.worktreeState !== 'clean') {
    reasons.push('评测在脏工作区上执行(worktreeState=dirty),证据无法与唯一提交绑定。');
  }

  const byName = new Map<string, RawHy3Result>();
  for (const result of report.results) {
    if (byName.has(result.name)) reasons.push(`操作 ${result.name} 出现了多次。`);
    byName.set(result.name, result);
  }
  for (const name of EXPECTED_OPERATIONS) {
    if (!byName.has(name)) reasons.push(`缺少必需的操作 ${name}。`);
  }
  for (const result of report.results) {
    if (!(EXPECTED_OPERATIONS as readonly string[]).includes(result.name)) {
      reasons.push(`未知操作 ${result.name} 不在评测契约内。`);
    }
    if (!result.ok) {
      reasons.push(`操作 ${result.name} 失败,失败的评测保持失败,不可发布为通过。`);
    }
    if (typeof result.skipped === 'string') {
      reasons.push(`操作 ${result.name} 被跳过,不完整的评测不可发布为通过。`);
    }
  }
  if (report.overall !== 'passed') {
    reasons.push('overall 不是 passed,失败的评测保持失败。');
  }

  // Meaningful-completion floors: each capability must actually have been
  // exercised online, not merely "not failed".
  const conceptA = byName.get('concept_analysis');
  if (conceptA && (asNumber(conceptA.groundingAccepted) ?? 0) < 1) {
    reasons.push('concept_analysis 没有任何通过本地引文验证的概念。');
  }
  const alignment = byName.get('alignment_agreement');
  if (alignment && (asNumber(alignment.comparablePairs) ?? 0) < 1) {
    reasons.push('alignment_agreement 没有可比对的概念对,对齐一致率未被真正测量。');
  }
  const grading = byName.get('grading_agreement');
  if (grading && (asNumber(grading.samples) ?? 0) < 1) {
    reasons.push('grading_agreement 没有判分样本。');
  }
  const crossDoc = byName.get('cross_document_assessment');
  if (crossDoc) {
    if ((asNumber(crossDoc.items) ?? 0) < 1) {
      reasons.push('cross_document_assessment 没有生成任何题目。');
    } else if ((asNumber(crossDoc.itemsTrulyCrossDocument) ?? 0) < 1) {
      reasons.push('cross_document_assessment 没有真正使用多文档证据的题目。');
    }
  }
  const tutor = byName.get('tutor_first_step');
  if (tutor && tutor.action !== 'call_tool' && tutor.action !== 'finalize') {
    reasons.push('tutor_first_step 的动作不在受控白名单(call_tool | finalize)内。');
  }

  if (reasons.length > 0) throw new EvidenceValidationError(reasons);
  return report;
}

export interface EvidenceOperation {
  name: ExpectedOperation;
  ok: boolean;
  requests: number;
  boundedRepairCalls: number;
  latencyMs: number;
  wallMs: number;
  metrics: Record<string, number | string | boolean>;
}

export interface PublicEvidence {
  title: string;
  suite: 'eval:hy3';
  overall: 'passed';
  provider: 'hy3';
  fakeFallback: false;
  failClosed: string;
  model: string;
  endpointHost: string | null;
  executedAt: string;
  generatedAt: string;
  environment: { node: string; osFamily: string };
  source: { commit: string; shortCommit: string; branch: string; worktreeState: 'clean' };
  totals: {
    operations: number;
    passed: number;
    failed: number;
    requests: number;
    boundedRepairCalls: number;
    latencyMs: number;
    wallMs: number;
  };
  operations: EvidenceOperation[];
  limitations: string[];
  reproduce: string[];
  generatedBy: string;
}

/** Copies only the named numeric/string aggregate fields — never `detail`. */
const METRIC_WHITELIST: Record<ExpectedOperation, string[]> = {
  concept_analysis: ['proposed', 'groundingAccepted', 'groundingAcceptanceRate', 'firstPassSchema'],
  concept_analysis_doc_b: ['proposed', 'groundingAccepted'],
  alignment_agreement: ['comparablePairs', 'agreement', 'agreementRate'],
  grading_agreement: ['samples', 'correctnessAgreement', 'keyPointExactMatch'],
  cross_document_assessment: [
    'items',
    'itemsWithVerifiedPrimaryEvidence',
    'itemsTrulyCrossDocument',
  ],
  tutor_first_step: ['action', 'tool'],
};

export const EVIDENCE_LIMITATIONS = [
  'The sample is deliberately small (original fixtures and hand-authored labels; counts are shown in the operation metrics). Results are indicative, not a benchmark, and depend on the configured model and API.',
  'Alignment agreement includes only labelled pairs whose concept names were extracted in this run (comparablePairs); unmatched labelled pairs are outside the denominator.',
  'This record proves that cited text exists at the claimed source position and passed local structural validation. Exact quotation verification does not independently prove complete semantic entailment.',
  'The raw report under eval/reports/ is gitignored. This record is a sanitized derivation that publishes only the endpoint hostname; credentials and local paths are never included.',
] as const;

export function deriveEvidence(raw: unknown, opts: { generatedAt: string }): PublicEvidence {
  const report = validateForPublication(raw);

  const operations: EvidenceOperation[] = EXPECTED_OPERATIONS.map((name) => {
    const result = report.results.find((r) => r.name === name) as RawHy3Result;
    const metrics: Record<string, number | string | boolean> = {};
    for (const key of METRIC_WHITELIST[name]) {
      const value = result[key];
      if (
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        (typeof value === 'string' && value.length <= 80)
      ) {
        metrics[key] = value;
      }
    }
    const boundedRepairCalls = Math.max(0, result.requests - minimumRequests(name, result));
    return {
      name,
      ok: result.ok,
      requests: result.requests,
      boundedRepairCalls,
      latencyMs: result.latencyMs,
      wallMs: result.wallMs,
      metrics,
    };
  });

  const totals = {
    operations: operations.length,
    passed: operations.filter((op) => op.ok).length,
    failed: operations.filter((op) => !op.ok).length,
    requests: operations.reduce((sum, op) => sum + op.requests, 0),
    boundedRepairCalls: operations.reduce((sum, op) => sum + op.boundedRepairCalls, 0),
    latencyMs: operations.reduce((sum, op) => sum + op.latencyMs, 0),
    wallMs: operations.reduce((sum, op) => sum + op.wallMs, 0),
  };

  return {
    title: 'Hy3 Study Clinic — Real Hy3 Online Verification',
    suite: 'eval:hy3',
    overall: 'passed',
    provider: 'hy3',
    fakeFallback: false,
    failClosed:
      'eval/run-hy3.mjs exits non-zero when HY3_BASE_URL, HY3_API_KEY, or HY3_MODEL is missing. The script has no FakeProvider code path and cannot silently fall back.',
    model: report.model,
    endpointHost: report.endpointHost,
    executedAt: report.executedAt,
    generatedAt: opts.generatedAt,
    environment: { node: report.node, osFamily: report.osFamily },
    source: {
      commit: report.git.commit,
      shortCommit: report.git.commit.slice(0, 7),
      branch: report.git.branch,
      worktreeState: 'clean',
    },
    totals,
    operations,
    limitations: [...EVIDENCE_LIMITATIONS],
    reproduce: [
      'npm run build',
      'npm run eval:hy3   # requires your own real HY3_* credentials; missing values fail closed',
      'npm run eval:evidence',
    ],
    generatedBy: 'eval/export-evidence.mjs',
  };
}

export interface SecretScanFinding {
  path: string;
  rule: string;
}

const SECRET_PATTERNS: Array<{ rule: string; pattern: RegExp }> = [
  { rule: 'api-key-literal', pattern: /sk-[A-Za-z0-9]{8,}/u },
  { rule: 'bearer-token', pattern: /bearer\s+[A-Za-z0-9._-]{8,}/iu },
  { rule: 'authorization-header', pattern: /authorization\s*[:=]/iu },
  { rule: 'api-key-assignment', pattern: /api[_-]?key\s*[:=]\s*\S/iu },
  { rule: 'url-credentials', pattern: /:\/\/[^/\s@]+:[^/\s@]+@/u },
  {
    rule: 'credential-query-parameter',
    pattern: /[?&](key|token|api_key|apikey|access_token|secret)=/iu,
  },
  { rule: 'windows-user-path', pattern: /[A-Za-z]:[\\/]Users[\\/]/iu },
  { rule: 'unix-home-path', pattern: /(?:^|[\s"'=:(])\/(?:home|Users)\/[A-Za-z0-9_-]+/u },
  { rule: 'long-opaque-token', pattern: /[A-Za-z0-9+/=_-]{48,}/u },
];

const SENSITIVE_KEY_PATTERN = /authorization|api[_-]?key|secret|password|credential|bearer/iu;

function scanString(value: string, path: string, secretValues: string[]): SecretScanFinding[] {
  const findings: SecretScanFinding[] = [];
  for (const { rule, pattern } of SECRET_PATTERNS) {
    if (pattern.test(value)) findings.push({ path, rule });
  }
  for (const secret of secretValues) {
    if (secret.length >= 6 && value.includes(secret)) {
      findings.push({ path, rule: 'configured-secret-value' });
    }
  }
  return findings;
}

/**
 * Recursively scans keys and string values. `secretValues` may contain the
 * actual configured credential strings; findings identify only the JSON path
 * and the violated rule — never the matched text.
 */
export function scanEvidenceValue(
  value: unknown,
  secretValues: string[] = [],
  path = '$',
): SecretScanFinding[] {
  if (typeof value === 'string') return scanString(value, path, secretValues);
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      scanEvidenceValue(entry, secretValues, `${path}[${index}]`),
    );
  }
  if (value !== null && typeof value === 'object') {
    const findings: SecretScanFinding[] = [];
    for (const [key, entry] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        findings.push({ path: `${path}.${key}`, rule: 'sensitive-key-name' });
      }
      findings.push(...scanEvidenceValue(entry, secretValues, `${path}.${key}`));
    }
    return findings;
  }
  return [];
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

function metricText(op: EvidenceOperation): string {
  const parts = Object.entries(op.metrics).map(([key, value]) => `${key}=${String(value)}`);
  return parts.join(', ');
}

/** Renders the Markdown artifact from the exact same sanitized object. */
export function renderEvidenceMarkdown(evidence: PublicEvidence): string {
  const lines: string[] = [
    `# ${evidence.title}`,
    '',
    '> Sanitized public record of the real-provider evaluation (`eval:hy3`) executed online',
    '> against the Hy3 API at the source commit below. Derived from the gitignored raw report',
    `> by \`${evidence.generatedBy}\`; the raw report itself is never committed.`,
    '',
    '## Run identity',
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Overall result | **${evidence.overall}** (${evidence.totals.passed}/${evidence.totals.operations} operations) |`,
    `| Provider | \`${evidence.provider}\` (real online API) |`,
    `| Fake fallback | \`${String(evidence.fakeFallback)}\` — ${evidence.failClosed} |`,
    `| Model | \`${evidence.model}\` |`,
    `| Endpoint host | ${evidence.endpointHost ? `\`${evidence.endpointHost}\`` : '(not recorded)'} |`,
    `| Source commit | \`${evidence.source.commit}\` |`,
    `| Branch / worktree | \`${evidence.source.branch}\` / ${evidence.source.worktreeState} |`,
    `| Executed at (UTC) | ${evidence.executedAt} |`,
    `| Evidence generated at (UTC) | ${evidence.generatedAt} |`,
    `| Runtime | Node.js ${evidence.environment.node} on ${evidence.environment.osFamily} |`,
    `| Requests | ${evidence.totals.requests} total, ${formatCount(evidence.totals.boundedRepairCalls, 'bounded repair call')}, provider latency ${formatSeconds(evidence.totals.latencyMs)} |`,
    '',
    '## Operations',
    '',
    '| Operation | Result | Requests | Bounded repairs | Latency | Key metrics |',
    '| --- | --- | ---: | ---: | ---: | --- |',
    ...evidence.operations.map(
      (op) =>
        `| \`${op.name}\` | ${op.ok ? '✅ passed' : '❌ failed'} | ${op.requests} | ${op.boundedRepairCalls} | ${formatSeconds(op.latencyMs)} | ${metricText(op)} |`,
    ),
    '',
    '## What this proves',
    '',
    '- The exact source version above completed every model-backed evaluation operation against the real Hy3 endpoint, with structured output accepted by runtime schema validation (at most one bounded repair per call).',
    '- Proposed evidence quotes were verified by the local exact-quote grounding validator against the real source blocks.',
    '- Alignment and short-answer grading agreed with the small hand-authored labels at the rates recorded above, and the cross-document operation produced at least one question whose verified evidence really spans multiple documents.',
    '- The Tutor first step stayed inside the controlled action vocabulary.',
    '',
    '## What this does not prove',
    '',
    ...evidence.limitations.map((limitation) => `- ${limitation}`),
    '',
    '## Reproduce',
    '',
    '```bash',
    ...evidence.reproduce,
    '```',
    '',
    'The complete sanitized aggregates are in `hy3-online-verification.json` in this directory; both files are generated from the same validated object.',
  ];
  return `${lines.join('\n')}\n`;
}
