import { ApiErrorCode, type ApiErrorCodeValue } from '@hy3-clinic/shared';
import type {
  ProviderCandidateFailureArtifact,
  ProviderCandidateFailureValue,
  StructuredOutputDiagnostic,
  StructuredOutputFailureCategory,
} from './provider.js';

export type ProviderErrorCode = Extract<
  ApiErrorCodeValue,
  'PROVIDER_ERROR' | 'PROVIDER_TIMEOUT' | 'PROVIDER_INVALID_OUTPUT' | 'REQUEST_CANCELLED'
>;

const CANDIDATE_FAILURE_STRING_LIMIT = 500;
const CANDIDATE_FAILURE_ARRAY_LIMIT = 20;
const CANDIDATE_FAILURE_OBJECT_KEY_LIMIT = 30;
const CANDIDATE_FAILURE_DEPTH_LIMIT = 4;
const BLOCKED_CANDIDATE_FAILURE_KEY =
  /authorization|api.?key|secret|token|prompt|raw|payload|body|stack/iu;

function sanitizeCandidateFailureValue(
  value: unknown,
  depth = 0,
): ProviderCandidateFailureValue | undefined {
  if (depth > CANDIDATE_FAILURE_DEPTH_LIMIT) return undefined;
  if (typeof value === 'string') return value.slice(0, CANDIDATE_FAILURE_STRING_LIMIT);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) {
    return value
      .slice(0, CANDIDATE_FAILURE_ARRAY_LIMIT)
      .map((item) => sanitizeCandidateFailureValue(item, depth + 1))
      .filter((item): item is ProviderCandidateFailureValue => item !== undefined);
  }
  if (typeof value !== 'object') return undefined;
  const safe: Record<string, ProviderCandidateFailureValue> = {};
  for (const [key, item] of Object.entries(value).slice(0, CANDIDATE_FAILURE_OBJECT_KEY_LIMIT)) {
    if (BLOCKED_CANDIDATE_FAILURE_KEY.test(key)) continue;
    const sanitized = sanitizeCandidateFailureValue(item, depth + 1);
    if (sanitized !== undefined) safe[key.slice(0, 100)] = sanitized;
  }
  return safe;
}

export function sanitizeProviderCandidateFailureArtifact(
  artifact: unknown,
): ProviderCandidateFailureArtifact | undefined {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) return undefined;
  const record = artifact as Record<string, unknown>;
  if (typeof record.kind !== 'string' || !Array.isArray(record.diagnostics)) return undefined;
  const context = record.context ? sanitizeCandidateFailureValue(record.context) : undefined;
  const diagnostics = record.diagnostics
    .slice(0, CANDIDATE_FAILURE_ARRAY_LIMIT)
    .flatMap((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const diagnostic = value as Record<string, unknown>;
      if (typeof diagnostic.code !== 'string' || typeof diagnostic.message !== 'string') return [];
      const facts = diagnostic.facts ? sanitizeCandidateFailureValue(diagnostic.facts) : undefined;
      return [
        {
          code: diagnostic.code.slice(0, 100),
          message: diagnostic.message.slice(0, CANDIDATE_FAILURE_STRING_LIMIT),
          ...(facts && !Array.isArray(facts) && typeof facts === 'object' ? { facts } : {}),
        },
      ];
    });
  return {
    kind: record.kind.slice(0, 100),
    ...(context && !Array.isArray(context) && typeof context === 'object' ? { context } : {}),
    diagnostics,
  };
}

function sanitizeStructuredOutputFailure(diagnostic: StructuredOutputDiagnostic | undefined) {
  if (!diagnostic || diagnostic.failureCategory === null) return undefined;
  return {
    attemptNumber: diagnostic.attemptNumber,
    attemptKind: diagnostic.attemptKind,
    finishReason: diagnostic.finishReason,
    truncated: diagnostic.truncated,
    possiblyIncomplete: diagnostic.possiblyIncomplete,
    jsonParseSuccess: diagnostic.jsonParseSuccess,
    jsonFormat: diagnostic.jsonFormat,
    schemaIssueCount: diagnostic.schemaIssueCount,
    schemaIssues: diagnostic.schemaIssues.slice(0, 20).map((issue) => ({
      path: issue.path.slice(0, 500),
      code: issue.code.slice(0, 100),
    })),
    failureCategory: diagnostic.failureCategory,
    repairAction: diagnostic.repairAction,
  };
}

/**
 * Structured provider failure. Messages are user-facing and MUST NOT contain
 * API keys, endpoint URLs, raw HTTP bodies, or stack traces.
 */
export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly details?: unknown,
    readonly technicalFailureCode?: string,
    readonly technicalHttpStatus?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  static timeout(ms: number): ProviderError {
    return new ProviderError(
      ApiErrorCode.ProviderTimeout,
      '模型服务响应时间超过预期，请稍后重试。',
      { timeoutMs: ms },
    );
  }

  static cancelled(): ProviderError {
    return new ProviderError(ApiErrorCode.RequestCancelled, '请求已取消。');
  }

  static invalidOutput(
    _summary: string,
    validationKind?: 'schema' | 'candidate',
    failureCategory?: StructuredOutputFailureCategory,
    repairExhausted = false,
    candidateFailure?: ProviderCandidateFailureArtifact,
    structuredOutputDiagnostic?: StructuredOutputDiagnostic,
  ): ProviderError {
    const safeCandidateFailure = sanitizeProviderCandidateFailureArtifact(candidateFailure);
    const structuredFailure = sanitizeStructuredOutputFailure(structuredOutputDiagnostic);
    return new ProviderError(
      ApiErrorCode.ProviderInvalidOutput,
      repairExhausted
        ? '模型返回的数据不符合约定格式,已在一次修复尝试后放弃。'
        : '模型返回的数据不符合约定格式。',
      validationKind
        ? {
            validationKind,
            ...(safeCandidateFailure ? { candidateFailure: safeCandidateFailure } : {}),
            ...(structuredFailure ? { structuredFailure } : {}),
          }
        : undefined,
      failureCategory
        ? repairExhausted
          ? `REPAIR_EXHAUSTED:${failureCategory}`
          : failureCategory
        : undefined,
    );
  }

  static http(status: number): ProviderError {
    return new ProviderError(
      ApiErrorCode.ProviderError,
      `模型服务返回错误状态 ${status},请检查服务配置或稍后重试。`,
      undefined,
      undefined,
      status,
    );
  }

  static network(): ProviderError {
    return new ProviderError(
      ApiErrorCode.ProviderError,
      '无法连接模型服务,请检查网络与 HY3_BASE_URL 配置。',
    );
  }
}
