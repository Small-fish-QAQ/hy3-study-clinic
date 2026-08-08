import { ApiErrorCode, type ApiErrorCodeValue } from '@hy3-clinic/shared';

/** Application error carrying a machine-readable code; safe to expose. */
export class AppError extends Error {
  constructor(
    readonly code: ApiErrorCodeValue,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** Map error codes to HTTP status codes. */
export function statusForErrorCode(code: ApiErrorCodeValue): number {
  switch (code) {
    case ApiErrorCode.ValidationError:
    case ApiErrorCode.EmptySource:
      return 400;
    case ApiErrorCode.NotFound:
      return 404;
    case ApiErrorCode.SourceTooLarge:
      return 413;
    case ApiErrorCode.UnsupportedFile:
    case ApiErrorCode.BinaryInput:
      return 415;
    case ApiErrorCode.ParseFailed:
    case ApiErrorCode.GroundingFailed:
      return 422;
    case ApiErrorCode.DuplicateSubmission:
      return 409;
    case ApiErrorCode.RequestCancelled:
      return 499;
    case ApiErrorCode.ProviderError:
    case ApiErrorCode.ProviderInvalidOutput:
      return 502;
    case ApiErrorCode.ProviderTimeout:
      return 504;
    case ApiErrorCode.Internal:
      return 500;
  }
}

export function notFound(message = '资源不存在。'): AppError {
  return new AppError(ApiErrorCode.NotFound, message);
}
