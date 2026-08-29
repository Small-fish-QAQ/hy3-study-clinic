import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_RETAINED_CANDIDATE_BYTES,
  serializeRejectedCandidate,
  type RejectedGenerationArtifact,
} from './rejectedArtifact.js';
import { toRejectedEvaluationCase } from './rejectedArtifactCase.js';

/** Learner prose, credential-shaped strings, and prompt-like keys, all hostile. */
const HOSTILE_LEARNER_TEXT = '学习者写道:工作记忆的容量十分有限,这是我的答案。';
const HOSTILE_API_KEY = 'sk-live-51H8xQwErTyUiOpAsDfGhJkLzXcVbNm1234567890';
const HOSTILE_AUTHORIZATION = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig';

const hostileCandidate = {
  prompt: 'You are Hy3. The full system prompt follows: ' + HOSTILE_LEARNER_TEXT,
  payload: { raw: HOSTILE_LEARNER_TEXT, body: HOSTILE_AUTHORIZATION },
  authorization: HOSTILE_AUTHORIZATION,
  apiKey: HOSTILE_API_KEY,
  learnerAnswer: HOSTILE_LEARNER_TEXT,
  sourceQuote: HOSTILE_LEARNER_TEXT,
  nested: { deeply: { arbitrary: { key: HOSTILE_LEARNER_TEXT } } },
};

function artifact(overrides: Partial<RejectedGenerationArtifact> = {}): RejectedGenerationArtifact {
  return {
    id: 'rej_1',
    logicalCallId: 'call_1',
    attemptId: 'att_1',
    attemptNumber: 1,
    attemptKind: 'original',
    operationKind: 'concept_lesson',
    schemaName: 'ConceptLessonPayload',
    createdAt: '2026-08-29T00:00:00.000Z',
    validationKind: 'candidate',
    failureCategory: 'SEMANTIC_VALIDATION_FAILURE',
    repairExhausted: true,
    candidate: serializeRejectedCandidate(hostileCandidate, false),
    findings: [
      { kind: 'schema', path: 'steps.0.detail', code: 'too_small', message: HOSTILE_LEARNER_TEXT },
      { kind: 'semantic', code: 'worked_process_not_bounded', message: HOSTILE_LEARNER_TEXT },
    ],
    promptFingerprint: 'c'.repeat(64),
    schemaFingerprint: null,
    policyFingerprint: null,
    sourceFingerprint: null,
    validationFingerprint: null,
    ...overrides,
  };
}

describe('Tier-1 rejected candidate serialization', () => {
  it('retains the exact rejected candidate verbatim with a content hash', () => {
    const candidate = { steps: [{ detail: HOSTILE_LEARNER_TEXT }] };
    const serialized = serializeRejectedCandidate(candidate, false);
    expect(serialized.representation).toBe('json');
    expect(serialized.truncated).toBe(false);
    expect(JSON.parse(serialized.body!)).toEqual(candidate);
    expect(serialized.contentHash).toBe(
      createHash('sha256').update(JSON.stringify(candidate)).digest('hex'),
    );
    expect(serialized.bytes).toBe(Buffer.byteLength(JSON.stringify(candidate), 'utf8'));
  });

  it('retains raw response text when JSON extraction never produced a value', () => {
    const serialized = serializeRejectedCandidate('not json at all', true);
    expect(serialized.representation).toBe('text');
    expect(serialized.body).toBe('not json at all');
  });

  it('records that truncation occurred and keeps the full hash and byte length', () => {
    const oversized = 'x'.repeat(MAX_RETAINED_CANDIDATE_BYTES + 500);
    const serialized = serializeRejectedCandidate(oversized, true);
    expect(serialized.representation).toBe('text_truncated');
    expect(serialized.truncated).toBe(true);
    expect(serialized.bytes).toBe(MAX_RETAINED_CANDIDATE_BYTES + 500);
    expect(serialized.body!.length).toBeLessThanOrEqual(MAX_RETAINED_CANDIDATE_BYTES);
    expect(serialized.contentHash).toBe(createHash('sha256').update(oversized).digest('hex'));
  });

  it('degrades cyclic, binary, and absurdly nested candidates without throwing', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    expect(serializeRejectedCandidate(cyclic, false).representation).toBe('unserializable');

    const binary = `head${String.fromCharCode(0)}tail`;
    expect(serializeRejectedCandidate(binary, true).representation).toBe('unserializable');

    let deep: unknown = 'leaf';
    for (let index = 0; index < 200; index += 1) deep = { deep };
    expect(serializeRejectedCandidate(deep, false).representation).toBe('unserializable');
  });
});

