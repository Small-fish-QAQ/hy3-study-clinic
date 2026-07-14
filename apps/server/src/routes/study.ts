import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { QuizConfigSchema, SubmissionRequestSchema } from '@hy3-clinic/shared';
import type { Services } from '../services/index.js';
import { toPublicQuiz } from '../services/quizzes.js';
import { requestSignal } from '../util/requestSignal.js';

const IdParams = z.object({ id: z.string().min(1) });

const GenerateQuizBody = z.object({
  materialId: z.string().min(1),
  config: QuizConfigSchema,
});

/**
 * Flow routes: analysis → quiz generation → answering → grading →
 * mistakes → remediation → mastery.
 *
 * Provider-backed routes thread an AbortSignal from the client connection,
 * so closing the browser tab (or hitting "取消") cancels the model call.
 */
export function registerStudyRoutes(app: FastifyInstance, services: Services): void {
  // --- Flow A: concept analysis + quiz generation + answering ---

  app.post('/api/materials/:id/analyze', async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const concepts = await services.analysis.analyze(id, {
      signal: requestSignal(request, reply),
    });
    return { concepts };
  });

  app.get('/api/materials/:id/concepts', async (request) => {
    const { id } = IdParams.parse(request.params);
    return { concepts: services.analysis.list(id) };
  });

  app.post('/api/quizzes', async (request, reply) => {
    const body = GenerateQuizBody.parse(request.body);
    const quiz = await services.quizzes.generate(body.materialId, body.config, {
      signal: requestSignal(request, reply),
    });
    reply.status(201);
    return { quiz: toPublicQuiz(quiz) };
  });

  app.get('/api/quizzes/:id', async (request) => {
    const { id } = IdParams.parse(request.params);
    return { quiz: toPublicQuiz(services.quizzes.get(id)) };
  });

  // --- Flow B: submission → grading → mistakes → remediation → mastery ---

  app.post('/api/quizzes/:id/submissions', async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const body = SubmissionRequestSchema.parse({
      ...(typeof request.body === 'object' && request.body !== null ? request.body : {}),
      quizId: id,
    });
    const result = await services.grading.grade(body, {
      signal: requestSignal(request, reply),
    });
    // After grading, the full questions (with answers/rubrics) are revealed
    // so the client can render explanations and evidence.
    const quiz = services.quizzes.get(id);
    reply.status(201);
    return { grading: result, questions: quiz.questions };
  });

  app.get('/api/materials/:id/mistakes', async (request) => {
    const { id } = IdParams.parse(request.params);
    const query = z
      .object({ status: z.enum(['open', 'all']).default('all') })
      .parse(request.query ?? {});
    const all = services.mistakes.listByMaterial(id);
    const mistakes = query.status === 'open' ? all.filter((m) => m.status === 'open') : all;
    return { mistakes, weakConcepts: services.mistakes.weakConcepts(id) };
  });

  app.post('/api/materials/:id/remediation', async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const quiz = await services.remediation.generate(id, {
      signal: requestSignal(request, reply),
    });
    reply.status(201);
    return { quiz: toPublicQuiz(quiz) };
  });

  app.get('/api/materials/:id/mastery', async (request) => {
    const { id } = IdParams.parse(request.params);
    return {
      mastery: services.mistakes.mastery(id),
      weakConcepts: services.mistakes.weakConcepts(id),
    };
  });
}
