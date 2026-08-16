import {
  ApiErrorCode,
  ApiErrorCodeSchema,
  fnv1a32,
  type ApiErrorCodeValue,
  type CourseExecutionCommandEnvelope,
} from '@hy3-clinic/shared';
import { AppError } from '../errors.js';
import { ProviderError } from '../llm/errors.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';

interface CourseCommandDeps {
  repos: Repositories;
  clock: Clock;
}

export interface ClaimedCourseCommand {
  operationId: string;
  owner: string;
  fencingToken: number;
  replayPayload?: unknown;
}

const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const FAILURE_MESSAGE_LIMIT = 500;
const FAILURE_DETAILS_JSON_LIMIT = 16_000;
const BLOCKED_DETAIL_KEY = /authorization|api.?key|secret|token|prompt|raw|payload|body|stack/iu;

interface SafeCommandFailure {
  code?: ApiErrorCodeValue;
  message: string;
  details?: unknown;
}

function sanitizeFailureDetails(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null) return value === null ? null : undefined;
  if (typeof value === 'string') return value.slice(0, 500);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value
      .slice(0, 20)
      .map((item) => sanitizeFailureDetails(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (typeof value !== 'object') return undefined;
  const safe: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 30)) {
    if (BLOCKED_DETAIL_KEY.test(key)) continue;
    const sanitized = sanitizeFailureDetails(item, depth + 1);
    if (sanitized !== undefined) safe[key.slice(0, 100)] = sanitized;
  }
  return safe;
}

function safeCommandFailure(error: unknown): SafeCommandFailure {
  if (error instanceof AppError || error instanceof ProviderError) {
    const failure: SafeCommandFailure = {
      code: error.code,
      message: error.message.slice(0, FAILURE_MESSAGE_LIMIT),
    };
    const details = sanitizeFailureDetails(error.details);
    if (details !== undefined && JSON.stringify(details).length <= FAILURE_DETAILS_JSON_LIMIT) {
      failure.details = details;
    }
    return failure;
  }
  return { message: 'Course command failed.' };
}

export function commandFingerprint(value: unknown): string {
  return fnv1a32(JSON.stringify(value)).toString(16).padStart(8, '0');
}

/** Durable command identity and lease helper, intentionally not a workflow engine. */
export function createCourseCommandService({ repos, clock }: CourseCommandDeps) {
  function begin(
    command: CourseExecutionCommandEnvelope,
    operationType: string,
    expectedState: unknown,
    options: { leaseMs?: number } = {},
  ): ClaimedCourseCommand {
    const now = clock.now();
    let created: ReturnType<Repositories['operations']['createOrGet']>;
    try {
      created = repos.operations.createOrGet({
        id: newId('op'),
        workspaceId: command.workspaceId,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        logicalOperationId: `command:${command.commandId}`,
        operationType,
        expectedFingerprint: commandFingerprint(expectedState),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
    } catch (error) {
      throw new AppError(
        ApiErrorCode.VersionConflict,
        'The idempotency identity was reused for a different command.',
        { reason: error instanceof Error ? error.message : String(error) },
      );
    }

    if (!created.created) {
      const result = repos.operations.getResult(created.operation.id);
      if (result?.status === 'completed') {
        return {
          operationId: created.operation.id,
          owner: '',
          fencingToken: result.fencingToken,
          replayPayload: result.payload,
        };
      }
      if (result) {
        const message =
          typeof result.payload === 'object' &&
          result.payload !== null &&
          'message' in result.payload &&
          typeof result.payload.message === 'string'
            ? result.payload.message
            : 'The prior command attempt did not complete successfully.';
        const resultPayload =
          typeof result.payload === 'object' && result.payload !== null ? result.payload : null;
        const code =
          resultPayload && 'code' in resultPayload
            ? ApiErrorCodeSchema.safeParse(resultPayload.code)
            : null;
        if (code?.success) {
          throw new AppError(
            code.data,
            message,
            resultPayload && 'details' in resultPayload ? resultPayload.details : undefined,
          );
        }
        throw new AppError(ApiErrorCode.VersionConflict, message, {
          operationId: created.operation.id,
          priorStatus: result.status,
        });
      }
    }

    const owner = newId('worker');
    const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new Error('Course command lease must be finite and positive.');
    }
    const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
    const claimed = repos.operations.claim(
      created.operation.id,
      owner,
      leaseExpiresAt,
      now.toISOString(),
    );
    if (!claimed) {
      throw new AppError(ApiErrorCode.VersionConflict, 'This command is already in progress.', {
        operationId: created.operation.id,
      });
    }
    return {
      operationId: claimed.id,
      owner,
      fencingToken: claimed.fencingToken,
    };
  }

  function complete<T>(claim: ClaimedCourseCommand, mutate: () => T): T {
    if ('replayPayload' in claim) return claim.replayPayload as T;
    const at = clock.now().toISOString();
    return repos.transaction(() => {
      const payload = mutate();
      const finalized = repos.operations.finalize(
        { operationId: claim.operationId, status: 'completed', payload, createdAt: at },
        claim.owner,
        claim.fencingToken,
      );
      if (!finalized) throw new Error('Course command lost its operation lease.');
      return payload;
    });
  }

  function fail(claim: ClaimedCourseCommand, error: unknown): void {
    if ('replayPayload' in claim) return;
    const at = clock.now().toISOString();
    repos.operations.finalize(
      {
        operationId: claim.operationId,
        status: 'failed',
        payload: safeCommandFailure(error),
        createdAt: at,
      },
      claim.owner,
      claim.fencingToken,
    );
  }

  return { begin, complete, fail };
}

export type CourseCommandService = ReturnType<typeof createCourseCommandService>;
