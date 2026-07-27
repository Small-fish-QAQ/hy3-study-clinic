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
const ProposalParams = z.object({ id: z.string().min(1), proposalId: z.string().min(1) });
const CanonicalParams = z.object({ id: z.string().min(1), canonicalId: z.string().min(1) });
const RunParams = z.object({ id: z.string().min(1), runId: z.string().min(1) });
const AttemptParams = z.object({ id: z.string().min(1), attemptId: z.string().min(1) });
const TutorStartBody = z.object({ conceptId: z.string().min(1) }).strict();

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

  // --- Concept alignment ---

  app.get('/api/workspaces/:id/alignment', async (request) => {
    const { id } = WorkspaceIdParams.parse(request.params);
    return services.alignment.overview(id);
  });

  app.post('/api/workspaces/:id/alignment/propose', async (request, reply) => {
    const { id } = WorkspaceIdParams.parse(request.params);
    const result = await services.alignment.propose(id, {
      signal: requestSignal(request, reply),
    });
    reply.status(201);
    return result;
  });

  app.post('/api/workspaces/:id/alignment/proposals/:proposalId/accept', async (request) => {
    const { id, proposalId } = ProposalParams.parse(request.params);
    return services.alignment.accept(id, proposalId, request.body);
  });

  app.post('/api/workspaces/:id/alignment/proposals/:proposalId/reject', async (request) => {
    const { id, proposalId } = ProposalParams.parse(request.params);
    return services.alignment.reject(id, proposalId);
  });

  app.post('/api/workspaces/:id/alignment/proposals/:proposalId/keep-separate', async (request) => {
    const { id, proposalId } = ProposalParams.parse(request.params);
    return services.alignment.keepSeparate(id, proposalId);
  });

  app.patch('/api/workspaces/:id/canonical/:canonicalId', async (request) => {
    const { id, canonicalId } = CanonicalParams.parse(request.params);
    return { canonical: services.alignment.rename(id, canonicalId, request.body) };
  });

  // --- Workspace assessments (cross-document) ---

  app.post('/api/workspaces/:id/assessments', async (request, reply) => {
    const { id } = WorkspaceIdParams.parse(request.params);
    const result = await services.assessment.create(id, request.body, {
      signal: requestSignal(request, reply),
    });
    reply.status(201);
    return {
      quiz: toPublicQuiz(result.quiz),
      blueprints: services.assessment.publicBlueprints(result.quiz.id),
      rejected: result.rejected,
    };
  });

  // --- Completed-quiz history (read-only; never grades, never mutates) ---

  app.get('/api/workspaces/:id/attempts', async (request) => {
    const { id } = WorkspaceIdParams.parse(request.params);
    return { attempts: services.attempts.listByWorkspace(id) };
  });

  app.get('/api/workspaces/:id/attempts/:attemptId', async (request) => {
    const { id, attemptId } = AttemptParams.parse(request.params);
    return services.attempts.get(id, attemptId);
  });

  // --- Misconceptions ---

  app.get('/api/workspaces/:id/misconceptions', async (request) => {
    const { id } = WorkspaceIdParams.parse(request.params);
    const query = z
      .object({ status: z.enum(['proposed', 'confirmed', 'rejected', 'resolved']).optional() })
      .parse(request.query ?? {});
    return { misconceptions: services.misconceptions.listByWorkspace(id, query.status) };
  });

  // --- Review scheduling + daily learning queue ---

  app.get('/api/workspaces/:id/review', async (request) => {
    const { id } = WorkspaceIdParams.parse(request.params);
    return { items: services.review.listByWorkspace(id) };
  });

  app.get('/api/workspaces/:id/queue', async (request) => {
    const { id } = WorkspaceIdParams.parse(request.params);
    return { items: services.queue.dailyQueue(id) };
  });

  // --- Bounded Hy3 Tutor ---

  /**
   * Start a Tutor session and stream its safe timeline as NDJSON lines:
   *   {"kind":"event","event":{…}}   for each timeline event
   *   {"kind":"run","run":{…}}       once, when the session settles
   * Client disconnect (取消) aborts the in-flight provider call; the run is
   * then persisted as cancelled. Input errors 404/400 BEFORE streaming.
   */
  app.post('/api/workspaces/:id/tutor', async (request, reply) => {
    const { id } = WorkspaceIdParams.parse(request.params);
    const body = TutorStartBody.parse(request.body);
    services.tutor.ensureSessionInput(id, body.conceptId);

    const signal = requestSignal(request, reply);
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache',
    });
    const write = (line: unknown): void => {
      if (!reply.raw.writableEnded) reply.raw.write(`${JSON.stringify(line)}\n`);
    };
    try {
      const result = await services.tutor.runSession(id, body.conceptId, {
        signal,
        onEvent: (event) => write({ kind: 'event', event }),
      });
      write({ kind: 'run', run: result.run });
    } catch (error) {
      write({
        kind: 'error',
        message: error instanceof Error ? error.message.slice(0, 300) : '辅导会话失败。',
      });
    } finally {
      reply.raw.end();
    }
  });

  app.get('/api/workspaces/:id/tutor/runs', async (request) => {
    const { id } = WorkspaceIdParams.parse(request.params);
    return { runs: services.tutor.listRuns(id) };
  });

  app.get('/api/workspaces/:id/tutor/runs/:runId', async (request) => {
    const { id, runId } = RunParams.parse(request.params);
    return services.tutor.getRun(id, runId);
  });
}