describe('Tier-2 redacted evaluation case', () => {
  it('projects only allowlisted metadata for a rejected candidate', () => {
    const projected = toRejectedEvaluationCase(artifact());
    expect(projected).toEqual({
      artifactId: 'rej_1',
      logicalCallId: 'call_1',
      attemptId: 'att_1',
      attemptNumber: 1,
      attemptKind: 'original',
      operationKind: 'concept_lesson',
      schemaName: 'ConceptLessonPayload',
      createdAt: '2026-08-29T00:00:00.000Z',
      validationKind: 'candidate',
      failureCategory: 'SEMANTIC_VALIDATION_FAILURE',
      repairExhausted: true,
      candidateRepresentation: 'json',
      candidateBytes: expect.any(Number),
      candidateTruncated: false,
      candidateContentHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      findingCount: 2,
      findings: [
        { kind: 'schema', code: 'too_small', path: 'steps.0.detail' },
        { kind: 'semantic', code: 'worked_process_not_bounded' },
      ],
      promptFingerprint: 'c'.repeat(64),
      schemaFingerprint: null,
      policyFingerprint: null,
      sourceFingerprint: null,
      validationFingerprint: null,
      publishable: false,
    });
  });

  // Test F: hostile Tier-1 content must be mechanically incapable of reaching Tier 2.
  it('leaks no learner text, candidate body, prompt content, or credentials', () => {
    const serialized = JSON.stringify(toRejectedEvaluationCase(artifact()));
    expect(serialized).not.toContain(HOSTILE_LEARNER_TEXT);
    expect(serialized).not.toContain(HOSTILE_API_KEY);
    expect(serialized).not.toContain(HOSTILE_AUTHORIZATION);
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toContain('sk-live');
    expect(serialized).not.toContain('You are Hy3');
    for (const key of ['prompt', 'payload', 'raw', 'body', 'authorization', 'apiKey']) {
      expect(serialized).not.toContain(`"${key}"`);
    }
    // The candidate body itself never appears, only its shape metadata.
    expect(serialized).not.toContain('learnerAnswer');
    expect(serialized).not.toContain('sourceQuote');
  });

  it('collapses unrecognized codes, paths, digests, and enums instead of passing them through', () => {
    const projected = toRejectedEvaluationCase(
      artifact({
        operationKind: HOSTILE_LEARNER_TEXT,
        schemaName: HOSTILE_API_KEY,
        createdAt: HOSTILE_LEARNER_TEXT,
        failureCategory: 'INVENTED_CATEGORY',
        attemptKind: 'original',
        promptFingerprint: HOSTILE_AUTHORIZATION,
        findings: [
          { kind: 'schema', path: HOSTILE_LEARNER_TEXT, code: HOSTILE_LEARNER_TEXT, message: '' },
          { kind: 'semantic', code: HOSTILE_API_KEY },
        ],
      }),
    );
    expect(projected.operationKind).toMatch(/^<operation:sha256:[0-9a-f]{64}>$/u);
    expect(projected.schemaName).toMatch(/^<schema:sha256:[0-9a-f]{64}>$/u);
    expect(projected.createdAt).toBe('');
    expect(projected.failureCategory).toBe('other');
    expect(projected.promptFingerprint).toBeNull();
    expect(projected.findings).toEqual([
      {
        kind: 'schema',
        code: expect.stringMatching(/^<code:sha256:[0-9a-f]{64}>$/u),
        path: expect.stringMatching(/^<path:sha256:[0-9a-f]{64}>$/u),
      },
      { kind: 'semantic', code: expect.stringMatching(/^<code:sha256:[0-9a-f]{64}>$/u) },
    ]);
  });

  it('hashes a credential-shaped token instead of reproducing it', () => {
    const projected = toRejectedEvaluationCase(artifact({ schemaName: HOSTILE_API_KEY }));
    expect(projected.schemaName).not.toContain('sk-live');
    expect(projected.schemaName).toMatch(/^<schema:sha256:[0-9a-f]{64}>$/u);
  });

  it('bounds the projected finding list', () => {
    const many = Array.from({ length: 200 }, () => ({
      kind: 'semantic' as const,
      code: 'worked_process_not_bounded',
    }));
    const projected = toRejectedEvaluationCase(artifact({ findings: many }));
    expect(projected.findingCount).toBe(200);
    expect(projected.findings.length).toBeLessThanOrEqual(24);
  });

  it('is pure and deterministic', () => {
    const input = artifact();
    const before = JSON.stringify(input);
    expect(toRejectedEvaluationCase(input)).toEqual(toRejectedEvaluationCase(input));
    expect(JSON.stringify(input)).toBe(before);
  });

  it('never marks a case publishable by default', () => {
    expect(toRejectedEvaluationCase(artifact()).publishable).toBe(false);
  });
});
