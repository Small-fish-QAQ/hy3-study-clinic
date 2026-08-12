import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { makeWorkspace, T0 } from '../testing/fixtures.js';
import { createRepositories, type Repositories } from './index.js';
import type { ModelCallAttempt, ModelLogicalCall } from './telemetry.js';

const T1 = '2026-01-01T00:01:00.000Z';
const T2 = '2026-01-01T00:02:00.000Z';

let db: SqliteDb;
let repos: Repositories;

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  repos = createRepositories(db);
  repos.workspaces.insert(makeWorkspace());
});

function createOperation(id = 'op_1') {
  return repos.operations.createOrGet({
    id,
    workspaceId: 'ws_1',
    commandId: `cmd_${id}`,
    idempotencyKey: `idem_${id}`,
    logicalOperationId: `logical_${id}`,
    operationType: 'propose_curriculum',
    expectedFingerprint: 'contract:1/source:abc',
    createdAt: T0,
    updatedAt: T0,
  });
}

function logicalCall(
  overrides: Partial<ModelLogicalCall> & Pick<ModelLogicalCall, 'id'>,
): ModelLogicalCall {
  return {
    id: overrides.id,
    operationId: 'op_1',
    workspaceId: 'ws_1',
    studySessionId: null,
    learningUnitId: null,
    assessmentId: null,
    operationType: 'propose_curriculum',
    cacheKey: null,
    cacheStatus: 'not_checked',
    promptFingerprint: 'prompt:1',
    schemaFingerprint: 'schema:1',
    policyFingerprint: 'policy:1',
    sourceFingerprint: 'source:abc',
    status: 'open',
    createdAt: T0,
    completedAt: null,
    ...overrides,
  };
}

function attempt(
  overrides: Partial<ModelCallAttempt> & Pick<ModelCallAttempt, 'id' | 'logicalCallId'>,
): ModelCallAttempt {
  return {
    id: overrides.id,
    logicalCallId: overrides.logicalCallId,
    attemptNumber: 1,
    attemptKind: 'original',
    provider: 'fake',
    model: 'fake-deterministic',
    fencingToken: 1,
    status: 'queued',
    startedAt: T0,
    sentAt: null,
    firstTokenAt: null,
    completedAt: null,
    latencyMs: null,
    timeToFirstTokenMs: null,
    errorCode: null,
    errorMessage: null,
    ...overrides,
  };
}

