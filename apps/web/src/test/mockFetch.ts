import { vi } from 'vitest';

export interface MockRoute {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  pattern: RegExp;
  /** Return the JSON body (and optional status) for a matched request. */
  handler: (
    body: unknown,
    url: string,
    init?: RequestInit,
  ) =>
    | { status?: number; body?: unknown }
    | 'never'
    | Promise<{ status?: number; body?: unknown } | 'never'>;
}

export interface FetchCall {
  method: string;
  url: string;
  body: unknown;
}

/**
 * Install a route-table fetch mock. Returns the calls made so tests can
 * assert on them. Handlers returning 'never' produce a pending promise that
 * rejects on abort — used for cancellation tests.
 */
export function installFetchMock(routes: MockRoute[]): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const rawBody = typeof init?.body === 'string' ? init.body : undefined;
      const body = rawBody ? (JSON.parse(rawBody) as unknown) : undefined;
      calls.push({ method, url, body });

      const route = routes.find((r) => r.method === method && r.pattern.test(url));
      if (!route) {
        return Promise.resolve(
          makeResponse(404, {
            error: { code: 'NOT_FOUND', message: `未匹配的测试路由:${method} ${url}` },
          }),
        );
      }
      const result = await route.handler(body, url, init);
      if (result === 'never') {
        return new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }
      return Promise.resolve(makeResponse(result.status ?? 200, result.body));
    },
  );

  vi.stubGlobal('fetch', fetchMock);
  return { calls };
}

function makeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/**
 * Default (empty) routes for the adaptive-learning data the graph workspace
 * loads alongside the graph: alignment overview, misconceptions, review
 * items, and the daily queue. Tests append these unless they exercise the
 * feature explicitly.
 */
export function adaptiveDataRoutes(workspaceId = 'ws_1'): MockRoute[] {
  return [
    {
      method: 'GET',
      pattern: new RegExp(`/api/workspaces/${workspaceId}/alignment$`),
      handler: () => ({
        body: { canonical: [], pendingProposals: [], decidedProposals: [] },
      }),
    },
    {
      method: 'GET',
      pattern: new RegExp(`/api/workspaces/${workspaceId}/misconceptions$`),
      handler: () => ({ body: { misconceptions: [] } }),
    },
    {
      method: 'GET',
      pattern: new RegExp(`/api/workspaces/${workspaceId}/review$`),
      handler: () => ({ body: { items: [] } }),
    },
    {
      method: 'GET',
      pattern: new RegExp(`/api/workspaces/${workspaceId}/queue$`),
      handler: () => ({ body: { items: [] } }),
    },
  ];
}
