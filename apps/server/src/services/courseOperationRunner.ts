import {
  CourseOperationSchema,
  CoursePreferencesSchema,
  type CourseCommand,
  type CourseOperation,
  type CoursePreparationProgress,
} from '@hy3-clinic/shared';
import type { ClinicRepository } from '../repositories/clinic.js';
import { newClinicId } from '../repositories/clinic.js';
import { AppError, notFound } from '../errors.js';
import { canonical, sha256 } from '../util/canonical.js';
import { ProviderError } from '../llm/errors.js';
import type { CourseProvider } from '../llm/courseContract.js';

export interface CourseOperationContext {
  operationId: string;
  workspaceId: string;
  fence: number;
  signal: AbortSignal;
  provider: CourseProvider;
  check(): void;
  report?(progress: CoursePreparationProgress): void;
}
type Task = (
  context: CourseOperationContext,
  request: Record<string, unknown>,
) => Promise<{ resourceId: string; [key: string]: unknown }>;
export class CourseOperationRunner {
  private readonly tasks = new Map<CourseOperation['kind'], Task>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly pending = new Map<string, Promise<void>>();
  readonly owner = newClinicId('process');
  constructor(
    readonly repo: ClinicRepository,
    private readonly provider: () => CourseProvider,
    private readonly leaseMs = 90_000,
    private readonly heartbeatMs = 20_000,
  ) {
    if (heartbeatMs <= 0 || leaseMs <= heartbeatMs) throw new Error('heartbeat 必须小于 lease。');
    const interrupted = repo.payloads<CourseOperation>(
      "SELECT payload FROM agent_operations WHERE status IN ('queued','running')",
    );
    for (const op of interrupted)
      this.write({
        ...op,
        status: 'interrupted',
        fence: op.fence + 1,
        version: op.version + 1,
        updatedAt: repo.now(),
        error: {
          code: 'INTERRUPTED',
          message: '服务已重启，请显式重试以恢复未完成内容。',
          retryable: true,
        },
      });
    repo.run("UPDATE llm_physical_attempts SET status='outcome_unknown' WHERE status='sent'");
    repo.run("UPDATE llm_calls SET status='outcome_unknown' WHERE status='running'");
  }
  register(kind: CourseOperation['kind'], task: Task) {
    this.tasks.set(kind, task);
  }
  start(
    workspaceId: string,
    command: CourseCommand,
    kind: CourseOperation['kind'],
    scopeKey: string,
    resourceKind: string,
    request: Record<string, unknown>,
  ): CourseOperation {
    const requestHash = sha256({ kind, request });
    const op = this.repo.command(workspaceId, command, { kind, scopeKey, request }, () => {
      const active = this.repo.row<{ request_hash: string; payload: string }>(
        "SELECT request_hash,payload FROM agent_operations WHERE workspace_id=? AND scope_key=? AND status IN ('queued','running')",
        workspaceId,
        scopeKey,
      );
      if (active) {
        if (active.request_hash !== requestHash)
          throw new AppError('VERSION_CONFLICT', '该资源正在执行其他操作。');
        return JSON.parse(active.payload) as CourseOperation;
      }
      const now = this.repo.now();
      const next: CourseOperation = {
        id: newClinicId('operation'),
        workspaceId,
        kind,
        ...(kind === 'preparePlan' && request.preferences
          ? { preferences: CoursePreferencesSchema.parse(request.preferences) }
          : {}),
        resourceKind,
        resourceId: null,
        status: 'queued',
        version: 1,
        fence: 1,
        result: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      };
      this.repo.run(
        'INSERT INTO agent_operations(id,workspace_id,scope_key,request_hash,request_payload,kind,status,version,fence,owner,lease_until,payload,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
        next.id,
        workspaceId,
        scopeKey,
        requestHash,
        canonical(request),
        kind,
        next.status,
        next.version,
        next.fence,
        this.owner,
        null,
        canonical(next),
        now,
      );
      return next;
    });
    // Capture selected instance at dispatch; settings changes only affect later operations.
    if (op.status === 'queued' && !this.pending.has(op.id)) {
      const selected = this.provider();
      const promise = Promise.resolve().then(() => this.execute(op.id, selected));
      this.pending.set(op.id, promise);
      void promise.finally(() => this.pending.delete(op.id));
    }
    return this.get(workspaceId, op.id);
  }
  get(workspaceId: string, id: string): CourseOperation {
    return CourseOperationSchema.parse(this.repo.owned('agent_operations', id, workspaceId));
  }
  retry(
    workspaceId: string,
    id: string,
    command: CourseCommand,
    expectedVersion: number,
  ): CourseOperation {
    const old = this.get(workspaceId, id);
    if (
      old.version !== expectedVersion ||
      !['failed', 'interrupted'].includes(old.status) ||
      old.error?.retryable === false
    )
      throw new AppError('VERSION_CONFLICT', '当前操作不能重试，请刷新状态。');
    const row = this.repo.row<{ scope_key: string; request_payload: string }>(
      'SELECT scope_key,request_payload FROM agent_operations WHERE id=?',
      id,
    )!;
    return this.start(
      workspaceId,
      command,
      old.kind,
      row.scope_key,
      old.resourceKind,
      JSON.parse(row.request_payload) as Record<string, unknown>,
    );
  }
  cancel(
    workspaceId: string,
    id: string,
    command: CourseCommand,
    expectedVersion: number,
  ): CourseOperation {
    return this.repo.command(
      workspaceId,
      command,
      { id, expectedVersion, action: 'cancel' },
      () => {
        const old = this.get(workspaceId, id);
        if (old.version !== expectedVersion)
          throw new AppError('VERSION_CONFLICT', '操作状态已改变，请刷新。');
        if (!['queued', 'running'].includes(old.status))
          throw new AppError('VERSION_CONFLICT', '该操作已结束。');
        const next = {
          ...old,
          status: 'cancelled' as const,
          fence: old.fence + 1,
          version: old.version + 1,
          updatedAt: this.repo.now(),
        };
        this.write(next);
        this.controllers.get(id)?.abort();
        return next;
      },
    );
  }
  fenceResource(id: string): void {
    const op = this.repo.payload<CourseOperation>(
      'SELECT payload FROM agent_operations WHERE id=?',
      id,
    );
    if (op && ['queued', 'running'].includes(op.status)) {
      this.write({
        ...op,
        status: 'cancelled',
        fence: op.fence + 1,
        version: op.version + 1,
        updatedAt: this.repo.now(),
      });
      this.controllers.get(id)?.abort();
    }
  }
  async idle(id?: string): Promise<void> {
    if (id) await this.pending.get(id);
    else await Promise.all(this.pending.values());
  }
  close(): void {
    for (const [id, controller] of this.controllers) {
      const op = this.repo.payload<CourseOperation>(
        'SELECT payload FROM agent_operations WHERE id=?',
        id,
      );
      if (op && ['queued', 'running'].includes(op.status))
        this.write({
          ...op,
          status: 'interrupted',
          fence: op.fence + 1,
          version: op.version + 1,
          updatedAt: this.repo.now(),
          error: { code: 'INTERRUPTED', message: '服务已停止，可显式重试。', retryable: true },
        });
      controller.abort();
    }
  }
  private write(op: CourseOperation) {
    this.repo.run(
      'UPDATE agent_operations SET status=?,version=?,fence=?,payload=?,lease_until=? WHERE id=?',
      op.status,
      op.version,
      op.fence,
      canonical(op),
      op.status === 'running' ? new Date(Date.now() + this.leaseMs).toISOString() : null,
      op.id,
    );
  }
  private async execute(id: string, provider: CourseProvider): Promise<void> {
    const initial = this.repo.payload<CourseOperation>(
      'SELECT payload FROM agent_operations WHERE id=?',
      id,
    );
    if (!initial || initial.status !== 'queued') return;
    const running = {
      ...initial,
      status: 'running' as const,
      version: initial.version + 1,
      updatedAt: this.repo.now(),
    };
    this.write(running);
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const check = () => {
      const row = this.repo.row<{
        status: string;
        fence: number;
        owner: string;
        lease_until: string;
      }>('SELECT status,fence,owner,lease_until FROM agent_operations WHERE id=?', id);
      if (
        controller.signal.aborted ||
        !row ||
        row.status !== 'running' ||
        row.fence !== running.fence ||
        row.owner !== this.owner ||
        Date.parse(row.lease_until) <= Date.now()
      )
        throw new AppError('REQUEST_CANCELLED', '操作已取消或执行权失效，候选未发布。');
    };
    const renew = () => {
      this.repo.run(
        'UPDATE agent_operations SET lease_until=? WHERE id=? AND owner=? AND fence=? AND status=?',
        new Date(Date.now() + this.leaseMs).toISOString(),
        id,
        this.owner,
        running.fence,
        'running',
      );
    };
    const heartbeat = setInterval(() => {
      try {
        check();
        renew();
      } catch {
        controller.abort();
      }
    }, this.heartbeatMs);
    heartbeat.unref();
    try {
      const request = this.repo.row<{ request_payload: string }>(
        'SELECT request_payload FROM agent_operations WHERE id=?',
        id,
      )!;
      const task = this.tasks.get(running.kind);
      if (!task) throw notFound('操作类型没有实现。');
      const result = await task(
        {
          operationId: id,
          workspaceId: running.workspaceId,
          fence: running.fence,
          signal: controller.signal,
          provider,
          check,
          report: (progress) => {
            check();
            const current = this.get(running.workspaceId, id);
            this.write({ ...current, progress, updatedAt: this.repo.now() });
          },
        },
        JSON.parse(request.request_payload) as Record<string, unknown>,
      );
      check();
      this.write({
        ...this.get(running.workspaceId, id),
        status: 'completed',
        resourceId: result.resourceId,
        result,
        version: running.version + 1,
        updatedAt: this.repo.now(),
      });
    } catch (error) {
      const latest = this.repo.payload<CourseOperation>(
        'SELECT payload FROM agent_operations WHERE id=?',
        id,
      );
      if (latest?.status === 'running' && latest.fence === running.fence)
        this.write({
          ...latest,
          status: 'failed',
          version: latest.version + 1,
          updatedAt: this.repo.now(),
          error: {
            code:
              error instanceof AppError || (error instanceof Error && 'code' in error)
                ? String((error as AppError).code)
                : 'INTERNAL',
            message:
              error instanceof AppError || error instanceof ProviderError
                ? error.message
                : '内容生成或校验未完成，请查看结果并显式重试。',
            retryable: !(
              error instanceof AppError &&
              (error.details as { retryable?: boolean } | undefined)?.retryable === false
            ),
          },
        });
    } finally {
      clearInterval(heartbeat);
      this.controllers.delete(id);
    }
  }
}
