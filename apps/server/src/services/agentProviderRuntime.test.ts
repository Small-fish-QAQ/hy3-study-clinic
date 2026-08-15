import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../repositories/index.js';
import type { CostPolicy } from '../repositories/telemetry.js';
import { FakeProvider } from '../llm/fakeProvider.js';
import { makeWorkspace, T0 } from '../testing/fixtures.js';
import { fixedClock } from '../util/ids.js';
import {
  enforceAgentCostPolicies,
  runTrackedAgentProviderOperation,
} from './agentProviderRuntime.js';
import { createTelemetryProvider } from './providerTelemetry.js';

let db: SqliteDb;
let repos: Repositories;

function policy(overrides: Partial<CostPolicy> = {}): CostPolicy {
  return {
    id: 'cost_policy_1',
    policyKey: 'test-policy',
    workspaceId: 'ws_1',
    scopeType: 'operation',
    scopeKey: 'propose_curriculum',
    limitMicrounits: 10,
    currency: 'USD',
    onExceed: 'refuse',
    enabled: true,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function recordCall(input: {
  id: string;
  operationType: string;
  studySessionId?: string | null;
  createdAt?: string;
  costMicrounits: number | null;
}): void {
  const createdAt = input.createdAt ?? T0;
  const attemptId = `attempt_${input.id}`;
  repos.telemetry.insertLogicalCall({
    id: input.id,
    operationId: null,
    workspaceId: 'ws_1',
    studySessionId: input.studySessionId ?? null,
    learningUnitId: null,
    assessmentId: null,
    operationType: input.operationType,
    cacheKey: null,
    cacheStatus: 'not_checked',
    promptFingerprint: null,
    schemaFingerprint: null,
    policyFingerprint: null,
    sourceFingerprint: null,
    status: 'completed',
    createdAt,
    completedAt: createdAt,
  });
  repos.telemetry.insertAttempt({
    id: attemptId,
    logicalCallId: input.id,
    attemptNumber: 1,
    attemptKind: 'original',
    provider: 'fake',
    model: null,
    fencingToken: 1,
    status: 'completed',
    startedAt: createdAt,
    sentAt: createdAt,
    firstTokenAt: null,
    completedAt: createdAt,
    latencyMs: 0,
    timeToFirstTokenMs: null,
    errorCode: null,
    errorMessage: null,
  });
  repos.telemetry.insertUsage({
    id: `usage_${input.id}`,
    attemptId,
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    estimatedCostMicrounits: input.costMicrounits,
    currency: input.costMicrounits === null ? null : 'USD',
    pricingSource: input.costMicrounits === null ? null : 'test',
    pricingVersion: input.costMicrounits === null ? null : 'v1',
    recordedAt: createdAt,
  });
}

function enforce(
  input: {
    operationType?: string;
    studySessionId?: string | null;
    at?: string;
    confirmedPolicyIds?: string[];
  } = {},
) {
  return enforceAgentCostPolicies(repos, {
    workspaceId: 'ws_1',
    operationType: input.operationType ?? 'propose_curriculum',
    studySessionId: input.studySessionId ?? null,
    at: input.at ?? T0,
    confirmedPolicyIds: input.confirmedPolicyIds ?? [],
  });
}

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  repos = createRepositories(db);
  repos.workspaces.insert(makeWorkspace());
});

afterEach(() => db.close());