describe('durable agent operations repository', () => {
  it('returns one operation for an exact idempotent retry and rejects identity reuse', () => {
    const first = createOperation();
    const retry = createOperation();

    expect(first.created).toBe(true);
    expect(retry).toEqual({ operation: first.operation, created: false });
    expect(() =>
      repos.operations.createOrGet({
        ...first.operation,
        id: 'op_different',
        commandId: 'cmd_different',
        logicalOperationId: 'logical_different',
        createdAt: T1,
        updatedAt: T1,
      }),
    ).toThrow(/Idempotency key/);
  });

  it('orders events and permits exactly one terminal result from the current lease owner', () => {
    createOperation();
    const claimed = repos.operations.claim('op_1', 'worker-a', T2, T0)!;
    expect(claimed.fencingToken).toBe(1);

    expect(
      repos.operations.appendEvent(
        { id: 'opevt_1', operationId: 'op_1', kind: 'started', payload: {}, createdAt: T0 },
        'worker-a',
        1,
      )?.seq,
    ).toBe(0);
    expect(
      repos.operations.appendEvent(
        {
          id: 'opevt_2',
          operationId: 'op_1',
          kind: 'validated',
          payload: { accepted: 3 },
          createdAt: T1,
        },
        'worker-a',
        1,
      )?.seq,
    ).toBe(1);
    expect(repos.operations.renewLease('op_1', 'worker-stale', 1, T2, T1)).toBe(false);
    expect(
      repos.operations.finalize(
        { operationId: 'op_1', status: 'completed', payload: {}, createdAt: T1 },
        'worker-stale',
        1,
      ),
    ).toBe(false);
    expect(
      repos.operations.finalize(
        {
          operationId: 'op_1',
          status: 'completed',
          payload: { curriculumId: 'cur_1' },
          createdAt: T1,
        },
        'worker-a',
        1,
      ),
    ).toBe(true);
    expect(
      repos.operations.finalize(
        { operationId: 'op_1', status: 'failed', payload: {}, createdAt: T2 },
        'worker-a',
        1,
      ),
    ).toBe(false);

    expect(repos.operations.get('op_1')?.status).toBe('completed');
    expect(repos.operations.getResult('op_1')).toMatchObject({
      operationId: 'op_1',
      fencingToken: 1,
      payload: { curriculumId: 'cur_1' },
    });
    expect(repos.operations.listEvents('op_1').map((event) => event.seq)).toEqual([0, 1]);
  });

  it('accounts for orphaned provider sends and fences a late worker after takeover', () => {
    createOperation();
    repos.operations.claim('op_1', 'worker-old', T1, T0);
    repos.telemetry.insertLogicalCall(logicalCall({ id: 'call_queued' }));
    repos.telemetry.insertAttempt(attempt({ id: 'attempt_queued', logicalCallId: 'call_queued' }));
    repos.telemetry.insertLogicalCall(logicalCall({ id: 'call_sent' }));
    repos.telemetry.insertAttempt(attempt({ id: 'attempt_sent', logicalCallId: 'call_sent' }));
    repos.telemetry.markAttemptSent('attempt_sent', T0);

    expect(repos.operations.recoverExpired(T2)).toBe(1);
    expect(repos.operations.get('op_1')).toMatchObject({
      status: 'interrupted',
      fencingToken: 1,
      leaseOwner: null,
    });
    expect(repos.telemetry.getAttempt('attempt_queued')).toMatchObject({
      status: 'interrupted',
      errorCode: 'PROCESS_ORPHANED',
    });
    expect(repos.telemetry.getAttempt('attempt_sent')).toMatchObject({
      status: 'outcome_unknown',
      errorCode: 'PROCESS_ORPHANED',
    });

    const replacement = repos.operations.claim(
      'op_1',
      'worker-new',
      '2026-01-01T00:05:00.000Z',
      T2,
    )!;
    expect(replacement.fencingToken).toBe(2);
    expect(
      repos.operations.appendEvent(
        { id: 'opevt_late', operationId: 'op_1', kind: 'late', payload: {}, createdAt: T2 },
        'worker-old',
        1,
      ),
    ).toBeUndefined();
    expect(
      repos.operations.finalize(
        { operationId: 'op_1', status: 'completed', payload: {}, createdAt: T2 },
        'worker-old',
        1,
      ),
    ).toBe(false);
    const resumedEvent = repos.operations.appendEvent(
      { id: 'opevt_new', operationId: 'op_1', kind: 'resumed', payload: {}, createdAt: T2 },
      'worker-new',
      2,
    );
    expect(resumedEvent?.seq).toBe(1);
  });

  it('rejects append, renewal, and finalization after lease expiry before recovery runs', () => {
    createOperation();
    repos.operations.claim('op_1', 'worker-old', T1, T0);

    expect(
      repos.operations.renewLease('op_1', 'worker-old', 1, '2026-01-01T00:03:00.000Z', T2),
    ).toBe(false);
    expect(
      repos.operations.appendEvent(
        { id: 'opevt_expired', operationId: 'op_1', kind: 'late', payload: {}, createdAt: T2 },
        'worker-old',
        1,
      ),
    ).toBeUndefined();
    expect(
      repos.operations.finalize(
        { operationId: 'op_1', status: 'completed', payload: {}, createdAt: T2 },
        'worker-old',
        1,
      ),
    ).toBe(false);
    expect(repos.operations.get('op_1')?.status).toBe('running');
    expect(repos.operations.getResult('op_1')).toBeUndefined();
  });

  it('recovers an expired lease only after exact operation identity matches', () => {
    const first = createOperation();
    repos.operations.claim('op_1', 'worker-old', T1, T0);

    expect(() =>
      repos.operations.createOrGet({
        ...first.operation,
        id: 'op_changed',
        expectedFingerprint: 'contract:2/source:changed',
        createdAt: T2,
        updatedAt: T2,
      }),
    ).toThrow(/Idempotency key/);
    expect(repos.operations.get('op_1')).toMatchObject({
      status: 'running',
      leaseOwner: 'worker-old',
      fencingToken: 1,
    });
    expect(repos.operations.listEvents('op_1')).toEqual([]);

    const retry = repos.operations.createOrGet({
      ...first.operation,
      id: 'op_retry',
      createdAt: T2,
      updatedAt: T2,
    });
    expect(retry).toMatchObject({
      created: false,
      operation: {
        id: 'op_1',
        status: 'interrupted',
        leaseOwner: null,
        fencingToken: 1,
      },
    });
    expect(repos.operations.listEvents('op_1')).toMatchObject([
      { kind: 'operation_interrupted', payload: { reason: 'lease_expired' }, fencingToken: 1 },
    ]);
  });

  it('interrupts every prior-process running operation at startup even before lease expiry', () => {
    createOperation();
    repos.operations.claim('op_1', 'previous-process', T2, T0);

    expect(repos.operations.recoverRunningAfterRestart(T1)).toBe(1);
    expect(repos.operations.get('op_1')).toMatchObject({
      status: 'interrupted',
      leaseOwner: null,
      fencingToken: 1,
    });
  });
});

