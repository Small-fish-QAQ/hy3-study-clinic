import { COURSE_POLICY, type CourseOperation } from '@hy3-clinic/shared';
import type { z } from 'zod';
import type { ClinicRepository } from '../repositories/clinic.js';
import { newClinicId } from '../repositories/clinic.js';
import type { ProviderCallOptions, ProviderUsage } from '../llm/provider.js';
import type { CourseOperationContext } from './courseOperationRunner.js';
import { canonical, sha256 } from '../util/canonical.js';
import { AppError } from '../errors.js';
import { projectModelOutput } from '../llm/outputProjection.js';
import { ProviderError } from '../llm/errors.js';

class ProviderSemaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly capacity: number) {
    if (capacity < 1) throw new Error('Provider concurrency must be positive.');
  }
  async run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    if (this.active >= this.capacity)
      await new Promise<void>((resolve, reject) => {
        const go = () => {
          signal.removeEventListener('abort', abort);
          resolve();
        };
        const abort = () => {
          const i = this.queue.indexOf(go);
          if (i >= 0) this.queue.splice(i, 1);
          reject(new AppError('REQUEST_CANCELLED', '操作已取消。'));
        };
        this.queue.push(go);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    if (signal.aborted) {
      this.queue.shift()?.();
      throw new AppError('REQUEST_CANCELLED', '操作已取消。');
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}
export class CourseGeneration {
  private readonly locks = new Map<string, Promise<{ value: unknown; callId: string }>>();
  private readonly semaphore: ProviderSemaphore;
  constructor(
    readonly repo: ClinicRepository,
    concurrency = 2,
  ) {
    this.semaphore = new ProviderSemaphore(concurrency);
  }
  reject(callId: string, findings: string[], retryAfterOperation?: string): void {
    const row = this.repo.payload<Record<string, unknown>>(
      'SELECT payload FROM llm_calls WHERE id=?',
      callId,
    );
    if (row)
      this.repo.run(
        'UPDATE llm_calls SET payload=? WHERE id=?',
        canonical({
          ...row,
          contentRejected: true,
          ...(retryAfterOperation ? { retryAfterOperation } : {}),
          rejectionCodes: findings.map((f) => sha256(f)),
          rejectionFindings: findings,
        }),
        callId,
      );
  }
  rejectPayload(workspaceId: string, payload: unknown, findings: string[]): void {
    const matches = this.repo.payloads<{ callId: string }>(
      'SELECT payload FROM semantic_cache WHERE workspace_id=? AND candidate_hash=?',
      workspaceId,
      sha256(payload),
    );
    for (const match of matches) this.reject(match.callId, findings);
  }
  /** Retain physical provenance and rejection history; caller must revalidate before use. */
  retainedStage<T>(
    ctx: CourseOperationContext,
    method: string,
    input: unknown,
    sourceScopeHash: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  ): { value: T; callId: string } | null {
    ctx.check();
    const providerSnapshot = {
      provider: ctx.provider.name,
      model: ctx.provider.model ?? null,
      endpoint: ctx.provider.endpointIdentity ?? null,
      reasoning: ctx.provider.runtimeIdentityFor?.(method) ?? ctx.provider.runtimeIdentity ?? null,
    };
    const baseKey = sha256({
      workspaceId: ctx.workspaceId,
      method,
      input,
      sourceScopeHash,
      policy: COURSE_POLICY,
      provider: providerSnapshot,
    });
    const row = this.repo.row<{ payload: string; candidate_hash: string }>(
      `SELECT s.payload,s.candidate_hash FROM semantic_cache s
       JOIN llm_calls c ON c.id=json_extract(s.payload,'$.callId')
       JOIN llm_physical_attempts p ON p.id=s.physical_attempt_id AND p.logical_call_id=c.id
       WHERE s.workspace_id=? AND s.source_scope_hash=? AND c.workspace_id=? AND c.method=?
         AND c.status='completed' AND p.status='completed' AND c.generation_key=s.generation_key
         AND json_extract(c.payload,'$.baseKey')=? ORDER BY c.created_at DESC LIMIT 1`,
      ctx.workspaceId,
      sourceScopeHash,
      ctx.workspaceId,
      method,
      baseKey,
    );
    if (!row) return null;
    const envelope = JSON.parse(row.payload) as {
      value: unknown;
      callId: string;
      originalProviderSnapshot: unknown;
    };
    if (
      sha256(envelope.value) !== row.candidate_hash ||
      sha256(envelope.originalProviderSnapshot) !== sha256(providerSnapshot)
    )
      throw new AppError('GROUNDING_FAILED', '保存候选的来源或完整性校验失败。');
    return { value: schema.parse(envelope.value), callId: envelope.callId };
  }
  failedCandidate(
    ctx: CourseOperationContext,
    method: string,
    input: unknown,
    sourceScopeHash: string,
  ): { candidate: unknown; findings: string[] } | null {
    const providerSnapshot = {
      provider: ctx.provider.name,
      model: ctx.provider.model ?? null,
      endpoint: ctx.provider.endpointIdentity ?? null,
      reasoning: ctx.provider.runtimeIdentityFor?.(method) ?? ctx.provider.runtimeIdentity ?? null,
    };
    const baseKey = sha256({
      workspaceId: ctx.workspaceId,
      method,
      input,
      sourceScopeHash,
      policy: COURSE_POLICY,
      provider: providerSnapshot,
    });
    const row = this.repo.payload<{
      candidate: unknown;
      candidateHash: string;
      failureFindings?: string[];
      diagnostic?: { schemaFindings?: { path: string; code: string }[] };
    }>(
      "SELECT payload FROM llm_calls WHERE workspace_id=? AND method=? AND status='failed' AND json_extract(payload,'$.baseKey')=? AND json_extract(payload,'$.candidateHash') IS NOT NULL AND json_extract(payload,'$.diagnostic.bodyReadCompleted')=1 AND json_extract(payload,'$.diagnostic.outcome')='response_received' ORDER BY created_at DESC,rowid DESC LIMIT 1",
      ctx.workspaceId,
      method,
      baseKey,
    );
    if (!row) return null;
    if (sha256(row.candidate) !== row.candidateHash)
      throw new AppError('GROUNDING_FAILED', '保存的完整坏结构候选哈希不符。');
    const findings =
      row.failureFindings ??
      row.diagnostic?.schemaFindings?.map((i) => `${i.path}: ${i.code}`) ??
      [];
    return {
      candidate: row.candidate,
      findings: findings.length
        ? findings
        : ['完整候选的引用合同未通过；请核对全部引用范围与实际数组索引。'],
    };
  }
  async stage<T>(
    ctx:
      | CourseOperationContext
      | (Omit<CourseOperationContext, 'operationId'> & { operationId: null }),
    method: string,
    input: unknown,
    sourceScopeHash: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    invoke: (opts: ProviderCallOptions) => Promise<T>,
  ): Promise<{ value: T; callId: string }> {
    ctx.check();
    const providerSnapshot = {
      provider: ctx.provider.name,
      model: ctx.provider.model ?? null,
      endpoint: ctx.provider.endpointIdentity ?? null,
      reasoning: ctx.provider.runtimeIdentityFor?.(method) ?? ctx.provider.runtimeIdentity ?? null,
    };
    const baseKey = sha256({
      workspaceId: ctx.workspaceId,
      method,
      input,
      sourceScopeHash,
      policy: COURSE_POLICY,
      provider: providerSnapshot,
    });
    const rejections =
      this.repo.row<{ n: number }>(
        "SELECT COUNT(*) AS n FROM llm_calls WHERE json_extract(payload,'$.baseKey')=? AND json_extract(payload,'$.contentRejected')=1 AND (json_extract(payload,'$.retryAfterOperation') IS NULL OR json_extract(payload,'$.retryAfterOperation')<>?)",
        baseKey,
        ctx.operationId,
      )?.n ?? 0;
    const key = rejections ? sha256({ baseKey, successor: rejections }) : baseKey;
    const cached = this.repo.row<{
      candidate_hash: string;
      physical_attempt_id: string;
      payload: string;
    }>(
      'SELECT * FROM semantic_cache WHERE generation_key=? AND workspace_id=? AND source_scope_hash=?',
      key,
      ctx.workspaceId,
      sourceScopeHash,
    );
    if (cached) {
      const envelope = JSON.parse(cached.payload) as {
        value: T;
        callId: string;
        originalProviderSnapshot: unknown;
      };
      const origin = this.repo.row<{
        status: string;
        generation_key: string;
        workspace_id: string;
        physical_status: string;
      }>(
        'SELECT c.status,c.generation_key,c.workspace_id,p.status AS physical_status FROM llm_calls c JOIN llm_physical_attempts p ON p.logical_call_id=c.id WHERE c.id=? AND p.id=?',
        envelope.callId,
        cached.physical_attempt_id,
      );
      if (
        !origin ||
        origin.status !== 'completed' ||
        origin.physical_status !== 'completed' ||
        origin.workspace_id !== ctx.workspaceId ||
        origin.generation_key !== key ||
        sha256(envelope.value) !== cached.candidate_hash ||
        sha256(envelope.originalProviderSnapshot) !== sha256(providerSnapshot)
      )
        throw new AppError('GROUNDING_FAILED', '已保存候选的来源或完整性校验失败。');
      return { value: schema.parse(envelope.value), callId: envelope.callId };
    }
    // Known complete JSON survives a schema interpretation failure. Revalidate it
    // locally before buying a replacement; retain the earlier failure as history.
    const failedRows = this.repo.rows<{
      id: string;
      payload: string;
      physicalId: string;
      physicalPayload: string;
    }>(
      `SELECT c.id,c.payload,p.id AS physicalId,p.payload AS physicalPayload FROM llm_calls c JOIN llm_physical_attempts p ON p.logical_call_id=c.id WHERE c.workspace_id=? AND c.generation_key=? AND c.status='failed' AND json_extract(c.payload,'$.candidateHash') IS NOT NULL AND json_extract(c.payload,'$.diagnostic.bodyReadCompleted')=1 AND json_extract(c.payload,'$.diagnostic.outcome')='response_received' ORDER BY c.created_at DESC`,
      ctx.workspaceId,
      key,
    );
    for (const row of failedRows) {
      const prior = JSON.parse(row.payload) as {
        candidate: unknown;
        candidateHash: string;
        [key: string]: unknown;
      };
      if (sha256(prior.candidate) !== prior.candidateHash)
        throw new AppError('GROUNDING_FAILED', '未通过合同的完整候选哈希不符。');
      const parsed = projectModelOutput(schema, prior.candidate).parsed;
      if (!parsed.success) continue;
      const origin = this.repo.row<{ provider_snapshot: string; generation_key: string }>(
        'SELECT provider_snapshot,generation_key FROM llm_calls WHERE id=?',
        row.id,
      )!;
      if (sha256(JSON.parse(origin.provider_snapshot)) !== sha256(providerSnapshot)) continue;
      this.repo.transaction(() => {
        this.repo.run(
          'INSERT OR IGNORE INTO semantic_cache VALUES(?,?,?,?,?,?,?,?,?)',
          key,
          ctx.workspaceId,
          'retained_candidate_v2',
          sha256(parsed.data),
          row.physicalId,
          sourceScopeHash,
          'complete',
          canonical({
            value: parsed.data,
            callId: row.id,
            originalProviderSnapshot: providerSnapshot,
          }),
          this.repo.now(),
        );
        this.repo.run(
          "UPDATE llm_calls SET status='completed',payload=? WHERE id=?",
          canonical({
            ...prior,
            localRevalidation: {
              at: this.repo.now(),
              priorStatus: 'failed',
              reason: 'complete_candidate_passes_current_contract',
            },
          }),
          row.id,
        );
        this.repo.run(
          "UPDATE llm_physical_attempts SET status='completed',payload=? WHERE id=?",
          canonical({
            ...JSON.parse(row.physicalPayload),
            priorInterpretation: 'failed',
            locallyRevalidated: true,
          }),
          row.physicalId,
        );
      });
      return { value: parsed.data, callId: row.id };
    }
    const existing = this.locks.get(key);
    if (existing) {
      const result = await existing;
      ctx.check();
      return { value: schema.parse(result.value), callId: result.callId };
    }
    const promise = this.semaphore.run(ctx.signal, async () => {
      ctx.check();
      const callId = newClinicId('call');
      let attemptId = newClinicId('physical');
      const now = this.repo.now();
      this.repo.run(
        'INSERT INTO llm_calls VALUES(?,?,?,?,?,?,?,?,?)',
        callId,
        ctx.workspaceId,
        ctx.operationId,
        key,
        method,
        canonical(providerSnapshot),
        'running',
        canonical({ baseKey, usage: null }),
        now,
      );
      this.repo.run(
        'INSERT INTO llm_physical_attempts VALUES(?,?,?,?,?)',
        attemptId,
        callId,
        'prepared',
        canonical({ usage: null }),
        now,
      );
      let usage: ProviderUsage | null = null;
      let diagnostic: unknown = null;
      let candidate: unknown;
      let sent = false;
      const reportRequest = (update: (op: CourseOperation) => CourseOperation) => {
        if (!ctx.operationId) return;
        ctx.check();
        const current = this.repo.payload<CourseOperation>(
          'SELECT payload FROM agent_operations WHERE id=?',
          ctx.operationId,
        )!;
        this.repo.run(
          'UPDATE agent_operations SET payload=? WHERE id=?',
          canonical({ ...update(current), updatedAt: this.repo.now() }),
          ctx.operationId,
        );
      };
      const options: ProviderCallOptions = {
        signal: ctx.signal,
        onCandidate: (value) => {
          candidate = value;
        },
        onRequestStarted: ({ timeoutMs }) =>
          reportRequest((op) => ({
            ...op,
            modelRequest: {
              provider: ctx.provider.name,
              model: ctx.provider.model ?? ctx.provider.name,
              method,
              startedAt: this.repo.now(),
              timeoutMs,
              responseReceived: false,
            },
          })),
        onResponseHeaders: () =>
          reportRequest((op) => ({
            ...op,
            ...(op.modelRequest
              ? { modelRequest: { ...op.modelRequest, responseReceived: true } }
              : {}),
          })),
        onRequestSent: () => {
          sent = true;
          this.repo.run("UPDATE llm_physical_attempts SET status='sent' WHERE id=?", attemptId);
        },
        onUsage: (value) => {
          usage = value;
        },
        onRequestDiagnostic: (value) => {
          diagnostic = value;
          this.repo.run(
            'UPDATE llm_physical_attempts SET payload=? WHERE id=?',
            canonical({ usage, diagnostic }),
            attemptId,
          );
        },
        onTransportRetry: () => {
          this.repo.run(
            "UPDATE llm_physical_attempts SET status='failed',payload=? WHERE id=?",
            canonical({ usage, diagnostic, reason: 'confirmed_not_generated' }),
            attemptId,
          );
          attemptId = newClinicId('physical');
          usage = null;
          diagnostic = null;
          candidate = undefined;
          sent = false;
          this.repo.run(
            'INSERT INTO llm_physical_attempts VALUES(?,?,?,?,?)',
            attemptId,
            callId,
            'prepared',
            canonical({ usage: null }),
            this.repo.now(),
          );
        },
      };
      try {
        const value = schema.parse(await invoke(options));
        // Complete candidates are retained before publication fencing. Never store chain of thought.
        this.repo.transaction(() => {
          this.repo.run(
            'INSERT OR IGNORE INTO semantic_cache VALUES(?,?,?,?,?,?,?,?,?)',
            key,
            ctx.workspaceId,
            'retained_candidate_v2',
            sha256(value),
            attemptId,
            sourceScopeHash,
            'complete',
            canonical({ value, callId, originalProviderSnapshot: providerSnapshot }),
            this.repo.now(),
          );
          this.repo.run(
            "UPDATE llm_physical_attempts SET status='completed',payload=? WHERE id=?",
            canonical({ usage, diagnostic }),
            attemptId,
          );
          this.repo.run(
            "UPDATE llm_calls SET status='completed',payload=? WHERE id=?",
            canonical({
              baseKey,
              usage,
              diagnostic,
              ...(candidate === undefined ? {} : { candidate, candidateHash: sha256(candidate) }),
            }),
            callId,
          );
        });
        return { value, callId };
      } catch (error) {
        const unknown =
          sent &&
          !(
            diagnostic &&
            typeof diagnostic === 'object' &&
            'bodyReadCompleted' in diagnostic &&
            diagnostic.bodyReadCompleted
          );
        this.repo.run(
          'UPDATE llm_calls SET status=?,payload=? WHERE id=?',
          unknown ? 'outcome_unknown' : 'failed',
          canonical({
            baseKey,
            usage,
            diagnostic,
            ...(candidate === undefined ? {} : { candidate, candidateHash: sha256(candidate) }),
            ...(error instanceof ProviderError &&
            error.technicalFailureCode === 'COMPLETE_CANDIDATE_INVALID'
              ? { failureFindings: (error.details as { findings: string[] }).findings }
              : {}),
          }),
          callId,
        );
        this.repo.run(
          'UPDATE llm_physical_attempts SET status=?,payload=? WHERE id=?',
          unknown ? 'outcome_unknown' : 'failed',
          canonical({ usage, diagnostic }),
          attemptId,
        );
        throw error;
      }
    });
    this.locks.set(key, promise);
    try {
      const result = await promise;
      ctx.check();
      return result;
    } finally {
      this.locks.delete(key);
    }
  }
}
