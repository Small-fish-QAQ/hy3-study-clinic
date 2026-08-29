import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceBlock } from '@hy3-clinic/shared';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { ProviderError } from '../llm/errors.js';
import { Hy3Provider } from '../llm/hy3Provider.js';
import type { ConceptAnalysisInput } from '../llm/provider.js';
import { createRepositories, type Repositories } from '../repositories/index.js';
import { T0 } from '../testing/fixtures.js';
import { makeWorkspace } from '../testing/fixtures.js';
import { fixedClock } from '../util/ids.js';
import {
  createTelemetryProvider,
  type RejectedArtifactCaptureFailureSignal,
} from './providerTelemetry.js';

/**
 * Tier-1 capture wired end to end: a real Hy3Provider whose transport returns
 * synthetic deliberately-invalid candidates, driven through the real telemetry
 * proxy. No real provider is contacted and no live database is opened.
 */

const blocks: SourceBlock[] = [
  {
    id: 'blk_0',
    materialId: 'mat_1',
    index: 0,
    heading: '记忆',
    headingPath: ['记忆'],
    content: '工作记忆的容量十分有限。',
    startOffset: 0,
    endOffset: 12,
  },
];

const analysisInput: ConceptAnalysisInput = { materialTitle: '记忆导论', blocks };

/** Learner-authored prose that must appear in Tier 1 and nowhere else. */
const LEARNER_TEXT = '学习者原话:我以为工作记忆没有容量上限。';

function jsonResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeProvider(fetchImpl: typeof fetch): Hy3Provider {
  return new Hy3Provider({
    baseUrl: 'https://example.test/v1',
    apiKey: 'test-key-should-never-leak',
    model: 'test-model',
    timeoutMs: 30_000,
    fetchImpl,
  });
}

/** A schema-valid concept analysis payload. */
const validPayload = JSON.stringify({
  concepts: [
    {
      name: '工作记忆',
      summary: '容量有限的加工系统。',
      importance: 'high',
      blockId: 'blk_0',
      quote: '工作记忆的容量十分有限。',
    },
  ],
});

/** Schema-invalid: `concepts` is the wrong type entirely. */
const schemaInvalidPayload = JSON.stringify({ concepts: LEARNER_TEXT });

let db: SqliteDb;
let repos: Repositories;

function wrap(
  raw: Hy3Provider,
  onRejectedArtifactCaptureFailure?: (signal: RejectedArtifactCaptureFailureSignal) => void,
) {
  return createTelemetryProvider({
    repos,
    clock: fixedClock(T0),
    provider: raw,
    providerGeneration: () => 1,
    ...(onRejectedArtifactCaptureFailure ? { onRejectedArtifactCaptureFailure } : {}),
  });
}

const telemetry = { workspaceId: 'ws_1', operationType: 'analyze_concepts' } as const;

/**
 * Independent re-implementation of the production canonicalisation, applied to the
 * message sequences actually observed on the wire. Deriving the expectation from the
 * captured request bodies — rather than from the provider's own helper — is what makes
 * this an oracle rather than a tautology.
 */
function fingerprintOracle(messages: Array<{ role: string; content: string }>): string {
  const digest = createHash('sha256');
  for (const message of messages) {
    digest.update(`${message.role}:${message.content.length}:${message.content}`);
  }
  return digest.digest('hex');
}

/** Records the exact outbound message sequence of every physical provider attempt. */
function recordingFetch(payloads: string[]): {
  fetchImpl: typeof fetch;
  sent: Array<Array<{ role: string; content: string }>>;
} {
  const sent: Array<Array<{ role: string; content: string }>> = [];
  let index = 0;
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    sent.push(body.messages);
    const payload = payloads[Math.min(index, payloads.length - 1)]!;
    index += 1;
    return jsonResponse(payload);
  };
  return { fetchImpl, sent };
}

