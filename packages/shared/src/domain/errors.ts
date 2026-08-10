import { z } from 'zod';

/** Machine-readable error codes used across the API. */
export const ApiErrorCode = {
  ValidationError: 'VALIDATION_ERROR',
  NotFound: 'NOT_FOUND',
  EmptySource: 'EMPTY_SOURCE',
  SourceTooLarge: 'SOURCE_TOO_LARGE',
  UnsupportedFile: 'UNSUPPORTED_FILE',
  BinaryInput: 'BINARY_INPUT',
  ParseFailed: 'PARSE_FAILED',
  GroundingFailed: 'GROUNDING_FAILED',
  DuplicateSubmission: 'DUPLICATE_SUBMISSION',
  VersionConflict: 'VERSION_CONFLICT',
  ProviderError: 'PROVIDER_ERROR',
  ProviderTimeout: 'PROVIDER_TIMEOUT',
  ProviderInvalidOutput: 'PROVIDER_INVALID_OUTPUT',
  RequestCancelled: 'REQUEST_CANCELLED',
  Internal: 'INTERNAL',
} as const;
export type ApiErrorCodeValue = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

export const ApiErrorCodeSchema = z.enum([
  ApiErrorCode.ValidationError,
  ApiErrorCode.NotFound,
  ApiErrorCode.EmptySource,
  ApiErrorCode.SourceTooLarge,
  ApiErrorCode.UnsupportedFile,
  ApiErrorCode.BinaryInput,
  ApiErrorCode.ParseFailed,
  ApiErrorCode.GroundingFailed,
  ApiErrorCode.DuplicateSubmission,
  ApiErrorCode.VersionConflict,
  ApiErrorCode.ProviderError,
  ApiErrorCode.ProviderTimeout,
  ApiErrorCode.ProviderInvalidOutput,
  ApiErrorCode.RequestCancelled,
  ApiErrorCode.Internal,
]);

/**
 * Structured error body returned by every failing API route.
 * `message` is safe to show to the user and never contains secrets,
 * stack traces, or raw provider payloads.
 */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    message: z.string().min(1),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
