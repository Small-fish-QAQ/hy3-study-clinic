import { describe, expect, it, vi } from 'vitest';
import { TOKENHUB_VISUAL_MODEL, TokenHubVisionProvider } from './tokenHubVisionProvider.js';
import {
  visualConfigurationFingerprint,
  visualPreparationLeaseMs,
} from '../services/visualPreparation.js';

const input = {
  image: {
    dataBase64: Buffer.from('png-bytes').toString('base64'),
    mediaType: 'image/png' as const,
    width: 320,
    height: 200,
    byteLength: 9,
  },
  limits: {
    maxDescriptionChars: 1200,
    maxVisibleTextChars: 2000,
    maxConcepts: 12,
    maxPedagogicalNotes: 6,
    maxUncertaintyItems: 6,
  },
};

const valid = JSON.stringify({
  description: 'A labeled educational diagram.',
  visualType: 'diagram',
  visibleText: 'Input -> Output',
  importantConcepts: ['process'],
  pedagogicalNotes: ['Use the arrow direction as a teaching cue.'],
  uncertainty: [],
});

function response(content: string, usage = true): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: 'stop' }],
      ...(usage ? { usage: { prompt_tokens: 12, completion_tokens: 8 } } : {}),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function provider(fetchImpl: typeof fetch): TokenHubVisionProvider {
  return new TokenHubVisionProvider({
    baseUrl: 'https://tokenhub.tencentmaas.com/v1',
    apiKey: 'test-key',
    model: TOKENHUB_VISUAL_MODEL,
    timeoutMs: 100,
    fetchImpl,
  });
}

