import { describe, expect, it } from 'vitest';
import {
  deriveEvidence,
  EvidenceValidationError,
  EXPECTED_OPERATIONS,
  renderEvidenceMarkdown,
  scanEvidenceValue,
  validateForPublication,
} from './evidence.js';

const CLEAN_COMMIT = '0123456789abcdef0123456789abcdef01234567';

function makeRawReport(): Record<string, unknown> {
  return {
    suite: 'eval:hy3',
    executedAt: '2026-07-31T04:00:00.000Z',
    provider: 'hy3',
    fakeFallback: false,
    model: 'hunyuan-eval-model',
    endpointHost: 'api.example-hy3.test',
    node: 'v22.0.0',
    osFamily: 'win32',
    git: { commit: CLEAN_COMMIT, branch: 'main', worktreeState: 'clean' },
    overall: 'passed',
    results: [
      {
        name: 'concept_analysis',
        ok: true,
        requests: 1,
        latencyMs: 5000,
        wallMs: 5200,
        proposed: 6,
        groundingAccepted: 6,
        groundingAcceptanceRate: 1,
        firstPassSchema: true,
      },
      {
        name: 'concept_analysis_doc_b',
        ok: true,
        requests: 1,
        latencyMs: 4000,
        wallMs: 4100,
        proposed: 5,
        groundingAccepted: 5,
      },
      {
        name: 'alignment_agreement',
        ok: true,
        requests: 1,
        latencyMs: 6000,
        wallMs: 6100,
        comparablePairs: 4,
        agreement: 4,
        agreementRate: 1,
        detail: [
          { pair: '工作记忆 ↔ working memory', human: 'merge', model: 'equivalent', agree: true },
        ],
      },
      {
        name: 'grading_agreement',
        ok: true,
        requests: 7,
        latencyMs: 21000,
        wallMs: 21400,
        samples: 7,
        correctnessAgreement: 1,
        keyPointExactMatch: 0.857,
        detail: [
          {
            answer: '学生真实答案片段不应外泄',
            humanCorrect: true,
            modelScore: 1,
            keyPointsAgree: true,
          },
        ],
      },
      {
        name: 'cross_document_assessment',
        ok: true,
        requests: 1,
        latencyMs: 9000,
        wallMs: 9100,
        items: 2,
        itemsWithVerifiedPrimaryEvidence: 2,
        itemsTrulyCrossDocument: 1,
      },
      {
        name: 'tutor_first_step',
        ok: true,
        requests: 1,
        latencyMs: 3000,
        wallMs: 3100,
        action: 'call_tool',
        tool: 'inspect_learning_state',
        schemaValid: true,
      },
    ],
  };
}

function mutate(fn: (report: Record<string, unknown>) => void): Record<string, unknown> {
  const report = makeRawReport();
  fn(report);
  return report;
}

function resultsOf(report: Record<string, unknown>): Array<Record<string, unknown>> {
  return report.results as Array<Record<string, unknown>>;
}

