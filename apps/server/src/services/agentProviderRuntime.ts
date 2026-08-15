import { ApiErrorCode, fnv1a32 } from '@hy3-clinic/shared';
import { AppError } from '../errors.js';
import type { LlmProvider, ProviderCallOptions } from '../llm/provider.js';
import type { CostPolicy } from '../repositories/telemetry.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';

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
  provider: _provider,
  providerModel: _providerModel,
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
  const assertCurrentLease = (): void => {
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
  };
  const result = await invoke({
    ...providerOptions,
    onRepairAttempt: assertCurrentLease,
    beforeTelemetryComplete: assertCurrentLease,
    telemetry: {
      workspaceId,
      operationId,
      studySessionId,
      learningUnitId,
      assessmentId,
      operationType,
      schemaFingerprint,
      policyFingerprint,
      sourceFingerprint,
      fencingToken,
    },
  });
  return result;
}
