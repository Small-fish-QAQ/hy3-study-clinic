import type { SqliteDb } from '../db/database.js';

export type LogicalCallStatus = 'open' | 'completed' | 'failed' | 'cancelled';
export type CacheLookupStatus = 'not_checked' | 'hit' | 'miss' | 'bypassed';
export type ModelAttemptStatus =
  'queued' | 'sent' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'outcome_unknown';

export interface ModelLogicalCall {
  id: string;
  operationId: string | null;
  workspaceId: string;
  studySessionId: string | null;
  learningUnitId: string | null;
  assessmentId: string | null;
  operationType: string;
  cacheKey: string | null;
  cacheStatus: CacheLookupStatus;
  promptFingerprint: string | null;
  schemaFingerprint: string | null;
  policyFingerprint: string | null;
  sourceFingerprint: string | null;
  status: LogicalCallStatus;
  createdAt: string;
  completedAt: string | null;
}

export interface ModelCallAttempt {
  id: string;
  logicalCallId: string;
  attemptNumber: number;
  attemptKind: 'original' | 'repair' | 'retry' | 'fallback';
  provider: string;
  model: string | null;
  fencingToken: number;
  status: ModelAttemptStatus;
  startedAt: string;
  sentAt: string | null;
  firstTokenAt: string | null;
  completedAt: string | null;
  latencyMs: number | null;
  timeToFirstTokenMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface ModelUsageRecord {
  id: string;
  attemptId: string;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  estimatedCostMicrounits: number | null;
  currency: string | null;
  pricingSource: string | null;
  pricingVersion: string | null;
  recordedAt: string;
}

export interface SemanticCacheEntry {
  cacheKey: string;
  operationType: string;
  workspaceId: string | null;
  result: unknown;
  provider: string | null;
  model: string | null;
  promptFingerprint: string | null;
  schemaFingerprint: string | null;
  policyFingerprint: string | null;
  sourceFingerprint: string | null;
  validationFingerprint: string;
  createdAt: string;
  expiresAt: string | null;
  invalidatedAt: string | null;
  hitCount: number;
  lastHitAt: string | null;
}

export interface CostPolicy {
  id: string;
  policyKey: string;
  workspaceId: string | null;
  scopeType: 'operation' | 'session' | 'day' | 'course';
  scopeKey: string;
  limitMicrounits: number;
  currency: string;
  onExceed: 'confirm' | 'cache_only' | 'lower_cost_or_confirm' | 'refuse';
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UsageScope {
  scopeType: CostPolicy['scopeType'];
  scopeKey: string;
}

interface LogicalCallRow {
  id: string;
  operation_id: string | null;
  workspace_id: string;
  study_session_id: string | null;
  learning_unit_id: string | null;
  assessment_id: string | null;
  operation_type: string;
  cache_key: string | null;
  cache_status: CacheLookupStatus;
  prompt_fingerprint: string | null;
  schema_fingerprint: string | null;
  policy_fingerprint: string | null;
  source_fingerprint: string | null;
  status: LogicalCallStatus;
  created_at: string;
  completed_at: string | null;
}

interface AttemptRow {
  id: string;
  logical_call_id: string;
  attempt_number: number;
  attempt_kind: ModelCallAttempt['attemptKind'];
  provider: string;
  model: string | null;
  fencing_token: number;
  status: ModelAttemptStatus;
  started_at: string;
  sent_at: string | null;
  first_token_at: string | null;
  completed_at: string | null;
  latency_ms: number | null;
  time_to_first_token_ms: number | null;
  error_code: string | null;
  error_message: string | null;
}

interface UsageRow {
  id: string;
  attempt_id: string;
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  estimated_cost_microunits: number | null;
  currency: string | null;
  pricing_source: string | null;
  pricing_version: string | null;
  recorded_at: string;
}

interface CacheRow {
  cache_key: string;
  operation_type: string;
  workspace_id: string | null;
  result_payload: string;
  provider: string | null;
  model: string | null;
  prompt_fingerprint: string | null;
  schema_fingerprint: string | null;
  policy_fingerprint: string | null;
  source_fingerprint: string | null;
  validation_fingerprint: string;
  created_at: string;
  expires_at: string | null;
  invalidated_at: string | null;
  hit_count: number;
  last_hit_at: string | null;
}

interface CostPolicyRow {
  id: string;
  policy_key: string;
  workspace_id: string | null;
  scope_type: CostPolicy['scopeType'];
  scope_key: string;
  limit_microunits: number;
  currency: string;
  on_exceed: CostPolicy['onExceed'];
  enabled: number;
  created_at: string;
  updated_at: string;
}

function rowToLogicalCall(row: LogicalCallRow): ModelLogicalCall {
  return {
    id: row.id,
    operationId: row.operation_id,
    workspaceId: row.workspace_id,
    studySessionId: row.study_session_id,
    learningUnitId: row.learning_unit_id,
    assessmentId: row.assessment_id,
    operationType: row.operation_type,
    cacheKey: row.cache_key,
    cacheStatus: row.cache_status,
    promptFingerprint: row.prompt_fingerprint,
    schemaFingerprint: row.schema_fingerprint,
    policyFingerprint: row.policy_fingerprint,
    sourceFingerprint: row.source_fingerprint,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function rowToAttempt(row: AttemptRow): ModelCallAttempt {
  return {
    id: row.id,
    logicalCallId: row.logical_call_id,
    attemptNumber: row.attempt_number,
    attemptKind: row.attempt_kind,
    provider: row.provider,
    model: row.model,
    fencingToken: row.fencing_token,
    status: row.status,
    startedAt: row.started_at,
    sentAt: row.sent_at,
    firstTokenAt: row.first_token_at,
    completedAt: row.completed_at,
    latencyMs: row.latency_ms,
    timeToFirstTokenMs: row.time_to_first_token_ms,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
}

function rowToUsage(row: UsageRow): ModelUsageRecord {
  return {
    id: row.id,
    attemptId: row.attempt_id,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    reasoningTokens: row.reasoning_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    estimatedCostMicrounits: row.estimated_cost_microunits,
    currency: row.currency,
    pricingSource: row.pricing_source,
    pricingVersion: row.pricing_version,
    recordedAt: row.recorded_at,
  };
}

function rowToCache(row: CacheRow): SemanticCacheEntry {
  return {
    cacheKey: row.cache_key,
    operationType: row.operation_type,
    workspaceId: row.workspace_id,
    result: JSON.parse(row.result_payload) as unknown,
    provider: row.provider,
    model: row.model,
    promptFingerprint: row.prompt_fingerprint,
    schemaFingerprint: row.schema_fingerprint,
    policyFingerprint: row.policy_fingerprint,
    sourceFingerprint: row.source_fingerprint,
    validationFingerprint: row.validation_fingerprint,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    invalidatedAt: row.invalidated_at,
    hitCount: row.hit_count,
    lastHitAt: row.last_hit_at,
  };
}

function rowToCostPolicy(row: CostPolicyRow): CostPolicy {
  return {
    id: row.id,
    policyKey: row.policy_key,
    workspaceId: row.workspace_id,
    scopeType: row.scope_type,
    scopeKey: row.scope_key,
    limitMicrounits: row.limit_microunits,
    currency: row.currency,
    onExceed: row.on_exceed,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Logical-call, physical-attempt, usage, cache, and optional cap storage. */
export function createTelemetryRepo(db: SqliteDb) {
  const usageSummaryForWhere = (
    workspaceId: string,
    where: string,
    params: unknown[],
  ): {
    logicalCalls: number;
    physicalAttempts: number;
    cacheHits: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    estimatedCostMicrounits: number;
    attemptsWithKnownCost: number;
  } =>
    db
      .prepare(
        `SELECT
           COUNT(DISTINCT lc.id) AS logicalCalls,
           COUNT(DISTINCT a.id) AS physicalAttempts,
           COUNT(DISTINCT CASE WHEN lc.cache_status = 'hit' THEN lc.id END) AS cacheHits,
           COALESCE(SUM(u.input_tokens), 0) AS inputTokens,
           COALESCE(SUM(u.output_tokens), 0) AS outputTokens,
           COALESCE(SUM(u.reasoning_tokens), 0) AS reasoningTokens,
           COALESCE(SUM(u.estimated_cost_microunits), 0) AS estimatedCostMicrounits,
           COUNT(u.estimated_cost_microunits) AS attemptsWithKnownCost
         FROM model_logical_calls lc
         LEFT JOIN model_call_attempts a ON a.logical_call_id = lc.id
         LEFT JOIN model_usage_records u ON u.attempt_id = a.id
         WHERE lc.workspace_id = ? AND ${where}`,
      )
      .get(workspaceId, ...params) as {
      logicalCalls: number;
      physicalAttempts: number;
      cacheHits: number;
      inputTokens: number;
      outputTokens: number;
      reasoningTokens: number;
      estimatedCostMicrounits: number;
      attemptsWithKnownCost: number;
    };

  const cacheLookupTx = db.transaction(
    (
      cacheKey: string,
      validationFingerprint: string,
      at: string,
    ): SemanticCacheEntry | undefined => {
      const row = db
        .prepare(
          `SELECT * FROM semantic_cache_entries
           WHERE cache_key = ? AND validation_fingerprint = ?
             AND invalidated_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
        )
        .get(cacheKey, validationFingerprint, at) as CacheRow | undefined;
      if (!row) return undefined;
      db.prepare(
        `UPDATE semantic_cache_entries
         SET hit_count = hit_count + 1, last_hit_at = ? WHERE cache_key = ?`,
      ).run(at, cacheKey);
      return rowToCache({ ...row, hit_count: row.hit_count + 1, last_hit_at: at });
    },
  );

  const putCacheTx = db.transaction((entry: SemanticCacheEntry): boolean => {
    const existing = db
      .prepare('SELECT * FROM semantic_cache_entries WHERE cache_key = ?')
      .get(entry.cacheKey) as CacheRow | undefined;
    if (existing) {
      if (
        existing.validation_fingerprint !== entry.validationFingerprint ||
        existing.operation_type !== entry.operationType ||
        existing.result_payload !== JSON.stringify(entry.result)
      ) {
        throw new Error('Cache key collision with a different validated result.');
      }
      return false;
    }
    db.prepare(
      `INSERT INTO semantic_cache_entries
         (cache_key, operation_type, workspace_id, result_payload, provider, model,
          prompt_fingerprint, schema_fingerprint, policy_fingerprint, source_fingerprint,
          validation_fingerprint, created_at, expires_at, invalidated_at, hit_count, last_hit_at)
       VALUES
         (@cacheKey, @operationType, @workspaceId, @resultPayload, @provider, @model,
          @promptFingerprint, @schemaFingerprint, @policyFingerprint, @sourceFingerprint,
          @validationFingerprint, @createdAt, @expiresAt, @invalidatedAt, @hitCount, @lastHitAt)`,
    ).run({ ...entry, resultPayload: JSON.stringify(entry.result), result: undefined });
    return true;
  });

  return {
    insertLogicalCall(call: ModelLogicalCall): void {
      db.prepare(
        `INSERT INTO model_logical_calls
           (id, operation_id, workspace_id, study_session_id, learning_unit_id, assessment_id,
            operation_type, cache_key, cache_status, prompt_fingerprint, schema_fingerprint,
            policy_fingerprint, source_fingerprint, status, created_at, completed_at)
         VALUES
           (@id, @operationId, @workspaceId, @studySessionId, @learningUnitId, @assessmentId,
            @operationType, @cacheKey, @cacheStatus, @promptFingerprint, @schemaFingerprint,
            @policyFingerprint, @sourceFingerprint, @status, @createdAt, @completedAt)`,
      ).run(call);
    },

    getLogicalCall(id: string): ModelLogicalCall | undefined {
      const row = db.prepare('SELECT * FROM model_logical_calls WHERE id = ?').get(id) as
        LogicalCallRow | undefined;
      return row ? rowToLogicalCall(row) : undefined;
    },

    completeLogicalCall(
      id: string,
      status: Exclude<LogicalCallStatus, 'open'>,
      completedAt: string,
    ): boolean {
      return (
        db
          .prepare(
            `UPDATE model_logical_calls SET status = ?, completed_at = ?
             WHERE id = ? AND status = 'open'`,
          )
          .run(status, completedAt, id).changes === 1
      );
    },

    setCacheStatus(id: string, status: CacheLookupStatus, cacheKey: string | null): boolean {
      return (
        db
          .prepare(
            `UPDATE model_logical_calls SET cache_status = ?, cache_key = ?
             WHERE id = ? AND status = 'open'`,
          )
          .run(status, cacheKey, id).changes === 1
      );
    },

    insertAttempt(attempt: ModelCallAttempt): void {
      db.prepare(
        `INSERT INTO model_call_attempts
           (id, logical_call_id, attempt_number, attempt_kind, provider, model, fencing_token, status,
            started_at, sent_at, first_token_at, completed_at, latency_ms,
            time_to_first_token_ms, error_code, error_message)
         VALUES
           (@id, @logicalCallId, @attemptNumber, @attemptKind, @provider, @model, @fencingToken, @status,
            @startedAt, @sentAt, @firstTokenAt, @completedAt, @latencyMs,
            @timeToFirstTokenMs, @errorCode, @errorMessage)`,
      ).run(attempt);
    },

    getAttempt(id: string): ModelCallAttempt | undefined {
      const row = db.prepare('SELECT * FROM model_call_attempts WHERE id = ?').get(id) as
        AttemptRow | undefined;
      return row ? rowToAttempt(row) : undefined;
    },

    listAttempts(logicalCallId: string): ModelCallAttempt[] {
      const rows = db
        .prepare(
          `SELECT * FROM model_call_attempts WHERE logical_call_id = ?
           ORDER BY attempt_number ASC`,
        )
        .all(logicalCallId) as AttemptRow[];
      return rows.map(rowToAttempt);
    },

    markAttemptSent(id: string, sentAt: string): boolean {
      return (
        db
          .prepare(
            `UPDATE model_call_attempts SET status = 'sent', sent_at = ?
             WHERE id = ? AND status = 'queued'`,
          )
          .run(sentAt, id).changes === 1
      );
    },

    finishAttempt(
      id: string,
      update: {
        status: Exclude<ModelAttemptStatus, 'queued' | 'sent'>;
        completedAt: string;
        firstTokenAt?: string | null;
        latencyMs?: number | null;
        timeToFirstTokenMs?: number | null;
        errorCode?: string | null;
        errorMessage?: string | null;
      },
    ): boolean {
      return (
        db
          .prepare(
            `UPDATE model_call_attempts
             SET status = @status, completed_at = @completedAt,
                 first_token_at = @firstTokenAt, latency_ms = @latencyMs,
                 time_to_first_token_ms = @timeToFirstTokenMs,
                 error_code = @errorCode, error_message = @errorMessage
             WHERE id = @id AND status IN ('queued', 'sent')`,
          )
          .run({
            id,
            status: update.status,
            completedAt: update.completedAt,
            firstTokenAt: update.firstTokenAt ?? null,
            latencyMs: update.latencyMs ?? null,
            timeToFirstTokenMs: update.timeToFirstTokenMs ?? null,
            errorCode: update.errorCode ?? null,
            errorMessage: update.errorMessage ?? null,
          }).changes === 1
      );
    },

    insertUsage(usage: ModelUsageRecord): void {
      db.prepare(
        `INSERT INTO model_usage_records
           (id, attempt_id, input_tokens, output_tokens, reasoning_tokens,
            cache_read_tokens, cache_write_tokens, estimated_cost_microunits,
            currency, pricing_source, pricing_version, recorded_at)
         VALUES
           (@id, @attemptId, @inputTokens, @outputTokens, @reasoningTokens,
            @cacheReadTokens, @cacheWriteTokens, @estimatedCostMicrounits,
            @currency, @pricingSource, @pricingVersion, @recordedAt)`,
      ).run(usage);
    },

    getUsageByAttempt(attemptId: string): ModelUsageRecord | undefined {
      const row = db
        .prepare('SELECT * FROM model_usage_records WHERE attempt_id = ?')
        .get(attemptId) as UsageRow | undefined;
      return row ? rowToUsage(row) : undefined;
    },

    usageSummary(workspaceId: string): {
      logicalCalls: number;
      physicalAttempts: number;
      cacheHits: number;
      inputTokens: number;
      outputTokens: number;
      reasoningTokens: number;
      estimatedCostMicrounits: number;
      attemptsWithKnownCost: number;
    } {
      return usageSummaryForWhere(workspaceId, '1 = 1', []);
    },

    usageSummaryForScope(workspaceId: string, scope: UsageScope) {
      switch (scope.scopeType) {
        case 'operation':
          return usageSummaryForWhere(workspaceId, 'lc.operation_type = ?', [scope.scopeKey]);
        case 'session':
          return usageSummaryForWhere(workspaceId, 'lc.study_session_id = ?', [scope.scopeKey]);
        case 'day':
          return usageSummaryForWhere(workspaceId, 'substr(lc.created_at, 1, 10) = ?', [
            scope.scopeKey,
          ]);
        case 'course':
          return usageSummaryForWhere(workspaceId, '1 = 1', []);
      }
    },

    putCache(entry: Omit<SemanticCacheEntry, 'hitCount' | 'lastHitAt'>): boolean {
      return putCacheTx({ ...entry, hitCount: 0, lastHitAt: null });
    },

    getCache(
      cacheKey: string,
      validationFingerprint: string,
      at: string,
    ): SemanticCacheEntry | undefined {
      return cacheLookupTx(cacheKey, validationFingerprint, at);
    },

    invalidateCache(cacheKey: string, at: string): boolean {
      return (
        db
          .prepare(
            `UPDATE semantic_cache_entries SET invalidated_at = ?
             WHERE cache_key = ? AND invalidated_at IS NULL`,
          )
          .run(at, cacheKey).changes === 1
      );
    },

    upsertCostPolicy(policy: CostPolicy): void {
      db.prepare(
        `INSERT INTO cost_policies
           (id, policy_key, workspace_id, scope_type, scope_key, limit_microunits,
            currency, on_exceed, enabled, created_at, updated_at)
         VALUES
           (@id, @policyKey, @workspaceId, @scopeType, @scopeKey, @limitMicrounits,
            @currency, @onExceed, @enabled, @createdAt, @updatedAt)
         ON CONFLICT(policy_key) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           scope_type = excluded.scope_type,
           scope_key = excluded.scope_key,
           limit_microunits = excluded.limit_microunits,
           currency = excluded.currency,
           on_exceed = excluded.on_exceed,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      ).run({ ...policy, enabled: policy.enabled ? 1 : 0 });
    },

    getCostPolicy(policyKey: string): CostPolicy | undefined {
      const row = db.prepare('SELECT * FROM cost_policies WHERE policy_key = ?').get(policyKey) as
        CostPolicyRow | undefined;
      return row ? rowToCostPolicy(row) : undefined;
    },

    listEnabledCostPolicies(workspaceId: string): CostPolicy[] {
      const rows = db
        .prepare(
          `SELECT * FROM cost_policies
           WHERE enabled = 1 AND (workspace_id = ? OR workspace_id IS NULL)
           ORDER BY created_at ASC, id ASC`,
        )
        .all(workspaceId) as CostPolicyRow[];
      return rows.map(rowToCostPolicy);
    },
  };
}

export type TelemetryRepo = ReturnType<typeof createTelemetryRepo>;