describe('local rejected-artifact capture', () => {
  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db);
    repos = createRepositories(db);
    repos.workspaces.insert(makeWorkspace());
  });

  afterEach(() => db.close());

  // Test B: the success path must retain nothing.
  it('retains no artifact when the first candidate is accepted', async () => {
    const provider = wrap(makeProvider(async () => jsonResponse(validPayload)));
    await provider.analyzeConcepts(analysisInput, { telemetry });

    expect(db.prepare('SELECT COUNT(*) AS n FROM rejected_generation_artifacts').get()).toEqual({
      n: 0,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM model_call_attempts').get()).toEqual({ n: 1 });
  });

  // Test C: a rejected candidate is retained exactly, with linked identity.
  it('retains the exact rejected candidate with linked identity and findings', async () => {
    let calls = 0;
    const provider = wrap(
      makeProvider(async () => {
        calls += 1;
        return jsonResponse(calls === 1 ? schemaInvalidPayload : validPayload);
      }),
    );
    await provider.analyzeConcepts(analysisInput, { telemetry });

    const call = db.prepare('SELECT id FROM model_logical_calls').get() as { id: string };
    const artifacts = repos.telemetry.listRejectedArtifacts(call.id);
    expect(artifacts).toHaveLength(1);
    const artifact = artifacts[0]!;

    // Exact Tier-1 candidate, byte for byte.
    expect(artifact.candidate.representation).toBe('json');
    expect(artifact.candidate.body).toBe(schemaInvalidPayload);
    expect(artifact.candidate.truncated).toBe(false);
    expect(artifact.candidate.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(artifact.candidate.bytes).toBe(Buffer.byteLength(schemaInvalidPayload, 'utf8'));

    // Identity links resolve to a real physical attempt on this logical call.
    const attempt = repos.telemetry.getAttempt(artifact.attemptId);
    expect(attempt?.logicalCallId).toBe(call.id);
    expect(artifact.attemptNumber).toBe(1);
    expect(artifact.attemptKind).toBe('original');
    expect(artifact.operationKind).toBe('analyze_concepts');

    // Validation findings and fingerprints round-trip.
    expect(artifact.validationKind).toBe('schema');
    expect(artifact.failureCategory).toBe('SCHEMA_VALIDATION_FAILURE');
    expect(artifact.repairExhausted).toBe(false);
    expect(artifact.findingCount ?? artifact.findings.length).toBeGreaterThan(0);
    expect(artifact.findings.some((finding) => finding.kind === 'schema')).toBe(true);
    expect(artifact.promptFingerprint).toMatch(/^[0-9a-f]{64}$/u);
  });

  // Test D: the rejected original and the rejected repair are distinguishable.
  // Two same-dimension schema failures exhaust the bounded allowance at attempt
  // two, so the call fails — but both rejected candidates are still retained.
  it('separates rejected original and rejected repair by physical attempt identity', async () => {
    const provider = wrap(makeProvider(async () => jsonResponse(schemaInvalidPayload)));
    await expect(provider.analyzeConcepts(analysisInput, { telemetry })).rejects.toBeInstanceOf(
      ProviderError,
    );

    const call = db.prepare('SELECT id FROM model_logical_calls').get() as { id: string };
    const artifacts = repos.telemetry.listRejectedArtifacts(call.id);
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]!.attemptNumber).toBe(1);
    expect(artifacts[0]!.attemptKind).toBe('original');
    expect(artifacts[1]!.attemptNumber).toBe(2);
    expect(artifacts[1]!.attemptKind).toBe('repair');
    // Distinct physical attempts: neither artifact overwrote the other.
    expect(artifacts[0]!.attemptId).not.toBe(artifacts[1]!.attemptId);
    expect(artifacts[0]!.id).not.toBe(artifacts[1]!.id);
    expect(repos.telemetry.getAttempt(artifacts[0]!.attemptId)?.attemptNumber).toBe(1);
    expect(repos.telemetry.getAttempt(artifacts[1]!.attemptId)?.attemptNumber).toBe(2);
  });

  it('retains every rejected candidate when repair is exhausted', async () => {
    const provider = wrap(makeProvider(async () => jsonResponse(schemaInvalidPayload)));
    await expect(provider.analyzeConcepts(analysisInput, { telemetry })).rejects.toBeInstanceOf(
      ProviderError,
    );

    const call = db.prepare('SELECT id FROM model_logical_calls').get() as { id: string };
    const artifacts = repos.telemetry.listRejectedArtifacts(call.id);
    expect(artifacts.map((artifact) => artifact.attemptNumber)).toEqual([1, 2]);
    expect(artifacts.at(-1)!.repairExhausted).toBe(true);
  });

  it('retains raw response text when the candidate never parsed as JSON', async () => {
    const provider = wrap(makeProvider(async () => jsonResponse('这不是 JSON')));
    await expect(provider.analyzeConcepts(analysisInput, { telemetry })).rejects.toBeInstanceOf(
      ProviderError,
    );

    const call = db.prepare('SELECT id FROM model_logical_calls').get() as { id: string };
    const artifact = repos.telemetry.listRejectedArtifacts(call.id)[0];
    expect(artifact?.candidate.representation).toBe('text');
    expect(artifact?.candidate.body).toBe('这不是 JSON');
  });

  // Test E: capture failure must not alter the original outcome.
  it('leaves the original failure unchanged when artifact persistence throws', async () => {
    const signals: RejectedArtifactCaptureFailureSignal[] = [];
    const provider = wrap(
      makeProvider(async () => jsonResponse(schemaInvalidPayload)),
      (signal) => void signals.push(signal),
    );
    const captureError = new Error('artifact persistence is broken');
    let captureAttempts = 0;
    repos.telemetry.insertRejectedArtifact = () => {
      captureAttempts += 1;
      throw captureError;
    };

    const failure = await provider
      .analyzeConcepts(analysisInput, { telemetry })
      .catch((error: unknown) => error);

    expect(captureAttempts).toBeGreaterThan(0);
    // The user-visible root failure is still the provider's own classification.
    expect(failure).toBeInstanceOf(ProviderError);
    expect(failure).not.toBe(captureError);
    expect((failure as ProviderError).message).not.toContain('artifact persistence is broken');
    // Attempt accounting is unchanged: two bounded attempts, no artifacts.
    expect(db.prepare('SELECT COUNT(*) AS n FROM model_call_attempts').get()).toEqual({ n: 2 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM rejected_generation_artifacts').get()).toEqual({
      n: 0,
    });

    // N2: the loss is no longer silent — one signal per lost artifact.
    expect(signals).toHaveLength(captureAttempts);
    expect(signals.map((signal) => signal.failure)).toEqual([
      'persistence_error',
      'persistence_error',
    ]);
    const call = db.prepare('SELECT id FROM model_logical_calls').get() as { id: string };
    for (const signal of signals) {
      expect(signal.event).toBe('rejected_artifact_capture_failed');
      expect(signal.logicalCallId).toBe(call.id);
      expect(repos.telemetry.getAttempt(signal.attemptId)?.logicalCallId).toBe(call.id);
      expect(signal.operationKind).toBe('analyze_concepts');
    }
    expect(signals.map((signal) => signal.attemptKind)).toEqual(['original', 'repair']);

    // The signal is content-free: nothing sensitive can ride along.
    const emitted = JSON.stringify(signals);
    expect(emitted).not.toContain(LEARNER_TEXT);
    expect(emitted).not.toContain('工作记忆');
    expect(emitted).not.toContain('记忆导论');
    expect(emitted).not.toContain('test-key-should-never-leak');
    expect(emitted).not.toContain('example.test');
    expect(emitted).not.toContain('artifact persistence is broken');
    for (const forbidden of ['candidate', 'findings', 'raw', 'payload', 'body', 'authorization']) {
      expect(emitted.toLowerCase()).not.toContain(forbidden);
    }
    // The permitted field set is exactly the documented one.
    for (const signal of signals) {
      expect(Object.keys(signal).sort()).toEqual([
        'attemptId',
        'attemptKind',
        'event',
        'failure',
        'logicalCallId',
        'operationKind',
      ]);
    }
  });

  it('leaves a successful operation unchanged when capture throws mid-repair', async () => {
    let calls = 0;
    const signals: RejectedArtifactCaptureFailureSignal[] = [];
    const provider = wrap(
      makeProvider(async () => {
        calls += 1;
        return jsonResponse(calls === 1 ? schemaInvalidPayload : validPayload);
      }),
      (signal) => void signals.push(signal),
    );
    repos.telemetry.insertRejectedArtifact = () => {
      throw new Error('artifact persistence is broken');
    };

    const result = await provider.analyzeConcepts(analysisInput, { telemetry });
    expect(result.concepts).toHaveLength(1);
    expect(db.prepare(`SELECT status FROM model_logical_calls`).get()).toEqual({
      status: 'completed',
    });
    // A successful operation still reports the capture loss it silently absorbed.
    expect(signals.map((signal) => signal.failure)).toEqual(['persistence_error']);
  });

  it('does not change repair accounting relative to capture being unavailable', async () => {
    const attemptsFor = async (capture: boolean): Promise<number> => {
      const localDb = openDatabase(':memory:');
      migrate(localDb);
      const localRepos = createRepositories(localDb);
      localRepos.workspaces.insert(makeWorkspace());
      if (!capture) {
        localRepos.telemetry.insertRejectedArtifact = () => undefined;
      }
      const provider = createTelemetryProvider({
        repos: localRepos,
        clock: fixedClock(T0),
        provider: makeProvider(async () => jsonResponse(schemaInvalidPayload)),
        providerGeneration: () => 1,
        // Signalling capture loss must not change attempt accounting either.
        onRejectedArtifactCaptureFailure: () => undefined,
      });
      await provider.analyzeConcepts(analysisInput, { telemetry }).catch(() => undefined);
      const { n } = localDb.prepare('SELECT COUNT(*) AS n FROM model_call_attempts').get() as {
        n: number;
      };
      localDb.close();
      return n;
    };

    expect(await attemptsFor(true)).toBe(await attemptsFor(false));
  });

  it('keeps learner text in Tier 1 only and never in the outward-facing error', async () => {
    const provider = wrap(makeProvider(async () => jsonResponse(schemaInvalidPayload)));
    const failure = await provider
      .analyzeConcepts(analysisInput, { telemetry })
      .catch((error: unknown) => error as ProviderError);

    const call = db.prepare('SELECT id FROM model_logical_calls').get() as { id: string };
    const artifact = repos.telemetry.listRejectedArtifacts(call.id)[0]!;
    expect(artifact.candidate.body).toContain(LEARNER_TEXT);
    expect(JSON.stringify(failure.details ?? {})).not.toContain(LEARNER_TEXT);
    expect(failure.message).not.toContain('test-key-should-never-leak');
    // No credential or endpoint material is ever retained.
    const retained = JSON.stringify(artifact);
    expect(retained).not.toContain('test-key-should-never-leak');
    expect(retained).not.toContain('example.test');
  });

  // N2 acceptance: with no sink configured, production is still not silent.
  it('emits a content-free structured warning through the default sink', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // No explicit sink: this is exactly how the three production call sites wire it.
      const provider = wrap(makeProvider(async () => jsonResponse(schemaInvalidPayload)));
      repos.telemetry.insertRejectedArtifact = () => {
        throw new Error('artifact persistence is broken');
      };
      await expect(provider.analyzeConcepts(analysisInput, { telemetry })).rejects.toBeInstanceOf(
        ProviderError,
      );

      expect(warn).toHaveBeenCalledTimes(2);
      const lines = warn.mock.calls.map((call) => String(call[0]));
      for (const line of lines) {
        // One machine-readable line, not free prose.
        const parsed = JSON.parse(line) as RejectedArtifactCaptureFailureSignal;
        expect(parsed.event).toBe('rejected_artifact_capture_failed');
        expect(parsed.failure).toBe('persistence_error');
        expect(warn.mock.calls[0]).toHaveLength(1);
      }
      const emitted = lines.join('\n');
      expect(emitted).not.toContain(LEARNER_TEXT);
      expect(emitted).not.toContain('test-key-should-never-leak');
      expect(emitted).not.toContain('artifact persistence is broken');
    } finally {
      warn.mockRestore();
    }
  });

  // N2: a row silently suppressed by UNIQUE (attempt_id) is still reported.
  it('signals duplicate suppression when no artifact row is written', async () => {
    const signals: RejectedArtifactCaptureFailureSignal[] = [];
    const provider = wrap(
      makeProvider(async () => jsonResponse(schemaInvalidPayload)),
      (signal) => void signals.push(signal),
    );
    // Nothing throws; the insert simply reports that it retained nothing.
    repos.telemetry.insertRejectedArtifact = () => undefined;

    await expect(provider.analyzeConcepts(analysisInput, { telemetry })).rejects.toBeInstanceOf(
      ProviderError,
    );

    expect(signals.map((signal) => signal.failure)).toEqual([
      'duplicate_suppressed',
      'duplicate_suppressed',
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM model_call_attempts').get()).toEqual({ n: 2 });
  });

  it('signals observer failure without disturbing retention or the operation', async () => {
    const signals: RejectedArtifactCaptureFailureSignal[] = [];
    let calls = 0;
    const provider = wrap(
      makeProvider(async () => {
        calls += 1;
        return jsonResponse(calls === 1 ? schemaInvalidPayload : validPayload);
      }),
      (signal) => void signals.push(signal),
    );

    const result = await provider.analyzeConcepts(analysisInput, {
      telemetry,
      onRejectedCandidate: () => {
        throw new Error('downstream observer is broken');
      },
    });

    // The operation still succeeded and the artifact was still retained.
    expect(result.concepts).toHaveLength(1);
    const call = db.prepare('SELECT id FROM model_logical_calls').get() as { id: string };
    expect(repos.telemetry.listRejectedArtifacts(call.id)).toHaveLength(1);
    expect(signals.map((signal) => signal.failure)).toEqual(['observer_error']);
    expect(JSON.stringify(signals)).not.toContain('downstream observer is broken');
  });

  it('keeps the operation intact when the capture-failure sink itself throws', async () => {
    const provider = wrap(
      makeProvider(async () => jsonResponse(schemaInvalidPayload)),
      () => {
        throw new Error('telemetry sink is broken');
      },
    );
    repos.telemetry.insertRejectedArtifact = () => {
      throw new Error('artifact persistence is broken');
    };

    const failure = await provider
      .analyzeConcepts(analysisInput, { telemetry })
      .catch((error: unknown) => error);

    // Observability is the outermost fail-open layer: the classification survives.
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).message).not.toContain('telemetry sink is broken');
    expect(db.prepare('SELECT COUNT(*) AS n FROM model_call_attempts').get()).toEqual({ n: 2 });
  });

  // N1: the digest identifies the physical attempt, not the logical call.
  it('fingerprints each physical attempt by its own outbound message sequence', async () => {
    const { fetchImpl, sent } = recordingFetch([schemaInvalidPayload]);
    const provider = wrap(makeProvider(fetchImpl));
    await expect(provider.analyzeConcepts(analysisInput, { telemetry })).rejects.toBeInstanceOf(
      ProviderError,
    );

    const call = db.prepare('SELECT id FROM model_logical_calls').get() as { id: string };
    const artifacts = repos.telemetry.listRejectedArtifacts(call.id);
    expect(artifacts).toHaveLength(2);
    expect(sent).toHaveLength(2);

    // The repair really did send a different sequence, so the digests must differ.
    expect(sent[1]!.length).toBeGreaterThan(sent[0]!.length);
    expect(artifacts[0]!.promptFingerprint).not.toBe(artifacts[1]!.promptFingerprint);

    // Each digest equals the oracle over the sequence that attempt actually sent.
    expect(artifacts[0]!.promptFingerprint).toBe(fingerprintOracle(sent[0]!));
    expect(artifacts[1]!.promptFingerprint).toBe(fingerprintOracle(sent[1]!));
    for (const artifact of artifacts) {
      expect(artifact.promptFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    }

    // Grouping stays with logical_call_id; the digest is not a grouping key.
    const attempts = artifacts.map((artifact) => repos.telemetry.getAttempt(artifact.attemptId));
    expect(attempts.map((attempt) => attempt?.logicalCallId)).toEqual([call.id, call.id]);
    expect(artifacts[0]!.attemptId).not.toBe(artifacts[1]!.attemptId);
  });

  it('retains no prompt text alongside the per-attempt digest', async () => {
    const { fetchImpl, sent } = recordingFetch([schemaInvalidPayload]);
    const provider = wrap(makeProvider(fetchImpl));
    await expect(provider.analyzeConcepts(analysisInput, { telemetry })).rejects.toBeInstanceOf(
      ProviderError,
    );

    // Guard the guard: the prompt genuinely carried this source prose.
    const outbound = sent[0]!.map((message) => message.content).join('\n');
    expect(outbound).toContain('工作记忆的容量十分有限。');

    const call = db.prepare('SELECT id FROM model_logical_calls').get() as { id: string };
    const row = db
      .prepare(
        `SELECT prompt_fingerprint FROM rejected_generation_artifacts
         WHERE logical_call_id = ? ORDER BY attempt_number LIMIT 1`,
      )
      .get(call.id) as { prompt_fingerprint: string };
    expect(row.prompt_fingerprint).toBe(fingerprintOracle(sent[0]!));
    // The digest column is a digest: it cannot contain the prompt it summarises.
    expect(row.prompt_fingerprint).not.toContain('工作记忆');
    expect(row.prompt_fingerprint).not.toContain('记忆导论');
  });
});
