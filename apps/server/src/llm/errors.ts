import { ApiErrorCode, type ApiErrorCodeValue } from '@hy3-clinic/shared';

export type ProviderErrorCode = Extract<
  ApiErrorCodeValue,
  'PROVIDER_ERROR' | 'PROVIDER_TIMEOUT' | 'PROVIDER_INVALID_OUTPUT' | 'REQUEST_CANCELLED'
>;

/**
 * Structured provider failure. Messages are user-facing and MUST NOT contain
 * API keys, endpoint URLs, raw HTTP bodies, or stack traces.
 */
export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly details?: unknown,
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

  static invalidOutput(summary: string, validationKind?: 'schema' | 'candidate'): ProviderError {
    return new ProviderError(
      ApiErrorCode.ProviderInvalidOutput,
      '模型返回的数据不符合约定格式,已在一次修复尝试后放弃。',
      { validation: summary, validationKind },
    );
  }

  static http(status: number): ProviderError {
    return new ProviderError(
      ApiErrorCode.ProviderError,
      `模型服务返回错误状态 ${status},请检查服务配置或稍后重试。`,
    );
  }

  static network(): ProviderError {
    return new ProviderError(
      ApiErrorCode.ProviderError,
      '无法连接模型服务,请检查网络与 HY3_BASE_URL 配置。',
    );
  }
}