describe('model-call telemetry, cache, and cost policy repository', () => {
  it('records retries as separate physical attempts and aggregates every attempt usage', () => {
    createOperation();
    repos.telemetry.insertLogicalCall(logicalCall({ id: 'call_1' }));
    repos.telemetry.insertAttempt(attempt({ id: 'attempt_1', logicalCallId: 'call_1' }));
    repos.telemetry.markAttemptSent('attempt_1', T0);
    repos.telemetry.finishAttempt('attempt_1', {
      status: 'failed',
      completedAt: T1,
      latencyMs: 100,
      errorCode: 'INVALID_SCHEMA',
    });
    repos.telemetry.insertUsage({
      id: 'usage_1',
      attemptId: 'attempt_1',
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: null,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostMicrounits: 120,
      currency: 'USD',
      pricingSource: 'test',
      pricingVersion: 'v1',
      recordedAt: T1,
    });

    repos.telemetry.insertAttempt(
      attempt({
        id: 'attempt_2',
        logicalCallId: 'call_1',
        attemptNumber: 2,
        attemptKind: 'repair',
        startedAt: T1,
      }),
    );
    repos.telemetry.markAttemptSent('attempt_2', T1);
    repos.telemetry.finishAttempt('attempt_2', {
      status: 'completed',
      completedAt: T2,
      latencyMs: 80,
    });
    repos.telemetry.insertUsage({
      id: 'usage_2',
      attemptId: 'attempt_2',
      inputTokens: 110,
      outputTokens: 30,
      reasoningTokens: 5,
      cacheReadTokens: 10,
      cacheWriteTokens: 0,
      estimatedCostMicrounits: 150,
      currency: 'USD',
      pricingSource: 'test',
      pricingVersion: 'v1',
      recordedAt: T2,
    });
    repos.telemetry.completeLogicalCall('call_1', 'completed', T2);

    expect(repos.telemetry.listAttempts('call_1').map((item) => item.attemptNumber)).toEqual([
      1, 2,
    ]);
    expect(repos.telemetry.getAttempt('attempt_2')?.fencingToken).toBe(1);
    expect(repos.telemetry.usageSummary('ws_1')).toEqual({
      logicalCalls: 1,
      physicalAttempts: 2,
      cacheHits: 0,
      inputTokens: 210,
      outputTokens: 50,
      reasoningTokens: 5,
      estimatedCostMicrounits: 270,
      attemptsWithKnownCost: 2,
    });
  });

  it('uses only matching valid cache entries and never overwrites a key collision', () => {
    expect(
      repos.telemetry.putCache({
        cacheKey: 'cache_1',
        operationType: 'propose_curriculum',
        workspaceId: 'ws_1',
        result: { curriculumId: 'cur_1' },
        provider: 'fake',
        model: 'fake-deterministic',
        promptFingerprint: 'prompt:1',
        schemaFingerprint: 'schema:1',
        policyFingerprint: 'policy:1',
        sourceFingerprint: 'source:abc',
        validationFingerprint: 'validation:1',
        createdAt: T0,
        expiresAt: '2026-01-02T00:00:00.000Z',
        invalidatedAt: null,
      }),
    ).toBe(true);
    expect(repos.telemetry.getCache('cache_1', 'wrong-validation', T1)).toBeUndefined();
    expect(repos.telemetry.getCache('cache_1', 'validation:1', T1)).toMatchObject({
      result: { curriculumId: 'cur_1' },
      hitCount: 1,
    });
    expect(() =>
      repos.telemetry.putCache({
        cacheKey: 'cache_1',
        operationType: 'propose_curriculum',
        workspaceId: 'ws_1',
        result: { curriculumId: 'cur_changed' },
        provider: 'fake',
        model: 'fake-deterministic',
        promptFingerprint: 'prompt:1',
        schemaFingerprint: 'schema:1',
        policyFingerprint: 'policy:1',
        sourceFingerprint: 'source:abc',
        validationFingerprint: 'validation:1',
        createdAt: T0,
        expiresAt: null,
        invalidatedAt: null,
      }),
    ).toThrow(/Cache key collision/);
    expect(repos.telemetry.invalidateCache('cache_1', T2)).toBe(true);
    expect(repos.telemetry.getCache('cache_1', 'validation:1', T2)).toBeUndefined();
  });

  it('represents no cap by absence and persists an explicitly configured policy', () => {
    expect(repos.telemetry.listEnabledCostPolicies('ws_1')).toEqual([]);
    expect(repos.telemetry.getCostPolicy('course:ws_1')).toBeUndefined();

    repos.telemetry.upsertCostPolicy({
      id: 'cost_1',
      policyKey: 'course:ws_1',
      workspaceId: 'ws_1',
      scopeType: 'course',
      scopeKey: 'ws_1',
      limitMicrounits: 5_000_000,
      currency: 'USD',
      onExceed: 'confirm',
      enabled: true,
      createdAt: T0,
      updatedAt: T0,
    });

    expect(repos.telemetry.getCostPolicy('course:ws_1')).toMatchObject({
      limitMicrounits: 5_000_000,
      onExceed: 'confirm',
      enabled: true,
    });
    expect(repos.telemetry.listEnabledCostPolicies('ws_1')).toHaveLength(1);
  });
});
