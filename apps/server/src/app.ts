import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { ApiErrorCode } from '@hy3-clinic/shared';
import { AppError, statusForErrorCode } from './errors.js';
import { IngestionError } from './ingestion/ingest.js';
import { ProviderError } from './llm/errors.js';
import type { LlmProvider } from './llm/provider.js';
import type { Repositories } from './repositories/index.js';
import type { Clock } from './util/ids.js';
import { systemClock } from './util/ids.js';
import { createServices } from './services/index.js';
import { registerMaterialRoutes } from './routes/materials.js';
import { registerStudyRoutes } from './routes/study.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';

export interface AppDeps {
  repos: Repositories;
  provider: LlmProvider;
  clock?: Clock;
  logger?: boolean;
  /** Model identifier recorded as graph provider metadata (hy3 only). */
  providerModel?: string | undefined;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    // Generous enough for the 100k-char source limit encoded as JSON and for
    // base64-encoded PDF/DOCX uploads (10 MB decoded → ~13.7 MB encoded).
    bodyLimit: 16 * 1024 * 1024,
    logger: deps.logger
      ? {
          level: 'info',
          redact: {
            paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]'],
            censor: '[REDACTED]',
          },
        }
      : false,
  });

  const clock = deps.clock ?? systemClock;
  const providerName = deps.provider.name;
  const services = createServices({
    repos: deps.repos,
    provider: deps.provider,
    clock,
    providerModel: deps.providerModel,
  });

  // Central error handler: converts known errors into structured API errors
  // and never leaks stack traces, secrets, or raw payloads to the client.
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      reply
        .status(statusForErrorCode(error.code))
        .send({ error: { code: error.code, message: error.message, details: error.details } });
      return;
    }
    if (error instanceof IngestionError) {
      reply
        .status(statusForErrorCode(error.code))
        .send({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof ProviderError) {
      reply
        .status(statusForErrorCode(error.code))
        .send({ error: { code: error.code, message: error.message, details: error.details } });
      return;
    }
    if (error instanceof ZodError) {
      reply.status(400).send({
        error: {
          code: ApiErrorCode.ValidationError,
          message: '请求数据校验失败。',
          details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
      return;
    }
    const fastifyError = error as { code?: string; statusCode?: number; validation?: unknown };
    if (fastifyError.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      reply.status(413).send({
        error: { code: ApiErrorCode.SourceTooLarge, message: '请求体过大,已拒绝。' },
      });
      return;
    }
    if (fastifyError.validation || fastifyError.statusCode === 400) {
      reply.status(400).send({
        error: { code: ApiErrorCode.ValidationError, message: '请求数据校验失败。' },
      });
      return;
    }
    // Unknown error: log server-side (sanitized logger), return generic message.
    request.log.error(error);
    reply.status(500).send({ error: { code: ApiErrorCode.Internal, message: '服务器内部错误。' } });
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({ error: { code: ApiErrorCode.NotFound, message: '接口不存在。' } });
  });

  app.get('/api/health', async () => ({ status: 'ok', service: 'hy3-study-clinic-server' }));

  // Exposes only the provider NAME — never keys, URLs, or models.
  app.get('/api/config', async () => ({ provider: providerName }));

  registerMaterialRoutes(app, services.materials);
  registerStudyRoutes(app, services);
  registerWorkspaceRoutes(app, services);

  return app;
}
