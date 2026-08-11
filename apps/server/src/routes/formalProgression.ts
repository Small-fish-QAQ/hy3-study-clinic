import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ProposeQualifiedReplanRequestSchema,
  QualifyReplanTriggerRequestSchema,
  ReconcileProgressionRequestSchema,
  RecordGoalOutcomeRequestSchema,
} from '@hy3-clinic/shared';
import type { Services } from '../services/index.js';

const WorkspaceParams = z.object({ id: z.string().min(1) });
const TriggerParams = z.object({ id: z.string().min(1), triggerId: z.string().min(1) });

function assertWorkspace(body: { command: { workspaceId: string } }, workspaceId: string): void {
  if (body.command.workspaceId !== workspaceId) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ['command', 'workspaceId'],
        message: 'command workspace does not match route workspace',
      },
    ]);
  }
}

/** Phase-4 formal evidence, replan, and terminal-course commands. */
export function registerFormalProgressionRoutes(app: FastifyInstance, services: Services): void {
  app.get('/api/workspaces/:id/progression', async (request) => {
    const { id } = WorkspaceParams.parse(request.params);
    return services.formalProgression.overview(id);
  });

  app.post('/api/workspaces/:id/progression/reconcile', async (request) => {
    const { id } = WorkspaceParams.parse(request.params);
    const body = ReconcileProgressionRequestSchema.parse(request.body);
    assertWorkspace(body, id);
    return services.formalProgression.reconcileCommand(body);
  });

  app.post('/api/workspaces/:id/replans/triggers', async (request, reply) => {
    const { id } = WorkspaceParams.parse(request.params);
    const body = QualifyReplanTriggerRequestSchema.parse(request.body);
    assertWorkspace(body, id);
    reply.status(201);
    return { trigger: services.formalProgression.qualifyReplanTrigger(body) };
  });

  app.post('/api/workspaces/:id/replans/:triggerId/proposal', async (request, reply) => {
    const params = TriggerParams.parse(request.params);
    const body = ProposeQualifiedReplanRequestSchema.parse(request.body);
    assertWorkspace(body, params.id);
    if (body.triggerId !== params.triggerId) throw new z.ZodError([]);
    reply.status(201);
    return services.formalProgression.proposeQualifiedReplan(body);
  });

  app.post('/api/workspaces/:id/goal-outcomes', async (request, reply) => {
    const { id } = WorkspaceParams.parse(request.params);
    const body = RecordGoalOutcomeRequestSchema.parse(request.body);
    assertWorkspace(body, id);
    reply.status(201);
    return { outcome: services.formalProgression.recordGoalOutcome(body) };
  });
}
