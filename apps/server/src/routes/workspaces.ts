import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AddDocumentRequestSchema } from '@hy3-clinic/shared';
import type { Services } from '../services/index.js';
import { toPublicQuiz } from '../services/quizzes.js';
import { requestSignal } from '../util/requestSignal.js';

const WorkspaceIdParams = z.object({ id: z.string().min(1) });
const DocumentParams = z.object({ id: z.string().min(1), docId: z.string().min(1) });
const VersionParams = z.object({ id: z.string().min(1), versionId: z.string().min(1) });
const ConceptParams = z.object({ id: z.string().min(1), conceptId: z.string().min(1) });
const PlanParams = z.object({ id: z.string().min(1), planId: z.string().min(1) });

/**
 * Course-workspace routes: workspaces → documents → concept graph →
 * learner-state overlay → remediation planning → plan launch.
 *
 * Provider-backed routes thread the client-connection AbortSignal so closing
 * the tab or pressing 取消 cancels the in-flight model call.
 */
export function registerWorkspaceRoutes(app: FastifyInstance, services: Services): void {
  // --- Workspaces ---

  app.post('/api/workspaces', async (request, reply) => {
    const workspace = services.workspaces.create(request.body);
    reply.status(201);
    return { workspace };
  });

  app.get('/api/workspaces', async () => {
    return { workspaces: services.workspaces.list() };
  });

  app.get('/api/workspaces/:id', async (request) => {
    const { id } = WorkspaceIdParams.parse(request.params);
    return services.workspaces.get(id);
  });

  app.patch('/api/workspaces/:id', async (request) => {
    const { id } = WorkspaceIdParams.parse(request.params);
    return { workspace: services.workspaces.rename(id, request.body) };
  });

  app.delete('/api/workspaces/:id', async (request, reply) => {
    const { id } = WorkspaceIdParams.parse(request.params);
    services.workspaces.delete(id);
    return reply.status(204).send();
  });

  // --- Documents ---

  app.post('/api/workspaces/:id/documents', async (request, reply) => {
    const { id } = WorkspaceIdParams.parse(request.params);
    const body = AddDocumentRequestSchema.parse(request.body);
    const created = await services.workspaces.addDocument(id, body);
    reply.status(201);
    return created;
  });

  app.get('/api/workspaces/:id/documents', async (request) => {
    const { id } = WorkspaceIdParams.parse(request.params);
    return { documents: services.workspaces.listDocuments(id) };
  });

  app.post('/api/workspaces/:id/documents/:docId/reprocess', async (request) => {
    const { id, docId } = DocumentParams.parse(request.params);
    return services.workspaces.reprocessDocument(id, docId);
  });

  app.delete('/api/workspaces/:id/documents/:docId', async (request, reply) => {
    const { id, docId } = DocumentParams.parse(request.params);
    services.workspaces.deleteDocument(id, docId);
    return reply.status(204).send();
  });

  // --- Concept graph ---

  app.post('/api/workspaces/:id/graph', async (request, reply) => {
    const { id } = WorkspaceIdParams.parse(request.params);
    const result = await services.graph.generate(id, {
      signal: requestSignal(request, reply),
    });
    reply.status(201);
    return result;
  });

  app.get('/api/workspaces/:id/graph', async (request) => {
    const { id } = WorkspaceIdParams.parse(request.params);
    return services.graph.getActive(id);
  });

  app.get('/api/workspaces/:id/graph/versions', async (request) => {
    const { id } = WorkspaceIdParams.parse(request.params);
    return { versions: services.graph.listVersions(id) };
  });

  app.get('/api/workspaces/:id/graph/versions/:versionId', async (request) => {
    const { id, versionId } = VersionParams.parse(request.params);
    return services.graph.getVersion(id, versionId);
  });

  app.post('/api/workspaces/:id/graph/versions/:versionId/activate', async (request) => {
    const { id, versionId } = VersionParams.parse(request.params);
    return { version: services.graph.activate(id, versionId) };
  });

  app.get('/api/workspaces/:id/overlay', async (request) => {
    const { id } = WorkspaceIdParams.parse(request.params);
    return { states: services.graph.learnerOverlay(id) };
  });

  // --- Remediation planning ---

  app.post('/api/workspaces/:id/concepts/:conceptId/plan', async (request, reply) => {
    const { id, conceptId } = ConceptParams.parse(request.params);
    const plan = await services.planner.generatePlan(id, conceptId, {
      signal: requestSignal(request, reply),
    });
    reply.status(201);
    return { plan };
  });

  app.get('/api/workspaces/:id/concepts/:conceptId/plan', async (request) => {
    const { id, conceptId } = ConceptParams.parse(request.params);
    return { plan: services.planner.getPlan(id, conceptId) };
  });

  app.post('/api/workspaces/:id/plans/:planId/launch', async (request, reply) => {
    const { id, planId } = PlanParams.parse(request.params);
    const result = await services.planner.launch(id, planId, {
      signal: requestSignal(request, reply),
    });
    reply.status(201);
    return { quiz: toPublicQuiz(result.quiz), mode: result.mode };
  });
}
