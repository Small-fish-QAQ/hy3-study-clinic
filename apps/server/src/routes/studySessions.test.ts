import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Services } from '../services/index.js';
import { registerStudySessionRoutes } from './studySessions.js';

function appWithSubmitTurn(
  submitTurn: (
    workspaceId: string,
    sessionId: string,
    body: unknown,
    options: { onEvent?: (event: unknown) => void },
  ) => Promise<unknown>,
) {
  const app = Fastify({ logger: false });
  registerStudySessionRoutes(app, {
    studySessions: {
      submitTurn,
    },
  } as unknown as Services);
  return app;
}

describe('StudySession turn stream', () => {
  it('emits persisted events before one terminal result', async () => {
    const submitTurn = vi.fn(
      async (
        _workspaceId: string,
        _sessionId: string,
        _body: unknown,
        options: { onEvent?: (event: unknown) => void },
      ) => {
        options.onEvent?.({ id: 'event_1', kind: 'started', provisional: true });
        options.onEvent?.({ id: 'event_2', kind: 'validated', provisional: false });
        return { terminalId: 'validated_result_1' };
      },
    );
    const app = appWithSubmitTurn(submitTurn);

    const response = await app.inject({
      method: 'POST',
      url: '/api/workspaces/ws_1/study-sessions/session_1/turns/stream',
      payload: {
        commandId: 'turn_command_1',
        expectedSessionVersion: 1,
        content: 'Why?',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/x-ndjson');
    const lines = response.body
      .trim()
      .split('\n')
      .map(
        (line) => JSON.parse(line) as { kind: string; event?: { id: string }; result?: unknown },
      );
    expect(lines).toEqual([
      { kind: 'event', event: { id: 'event_1', kind: 'started', provisional: true } },
      { kind: 'event', event: { id: 'event_2', kind: 'validated', provisional: false } },
      { kind: 'terminal', result: { terminalId: 'validated_result_1' } },
    ]);
    expect(submitTurn).toHaveBeenCalledWith(
      'ws_1',
      'session_1',
      expect.objectContaining({ commandId: 'turn_command_1' }),
      expect.objectContaining({ signal: expect.any(AbortSignal), onEvent: expect.any(Function) }),
    );
    await app.close();
  });

  it('emits an error envelope and no invented terminal result after failure', async () => {
    const app = appWithSubmitTurn(async () => {
      throw new Error('provider result was not durably observed');
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/workspaces/ws_1/study-sessions/session_1/turns/stream',
      payload: {
        commandId: 'turn_command_2',
        expectedSessionVersion: 1,
        content: 'Try again.',
      },
    });

    const lines = response.body
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string; message?: string });
    expect(lines).toEqual([{ kind: 'error', message: 'provider result was not durably observed' }]);
    expect(lines.some((line) => line.kind === 'terminal')).toBe(false);
    await app.close();
  });
});
