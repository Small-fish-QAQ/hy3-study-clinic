import { ApiErrorCode, fnv1a32 } from '@hy3-clinic/shared';
import { AppError } from '../errors.js';
import { ProviderError } from '../llm/errors.js';
import type { LlmProvider, ProviderCallOptions } from '../llm/provider.js';
import type { CostPolicy } from '../repositories/telemetry.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';

interface CostPolicyContext {
  workspaceId: string;
  operationType: string;
  studySessionId: string | null;
  at: string;
  confirmedPolicyIds: string[];
}

function concreteScopeKey(policy: CostPolicy, context: CostPolicyContext): string | null {
  const today = context.at.slice(0, 10);
  switch (policy.scopeType) {
    case 'course':
      return policy.scopeKey === '*' || policy.scopeKey === context.workspaceId
        ? context.workspaceId
        : null;
    case 'operation':
      return policy.scopeKey === '*' || policy.scopeKey === context.operationType
        ? context.operationType
        : null;
    case 'session':
      return context.studySessionId &&
        (policy.scopeKey === '*' || policy.scopeKey === context.studySessionId)
        ? context.studySessionId
        : null;
    case 'day':
      return policy.scopeKey === '*' || policy.scopeKey === today ? today : null;
  }
}

/**
 * Enforce only explicitly configured policies against usage in their exact
 * scope. Absence of a policy is the no-cap default.
 */
export function enforceAgentCostPolicies(
  repos: Repositories,
  context: CostPolicyContext,
): string | null {
  const policies = repos.telemetry.listEnabledCostPolicies(context.workspaceId);
  if (policies.length === 0) return null;
  const applicable = policies.flatMap((policy) => {
    const scopeKey = concreteScopeKey(policy, context);
    return scopeKey ? [{ policy, scopeKey }] : [];
  });
  for (const { policy, scopeKey } of applicable) {
    const usage = repos.telemetry.usageSummaryForScope(context.workspaceId, {
      scopeType: policy.scopeType,
      scopeKey,
    });
    const hasUnknownAttemptCost = usage.physicalAttempts > usage.attemptsWithKnownCost;
    if (usage.estimatedCostMicrounits < policy.limitMicrounits && !hasUnknownAttemptCost) {
      continue;
    }
    const confirmed = context.confirmedPolicyIds.includes(policy.id);
    if (
      confirmed &&
      (policy.onExceed === 'confirm' || policy.onExceed === 'lower_cost_or_confirm')
    ) {
      continue;
    }
    const requiresConfirmation =
      policy.onExceed === 'confirm' || policy.onExceed === 'lower_cost_or_confirm';
    throw new AppError(
      ApiErrorCode.ValidationError,
      requiresConfirmation
        ? hasUnknownAttemptCost
          ? 'The configured cost policy requires explicit confirmation because prior provider cost is unknown.'
          : 'The configured cost policy requires explicit confirmation before this provider operation.'
        : policy.onExceed === 'cache_only'
          ? 'The configured cost policy permits only a validated cache result; none is available for this operation.'
          : 'The configured cost policy does not permit another provider operation.',
      {
        policyId: policy.id,
        scopeType: policy.scopeType,
        scopeKey,
        onExceed: policy.onExceed,
        limitMicrounits: policy.limitMicrounits,
        observedMicrounits: usage.estimatedCostMicrounits,
        attemptsWithKnownCost: usage.attemptsWithKnownCost,
        physicalAttempts: usage.physicalAttempts,
        costKnowledge: hasUnknownAttemptCost ? 'incomplete' : 'complete',
      },
    );
  }
  if (applicable.length === 0) return null;
  const identity = applicable.map(({ policy, scopeKey }) => ({
    id: policy.id,
    updatedAt: policy.updatedAt,
    scopeKey,
  }));
  return `cost_policy_${fnv1a32(JSON.stringify(identity)).toString(16).padStart(8, '0')}`;
}

interface TrackedProviderOperation<T> {
  repos: Repositories;
  clock: Clock;
  provider: LlmProvider;
  providerModel: string | null;
  operationId: string;
  fencingToken: number;
  workspaceId: string;
  studySessionId: string | null;
  learningUnitId: string | null;
  assessmentId: string | null;
  operationType: string;
  schemaFingerprint: string;
  policyFingerprint: string | null;
  sourceFingerprint: string | null;
  providerOptions?: ProviderCallOptions | undefined;
  invoke: (options?: ProviderCallOptions) => Promise<T>;
}

