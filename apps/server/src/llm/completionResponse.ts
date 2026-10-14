import { ProviderError } from './errors.js';

interface CompletionChoice {
  message?: { content?: unknown };
  finish_reason?: string | null;
}
export interface CompletionEnvelope {
  choices?: CompletionChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
    prompt_tokens_details?: { cached_tokens?: number };
  };
}
export interface CompletionRead {
  envelope: CompletionEnvelope;
  bytes: number;
  streamChunks: number;
  reasoningBytes: number;
}

/** Accumulate only public content; discard reasoning deltas immediately. */
export async function readCompletionResponse(
  response: Response,
  secret: string,
  onProgress?: (metadata: {
    streamChunks: number;
    visibleBytes: number;
    reasoningBytes: number;
    responseBytes: number;
    finishReason: string | null;
    streamDone: boolean;
    usage?: CompletionEnvelope['usage'];
  }) => void,
): Promise<CompletionRead> {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const body = await response.text();
    if (body.includes(secret)) throw ProviderError.invalidOutput('模型响应包含不应返回的凭据。');
    let envelope: CompletionEnvelope;
    try {
      envelope = JSON.parse(body) as CompletionEnvelope;
    } catch {
      throw ProviderError.invalidOutput('模型响应不是完整 JSON。');
    }
    return { envelope, bytes: Buffer.byteLength(body), streamChunks: 0, reasoningBytes: 0 };
  }
  if (!response.body) throw ProviderError.invalidOutput('模型流没有响应正文。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '',
    content = '',
    reflectionTail = '';
  let bytes = 0,
    chunks = 0,
    reasoningBytes = 0;
  let finishReason: string | null = null;
  let usage: CompletionEnvelope['usage'];
  let done = false;
  const progress = () => {
    try {
      onProgress?.({
        streamChunks: chunks,
        visibleBytes: Buffer.byteLength(content),
        reasoningBytes,
        responseBytes: bytes,
        finishReason,
        streamDone: done,
        ...(usage ? { usage } : {}),
      });
    } catch {
      /* Observer only. */
    }
  };
  const frame = (event: string) => {
    const data = event
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (!data) return;
    if (data === '[DONE]') {
      done = true;
      progress();
      return;
    }
    let chunk: {
      choices?: {
        index?: number;
        delta?: { content?: unknown; reasoning_content?: unknown };
        finish_reason?: string | null;
      }[];
      usage?: CompletionEnvelope['usage'];
      error?: unknown;
    };
    try {
      chunk = JSON.parse(data) as typeof chunk;
    } catch {
      throw ProviderError.invalidOutput('模型流包含无效 JSON 事件。');
    }
    if (chunk.error) throw ProviderError.invalidOutput('模型流返回错误，未采用部分结果。');
    chunks++;
    const choice = chunk.choices?.find((c) => c.index === 0 || c.index === undefined);
    if (typeof choice?.delta?.content === 'string') content += choice.delta.content;
    if (typeof choice?.delta?.reasoning_content === 'string')
      reasoningBytes += Buffer.byteLength(choice.delta.reasoning_content);
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage) usage = chunk.usage;
    progress();
  };
  try {
    while (!done) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      const decoded = decoder.decode(next.value, { stream: true });
      const reflection = reflectionTail + decoded;
      if (reflection.includes(secret))
        throw ProviderError.invalidOutput('模型响应包含不应返回的凭据。');
      reflectionTail = secret.length > 1 ? reflection.slice(-(secret.length - 1)) : '';
      // Normalize CRLF while retaining a partial delimiter at chunk boundaries.
      buffer += decoded;
      for (;;) {
        const boundary = /\r?\n\r?\n/u.exec(buffer);
        if (!boundary) break;
        frame(buffer.slice(0, boundary.index).replaceAll('\r', ''));
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (done) break;
      }
    }
    if (!done || !finishReason)
      throw ProviderError.invalidOutput(
        '模型流未完整结束，未采用部分结果。',
        undefined,
        'TRUNCATED_OUTPUT',
      );
    if (content.includes(secret)) throw ProviderError.invalidOutput('模型响应包含不应返回的凭据。');
    return {
      envelope: { choices: [{ message: { content }, finish_reason: finishReason }], usage },
      bytes,
      streamChunks: chunks,
      reasoningBytes,
    };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
