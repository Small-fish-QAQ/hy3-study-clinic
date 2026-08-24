import type { SqliteDb } from '../db/database.js';
import { newId } from '../util/ids.js';

export type AgentOperationStatus =
  'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface AgentOperation {
  id: string;
  workspaceId: string;
  commandId: string;
  idempotencyKey: string;
  logicalOperationId: string;
  operationType: string;
  expectedFingerprint: string;
  status: AgentOperationStatus;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  fencingToken: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentOperationEvent {
  id: string;
  operationId: string;
  seq: number;
  fencingToken: number;
  kind: string;
  payload: unknown;
  createdAt: string;
}

export interface AgentOperationResult {
  operationId: string;
  fencingToken: number;
  status: 'completed' | 'failed' | 'cancelled';
  payload: unknown;
  createdAt: string;
}

interface OperationRow {
  id: string;
  workspace_id: string;
  study_session_id: string | null;
  command_id: string;
  idempotency_key: string;
  logical_operation_id: string;
  operation_type: string;
  expected_fingerprint: string;
  status: AgentOperationStatus;
  lease_owner: string | null;
  lease_expires_at: string | null;
  fencing_token: number;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: string;
  operation_id: string;
  seq: number;
  fencing_token: number;
  kind: string;
  payload: string;
  created_at: string;
}

interface ResultRow {
  operation_id: string;
  fencing_token: number;
  status: AgentOperationResult['status'];
  payload: string;
  created_at: string;
}

function rowToOperation(row: OperationRow): AgentOperation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    commandId: row.command_id,
    idempotencyKey: row.idempotency_key,
    logicalOperationId: row.logical_operation_id,
    operationType: row.operation_type,
    expectedFingerprint: row.expected_fingerprint,
    status: row.status,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    fencingToken: row.fencing_token,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToEvent(row: EventRow): AgentOperationEvent {
  return {
    id: row.id,
    operationId: row.operation_id,
    seq: row.seq,
    fencingToken: row.fencing_token,
    kind: row.kind,
    payload: JSON.parse(row.payload) as unknown,
    createdAt: row.created_at,
  };
}

function rowToResult(row: ResultRow): AgentOperationResult {
  return {
    operationId: row.operation_id,
    fencingToken: row.fencing_token,
    status: row.status,
    payload: JSON.parse(row.payload) as unknown,
    createdAt: row.created_at,
  };
}

type CreateAgentOperationInput = Omit<
  AgentOperation,
  'status' | 'leaseOwner' | 'leaseExpiresAt' | 'fencingToken'
> & {
  studySessionId?: string | null;
};

type AgentOperationWrite = AgentOperation & {
  studySessionId: string | null;
};

function sameIdentity(existing: OperationRow, requested: AgentOperationWrite): boolean {
  return (
    existing.command_id === requested.commandId &&
    existing.idempotency_key === requested.idempotencyKey &&
    existing.logical_operation_id === requested.logicalOperationId &&
    existing.operation_type === requested.operationType &&
    existing.expected_fingerprint === requested.expectedFingerprint &&
    existing.study_session_id === requested.studySessionId
  );
}

function exclusivePrefixUpperBound(prefix: string): string {
  const codePoints = Array.from(prefix);
  for (let index = codePoints.length - 1; index >= 0; index -= 1) {
    const codePoint = codePoints[index]!.codePointAt(0)!;
    if (codePoint < 0x10ffff) {
      codePoints[index] = String.fromCodePoint(codePoint + 1);
      return codePoints.slice(0, index + 1).join('');
    }
  }
  throw new Error('Idempotency-key prefix must have an exclusive upper bound.');
}

/**
 * Durable command execution primitives. Provider work never runs inside
 * these transactions; workers claim a lease, work outside SQLite, then
 * finalize only while they still own the current fencing token.
 */