describe('TokenHubVisionProvider documented one-image transport', () => {
  it('sends the selected model and one user text + one Data URL image part', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
        stream: boolean;
        temperature: number;
        max_tokens: number;
      };
      expect(url).toBe('https://tokenhub.tencentmaas.com/v1/chat/completions');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toEqual({
        authorization: 'Bearer test-key',
        'content-type': 'application/json',
      });
      expect(body.model).toBe(TOKENHUB_VISUAL_MODEL);
      expect(body.stream).toBe(false);
      expect(body.temperature).toBe(0);
      expect(body.max_tokens).toBe(2048);
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0]?.role).toBe('user');
      expect(body.messages[0]?.content).toHaveLength(2);
      expect(body.messages[0]?.content[0]).toEqual({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${input.image.dataBase64}` },
      });
      expect(body.messages[0]?.content[1]).toMatchObject({
        type: 'text',
        text: expect.stringContaining('Describe exactly one educational visual'),
      });
      expect(body.messages[0]?.content[1]?.text).toEqual(
        expect.stringContaining(
          'Limits: description <= 1200 chars; visibleText <= 2000 chars; importantConcepts <= 12; pedagogicalNotes <= 6; uncertainty <= 6.',
        ),
      );
      expect(body.messages[0]?.content[1]?.text).toEqual(
        expect.stringContaining(
          'For charts, preserve exact labels and values or mark them uncertain. For diagrams, describe arrow direction only when visible.',
        ),
      );
      expect(JSON.stringify(body)).not.toContain('system');
      expect(JSON.stringify(body)).not.toContain('response_format');
      expect(JSON.stringify(body)).not.toContain('material_');
      expect(JSON.stringify(body)).not.toContain('sha256:');
      return response(valid);
    }) as unknown as typeof fetch;
    const onUsage = vi.fn();
    const result = await provider(fetchImpl).describeVisual(input, { onUsage });
    expect(result.visualType).toBe('diagram');
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 12, outputTokens: 8 }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['image/jpeg', 'image/webp'] as const)(
    'uses a bounded Data URL for accepted %s transport',
    async (mediaType) => {
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
        expect(String(init?.body)).toContain(`data:${mediaType};base64,`);
        return response(valid);
      }) as unknown as typeof fetch;
      await provider(fetchImpl).describeVisual({
        ...input,
        image: { ...input.image, mediaType },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it('repeats the same one-image user transport once for schema/semantic repair', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response('{"wrong":true}'))
      .mockResolvedValueOnce(response(valid)) as unknown as typeof fetch;
    const onRepairAttempt = vi.fn();
    await provider(fetchImpl).describeVisual(input, { onRepairAttempt });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onRepairAttempt).toHaveBeenCalledTimes(1);
    const second = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)) as {
      messages: Array<{ role: string; content: unknown[] }>;
    };
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]?.role).toBe('user');
    expect(second.messages[0]?.content).toHaveLength(2);
  });

  it('performs exactly one repair after local semantic rejection', async () => {
    const fetchImpl = vi.fn(async () => response(valid)) as unknown as typeof fetch;
    const onRepairAttempt = vi.fn();
    let candidates = 0;
    const result = await provider(fetchImpl).describeVisual(input, {
      onRepairAttempt,
      validateCandidate: () => {
        candidates += 1;
        return candidates === 1
          ? { valid: false, diagnostics: ['Unsupported semantic claim.'] }
          : { valid: true, diagnostics: [] };
      },
    });
    expect(result.visualType).toBe('diagram');
    expect(candidates).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onRepairAttempt).toHaveBeenCalledWith('candidate', 'SEMANTIC_VALIDATION_FAILURE');
  });

  it('does not report invented usage when TokenHub omits the usage object', async () => {
    const fetchImpl = vi.fn(async () => response(valid, false)) as unknown as typeof fetch;
    const onUsage = vi.fn();
    await provider(fetchImpl).describeVisual(input, { onUsage });
    expect(onUsage).not.toHaveBeenCalled();
  });

  it('does not retry HTTP failures, malformed envelopes, or timeouts', async () => {
    const http = vi.fn(
      async () => new Response('nope', { status: 500 }),
    ) as unknown as typeof fetch;
    await expect(provider(http).describeVisual(input)).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
    expect(http).toHaveBeenCalledTimes(1);

    const malformedEnvelope = vi.fn(
      async () => new Response('{not-json', { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(provider(malformedEnvelope).describeVisual(input)).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_OUTPUT',
      technicalFailureCode: 'PROVIDER_FORMAT_INCOMPATIBILITY',
    });
    expect(malformedEnvelope).toHaveBeenCalledTimes(1);

    const nonStringContent = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: [{ type: 'text' }] } }] }), {
          status: 200,
        }),
    ) as unknown as typeof fetch;
    await expect(provider(nonStringContent).describeVisual(input)).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_OUTPUT',
      technicalFailureCode: 'PROVIDER_FORMAT_INCOMPATIBILITY',
    });
    expect(nonStringContent).toHaveBeenCalledTimes(1);

    const timeout = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    ) as unknown as typeof fetch;
    await expect(provider(timeout).describeVisual(input)).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
    });
    expect(timeout).toHaveBeenCalledTimes(1);
  });

  it('rejects timeout and cancellation that occur while reading a non-cooperative body', async () => {
    const envelope = JSON.stringify({
      choices: [{ message: { content: valid }, finish_reason: 'stop' }],
    });
    const slowBody = vi.fn(async () => ({
      ok: true,
      text: async () => new Promise<string>((resolve) => setTimeout(() => resolve(envelope), 30)),
    })) as unknown as typeof fetch;
    const shortProvider = new TokenHubVisionProvider({
      baseUrl: 'https://tokenhub.tencentmaas.com/v1',
      apiKey: 'test-key',
      model: TOKENHUB_VISUAL_MODEL,
      timeoutMs: 5,
      fetchImpl: slowBody,
    });
    await expect(shortProvider.describeVisual(input)).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
    });

    let releaseBody!: (value: string) => void;
    const bodyGate = new Promise<string>((resolve) => {
      releaseBody = resolve;
    });
    const pendingBody = vi.fn(async () => ({
      ok: true,
      text: async () => bodyGate,
    })) as unknown as typeof fetch;
    const controller = new AbortController();
    const pending = provider(pendingBody).describeVisual(input, { signal: controller.signal });
    controller.abort();
    releaseBody(envelope);
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
  });

  it('honors cancellation before and during transport', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      provider(fetchImpl).describeVisual(input, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(fetchImpl).not.toHaveBeenCalled();

    const running = new AbortController();
    const pendingFetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    ) as unknown as typeof fetch;
    const pending = provider(pendingFetch).describeVisual(input, { signal: running.signal });
    running.abort();
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(pendingFetch).toHaveBeenCalledTimes(1);
  });

  it('fails after exactly one repair when the repaired result is still invalid', async () => {
    const fetchImpl = vi.fn(async () => response('{"wrong":true}')) as unknown as typeof fetch;
    await expect(provider(fetchImpl).describeVisual(input)).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_OUTPUT',
      technicalFailureCode: 'REPAIR_EXHAUSTED:SCHEMA_VALIDATION_FAILURE',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('TokenHubVisionProvider configuration', () => {
  it('rejects a different model instead of silently routing', () => {
    expect(
      () =>
        new TokenHubVisionProvider({
          baseUrl: 'https://tokenhub.tencentmaas.com/v1',
          apiKey: 'test-key',
          model: 'youtu-vita' as typeof TOKENHUB_VISUAL_MODEL,
          timeoutMs: 100,
        }),
    ).toThrow(/Unsupported TokenHub visual model/);
  });

  it('rejects base URLs whose ignored components could alias another request target', () => {
    for (const baseUrl of [
      'ftp://tokenhub.tencentmaas.com/v1',
      'https://user:secret@tokenhub.tencentmaas.com/v1',
      'https://tokenhub.tencentmaas.com/v1?route=a',
      'https://tokenhub.tencentmaas.com/v1#route-a',
    ]) {
      expect(
        () =>
          new TokenHubVisionProvider({
            baseUrl,
            apiKey: 'test-key',
            model: TOKENHUB_VISUAL_MODEL,
            timeoutMs: 100,
          }),
      ).toThrow(/base URL/u);
    }
  });

  it('binds endpoint, model, adapter runtime, prompt, and lease margin into local policy', () => {
    const first = provider(vi.fn() as unknown as typeof fetch);
    const second = new TokenHubVisionProvider({
      baseUrl: 'https://alternate-tokenhub.example/v1',
      apiKey: 'test-key',
      model: TOKENHUB_VISUAL_MODEL,
      timeoutMs: 120_000,
    });
    expect(visualConfigurationFingerprint(first)).not.toBe(visualConfigurationFingerprint(second));
    expect(visualPreparationLeaseMs(first)).toBe(30_200);
    expect(visualPreparationLeaseMs(second)).toBe(270_000);
    expect(visualPreparationLeaseMs(second, 200_000)).toBe(430_000);
  });
});