describe('validateForPublication', () => {
  it('accepts a complete passing real-provider report', () => {
    const report = validateForPublication(makeRawReport());
    expect(report.provider).toBe('hy3');
    expect(report.results).toHaveLength(EXPECTED_OPERATIONS.length);
  });

  it('rejects fake-suite and fake-provider reports so eval:fake can never become online evidence', () => {
    expect(() => validateForPublication(mutate((r) => (r.suite = 'eval:fake')))).toThrow(
      EvidenceValidationError,
    );
    expect(() => validateForPublication(mutate((r) => (r.provider = 'fake')))).toThrow(
      EvidenceValidationError,
    );
    expect(() => validateForPublication(mutate((r) => (r.fakeFallback = true)))).toThrow(
      EvidenceValidationError,
    );
  });

  it('requires full git provenance on a clean worktree', () => {
    expect(() => validateForPublication(mutate((r) => (r.git = null)))).toThrow(
      EvidenceValidationError,
    );
    expect(() =>
      validateForPublication(
        mutate((r) => ((r.git as Record<string, unknown>).commit = '2637148')),
      ),
    ).toThrow(EvidenceValidationError);
    expect(() =>
      validateForPublication(
        mutate((r) => ((r.git as Record<string, unknown>).worktreeState = 'dirty')),
      ),
    ).toThrow(/dirty/u);
  });

  it('requires model identity', () => {
    expect(() => validateForPublication(mutate((r) => (r.model = '')))).toThrow(
      EvidenceValidationError,
    );
  });

  it('keeps failed evaluations failed', () => {
    expect(() => validateForPublication(mutate((r) => (resultsOf(r)[3].ok = false)))).toThrow(
      /失败的评测保持失败/u,
    );
    expect(() => validateForPublication(mutate((r) => (r.overall = 'failed')))).toThrow(
      /失败的评测保持失败/u,
    );
  });

  it('rejects incomplete runs: skipped, missing, duplicate, or unknown operations', () => {
    expect(() =>
      validateForPublication(mutate((r) => (resultsOf(r)[4].skipped = '概念不足'))),
    ).toThrow(/不完整的评测/u);
    expect(() => validateForPublication(mutate((r) => resultsOf(r).pop()))).toThrow(
      /缺少必需的操作 tutor_first_step/u,
    );
    expect(() => validateForPublication(mutate((r) => resultsOf(r).push(resultsOf(r)[0])))).toThrow(
      /出现了多次/u,
    );
    expect(() =>
      validateForPublication(
        mutate((r) =>
          resultsOf(r).push({ name: 'bonus_op', ok: true, requests: 1, latencyMs: 1, wallMs: 1 }),
        ),
      ),
    ).toThrow(/未知操作/u);
  });

  it('rejects runs whose capabilities were not meaningfully exercised', () => {
    expect(() =>
      validateForPublication(mutate((r) => (resultsOf(r)[2].comparablePairs = 0))),
    ).toThrow(/对齐一致率未被真正测量/u);
    expect(() =>
      validateForPublication(mutate((r) => (resultsOf(r)[4].itemsTrulyCrossDocument = 0))),
    ).toThrow(/真正使用多文档证据/u);
    expect(() =>
      validateForPublication(mutate((r) => (resultsOf(r)[5].action = 'delete_everything'))),
    ).toThrow(/受控白名单/u);
  });

  it('accepts and validates the optional semantic-recall and lesson operations', () => {
    const raw = mutate((r) => {
      resultsOf(r).push(
        {
          name: 'semantic_recall',
          ok: true,
          requests: 3,
          latencyMs: 9000,
          wallMs: 9300,
          sectionCount: 3,
          proposed: 12,
          groundingAccepted: 10,
          mustFind: 8,
          recalled: 7,
          recallRate: 0.875,
          firstPassSchema: true,
          detail: { missingLabels: ['不得公开的标签明细'] },
        },
        {
          name: 'lesson_generation',
          ok: true,
          requests: 1,
          latencyMs: 3000,
          wallMs: 3100,
          sections: 3,
          segments: 5,
          anchoredProposed: 2,
          anchorsVerified: 2,
          conflicts: 0,
          conflictsVerified: 0,
          firstPassSchema: true,
        },
      );
    });
    expect(() => validateForPublication(raw)).not.toThrow();

    const evidence = deriveEvidence(raw, { generatedAt: '2026-08-09T05:00:00.000Z' });
    expect(evidence.operations.map((operation) => operation.name)).toEqual([
      ...EXPECTED_OPERATIONS,
      'semantic_recall',
      'lesson_generation',
    ]);
    const recall = evidence.operations.find((operation) => operation.name === 'semantic_recall')!;
    expect(recall.boundedRepairCalls).toBe(0);
    expect(recall.metrics).toMatchObject({ mustFind: 8, recalled: 7, recallRate: 0.875 });
    expect(JSON.stringify(evidence)).not.toContain('不得公开的标签明细');
  });
});

