import { createHash } from 'node:crypto';
import { ApiErrorCode } from '@hy3-clinic/shared';
import { AppError } from '../errors.js';
import { ProviderError } from '../llm/errors.js';
import type { ModelLogicalCall } from '../repositories/telemetry.js';
import { newId } from '../util/ids.js';
import {
  runTrackedAgentProviderOperation,
  type TrackedProviderOperation,
} from './agentProviderRuntime.js';

const VERSION = 'generation-stage-v1';
const hash = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(value) ?? 'undefined')
    .digest('hex');

interface GenerationStage<T> extends TrackedProviderOperation<T> {
  owner: string;
  /** Full immutable input plus governance/prompt version; excludes attempt identity. */
  stageIdentity: unknown;
  /** Recheck source, route and acceptance fences, including on reuse and before persistence. */
  assertCurrent: () => void;
  /** Parse and validate against the current exact inventory. No authority is inferred from a hit. */
  validateResult: (value: unknown) => T;
  /** Cost admission is needed only when this stage will issue a new request. */
  beforeGenerate?: () => string | null;
}

/** Recover one completed generation dependency, never an accepted learner artifact.
 * Reuses the existing private cache and telemetry stores. A hit gets an explicit
 * zero-request receipt in the current operation, linked to the original completed
 * call. Failed/partial responses are never cached; downstream acceptance still runs.
 */