describe('Agent cost policy enforcement', () => {
  it('invents no product cap when no policy is configured', () => {
    recordCall({ id: 'call_1', operationType: 'propose_curriculum', costMicrounits: 999 });
    expect(enforce()).toBeNull();
  });

  it('isolates operation and session policies from unrelated calls', () => {
    recordCall({
      id: 'call_curriculum',
      operationType: 'propose_curriculum',
      studySessionId: 'session_1',
      costMicrounits: 4,
    });
    recordCall({
      id: 'call_plan',
      operationType: 'propose_study_plan',
      studySessionId: 'session_2',
      costMicrounits: 100,
    });
    repos.telemetry.upsertCostPolicy(policy({ limitMicrounits: 5 }));
    expect(enforce()).toMatch(/^cost_policy_/);

    repos.telemetry.upsertCostPolicy(
      policy({ scopeType: 'session', scopeKey: 'session_1', limitMicrounits: 5 }),
    );
    expect(enforce({ studySessionId: 'session_1' })).toMatch(/^cost_policy_/);
  });

  it('isolates day policy usage by UTC calendar date', () => {
    recordCall({
      id: 'call_yesterday',
      operationType: 'propose_curriculum',
      createdAt: '2025-12-31T23:59:00.000Z',
      costMicrounits: 100,
    });
    recordCall({
      id: 'call_today',
      operationType: 'propose_curriculum',
      createdAt: T0,
      costMicrounits: 4,
    });
    repos.telemetry.upsertCostPolicy(
      policy({ scopeType: 'day', scopeKey: T0.slice(0, 10), limitMicrounits: 5 }),
    );
    expect(enforce()).toMatch(/^cost_policy_/);
  });

  it('requires the configured decision when observed usage reaches the cap', () => {
    recordCall({ id: 'call_1', operationType: 'propose_curriculum', costMicrounits: 10 });
    repos.telemetry.upsertCostPolicy(policy({ onExceed: 'confirm' }));

    expect(() => enforce()).toThrow('requires explicit confirmation');
    expect(enforce({ confirmedPolicyIds: ['cost_policy_1'] })).toMatch(/^cost_policy_/);
  });

  it('does not silently treat an unknown prior provider cost as zero', () => {
    recordCall({ id: 'call_unknown', operationType: 'propose_curriculum', costMicrounits: null });
    repos.telemetry.upsertCostPolicy(policy({ limitMicrounits: 100 }));

    expect(() => enforce()).toThrow('does not permit another provider operation');
  });
});

describe('Agent provider physical-attempt telemetry', () => {
  it('records bounded structured repair as a second attempt in one logical call', async () => {
    const operation = repos.operations.createOrGet({
      id: 'op_repair',
      workspaceId: 'ws_1',
      commandId: 'repair-command',
      idempotencyKey: 'repair-key',
      logicalOperationId: 'repair-logical-operation',
      operationType: 'propose_curriculum',
      expectedFingerprint: 'expected-v1',
      createdAt: T0,
      updatedAt: T0,
    }).operation;
    const claim = repos.operations.claim(
      operation.id,
      'test-worker',
      '2026-01-01T00:05:00.000Z',
      T0,
    );
    expect(claim?.fencingToken).toBe(1);

    const rawProvider = new FakeProvider();
    rawProvider.analyzeConcepts = async (_input, options) => {
      options?.onRepairAttempt?.();
      return { concepts: [] };
    };
    const provider = createTelemetryProvider({
      repos,
      clock: fixedClock(T0),
      provider: rawProvider,
      providerGeneration: () => 3,
    });
    const result = await runTrackedAgentProviderOperation({
      repos,
      clock: fixedClock(T0),
      provider,
      providerModel: null,
      operationId: operation.id,
      fencingToken: 1,
      workspaceId: 'ws_1',
      studySessionId: null,
      learningUnitId: null,
      assessmentId: null,
      operationType: 'propose_curriculum',
      schemaFingerprint: 'curriculum-v1',
      policyFingerprint: null,
      sourceFingerprint: 'manifest-v1',
      invoke: async (options) => {
        await provider.analyzeConcepts({ materialTitle: 'Course', blocks: [] }, options);
        return 'valid';
      },
    });

    expect(result).toBe('valid');
    const row = db
      .prepare('SELECT id FROM model_logical_calls WHERE operation_id = ?')
      .get(operation.id) as { id: string };
    const attempts = repos.telemetry.listAttempts(row.id);
    expect(attempts).toMatchObject([
      {
        attemptNumber: 1,
        attemptKind: 'original',
        status: 'completed',
        errorCode: 'STRUCTURED_OUTPUT_REPAIR_REQUIRED',
      },
      { attemptNumber: 2, attemptKind: 'repair', status: 'completed', errorCode: null },
    ]);
    expect(attempts.map((attempt) => attempt.providerGeneration)).toEqual([3, 3]);
    expect(repos.telemetry.getUsageByAttempt(attempts[0]!.id)).toBeDefined();
    expect(repos.telemetry.getUsageByAttempt(attempts[1]!.id)).toBeDefined();
    expect(repos.telemetry.getLogicalCall(row.id)?.status).toBe('completed');
  });
});