/** Record one provider-interface attempt. Unknown provider usage remains NULL. */
export async function runTrackedAgentProviderOperation<T>({
  repos,
  clock,
  provider,
  providerModel,
  operationId,
  fencingToken,
  workspaceId,
  studySessionId,
  learningUnitId,
  assessmentId,
  operationType,
  schemaFingerprint,
  policyFingerprint,
  sourceFingerprint,
  providerOptions,
  invoke,
}: TrackedProviderOperation<T>): Promise<T> {
  const logicalCallId = newId('llm_call');
  let attemptId = newId('llm_attempt');
  let attemptNumber = 1;
  const startedAt = clock.now().toISOString();
  let attemptStartedAt = startedAt;
  repos.telemetry.insertLogicalCall({
    id: logicalCallId,
    operationId,
    workspaceId,
    studySessionId,
    learningUnitId,
    assessmentId,
    operationType,
    cacheKey: null,
    cacheStatus: 'not_checked',
    promptFingerprint: null,
    schemaFingerprint,
    policyFingerprint,
    sourceFingerprint,
    status: 'open',
    createdAt: startedAt,
    completedAt: null,
  });
  repos.telemetry.insertAttempt({
    id: attemptId,
    logicalCallId,
    attemptNumber: 1,
    attemptKind: 'original',
    provider: provider.name,
    model: provider.name === 'hy3' ? providerModel : null,
    fencingToken,
    status: 'queued',
    startedAt,
    sentAt: null,
    firstTokenAt: null,
    completedAt: null,
    latencyMs: null,
    timeToFirstTokenMs: null,
    errorCode: null,
    errorMessage: null,
  });
  repos.telemetry.markAttemptSent(attemptId, startedAt);

  const recordUnknownUsage = (id: string, at: string): void => {
    repos.telemetry.insertUsage({
      id: newId('llm_usage'),
      attemptId: id,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      estimatedCostMicrounits: null,
      currency: null,
      pricingSource: null,
      pricingVersion: null,
      recordedAt: at,
    });
  };

  const beginRepairAttempt = (): void => {
    const repairStartedAt = clock.now().toISOString();
    const operation = repos.operations.get(operationId);
    if (
      !operation ||
      operation.status !== 'running' ||
      operation.fencingToken !== fencingToken ||
      operation.leaseExpiresAt === null ||
      operation.leaseExpiresAt <= repairStartedAt
    ) {
      throw new AppError(
        ApiErrorCode.VersionConflict,
        'Provider repair was fenced because its operation lease is stale.',
      );
    }
    const nextAttemptNumber = attemptNumber + 1;
    const nextAttemptId = newId('llm_attempt');
    repos.transaction(() => {
      if (
        !repos.telemetry.finishAttempt(attemptId, {
          status: 'completed',
          completedAt: repairStartedAt,
          latencyMs: Math.max(0, Date.parse(repairStartedAt) - Date.parse(attemptStartedAt)),
          errorCode: 'STRUCTURED_OUTPUT_REPAIR_REQUIRED',
          errorMessage: 'The first response required bounded structured-output repair.',
        })
      ) {
        throw new Error('Original provider attempt was no longer open for repair.');
      }
      recordUnknownUsage(attemptId, repairStartedAt);
      repos.telemetry.insertAttempt({
        id: nextAttemptId,
        logicalCallId,
        attemptNumber: nextAttemptNumber,
        attemptKind: 'repair',
        provider: provider.name,
        model: provider.name === 'hy3' ? providerModel : null,
        fencingToken,
        status: 'queued',
        startedAt: repairStartedAt,
        sentAt: null,
        firstTokenAt: null,
        completedAt: null,
        latencyMs: null,
        timeToFirstTokenMs: null,
        errorCode: null,
        errorMessage: null,
      });
      if (!repos.telemetry.markAttemptSent(nextAttemptId, repairStartedAt)) {
        throw new Error('Repair provider attempt could not be marked sent.');
      }
    });
    attemptNumber = nextAttemptNumber;
    attemptId = nextAttemptId;
    attemptStartedAt = repairStartedAt;
  };

  try {
    const result = await invoke({ ...providerOptions, onRepairAttempt: beginRepairAttempt });
    const completedAt = clock.now().toISOString();
    const operation = repos.operations.get(operationId);
    const resultIsCurrent =
      operation?.status === 'running' &&
      operation.fencingToken === fencingToken &&
      operation.leaseExpiresAt !== null &&
      operation.leaseExpiresAt > completedAt;
    if (!resultIsCurrent) {
      repos.transaction(() => {
        repos.telemetry.finishAttempt(attemptId, {
          status: 'outcome_unknown',
          completedAt,
          latencyMs: Math.max(0, Date.parse(completedAt) - Date.parse(attemptStartedAt)),
          errorCode: 'OPERATION_LEASE_LOST',
          errorMessage: 'Provider result arrived after its operation lease became stale.',
        });
        recordUnknownUsage(attemptId, completedAt);
        repos.telemetry.completeLogicalCall(logicalCallId, 'failed', completedAt);
      });
      throw new AppError(
        ApiErrorCode.VersionConflict,
        'Provider result was fenced because its operation lease is stale.',
      );
    }
    repos.transaction(() => {
      repos.telemetry.finishAttempt(attemptId, {
        status: 'completed',
        completedAt,
        latencyMs: Math.max(0, Date.parse(completedAt) - Date.parse(attemptStartedAt)),
      });
      recordUnknownUsage(attemptId, completedAt);
      repos.telemetry.completeLogicalCall(logicalCallId, 'completed', completedAt);
    });
    return result;
  } catch (error) {
    if (
      error instanceof AppError &&
      error.code === ApiErrorCode.VersionConflict &&
      error.message === 'Provider result was fenced because its operation lease is stale.'
    ) {
      throw error;
    }
    const completedAt = clock.now().toISOString();
    const cancelled =
      error instanceof ProviderError && error.code === ApiErrorCode.RequestCancelled;
    repos.transaction(() => {
      repos.telemetry.finishAttempt(attemptId, {
        status: cancelled ? 'cancelled' : 'failed',
        completedAt,
        latencyMs: Math.max(0, Date.parse(completedAt) - Date.parse(attemptStartedAt)),
        errorCode: error instanceof ProviderError ? error.code : 'AGENT_PROVIDER_CALL_FAILED',
        errorMessage:
          error instanceof Error ? error.message.slice(0, 500) : 'Agent provider call failed.',
      });
      recordUnknownUsage(attemptId, completedAt);
      repos.telemetry.completeLogicalCall(
        logicalCallId,
        cancelled ? 'cancelled' : 'failed',
        completedAt,
      );
    });
    throw error;
  }
}
