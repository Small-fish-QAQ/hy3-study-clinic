import { ApiErrorCode } from '@hy3-clinic/shared';
import { AppError } from '../errors.js';
import { ProviderError } from '../llm/errors.js';
import type {
  LlmProvider,
  ProviderCallOptions,
  ProviderTelemetryContext,
  ProviderUsage,
} from '../llm/provider.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import { enforceAgentCostPolicies } from './agentProviderRuntime.js';

const TELEMETRY_PROVIDER = Symbol('hy3-study-clinic-telemetry-provider');

const unknownUsage = (): ProviderUsage => ({
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  estimatedCostMicrounits: null,
  currency: null,
  pricingSource: null,
  pricingVersion: null,
});

const fakeUsage = (): ProviderUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  estimatedCostMicrounits: 0,
  currency: 'USD',
  pricingSource: 'fake-provider',
  pricingVersion: '1',
});

interface TelemetryProviderOptions {
  repos: Repositories;
  clock: Clock;
  provider: LlmProvider;
  providerGeneration: () => number;
}

/**
 * Decorate the complete provider interface so no production inference can
 * bypass physical-attempt telemetry. Callers supply metadata only; this
 * boundary owns every ledger write and never receives prompt content.
 */
export function createTelemetryProvider({
  repos,
  clock,
  provider,
  providerGeneration,
}: TelemetryProviderOptions): LlmProvider {
  if ((provider as LlmProvider & { [TELEMETRY_PROVIDER]?: boolean })[TELEMETRY_PROVIDER]) {
    return provider;
  }
  return new Proxy(provider, {
    get(target, property, receiver) {
      if (property === TELEMETRY_PROVIDER) return true;
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof property !== 'string' || typeof value !== 'function') {
        return value;
      }
      const method = value as (...args: unknown[]) => Promise<unknown>;
      return async (...args: unknown[]): Promise<unknown> => {
        const optionsIndex = property === 'testConnection' ? 0 : 1;
        const supplied = (args[optionsIndex] ?? {}) as ProviderCallOptions;
        const context: ProviderTelemetryContext | undefined = supplied.telemetry;
        if (!context) {
          throw new AppError(
            ApiErrorCode.ValidationError,
            'Provider inference requires authoritative telemetry context.',
          );
        }
        const startedAt = clock.now().toISOString();
        const policyFingerprint =
          context.workspaceId !== null && context.policyFingerprint === undefined
            ? enforceAgentCostPolicies(repos, {
                workspaceId: context.workspaceId,
                operationType: context.operationType,
                studySessionId: context.studySessionId ?? null,
                at: startedAt,
                confirmedPolicyIds: context.confirmedCostPolicyIds ?? [],
              })
            : (context.policyFingerprint ?? null);
        const logicalCallId = context.logicalCallId ?? newId('llm_call');
        if (!repos.telemetry.getLogicalCall(logicalCallId)) {
          repos.telemetry.insertLogicalCall({
            id: logicalCallId,
            operationId: context.operationId ?? null,
            workspaceId: context.workspaceId,
            studySessionId: context.studySessionId ?? null,
            learningUnitId: context.learningUnitId ?? null,
            assessmentId: context.assessmentId ?? null,
            operationType: context.operationType,
            cacheKey: null,
            cacheStatus: 'not_checked',
            promptFingerprint: null,
            schemaFingerprint: context.schemaFingerprint ?? null,
            policyFingerprint,
            sourceFingerprint: context.sourceFingerprint ?? null,
            status: 'open',
            createdAt: startedAt,
            completedAt: null,
          });
        }

        let attemptNumber = repos.telemetry.listAttempts(logicalCallId).length + 1;
        let attemptId = newId('llm_attempt');
        let attemptStartedAt = startedAt;
        let usage: ProviderUsage = provider.name === 'fake' ? fakeUsage() : unknownUsage();
        let sent = false;
        const insertAttempt = (kind: 'original' | 'repair' | 'retry' | 'fallback'): void => {
          repos.telemetry.insertAttempt({
            id: attemptId,
            logicalCallId,
            attemptNumber,
            attemptKind: kind,
            provider: provider.name,
            model: provider.name === 'hy3' ? (provider.model ?? null) : null,
            providerGeneration: providerGeneration(),
            fencingToken: context.fencingToken ?? null,
            status: 'queued',
            startedAt: attemptStartedAt,
            sentAt: null,
            firstTokenAt: null,
            completedAt: null,
            latencyMs: null,
            timeToFirstTokenMs: null,
            errorCode: null,
            errorMessage: null,
          });
        };
        insertAttempt(context.attemptKind ?? 'original');

        const markSent = (): void => {
          if (sent) return;
          sent = repos.telemetry.markAttemptSent(attemptId, clock.now().toISOString());
          supplied.onRequestSent?.();
        };
        if (provider.name === 'fake' && !supplied.signal?.aborted) markSent();

        const recordUsage = (at: string): void => {
          repos.telemetry.insertUsage({
            id: newId('llm_usage'),
            attemptId,
            ...usage,
            recordedAt: at,
          });
        };
        const finishAttempt = (
          status: 'completed' | 'failed' | 'cancelled' | 'outcome_unknown',
          completedAt: string,
          errorCode: string | null = null,
          errorMessage: string | null = null,
        ): void => {
          repos.telemetry.finishAttempt(attemptId, {
            status,
            completedAt,
            latencyMs: Math.max(0, Date.parse(completedAt) - Date.parse(attemptStartedAt)),
            errorCode,
            errorMessage,
          });
          recordUsage(completedAt);
        };

        const providerOptions: ProviderCallOptions = {
          ...supplied,
          onRequestSent: markSent,
          onUsage: (reported) => {
            usage = reported;
            supplied.onUsage?.(reported);
          },
          onRepairAttempt: () => {
            supplied.onRepairAttempt?.();
            const repairStartedAt = clock.now().toISOString();
            finishAttempt(
              'completed',
              repairStartedAt,
              'STRUCTURED_OUTPUT_REPAIR_REQUIRED',
              'The first response required bounded structured-output repair.',
            );
            attemptNumber += 1;
            attemptId = newId('llm_attempt');
            attemptStartedAt = repairStartedAt;
            usage = provider.name === 'fake' ? fakeUsage() : unknownUsage();
            sent = false;
            insertAttempt('repair');
            if (provider.name === 'fake' && !supplied.signal?.aborted) markSent();
          },
        };
        args[optionsIndex] = providerOptions;

        let completionRejected = false;
        try {
          const result = await method.apply(target, args);
          try {
            supplied.beforeTelemetryComplete?.();
          } catch (error) {
            completionRejected = true;
            throw error;
          }
          const completedAt = clock.now().toISOString();
          repos.transaction(() => {
            finishAttempt('completed', completedAt);
            repos.telemetry.completeLogicalCall(logicalCallId, 'completed', completedAt);
          });
          return result;
        } catch (error) {
          const completedAt = clock.now().toISOString();
          const cancelled =
            (error instanceof ProviderError && error.code === ApiErrorCode.RequestCancelled) ||
            supplied.signal?.aborted === true;
          const errorCode =
            error instanceof ProviderError
              ? error.code
              : cancelled
                ? ApiErrorCode.RequestCancelled
                : 'PROVIDER_CALL_FAILED';
          const errorMessage =
            error instanceof ProviderError
              ? error.message.slice(0, 500)
              : cancelled
                ? 'Provider request was cancelled.'
                : 'Provider call failed.';
          const staleLease =
            completionRejected &&
            error instanceof AppError &&
            error.code === ApiErrorCode.VersionConflict;
          repos.transaction(() => {
            finishAttempt(
              staleLease ? 'outcome_unknown' : cancelled ? 'cancelled' : 'failed',
              completedAt,
              staleLease ? 'OPERATION_LEASE_LOST' : errorCode,
              staleLease
                ? 'Provider result arrived after its operation lease became stale.'
                : errorMessage,
            );
            repos.telemetry.completeLogicalCall(
              logicalCallId,
              cancelled && !staleLease ? 'cancelled' : 'failed',
              completedAt,
            );
          });
          throw error;
        }
      };
    },
  }) as LlmProvider;
}
