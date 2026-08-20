import type { FastifyInstance } from 'fastify';
import {
  StartMasteryRedTeamRunRequestSchema,
  SubmitMasteryRedTeamRunRequestSchema,
} from '@hy3-clinic/shared';
import type { Services } from '../services/index.js';
import { requestSignal } from '../util/requestSignal.js';

export function registerMasteryRedTeamRoutes(app: FastifyInstance, services: Services): void {
  app.post('/api/workspaces/:workspaceId/mastery-red-team/runs', async (request, reply) => {
    const workspaceId = String((request.params as { workspaceId: string }).workspaceId);
    const input = StartMasteryRedTeamRunRequestSchema.parse(request.body);
    const detail = await services.masteryRedTeam.start(
      { workspaceId, ...input },
      { signal: requestSignal(request, reply) },
    );
    reply.status(201);
    return detail;
  });
  app.get('/api/workspaces/:workspaceId/mastery-red-team/runs/:runId', async (request, reply) => {
    const params = request.params as { workspaceId: string; runId: string };
    const detail = services.masteryRedTeam.get(params.runId);
    if (detail.run.workspaceId !== params.workspaceId) {
      reply.status(404);
      return { error: { code: 'NOT_FOUND', message: 'Mastery Red Team 运行不存在。' } };
    }
    return detail;
  });
  app.post(
    '/api/workspaces/:workspaceId/mastery-red-team/runs/:runId/submit',
    async (request, reply) => {
      const params = request.params as { workspaceId: string; runId: string };
      const input = SubmitMasteryRedTeamRunRequestSchema.parse(request.body);
      const detail = await services.masteryRedTeam.submit(params.workspaceId, params.runId, input, {
        signal: requestSignal(request, reply),
      });
      return detail;
    },
  );
}
