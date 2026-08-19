import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiErrorCode } from '@hy3-clinic/shared';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { AppError } from '../errors.js';
import { ProviderError } from '../llm/errors.js';
import { FakeProvider } from '../llm/fakeProvider.js';
import type { LlmProvider, ProviderCallOptions } from '../llm/provider.js';
import { createRepositories, type Repositories } from '../repositories/index.js';
import { makeWorkspace, T0 } from '../testing/fixtures.js';
import { fixedClock } from '../util/ids.js';
import { createTelemetryProvider } from './providerTelemetry.js';

const methods = [
  'describeVisual',
  'analyzeConcepts',
  'generateQuiz',
  'gradeShortAnswer',
  'generateRemediation',
  'proposeGraphEdges',
  'proposeRemediationPlan',
  'proposeConceptAlignment',
  'proposeAssessment',
  'proposeMisconception',
  'generateConceptLesson',
  'proposeTutorStep',
  'respondToTutorTurn',
  'proposeCurriculum',
  'proposeStudyPlan',
] as const;

let db: SqliteDb;
let repos: Repositories;

function override(
  provider: LlmProvider,
  method: string,
  implementation: (...args: unknown[]) => Promise<unknown>,
): void {
  (provider as unknown as Record<string, unknown>)[method] = implementation;
}

function invoke(
  provider: LlmProvider,
  method: string,
  options: ProviderCallOptions,
): Promise<unknown> {
  const fn = (provider as unknown as Record<string, unknown>)[method] as (
    input: unknown,
    options: ProviderCallOptions,
  ) => Promise<unknown>;
  return fn({}, options);
}