export function createOperationsRepo(db: SqliteDb) {
  const getRow = (id: string): OperationRow | undefined =>
    db.prepare('SELECT * FROM agent_operations WHERE id = ?').get(id) as OperationRow | undefined;

  function recoverOperation(
    operation: OperationRow,
    at: string,
    reason: 'lease_expired' | 'process_restart',
  ): void {
    const turnRows = db
      .prepare(
        `SELECT t.id, t.session_id
         FROM study_session_turns t
         JOIN model_logical_calls lc ON lc.id = t.logical_call_id
         WHERE lc.operation_id = ? AND t.status IN ('queued', 'running')
         ORDER BY t.session_id, t.seq`,
      )
      .all(operation.id) as Array<{ id: string; session_id: string }>;
    for (const turn of turnRows) {
      const changed = db
        .prepare(
          `UPDATE study_session_turns
           SET status = 'interrupted', completed_at = COALESCE(completed_at, ?),
               error_message = COALESCE(error_message, ?)
           WHERE id = ? AND status IN ('queued', 'running')`,
        )
        .run(
          at,
          reason === 'process_restart'
            ? 'Server restart interrupted this StudySession turn.'
            : 'Worker lease expired before this StudySession turn completed.',
          turn.id,
        ).changes;
      if (changed !== 1) continue;
      const nextTurnEventSeq = (
        db
          .prepare(
            `SELECT COALESCE(MAX(seq), -1) + 1 AS seq
             FROM study_turn_events WHERE turn_id = ?`,
          )
          .get(turn.id) as { seq: number }
      ).seq;
      db.prepare(
        `INSERT INTO study_turn_events
           (id, session_id, turn_id, seq, kind, provisional, content, created_at)
         VALUES (?, ?, ?, ?, 'interrupted', 0, ?, ?)`,
      ).run(newId('study_event'), turn.session_id, turn.id, nextTurnEventSeq, reason, at);
    }
    db.prepare(
      `UPDATE model_call_attempts
       SET status = CASE WHEN status = 'sent' THEN 'outcome_unknown' ELSE 'interrupted' END,
           completed_at = COALESCE(completed_at, ?),
           error_code = COALESCE(error_code, 'PROCESS_ORPHANED'),
           error_message = COALESCE(error_message, 'Worker lease expired before a result was durably observed.')
       WHERE logical_call_id IN
         (SELECT id FROM model_logical_calls WHERE operation_id = ?)
         AND status IN ('queued', 'sent')`,
    ).run(at, operation.id);
    const changed = db
      .prepare(
        `UPDATE agent_operations
         SET status = 'interrupted', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'running' AND fencing_token = ?`,
      )
      .run(at, operation.id, operation.fencing_token).changes;
    if (changed !== 1) throw new Error('Operation ownership changed during recovery.');
    const next = db
      .prepare(
        'SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM agent_operation_events WHERE operation_id = ?',
      )
      .get(operation.id) as { seq: number };
    db.prepare(
      `INSERT INTO agent_operation_events
         (id, operation_id, seq, fencing_token, kind, payload, created_at)
       VALUES (?, ?, ?, ?, 'operation_interrupted', ?, ?)`,
    ).run(
      newId('opevt'),
      operation.id,
      next.seq,
      operation.fencing_token,
      JSON.stringify({ reason }),
      at,
    );
  }

  const createOrGetTx = db.transaction(
    (operation: AgentOperationWrite): { operation: AgentOperation; created: boolean } => {
      if (operation.studySessionId !== null) {
        const ownedSession = db
          .prepare('SELECT 1 FROM study_sessions WHERE id = ? AND workspace_id = ?')
          .get(operation.studySessionId, operation.workspaceId);
        if (!ownedSession) {
          throw new Error('Operation StudySession ownership must belong to its workspace.');
        }
      }
      const byIdempotency = db
        .prepare('SELECT * FROM agent_operations WHERE workspace_id = ? AND idempotency_key = ?')
        .get(operation.workspaceId, operation.idempotencyKey) as OperationRow | undefined;
      if (byIdempotency) {
        const existing = rowToOperation(byIdempotency);
        if (!sameIdentity(byIdempotency, operation)) {
          throw new Error('Idempotency key was already used for a different operation identity.');
        }
        if (
          byIdempotency.status === 'running' &&
          byIdempotency.lease_expires_at !== null &&
          byIdempotency.lease_expires_at <= operation.updatedAt
        ) {
          recoverOperation(byIdempotency, operation.updatedAt, 'lease_expired');
        }
        return { operation: rowToOperation(getRow(existing.id)!), created: false };
      }

      const identityCollision = db
        .prepare(
          `SELECT id FROM agent_operations
           WHERE command_id = ? OR logical_operation_id = ? OR id = ?`,
        )
        .get(operation.commandId, operation.logicalOperationId, operation.id) as
        { id: string } | undefined;
      if (identityCollision) {
        throw new Error(`Operation identity is already in use: ${identityCollision.id}`);
      }

      db.prepare(
        `INSERT INTO agent_operations
           (id, workspace_id, study_session_id, command_id, idempotency_key, logical_operation_id,
            operation_type, expected_fingerprint, status, lease_owner,
            lease_expires_at, fencing_token, created_at, updated_at)
         VALUES
           (@id, @workspaceId, @studySessionId, @commandId, @idempotencyKey, @logicalOperationId,
            @operationType, @expectedFingerprint, 'queued', NULL, NULL, 0,
            @createdAt, @updatedAt)`,
      ).run({ ...operation, status: undefined, leaseOwner: undefined, leaseExpiresAt: undefined });
      return { operation: rowToOperation(getRow(operation.id)!), created: true };
    },
  );

  const claimTx = db.transaction(
    (
      operationId: string,
      owner: string,
      leaseExpiresAt: string,
      at: string,
    ): AgentOperation | undefined => {
      const current = getRow(operationId);
      if (!current || (current.status !== 'queued' && current.status !== 'interrupted')) {
        return undefined;
      }
      const nextToken = current.fencing_token + 1;
      const changed = db
        .prepare(
          `UPDATE agent_operations
           SET status = 'running', lease_owner = ?, lease_expires_at = ?,
               fencing_token = ?, updated_at = ?
           WHERE id = ? AND fencing_token = ? AND status = ?`,
        )
        .run(
          owner,
          leaseExpiresAt,
          nextToken,
          at,
          operationId,
          current.fencing_token,
          current.status,
        ).changes;
      return changed === 1 ? rowToOperation(getRow(operationId)!) : undefined;
    },
  );

  const appendEventTx = db.transaction(
    (
      event: Omit<AgentOperationEvent, 'seq' | 'fencingToken'>,
      owner: string,
      fencingToken: number,
    ): AgentOperationEvent | undefined => {
      const operation = getRow(event.operationId);
      if (
        !operation ||
        operation.status !== 'running' ||
        operation.lease_owner !== owner ||
        operation.fencing_token !== fencingToken ||
        operation.lease_expires_at === null ||
        operation.lease_expires_at <= event.createdAt
      ) {
        return undefined;
      }
      const next = db
        .prepare(
          'SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM agent_operation_events WHERE operation_id = ?',
        )
        .get(event.operationId) as { seq: number };
      db.prepare(
        `INSERT INTO agent_operation_events
           (id, operation_id, seq, fencing_token, kind, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        event.id,
        event.operationId,
        next.seq,
        fencingToken,
        event.kind,
        JSON.stringify(event.payload),
        event.createdAt,
      );
      return {
        ...event,
        seq: next.seq,
        fencingToken,
      };
    },
  );

  const finalizeTx = db.transaction(
    (
      result: Omit<AgentOperationResult, 'fencingToken'>,
      owner: string,
      fencingToken: number,
    ): boolean => {
      const existing = db
        .prepare('SELECT 1 FROM agent_operation_results WHERE operation_id = ?')
        .get(result.operationId);
      if (existing) return false;
      const operation = getRow(result.operationId);
      if (
        !operation ||
        operation.status !== 'running' ||
        operation.lease_owner !== owner ||
        operation.fencing_token !== fencingToken ||
        operation.lease_expires_at === null ||
        operation.lease_expires_at <= result.createdAt
      ) {
        return false;
      }

      db.prepare(
        `INSERT INTO agent_operation_results
           (operation_id, fencing_token, status, payload, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        result.operationId,
        fencingToken,
        result.status,
        JSON.stringify(result.payload),
        result.createdAt,
      );
      const changed = db
        .prepare(
          `UPDATE agent_operations
           SET status = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE id = ? AND status = 'running' AND lease_owner = ? AND fencing_token = ?`,
        )
        .run(result.status, result.createdAt, result.operationId, owner, fencingToken).changes;
      if (changed !== 1) throw new Error('Operation ownership changed during finalization.');
      return true;
    },
  );

  const recoverOrphansTx = db.transaction((at: string, includeUnexpired: boolean): number => {
    const expired = db
      .prepare(
        `SELECT * FROM agent_operations
         WHERE status = 'running'
           AND (? = 1 OR (lease_expires_at IS NOT NULL AND lease_expires_at <= ?))
         ORDER BY created_at ASC, id ASC`,
      )
      .all(includeUnexpired ? 1 : 0, at) as OperationRow[];
    for (const operation of expired) {
      recoverOperation(operation, at, includeUnexpired ? 'process_restart' : 'lease_expired');
    }
    return expired.length;
  });

  const recoverExpiredForWorkspaceTx = db.transaction(
    (workspaceId: string, operationType: string, at: string): number => {
      const expired = db
        .prepare(
          `SELECT * FROM agent_operations
           WHERE workspace_id = ? AND operation_type = ? AND status = 'running'
             AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
           ORDER BY created_at ASC, id ASC`,
        )
        .all(workspaceId, operationType, at) as OperationRow[];
      for (const operation of expired) recoverOperation(operation, at, 'lease_expired');
      return expired.length;
    },
  );

  return {
    createOrGet(operation: CreateAgentOperationInput): {
      operation: AgentOperation;
      created: boolean;
    } {
      return createOrGetTx({
        ...operation,
        studySessionId: operation.studySessionId ?? null,
        status: 'queued',
        leaseOwner: null,
        leaseExpiresAt: null,
        fencingToken: 0,
      });
    },

    get(id: string): AgentOperation | undefined {
      const row = getRow(id);
      return row ? rowToOperation(row) : undefined;
    },

    getByIdempotencyKey(workspaceId: string, idempotencyKey: string): AgentOperation | undefined {
      const row = db
        .prepare('SELECT * FROM agent_operations WHERE workspace_id = ? AND idempotency_key = ?')
        .get(workspaceId, idempotencyKey) as OperationRow | undefined;
      return row ? rowToOperation(row) : undefined;
    },

    findLatestByIdempotencyPrefix(
      workspaceId: string,
      operationType: string,
      prefix: string,
      statuses?: readonly AgentOperationStatus[],
    ): AgentOperation | undefined {
      if (prefix.length === 0) throw new Error('Idempotency-key prefix must not be empty.');
      if (statuses?.length === 0) return undefined;
      const statusClause = statuses ? ` AND status IN (${statuses.map(() => '?').join(', ')})` : '';
      const row = db
        .prepare(
          `SELECT * FROM agent_operations
           WHERE workspace_id = ? AND operation_type = ?
             AND idempotency_key >= ? AND idempotency_key < ?${statusClause}
           ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .get(
          workspaceId,
          operationType,
          prefix,
          exclusivePrefixUpperBound(prefix),
          ...(statuses ?? []),
        ) as OperationRow | undefined;
      return row ? rowToOperation(row) : undefined;
    },

    listForWorkspace(workspaceId: string, operationType: string, limit = 50): AgentOperation[] {
      const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
      const rows = db
        .prepare(
          `SELECT * FROM agent_operations
           WHERE workspace_id = ? AND operation_type = ?
           ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(workspaceId, operationType, boundedLimit) as OperationRow[];
      return rows.map(rowToOperation);
    },

    claim(operationId: string, owner: string, leaseExpiresAt: string, at: string) {
      return claimTx(operationId, owner, leaseExpiresAt, at);
    },

    renewLease(
      operationId: string,
      owner: string,
      fencingToken: number,
      leaseExpiresAt: string,
      at: string,
    ): boolean {
      if (leaseExpiresAt <= at) return false;
      return (
        db
          .prepare(
            `UPDATE agent_operations SET lease_expires_at = ?, updated_at = ?
             WHERE id = ? AND status = 'running' AND lease_owner = ? AND fencing_token = ?
               AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`,
          )
          .run(leaseExpiresAt, at, operationId, owner, fencingToken, at).changes === 1
      );
    },

    appendEvent(
      event: Omit<AgentOperationEvent, 'seq' | 'fencingToken'>,
      owner: string,
      fencingToken: number,
    ): AgentOperationEvent | undefined {
      return appendEventTx(event, owner, fencingToken);
    },

    listEvents(operationId: string): AgentOperationEvent[] {
      const rows = db
        .prepare('SELECT * FROM agent_operation_events WHERE operation_id = ? ORDER BY seq ASC')
        .all(operationId) as EventRow[];
      return rows.map(rowToEvent);
    },

    finalize(
      result: Omit<AgentOperationResult, 'fencingToken'>,
      owner: string,
      fencingToken: number,
    ): boolean {
      return finalizeTx(result, owner, fencingToken);
    },

    getResult(operationId: string): AgentOperationResult | undefined {
      const row = db
        .prepare('SELECT * FROM agent_operation_results WHERE operation_id = ?')
        .get(operationId) as ResultRow | undefined;
      return row ? rowToResult(row) : undefined;
    },

    recoverExpired(at: string): number {
      return recoverOrphansTx(at, false);
    },

    recoverExpiredForWorkspace(workspaceId: string, operationType: string, at: string): number {
      return recoverExpiredForWorkspaceTx(workspaceId, operationType, at);
    },

    /** Every running operation belongs to the previous process at startup. */
    recoverRunningAfterRestart(at: string): number {
      return recoverOrphansTx(at, true);
    },
  };
}

export type OperationsRepo = ReturnType<typeof createOperationsRepo>;
