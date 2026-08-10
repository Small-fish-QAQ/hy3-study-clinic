import { ApiErrorCode, fnv1a32, type CourseExecutionCommandEnvelope } from '@hy3-clinic/shared';
import { AppError } from '../errors.js';
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

const LEASE_MS = 5 * 60 * 1000;

export function commandFingerprint(value: unknown): string {
  return fnv1a32(JSON.stringify(value)).toString(16).padStart(8, '0');
}

/** Durable command identity and lease helper, intentionally not a workflow engine. */
export function createCourseCommandService({ repos, clock }: CourseCommandDeps) {
  function begin(
    command: CourseExecutionCommandEnvelope,
    operationType: string,
    expectedState: unknown,
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
        throw new AppError(ApiErrorCode.VersionConflict, message, {
          operationId: created.operation.id,
          priorStatus: result.status,
        });
      }
    }

    const owner = newId('worker');
    const leaseExpiresAt = new Date(now.getTime() + LEASE_MS).toISOString();
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
        payload: {
          message: error instanceof Error ? error.message.slice(0, 500) : 'Course command failed.',
        },
        createdAt: at,
      },
      claim.owner,
      claim.fencingToken,
    );
  }

  return { begin, complete, fail };
}

export type CourseCommandService = ReturnType<typeof createCourseCommandService>;