describe('central provider inference telemetry', () => {
  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db);
    repos = createRepositories(db);
    repos.workspaces.insert(makeWorkspace());
  });

  afterEach(() => db.close());

  it('covers every semantic provider method and the workspace-less connection probe once', async () => {
    const raw = new FakeProvider();
    for (const method of methods) override(raw, method, async () => ({}));
    override(raw, 'testConnection', async () => undefined);
    const provider = createTelemetryProvider({
      repos,
      clock: fixedClock(T0),
      provider: raw,
      providerGeneration: () => 7,
    });

    for (const method of methods) {
      await invoke(provider, method, {
        telemetry: { workspaceId: 'ws_1', operationType: method },
      });
    }
    await provider.testConnection({
      telemetry: { workspaceId: null, operationType: 'provider_connection_test' },
    });

    expect(repos.telemetry.usageSummary('ws_1')).toMatchObject({
      logicalCalls: methods.length,
      physicalAttempts: methods.length,
      attemptsWithKnownCost: methods.length,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM model_logical_calls').get()).toEqual({
      count: methods.length + 1,
    });
    expect(
      db
        .prepare('SELECT COUNT(*) AS count FROM model_call_attempts WHERE sent_at IS NOT NULL')
        .get(),
    ).toEqual({ count: methods.length + 1 });
    expect(
      db
        .prepare(
          `SELECT workspace_id, operation_type FROM model_logical_calls
           WHERE operation_type = 'provider_connection_test'`,
        )
        .get(),
    ).toEqual({ workspace_id: null, operation_type: 'provider_connection_test' });
    const generations = db
      .prepare('SELECT DISTINCT provider_generation AS generation FROM model_call_attempts')
      .all();
    expect(generations).toEqual([{ generation: 7 }]);
  });

  it('automatically tracks future provider methods and refuses missing context before inference', async () => {
    const raw = new FakeProvider() as LlmProvider & {
      futureInference(input: unknown, options?: ProviderCallOptions): Promise<string>;
    };
    let calls = 0;
    raw.futureInference = async () => {
      calls += 1;
      return 'ok';
    };
    const provider = createTelemetryProvider({
      repos,
      clock: fixedClock(T0),
      provider: raw,
      providerGeneration: () => 3,
    }) as typeof raw;

    await expect(provider.futureInference({})).rejects.toMatchObject({
      code: ApiErrorCode.ValidationError,
    });
    expect(calls).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM model_logical_calls').get()).toEqual({
      count: 0,
    });

    await expect(
      provider.futureInference(
        {},
        {
          telemetry: { workspaceId: 'ws_1', operationType: 'future_inference' },
        },
      ),
    ).resolves.toBe('ok');
    expect(calls).toBe(1);
    expect(repos.telemetry.usageSummary('ws_1').physicalAttempts).toBe(1);
  });

  it('records repair as exactly two physical attempts in one logical call', async () => {
    const raw = new FakeProvider();
    override(raw, 'analyzeConcepts', async (...args) => {
      const options = args[1] as ProviderCallOptions;
      options.onRepairAttempt?.();
      return { concepts: [] };
    });
    const provider = createTelemetryProvider({
      repos,
      clock: fixedClock(T0),
      provider: raw,
      providerGeneration: () => 2,
    });
    await invoke(provider, 'analyzeConcepts', {
      telemetry: { workspaceId: 'ws_1', operationType: 'analyze_concepts' },
    });
    const call = db.prepare('SELECT id FROM model_logical_calls').get() as { id: string };
    expect(repos.telemetry.listAttempts(call.id)).toMatchObject([
      { attemptKind: 'original', errorCode: 'STRUCTURED_OUTPUT_REPAIR_REQUIRED' },
      { attemptKind: 'repair', status: 'completed' },
    ]);
    expect(repos.telemetry.usageSummary('ws_1').physicalAttempts).toBe(2);
  });

  it('fails closed after a repaired response is still invalid without a third attempt', async () => {
    const raw = new FakeProvider();
    override(raw, 'analyzeConcepts', async (...args) => {
      const options = args[1] as ProviderCallOptions;
      options.onRepairAttempt?.('schema', 'JSON_PARSE_FAILURE');
      throw ProviderError.invalidOutput(
        'still invalid',
        'schema',
        'SCHEMA_VALIDATION_FAILURE',
        true,
      );
    });
    const provider = createTelemetryProvider({
      repos,
      clock: fixedClock(T0),
      provider: raw,
      providerGeneration: () => 1,
    });
    await expect(
      invoke(provider, 'analyzeConcepts', {
        telemetry: { workspaceId: 'ws_1', operationType: 'analyze_concepts' },
      }),
    ).rejects.toMatchObject({ code: ApiErrorCode.ProviderInvalidOutput });
    const call = db.prepare('SELECT id, status FROM model_logical_calls').get() as {
      id: string;
      status: string;
    };
    expect(call.status).toBe('failed');
    expect(repos.telemetry.listAttempts(call.id)).toMatchObject([
      {
        attemptKind: 'original',
        status: 'completed',
        errorCode: 'JSON_PARSE_FAILURE_REPAIR_REQUIRED',
      },
      {
        attemptKind: 'repair',
        status: 'failed',
        errorCode: 'REPAIR_EXHAUSTED:SCHEMA_VALIDATION_FAILURE',
      },
    ]);
  });

  it('persists reported usage while leaving unreported cost unknown', async () => {
    const raw = new FakeProvider();
    override(raw, 'analyzeConcepts', async (...args) => {
      const options = args[1] as ProviderCallOptions;
      options.onUsage?.({
        inputTokens: 21,
        outputTokens: 8,
        reasoningTokens: 3,
        cacheReadTokens: 5,
        cacheWriteTokens: null,
        estimatedCostMicrounits: null,
        currency: null,
        pricingSource: null,
        pricingVersion: null,
      });
      return { concepts: [] };
    });
    const provider = createTelemetryProvider({
      repos,
      clock: fixedClock(T0),
      provider: raw,
      providerGeneration: () => 1,
    });
    await invoke(provider, 'analyzeConcepts', {
      telemetry: { workspaceId: 'ws_1', operationType: 'analyze_concepts' },
    });
    const attempt = db.prepare('SELECT id FROM model_call_attempts').get() as { id: string };
    expect(repos.telemetry.getUsageByAttempt(attempt.id)).toMatchObject({
      inputTokens: 21,
      outputTokens: 8,
      reasoningTokens: 3,
      cacheReadTokens: 5,
      estimatedCostMicrounits: null,
      currency: null,
    });
  });

  it('enforces applicable workspace cost policy before sending', async () => {
    repos.telemetry.upsertCostPolicy({
      id: 'policy_1',
      policyKey: 'deny-analysis',
      workspaceId: 'ws_1',
      scopeType: 'operation',
      scopeKey: 'analyze_concepts',
      limitMicrounits: 0,
      currency: 'USD',
      onExceed: 'refuse',
      enabled: true,
      createdAt: T0,
      updatedAt: T0,
    });
    const provider = createTelemetryProvider({
      repos,
      clock: fixedClock(T0),
      provider: new FakeProvider(),
      providerGeneration: () => 1,
    });
    await expect(
      provider.analyzeConcepts(
        { materialTitle: 'Course', blocks: [] },
        { telemetry: { workspaceId: 'ws_1', operationType: 'analyze_concepts' } },
      ),
    ).rejects.toThrow('does not permit another provider operation');
    expect(db.prepare('SELECT COUNT(*) AS count FROM model_call_attempts').get()).toEqual({
      count: 0,
    });
  });

  it.each([
    ['invalid output', ProviderError.invalidOutput('bad'), ApiErrorCode.ProviderInvalidOutput],
    ['timeout', ProviderError.timeout(10), ApiErrorCode.ProviderTimeout],
    ['cancellation', ProviderError.cancelled(), ApiErrorCode.RequestCancelled],
  ])('normalizes %s accounting', async (_label, failure, code) => {
    const raw = new FakeProvider();
    override(raw, 'analyzeConcepts', async () => {
      throw failure;
    });
    const provider = createTelemetryProvider({
      repos,
      clock: fixedClock(T0),
      provider: raw,
      providerGeneration: () => 1,
    });
    await expect(
      invoke(provider, 'analyzeConcepts', {
        telemetry: { workspaceId: 'ws_1', operationType: 'analyze_concepts' },
      }),
    ).rejects.toThrow();
    const attempt = db.prepare('SELECT status, error_code FROM model_call_attempts').get() as {
      status: string;
      error_code: string;
    };
    expect(attempt.error_code).toBe(code);
    expect(attempt.status).toBe(code === ApiErrorCode.RequestCancelled ? 'cancelled' : 'failed');
  });

  it('records one sent real timeout attempt without inventing a usage row or retry', async () => {
    class TimedOutHy3Provider extends FakeProvider {
      override readonly name = 'hy3' as const;
      override readonly model = 'hy3-test';

      override async analyzeConcepts(
        _input: Parameters<LlmProvider['analyzeConcepts']>[0],
        options?: ProviderCallOptions,
      ) {
        options?.onRequestSent?.();
        throw ProviderError.timeout(240_000);
      }
    }
    const provider = createTelemetryProvider({
      repos,
      clock: fixedClock(T0),
      provider: new TimedOutHy3Provider(),
      providerGeneration: () => 4,
    });

    await expect(
      provider.analyzeConcepts(
        { materialTitle: 'Course', blocks: [] },
        { telemetry: { workspaceId: 'ws_1', operationType: 'propose_curriculum' } },
      ),
    ).rejects.toMatchObject({ code: ApiErrorCode.ProviderTimeout });

    const call = db.prepare('SELECT id, status FROM model_logical_calls').get() as {
      id: string;
      status: string;
    };
    expect(call.status).toBe('failed');
    expect(repos.telemetry.listAttempts(call.id)).toMatchObject([
      {
        attemptNumber: 1,
        attemptKind: 'original',
        providerGeneration: 4,
        status: 'failed',
        errorCode: ApiErrorCode.ProviderTimeout,
      },
    ]);
    expect(db.prepare('SELECT COUNT(*) count FROM model_usage_records').get()).toEqual({
      count: 0,
    });
  });

  it('does not count a pre-aborted request as physically sent', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = createTelemetryProvider({
      repos,
      clock: fixedClock(T0),
      provider: new FakeProvider(),
      providerGeneration: () => 1,
    });
    await expect(
      provider.analyzeConcepts(
        { materialTitle: 'Course', blocks: [] },
        {
          signal: controller.signal,
          telemetry: { workspaceId: 'ws_1', operationType: 'analyze_concepts' },
        },
      ),
    ).rejects.toMatchObject({ code: ApiErrorCode.RequestCancelled });
    expect(repos.telemetry.usageSummary('ws_1').physicalAttempts).toBe(0);
    expect(db.prepare('SELECT sent_at FROM model_call_attempts').get()).toEqual({ sent_at: null });
  });

  it('fences stale completion before success accounting', async () => {
    const raw = new FakeProvider();
    override(raw, 'analyzeConcepts', async () => ({ concepts: [] }));
    const provider = createTelemetryProvider({
      repos,
      clock: fixedClock(T0),
      provider: raw,
      providerGeneration: () => 1,
    });
    await expect(
      invoke(provider, 'analyzeConcepts', {
        beforeTelemetryComplete: () => {
          throw new AppError(ApiErrorCode.VersionConflict, 'stale worker');
        },
        telemetry: { workspaceId: 'ws_1', operationType: 'analyze_concepts' },
      }),
    ).rejects.toMatchObject({ code: ApiErrorCode.VersionConflict });
    expect(db.prepare('SELECT status, error_code FROM model_call_attempts').get()).toEqual({
      status: 'outcome_unknown',
      error_code: 'OPERATION_LEASE_LOST',
    });
    expect(db.prepare('SELECT status FROM model_logical_calls').get()).toEqual({
      status: 'failed',
    });
  });

  it('stores no raw unknown error, prompt, or credential text', async () => {
    const raw = new FakeProvider();
    override(raw, 'analyzeConcepts', async () => {
      throw new Error('SECRET_KEY prompt body private source text');
    });
    const provider = createTelemetryProvider({
      repos,
      clock: fixedClock(T0),
      provider: raw,
      providerGeneration: () => 1,
    });
    await expect(
      invoke(provider, 'analyzeConcepts', {
        telemetry: { workspaceId: 'ws_1', operationType: 'analyze_concepts' },
      }),
    ).rejects.toThrow('SECRET_KEY');
    const stored = JSON.stringify(
      db.prepare('SELECT * FROM model_logical_calls, model_call_attempts').get(),
    );
    expect(stored).not.toContain('SECRET_KEY');
    expect(stored).not.toContain('private source text');
    expect(stored).toContain('Provider call failed.');
  });
});
