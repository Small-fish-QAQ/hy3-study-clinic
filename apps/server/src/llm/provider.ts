/** Options shared by the eleven fixed course provider capabilities. */
export interface ProviderUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  estimatedCostMicrounits: number | null;
  currency: string | null;
  pricingSource: string | null;
  pricingVersion: string | null;
}
export interface ProviderRequestDiagnostic {
  outcome: 'response_received' | 'http_error' | 'timeout' | 'cancelled' | 'network_error';
  timeoutMs: number;
  requestBytes: number;
  maxTokens: number | null;
  headersReceived: boolean;
  bodyReadCompleted: boolean;
  waitForResponseMs: number;
  readResponseMs: number | null;
  elapsedMs: number;
  httpStatus: number | null;
  usageKnown: boolean;
  responseBytes?: number | null;
  visibleBodyBytes?: number | null;
  finishReason?: string | null;
  estimatedInputTokens?: number;
  estimation?: string;
  reasoningReserve?: number;
  effectiveCap?: number;
  visibleTarget?: number;
  streamChunks?: number;
  reasoningBytes?: number;
  upstreamRequestId?: string | null;
  schemaFindings?: { path: string; code: string }[];
  reasoningEffort?: string;
  softEstimateExceeded?: boolean;
  discardedOutputPaths?: string[];
  streamDone?: boolean;
  firstContentMs?: number | null;
  lastEventMs?: number | null;
  responseBodyState?:
    'waiting' | 'reasoning_only' | 'content_streaming' | 'finished_waiting_done' | 'complete';
}
export interface ProviderCallOptions {
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  onRequestSent?: () => void;
  onRequestStarted?: (metadata: { timeoutMs: number }) => void;
  onResponseHeaders?: () => void;
  onTransportRetry?: (error: Error) => void;
  onUsage?: (usage: ProviderUsage) => void;
  /** Complete public JSON candidate only; never partial output or reasoning. */
  onCandidate?: (candidate: unknown) => void;
  onRequestDiagnostic?: (diagnostic: ProviderRequestDiagnostic) => void;
}
