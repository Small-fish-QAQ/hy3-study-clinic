export interface BudgetInput {
  messages: unknown;
  schema: unknown;
  visibleTokens: number;
  outputCap: number;
  contextCap?: number;
  reasoningEstimate?: number;
  historicalReasoning?: number | null;
}
export function planRequestBudget(input: BudgetInput) {
  const bytes =
    Buffer.byteLength(JSON.stringify(input.messages), 'utf8') +
    Buffer.byteLength(JSON.stringify(input.schema), 'utf8');
  // Byte estimate deliberately errs on the side of input safety, without pretending to be a tokenizer.
  const estimatedInputTokens = Math.ceil(bytes / 2);
  const cap = Math.min(
    input.outputCap,
    input.contextCap === undefined ? input.outputCap : input.contextCap - estimatedInputTokens,
  );
  if (!Number.isSafeInteger(cap) || cap < 1) throw new Error('request_context_exceeded');
  const visibleTarget = Math.max(1, Math.ceil(input.visibleTokens * 1.25));
  // One tiny classification must not replace the configured/model soft estimate for
  // a later proof. This reserve is still clamped to the actual cap, never a refusal floor.
  const reserve = Math.max(0, input.historicalReasoning ?? 0, input.reasoningEstimate ?? 0);
  return {
    bytes,
    estimatedInputTokens,
    estimation: 'utf8-bytes/2',
    visibleTarget,
    reasoningReserve: reserve,
    effectiveCap: cap,
    maxTokens: Math.min(cap, visibleTarget + reserve),
    softEstimateExceeded: visibleTarget + reserve > cap,
  };
}
