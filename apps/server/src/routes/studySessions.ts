import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SubmitTutorTurnRequestSchema } from '@hy3-clinic/shared';
import type { Services } from '../services/index.js';
import { requestSignal } from '../util/requestSignal.js';

const WorkspaceParams = z.object({ workspaceId: z.string().min(1) });
const SessionParams = z.object({ workspaceId: z.string().min(1), sessionId: z.string().min(1) });

export function registerStudySessionRoutes(app: FastifyInstance, services: Services): void {
  app.get('/api/workspaces/:workspaceId/study-sessions', async (request) => {
    const { workspaceId } = WorkspaceParams.parse(request.params);
    return { sessions: services.studySessions.list(workspaceId) };
  });

  app.post('/api/workspaces/:workspaceId/study-sessions', async (request, reply) => {
    const { workspaceId } = WorkspaceParams.parse(request.params);
    reply.status(201);
    return services.studySessions.start(workspaceId, request.body);
  });

  app.get('/api/workspaces/:workspaceId/study-sessions/:sessionId', async (request) => {
    const params = SessionParams.parse(request.params);
    return services.studySessions.detail(params.workspaceId, params.sessionId);
  });

  app.get(
    '/api/workspaces/:workspaceId/study-sessions/:sessionId/lesson-execution',
    async (request) => {
      const params = SessionParams.parse(request.params);
      return services.lessonExecution.get(params.workspaceId, params.sessionId);
    },
  );

  app.post(
    '/api/workspaces/:workspaceId/study-sessions/:sessionId/lesson-execution/prepare',
    async (request, reply) => {
      const params = SessionParams.parse(request.params);
      return services.lessonExecution.ensure(params.workspaceId, params.sessionId, request.body, {
        signal: requestSignal(request, reply),
      });
    },
  );

  app.post(
    '/api/workspaces/:workspaceId/study-sessions/:sessionId/lesson-execution/commands',
    async (request, reply) => {
      const params = SessionParams.parse(request.params);
      return services.lessonExecution.command(params.workspaceId, params.sessionId, request.body, {
        signal: requestSignal(request, reply),
      });
    },
  );

  app.post(
    '/api/workspaces/:workspaceId/study-sessions/:sessionId/turns',
    async (request, reply) => {
      const params = SessionParams.parse(request.params);
      return services.studySessions.submitTurn(params.workspaceId, params.sessionId, request.body, {
        signal: requestSignal(request, reply),
      });
    },
  );

  /**
   * Durable NDJSON replay/live path. Emitted events have already been
   * persisted; only the terminal validated result is authoritative.
   */
  app.post(
    '/api/workspaces/:workspaceId/study-sessions/:sessionId/turns/stream',
    async (request, reply) => {
      const params = SessionParams.parse(request.params);
      const body = SubmitTutorTurnRequestSchema.parse(request.body);
      const signal = requestSignal(request, reply);
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-cache',
      });
      const write = (value: unknown): void => {
        if (!reply.raw.writableEnded) reply.raw.write(`${JSON.stringify(value)}\n`);
      };
      try {
        const result = await services.studySessions.submitTurn(
          params.workspaceId,
          params.sessionId,
          body,
          {
            signal,
            onEvent: (event) => write({ kind: 'event', event }),
          },
        );
        write({ kind: 'terminal', result });
      } catch (error) {
        write({
          kind: 'error',
          message: error instanceof Error ? error.message.slice(0, 300) : 'Tutor turn failed.',
        });
      } finally {
        reply.raw.end();
      }
    },
  );

  app.post('/api/workspaces/:workspaceId/study-sessions/:sessionId/commands', async (request) => {
    const params = SessionParams.parse(request.params);
    return services.studySessions.command(params.workspaceId, params.sessionId, request.body);
  });

  for (const kind of ['pause', 'resume', 'stop'] as const) {
    app.post(`/api/workspaces/:workspaceId/study-sessions/:sessionId/${kind}`, async (request) => {
      const params = SessionParams.parse(request.params);
      return services.studySessions[kind](params.workspaceId, params.sessionId, request.body);
    });
  }
}
