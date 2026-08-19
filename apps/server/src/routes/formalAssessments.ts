import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FormalAssessmentItemSchema, GradeRecordSchema } from '@hy3-clinic/shared';
import type { Services } from '../services/index.js';
import { requestSignal } from '../util/requestSignal.js';

const idParams = z.object({ id: z.string().min(1) });
const workspaceParams = z.object({ workspaceId: z.string().min(1) });

export function registerFormalAssessmentRoutes(app: FastifyInstance, services: Services): void {
  app.post('/api/workspaces/:workspaceId/formal-assessments', async (request, reply) => {
    const { workspaceId } = workspaceParams.parse(request.params);
    const body = z
      .object({ logicalKey: z.string().min(1), title: z.string().min(1) })
      .parse(request.body);
    reply.status(201);
    return { definition: services.formalAssessments.createDefinition({ workspaceId, ...body }) };
  });
  app.post('/api/formal-assessments/:id/versions', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = z
      .object({
        items: z.array(FormalAssessmentItemSchema),
        sourceRevisionIds: z.array(z.string().min(1)).min(1),
        predecessorId: z.string().nullable().optional(),
      })
      .parse(request.body);
    reply.status(201);
    return { version: services.formalAssessments.createVersion({ definitionId: id, ...body }) };
  });
  app.post('/api/formal-assessment-versions/:id/accept', async (request) => ({
    version: services.formalAssessments.acceptVersion(idParams.parse(request.params).id),
  }));
  app.get('/api/formal-assessment-versions/:id', async (request) => ({
    version: services.formalAssessments.getVersion(idParams.parse(request.params).id),
  }));
  app.post('/api/formal-assessment-versions/:id/attempts', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = z.object({ workspaceId: z.string().min(1) }).parse(request.body);
    reply.status(201);
    return { attempt: services.formalAssessments.startAttempt(id, body.workspaceId) };
  });
  app.get(
    '/api/workspaces/:workspaceId/formal-assessment-versions/:versionId/execution',
    async (request) => {
      const params = z
        .object({ workspaceId: z.string().min(1), versionId: z.string().min(1) })
        .parse(request.params);
      return { execution: services.learnerAssessments.get(params.versionId, params.workspaceId) };
    },
  );
  app.get(
    '/api/workspaces/:workspaceId/agendas/:agendaId/items/:itemId/formal-assessment',
    async (request) => {
      const params = z
        .object({
          workspaceId: z.string().min(1),
          agendaId: z.string().min(1),
          itemId: z.string().min(1),
        })
        .parse(request.params);
      return {
        version: services.formalAssessments.getAcceptedForAgenda(
          params.workspaceId,
          params.agendaId,
          params.itemId,
        ),
      };
    },
  );
  app.post(
    '/api/workspaces/:workspaceId/formal-assessment-versions/:versionId/execution',
    async (request, reply) => {
      const params = z
        .object({ workspaceId: z.string().min(1), versionId: z.string().min(1) })
        .parse(request.params);
      reply.status(201);
      return { execution: services.learnerAssessments.start(params.versionId, params.workspaceId) };
    },
  );
  app.post('/api/formal-assessment-attempts/:id/submit', async (request) => ({
    attempt: services.formalAssessments.submitAttempt(
      idParams.parse(request.params).id,
      z.object({ responses: z.record(z.string(), z.string()) }).parse(request.body).responses,
    ),
  }));
  app.post('/api/formal-assessment-attempts/:id/learner-submit', async (request, reply) => {
    reply.status(201);
    return {
      execution: await services.learnerAssessments.submit(
        idParams.parse(request.params).id,
        z.object({ responses: z.record(z.string(), z.string()) }).parse(request.body).responses,
        { signal: requestSignal(request, reply) },
      ),
    };
  });
  app.post('/api/formal-assessment-attempts/:id/cancel', async (request) => ({
    attempt: services.formalAssessments.cancelAttempt(idParams.parse(request.params).id),
  }));
  app.post('/api/formal-assessment-grades', async (request, reply) => {
    const grade = GradeRecordSchema.parse(request.body);
    reply.status(201);
    return { grade: services.formalAssessments.recordGrade(grade) };
  });
  app.post('/api/formal-assessment-grades/:id/evidence', async (request) => ({
    evidence: services.formalAssessments.deriveEvidence(idParams.parse(request.params).id),
  }));
  app.post('/api/formal-assessment-evidence/:id/reconcile', async (request) => ({
    reconciliation: services.formalAssessments.reconcileEvidence(idParams.parse(request.params).id),
  }));
}