describe('deriveEvidence', () => {
  const generatedAt = '2026-07-31T05:00:00.000Z';

  it('whitelists aggregate metrics and drops per-sample detail content', () => {
    const evidence = deriveEvidence(makeRawReport(), { generatedAt });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain('detail');
    expect(serialized).not.toContain('学生真实答案片段不应外泄');
    expect(serialized).not.toContain('工作记忆 ↔ working memory');
    expect(evidence.operations[3].metrics).toEqual({
      samples: 7,
      correctnessAgreement: 1,
      keyPointExactMatch: 0.857,
    });
    expect(evidence.source).toEqual({
      commit: CLEAN_COMMIT,
      shortCommit: CLEAN_COMMIT.slice(0, 7),
      branch: 'main',
      worktreeState: 'clean',
    });
  });

  it('derives bounded-repair counts and totals from the raw results themselves', () => {
    const raw = mutate((r) => {
      resultsOf(r)[0].requests = 2; // one bounded repair
      resultsOf(r)[3].requests = 8; // 7 samples + one bounded repair
    });
    const evidence = deriveEvidence(raw, { generatedAt });
    expect(evidence.operations[0].boundedRepairCalls).toBe(1);
    expect(evidence.operations[3].boundedRepairCalls).toBe(1);
    expect(evidence.totals.boundedRepairCalls).toBe(2);
    expect(evidence.totals.requests).toBe(14);
    expect(evidence.totals.passed).toBe(6);
    expect(evidence.totals.failed).toBe(0);
  });

  it('refuses to derive evidence from an unpublishable report', () => {
    expect(() =>
      deriveEvidence(
        mutate((r) => (r.provider = 'fake')),
        { generatedAt },
      ),
    ).toThrow(EvidenceValidationError);
  });
});

describe('scanEvidenceValue', () => {
  // Obviously fake credential material, assembled so the literals in this
  // file are self-evidently test fixtures.
  const FAKE_KEY = 'sk-' + 'testonly0123456789';
  const FAKE_BEARER = 'Bearer ' + 'testonly.token.0123456789';

  it('flags credential patterns, credential URLs, and local user paths', () => {
    const rules = (value: unknown) => scanEvidenceValue(value).map((f) => f.rule);
    expect(rules({ note: FAKE_KEY })).toContain('api-key-literal');
    expect(rules({ note: FAKE_BEARER })).toContain('bearer-token');
    expect(rules({ note: 'authorization: ****' })).toContain('authorization-header');
    expect(rules({ note: 'api_key=abc' })).toContain('api-key-assignment');
    expect(rules({ note: 'https://user:pass@host.test/v1' })).toContain('url-credentials');
    expect(rules({ note: 'https://host.test/v1?access_token=abc' })).toContain(
      'credential-query-parameter',
    );
    expect(rules({ note: 'C:\\Users\\someone\\project' })).toContain('windows-user-path');
    expect(rules({ note: 'seen in /home/someone/.env' })).toContain('unix-home-path');
    expect(rules({ note: 'x'.repeat(48) })).toContain('long-opaque-token');
    expect(rules({ authorization: 'anything' })).toContain('sensitive-key-name');
  });

  it('flags configured secret values without echoing them in findings', () => {
    const secret = 'configured-secret-value-123';
    const findings = scanEvidenceValue({ nested: [{ text: `prefix ${secret} suffix` }] }, [secret]);
    expect(findings.some((f) => f.rule === 'configured-secret-value')).toBe(true);
    for (const finding of findings) {
      expect(JSON.stringify(finding)).not.toContain(secret);
    }
  });

  it('passes derived evidence and its rendered Markdown', () => {
    const evidence = deriveEvidence(makeRawReport(), { generatedAt: '2026-07-31T05:00:00.000Z' });
    expect(scanEvidenceValue(evidence, ['unrelated-secret-value'])).toEqual([]);
    expect(scanEvidenceValue(renderEvidenceMarkdown(evidence), ['unrelated-secret-value'])).toEqual(
      [],
    );
  });
});

describe('renderEvidenceMarkdown', () => {
  it('renders the same identity and per-operation facts as the JSON object', () => {
    const evidence = deriveEvidence(makeRawReport(), { generatedAt: '2026-07-31T05:00:00.000Z' });
    const markdown = renderEvidenceMarkdown(evidence);
    expect(markdown).toContain(evidence.source.commit);
    expect(markdown).toContain('`hunyuan-eval-model`');
    expect(markdown).toContain('**passed** (6/6 operations)');
    for (const name of EXPECTED_OPERATIONS) {
      expect(markdown).toContain(`\`${name}\``);
    }
    expect(markdown).toContain('itemsTrulyCrossDocument=1');
    expect(renderEvidenceMarkdown(evidence)).toBe(markdown);
  });
});
