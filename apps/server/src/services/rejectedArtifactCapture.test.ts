import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { createTelemetryProvider } from './providerTelemetry.js';

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

function wrap(raw: Hy3Provider) {
  return createTelemetryProvider({
    repos,
    clock: fixedClock(T0),
    provider: raw,
    providerGeneration: () => 1,
  });
}

const telemetry = { workspaceId: 'ws_1', operationType: 'analyze_concepts' } as const;

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
    const provider = wrap(makeProvider(async () => jsonResponse(schemaInvalidPayload)));
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
  });

  it('leaves a successful operation unchanged when capture throws mid-repair', async () => {
    let calls = 0;
    const provider = wrap(
      makeProvider(async () => {
        calls += 1;
        return jsonResponse(calls === 1 ? schemaInvalidPayload : validPayload);
      }),
    );
    repos.telemetry.insertRejectedArtifact = () => {
      throw new Error('artifact persistence is broken');
    };

    const result = await provider.analyzeConcepts(analysisInput, { telemetry });
    expect(result.concepts).toHaveLength(1);
    expect(db.prepare(`SELECT status FROM model_logical_calls`).get()).toEqual({
      status: 'completed',
    });
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
});
