import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../services/index.js';
import { requestSignal } from '../util/requestSignal.js';

const idParams = z.object({ id: z.string().min(1) });

export function registerRepairRoutes(app: FastifyInstance, services: Services): void {
  app.post('/api/formal-assessment-grades/:id/repair', async (request, reply) => {
    const episode = services.repair.createForGrade(idParams.parse(request.params).id);
    reply.status(episode ? 201 : 200);
    return { episode };
  });
  app.get('/api/repair-episodes/:id', async (request) =>
    services.repair.inspect(idParams.parse(request.params).id),
  );
  app.get('/api/repair-episodes/:id/learner', async (request) => ({
    repair: services.learnerAssessments.getRepair(idParams.parse(request.params).id),
  }));
  app.post('/api/repair-episodes/:id/generate', async (request, reply) => ({
    packet: await services.repair.generatePacket(idParams.parse(request.params).id, {
      signal: requestSignal(request, reply),
    }),
  }));
  app.post('/api/repair-episodes/:id/learner-start', async (request, reply) => {
    reply.status(201);
    return {
      repair: await services.learnerAssessments.startRepair(idParams.parse(request.params).id, {
        signal: requestSignal(request, reply),
      }),
    };
  });
  app.post('/api/repair-episodes/:id/learner-practice', async (request) => {
    const body = z
      .object({
        response: z.string().max(500),
        outcome: z.enum(['CONTINUE', 'READY_FOR_VERIFICATION', 'NEEDS_MORE_SUPPORT']),
      })
      .parse(request.body);
    return {
      repair: services.learnerAssessments.practice(
        idParams.parse(request.params).id,
        body.response,
        body.outcome,
      ),
    };
  });
  app.post('/api/repair-episodes/:id/learner-verification', async (request, reply) => {
    reply.status(201);
    return {
      execution: services.learnerAssessments.createVerification(idParams.parse(request.params).id),
    };
  });
  app.post('/api/repair-episodes/:id/learner-defer', async (request) => ({
    repair: services.learnerAssessments.defer(idParams.parse(request.params).id),
  }));
  app.post('/api/repair-episodes/:id/learner-cancel', async (request) => ({
    repair: services.learnerAssessments.cancelRepair(idParams.parse(request.params).id),
  }));
  app.post('/api/repair-episodes/:id/learner-resume', async (request) => ({
    repair: services.learnerAssessments.resumeRepair(idParams.parse(request.params).id),
  }));
  app.post('/api/repair-episodes/:id/practice', async (request) => {
    const body = z
      .object({
        responseSummary: z.string().max(500),
        outcome: z.enum(['CONTINUE', 'READY_FOR_VERIFICATION', 'NEEDS_MORE_SUPPORT']),
      })
      .parse(request.body);
    return {
      event: services.repair.recordPractice(
        idParams.parse(request.params).id,
        body.responseSummary,
        body.outcome,
      ),
    };
  });
  app.post('/api/repair-episodes/:id/defer', async (request) => ({
    episode: services.repair.defer(idParams.parse(request.params).id),
  }));
  app.post('/api/repair-episodes/:id/cancel', async (request) => ({
    episode: services.repair.cancel(idParams.parse(request.params).id),
  }));
  app.post('/api/repair-episodes/:id/resume', async (request) => ({
    episode: services.repair.resume(idParams.parse(request.params).id),
  }));
  app.post('/api/repair-episodes/:id/await-verification', async (request) => ({
    episode: services.repair.markAwaitingVerification(idParams.parse(request.params).id),
  }));
  app.post('/api/repair-episodes/:id/verification-attempt', async (request) => ({
    episode: services.repair.linkVerificationAttempt(
      idParams.parse(request.params).id,
      z.object({ attemptId: z.string().min(1) }).parse(request.body).attemptId,
    ),
  }));
  app.post('/api/repair-episodes/:id/resolve', async (request) => ({
    episode: services.repair.resolveFromEvidence(
      idParams.parse(request.params).id,
      z.object({ evidenceId: z.string().min(1) }).parse(request.body).evidenceId,
    ),
  }));
  app.post('/api/repair-episodes/:id/verification-failed', async (request) => ({
    episode: services.repair.recordVerificationFailure(idParams.parse(request.params).id),
  }));
}
