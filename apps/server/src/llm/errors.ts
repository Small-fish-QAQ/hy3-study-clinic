import { ApiErrorCode, type ApiErrorCodeValue } from '@hy3-clinic/shared';
export class ProviderError extends Error {
  constructor(
    readonly code: ApiErrorCodeValue,
    message: string,
    readonly details?: unknown,
    readonly technicalFailureCode?: string,
    readonly technicalHttpStatus?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
  static cancelled() {
    return new ProviderError(ApiErrorCode.RequestCancelled, '请求已取消。');
  }
  static timeout(ms: number) {
    return new ProviderError(
      ApiErrorCode.ProviderTimeout,
      '模型请求超过配置的等待时间。已保存成果保留，请显式重试未完成范围。',
      { timeoutMs: ms },
    );
  }
  static network() {
    return new ProviderError(
      ApiErrorCode.ProviderError,
      '无法连接模型服务，请检查网络与 API 地址。',
    );
  }
  static invalidOutput(_summary: string, _kind?: string, category?: string) {
    return new ProviderError(
      ApiErrorCode.ProviderInvalidOutput,
      category === 'EMPTY_RESPONSE'
        ? '模型没有返回可见正文；推理用量不能替代内容。'
        : category === 'TRUNCATED_OUTPUT'
          ? '模型输出被截断，部分结果未发布。'
          : '模型输出未通过当前内容合同。',
      undefined,
      category,
    );
  }
  static completeCandidate(candidate: unknown, findings: string[]) {
    return new ProviderError(
      ApiErrorCode.ProviderInvalidOutput,
      '模型完整候选存在可定位的内容合同错误。',
      { candidate, findings },
      'COMPLETE_CANDIDATE_INVALID',
    );
  }
  static http(status: number) {
    const message =
      status === 401
        ? 'API Key 错误或未授权。'
        : status === 403
          ? '账号没有访问该模型的权限。'
          : status === 404
            ? 'API 地址或 Model ID 不存在。'
            : status === 429
              ? '模型服务限流或配额不足，请稍后显式重试。'
              : status >= 500
                ? '模型服务暂时不可用，结果是否生成未知。'
                : `模型服务返回状态 ${status}，请检查配置。`;
    return new ProviderError(ApiErrorCode.ProviderError, message, undefined, undefined, status);
  }
}
