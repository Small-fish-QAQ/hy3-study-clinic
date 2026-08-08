import { describe, expect, it, vi } from 'vitest';
import { SAMPLE_MATERIAL_TITLE, type SourceBlock } from '@hy3-clinic/shared';
import { Hy3Provider } from './hy3Provider.js';
import { ProviderError } from './errors.js';

const blocks: SourceBlock[] = [
  {
    id: 'blk_0',
    materialId: 'mat_1',
    index: 0,
    heading: '记忆',
    headingPath: ['记忆'],
    content: '工作记忆的容量十分有限。',
    startOffset: 0,
    endOffset: 12,
  },
];

function jsonResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeProvider(fetchImpl: typeof fetch, timeoutMs = 30_000): Hy3Provider {
  return new Hy3Provider({
    baseUrl: 'https://example.test/v1',
    apiKey: 'test-key-should-never-leak',
    model: 'test-model',
    timeoutMs,
    fetchImpl,
  });
}

describe('Hy3Provider happy path', () => {
  it('sends a bearer token and parses a valid concept payload', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        '{"concepts":[{"name":"工作记忆","summary":"容量有限","importance":"high","blockId":"blk_0","quote":"工作记忆的容量十分有限。"}]}',
      ),
    ) as unknown as typeof fetch;

    const provider = makeProvider(fetchImpl);
    const payload = await provider.analyzeConcepts({
      materialTitle: SAMPLE_MATERIAL_TITLE,
      blocks,
    });
    expect(payload.concepts[0]?.name).toBe('工作记忆');

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers.authorization).toBe('Bearer test-key-should-never-leak');
  });
});

describe('Hy3Provider bounded repair', () => {
  it('retries exactly once on invalid output, then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse('这不是 JSON'))
      .mockResolvedValueOnce(
        jsonResponse(
          '{"concepts":[{"name":"工作记忆","summary":"容量有限","importance":"high","blockId":"blk_0","quote":"工作记忆的容量十分有限。"}]}',
        ),
      ) as unknown as typeof fetch;

    const provider = makeProvider(fetchImpl);
    const payload = await provider.analyzeConcepts({
      materialTitle: SAMPLE_MATERIAL_TITLE,
      blocks,
    });
    expect(payload.concepts).toHaveLength(1);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('fails with PROVIDER_INVALID_OUTPUT after the repair also fails (no unbounded retry)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse('仍然不是 JSON')) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl);
    await expect(
      provider.analyzeConcepts({ materialTitle: SAMPLE_MATERIAL_TITLE, blocks }),
    ).rejects.toMatchObject({ code: 'PROVIDER_INVALID_OUTPUT' });
    // Exactly two calls: initial + one repair.
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('repairs a schema-valid-but-wrong payload once', async () => {
    // NOTE: an EMPTY concepts array is deliberately legal since the
    // section-aware extraction upgrade (a thin section may yield nothing),
    // so the invalid first payload violates the importance enum instead.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          '{"concepts":[{"name":"X","summary":"y","importance":"CRITICAL","blockId":"blk_0","quote":"工作记忆的容量十分有限。"}]}',
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          '{"concepts":[{"name":"X","summary":"y","importance":"low","blockId":"blk_0","quote":"工作记忆的容量十分有限。"}]}',
        ),
      ) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl);
    const payload = await provider.analyzeConcepts({
      materialTitle: SAMPLE_MATERIAL_TITLE,
      blocks,
    });
    expect(payload.concepts).toHaveLength(1);
  });
});

describe('Hy3Provider error mapping', () => {
  it('maps non-2xx to PROVIDER_ERROR', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('nope', { status: 500 }),
    ) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl);
    await expect(
      provider.analyzeConcepts({ materialTitle: SAMPLE_MATERIAL_TITLE, blocks }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('maps network failure to PROVIDER_ERROR without leaking details', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED 10.0.0.1:443');
    }) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl);
    await expect(
      provider.analyzeConcepts({ materialTitle: SAMPLE_MATERIAL_TITLE, blocks }),
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof ProviderError &&
        err.code === 'PROVIDER_ERROR' &&
        !err.message.includes('ECONNREFUSED') &&
        !err.message.includes('10.0.0.1')
      );
    });
  });

  it('maps a timeout to PROVIDER_TIMEOUT', async () => {
    const fetchImpl = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    }) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl, 20);
    await expect(
      provider.analyzeConcepts({ materialTitle: SAMPLE_MATERIAL_TITLE, blocks }),
    ).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
  });

  it('maps external cancellation to REQUEST_CANCELLED', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    }) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl);
    const pending = provider.analyzeConcepts(
      { materialTitle: SAMPLE_MATERIAL_TITLE, blocks },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
  });

  it('never includes the API key in a thrown error', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('x', { status: 401 }),
    ) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl);
    await expect(
      provider.analyzeConcepts({ materialTitle: SAMPLE_MATERIAL_TITLE, blocks }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ProviderError && !err.message.includes('test-key'),
    );
  });
});

describe('Hy3Provider response-body cancellation', () => {
  function responseWithHangingBody(signal: AbortSignal): Response {
    return {
      ok: true,
      status: 200,
      json: () =>
        new Promise<never>((_resolve, reject) => {
          const rejectAbort = () =>
            reject(Object.assign(new Error('aborted while reading body'), { name: 'AbortError' }));
          if (signal.aborted) rejectAbort();
          else signal.addEventListener('abort', rejectAbort, { once: true });
        }),
    } as unknown as Response;
  }

  it('keeps the timeout active while reading the response body', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      return responseWithHangingBody(init!.signal as AbortSignal);
    }) as unknown as typeof fetch;

    const provider = makeProvider(fetchImpl, 20);
    await expect(
      provider.analyzeConcepts({ materialTitle: SAMPLE_MATERIAL_TITLE, blocks }),
    ).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
  });

  it('keeps external cancellation active while reading the response body', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      return responseWithHangingBody(init!.signal as AbortSignal);
    }) as unknown as typeof fetch;

    const provider = makeProvider(fetchImpl);
    const pending = provider.analyzeConcepts(
      { materialTitle: SAMPLE_MATERIAL_TITLE, blocks },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
  });
});
