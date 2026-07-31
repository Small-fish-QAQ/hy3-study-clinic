import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EXPECTED_OPERATIONS,
  renderEvidenceMarkdown,
  scanEvidenceValue,
  type PublicEvidence,
} from './evidence.js';

// Guards the committed sanitized artifact in docs/evidence/: the JSON must
// stay a passing real-provider record with full provenance, the Markdown must
// stay byte-identical to what the JSON renders (the repo forces eol=lf), and
// neither file may ever contain credentials or local paths.
const jsonPath = fileURLToPath(
  new URL('../../../../docs/evidence/hy3-online-verification.json', import.meta.url),
);
const mdPath = fileURLToPath(
  new URL('../../../../docs/evidence/hy3-online-verification.md', import.meta.url),
);

const evidence = JSON.parse(readFileSync(jsonPath, 'utf8')) as PublicEvidence;
const markdown = readFileSync(mdPath, 'utf8');

describe('published Hy3 online-verification evidence', () => {
  it('is a passing real-provider record with full source provenance', () => {
    expect(evidence.suite).toBe('eval:hy3');
    expect(evidence.provider).toBe('hy3');
    expect(evidence.fakeFallback).toBe(false);
    expect(evidence.overall).toBe('passed');
    expect(evidence.model.length).toBeGreaterThan(0);
    expect(evidence.source.commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(evidence.source.shortCommit).toBe(evidence.source.commit.slice(0, 7));
    expect(evidence.source.worktreeState).toBe('clean');
  });

  it('covers every contract operation and derives totals from the operations', () => {
    expect(evidence.operations.map((op) => op.name)).toEqual([...EXPECTED_OPERATIONS]);
    for (const op of evidence.operations) {
      expect(op.ok).toBe(true);
    }
    expect(evidence.totals.operations).toBe(evidence.operations.length);
    expect(evidence.totals.passed).toBe(evidence.operations.length);
    expect(evidence.totals.failed).toBe(0);
    expect(evidence.totals.requests).toBe(
      evidence.operations.reduce((sum, op) => sum + op.requests, 0),
    );
    expect(evidence.totals.boundedRepairCalls).toBe(
      evidence.operations.reduce((sum, op) => sum + op.boundedRepairCalls, 0),
    );
  });

  it('keeps Markdown and JSON in exact agreement', () => {
    expect(renderEvidenceMarkdown(evidence)).toBe(markdown);
  });

  it('contains no credentials, per-sample detail, or local paths', () => {
    expect(scanEvidenceValue(evidence)).toEqual([]);
    expect(scanEvidenceValue(markdown)).toEqual([]);
    expect(JSON.stringify(evidence)).not.toContain('"detail"');
    expect(evidence.limitations.length).toBeGreaterThan(0);
  });
});