export async function runRecoverableGenerationStage<T>(stage: GenerationStage<T>): Promise<T> {
  const { repos, clock } = stage;
  const logicalCallId = stage.logicalCallId ?? newId('llm_call');
  const identity = {
    version: VERSION,
    workspaceId: stage.workspaceId,
    studySessionId: stage.studySessionId,
    learningUnitId: stage.learningUnitId,
    assessmentId: stage.assessmentId,
    operationType: stage.operationType,
    schemaFingerprint: stage.schemaFingerprint,
    sourceFingerprint: stage.sourceFingerprint,
    provider: stage.provider.name,
    model: stage.providerModel,
    input: stage.stageIdentity,
  };
  const fingerprint = hash(identity);
  const baseKey = `${VERSION}:${fingerprint}`;
  let cacheKey = baseKey;
  let revision = 0;
  // Rejected dependencies remain immutable audit history. An explicit retry
  // may replace one through a successor cache identity, never resurrect it.
  while (repos.telemetry.peekCache(cacheKey)?.invalidatedAt) {
    revision += 1;
    cacheKey = `${baseKey}:${revision}`;
  }
  const assertCurrent = () => {
    if (stage.providerOptions?.signal?.aborted) throw ProviderError.cancelled();
    stage.assertCurrent();
    const operation = repos.operations.get(stage.operationId);
    if (
      operation?.status !== 'running' ||
      operation.leaseOwner !== stage.owner ||
      operation.fencingToken !== stage.fencingToken ||
      !operation.leaseExpiresAt ||
      operation.leaseExpiresAt <= clock.now().toISOString()
    )
      throw new AppError(
        ApiErrorCode.VersionConflict,
        'Generation stage lost its operation lease.',
      );
  };
  const matches = (call: ModelLogicalCall | undefined) =>
    call?.status === 'completed' &&
    call.workspaceId === stage.workspaceId &&
    call.studySessionId === stage.studySessionId &&
    call.learningUnitId === stage.learningUnitId &&
    call.assessmentId === stage.assessmentId &&
    call.operationType === stage.operationType &&
    call.schemaFingerprint === stage.schemaFingerprint &&
    call.sourceFingerprint === stage.sourceFingerprint;
  const event = (kind: string, payload: unknown) => {
    if (
      !repos.operations.appendEvent(
        {
          id: newId('op_evt'),
          operationId: stage.operationId,
          kind,
          payload,
          createdAt: clock.now().toISOString(),
        },
        stage.owner,
        stage.fencingToken,
      )
    ) {
      throw new AppError(ApiErrorCode.VersionConflict, 'Generation stage receipt was fenced.');
    }
  };
  assertCurrent();
  const cached = repos.telemetry.getCache(cacheKey, fingerprint, clock.now().toISOString());
  if (cached) {
    const envelope = cached.result as {
      payload?: unknown;
      hash?: string;
      logicalCallId?: string;
    } | null;
    const origin =
      typeof envelope?.logicalCallId === 'string'
        ? repos.telemetry.getLogicalCall(envelope.logicalCallId)
        : undefined;
    let result: T | undefined;
    let valid = false;
    if (
      cached.workspaceId === stage.workspaceId &&
      cached.operationType === stage.operationType &&
      cached.provider === stage.provider.name &&
      cached.model === stage.providerModel &&
      cached.schemaFingerprint === stage.schemaFingerprint &&
      cached.sourceFingerprint === stage.sourceFingerprint &&
      envelope &&
      envelope.hash === hash(envelope.payload) &&
      matches(origin) &&
      origin?.cacheStatus !== 'hit' &&
      repos.telemetry
        .listAttempts(origin!.id)
        .some(
          (a) =>
            a.status === 'completed' &&
            a.provider === stage.provider.name &&
            a.model === stage.providerModel,
        )
    ) {
      try {
        result = stage.validateResult(structuredClone(envelope.payload));
        valid = true;
      } catch {
        /* Corrupt or obsolete dependency: regenerate only this stage. */
      }
    }
    if (valid) {
      repos.transaction(() => {
        assertCurrent();
        const at = clock.now().toISOString();
        repos.telemetry.insertLogicalCall({
          ...origin!,
          id: logicalCallId,
          operationId: stage.operationId,
          cacheKey,
          cacheStatus: 'hit',
          policyFingerprint: stage.policyFingerprint,
          createdAt: at,
          completedAt: at,
        });
        event('generation_stage_reused', {
          cacheKey,
          logicalCallId,
          originLogicalCallId: origin!.id,
          schema: stage.schemaFingerprint,
          validatedResultFingerprint: hash(result),
        });
      });
      return result!;
    }
    repos.telemetry.invalidateCache(cacheKey, clock.now().toISOString());
    revision += 1;
    cacheKey = `${baseKey}:${revision}`;
  }
  assertCurrent();
  const policyFingerprint = stage.beforeGenerate ? stage.beforeGenerate() : stage.policyFingerprint;
  const result = stage.validateResult(
    await runTrackedAgentProviderOperation({ ...stage, policyFingerprint, logicalCallId }),
  );
  repos.transaction(() => {
    assertCurrent();
    const call = repos.telemetry.getLogicalCall(logicalCallId);
    if (!matches(call) || call?.operationId !== stage.operationId)
      throw new AppError(
        ApiErrorCode.VersionConflict,
        'Generation stage requires its completed provider call.',
      );
    // Invalidated entries remain immutable history, never replaced by a retry.
    if (!repos.telemetry.peekCache(cacheKey)) {
      repos.telemetry.putCache({
        cacheKey,
        operationType: stage.operationType,
        workspaceId: stage.workspaceId,
        result: { payload: result, hash: hash(result), logicalCallId },
        provider: stage.provider.name,
        model: stage.providerModel,
        promptFingerprint: call!.promptFingerprint,
        schemaFingerprint: stage.schemaFingerprint,
        policyFingerprint,
        sourceFingerprint: stage.sourceFingerprint,
        validationFingerprint: fingerprint,
        createdAt: clock.now().toISOString(),
        expiresAt: null,
        invalidatedAt: null,
      });
    }
    const persisted = repos.telemetry.peekCache(cacheKey)?.result as
      { logicalCallId?: string } | undefined;
    event('generation_stage_completed', {
      cacheKey: persisted?.logicalCallId === logicalCallId ? cacheKey : null,
      logicalCallId,
      schema: stage.schemaFingerprint,
      validatedResultFingerprint: hash(result),
    });
  });
  return result;
}

/** Revoke only the unaccepted generation dependency rejected by content review.
 * Both fresh and reused receipts name the exact cache key. Accepted Lesson
 * checkpoints are separate immutable artifacts and are never touched here. */
export function invalidateGenerationDependency(
  repos: TrackedProviderOperation<unknown>['repos'],
  logicalCallId: string,
  at: string,
): void {
  const call = repos.telemetry.getLogicalCall(logicalCallId);
  if (!call?.operationId) return;
  for (const event of repos.operations.listEvents(call.operationId)) {
    if (!['generation_stage_completed', 'generation_stage_reused'].includes(event.kind)) continue;
    const payload = event.payload as { logicalCallId?: string; cacheKey?: string } | null;
    if (payload?.logicalCallId === logicalCallId && typeof payload.cacheKey === 'string')
      repos.telemetry.invalidateCache(payload.cacheKey, at);
  }
}
