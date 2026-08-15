import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { ApiErrorCode, ProviderConnectionTestRequestSchema } from '@hy3-clinic/shared';
import { AppError, statusForErrorCode } from './errors.js';
import { IngestionError } from './ingestion/ingest.js';
import { ProviderError } from './llm/errors.js';
import type { LlmProvider } from './llm/provider.js';
import type { Repositories } from './repositories/index.js';
import type { Clock } from './util/ids.js';
import type { AppConfig } from './config.js';
import { systemClock } from './util/ids.js';
import { createServices } from './services/index.js';
import { registerMaterialRoutes } from './routes/materials.js';
import { registerStudyRoutes } from './routes/study.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import { registerAgentCourseRoutes } from './routes/agentCourse.js';
import { registerStudySessionRoutes } from './routes/studySessions.js';
import { registerFormalProgressionRoutes } from './routes/formalProgression.js';
import {
  ProviderRuntime,
  createRuntimeProvider,
  type ProviderConfigStore,
} from './services/providerRuntime.js';
import { requestSignal } from './util/requestSignal.js';

export interface AppDeps {
  repos: Repositories;
  provider: LlmProvider;
  providerRuntime?: ProviderRuntime;
  providerConfigStore?: ProviderConfigStore | null;
  startupConfig?: AppConfig;
  clock?: Clock;
  logger?: boolean;
  /** Model identifier recorded as graph provider metadata (hy3 only). */
  providerModel?: string | undefined;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const runtime =
    deps.providerRuntime ??
    new ProviderRuntime({
      startup: deps.startupConfig ?? {
        port: 0,
        host: '127.0.0.1',
        databasePath: '',
        provider: deps.provider.name,
        hy3BaseUrl: undefined,
        hy3ApiKey: undefined,
        hy3Model: deps.providerModel,
        hy3TimeoutMs: 30_000,
        providerConfigPath: '',
      },
      store: deps.providerConfigStore,
      initialProvider: deps.provider,
    });
  const app = Fastify({
    // Generous enough for the 100k-char source limit encoded as JSON and for
    // base64-encoded PDF/DOCX uploads (10 MB decoded → ~13.7 MB encoded).
    bodyLimit: 16 * 1024 * 1024,
    logger: deps.logger
      ? {
          level: 'info',
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.headers["x-api-key"]',
              'req.body.secret.value',
              'req.body.apiKey',
              'req.body.token',
            ],
            censor: '[REDACTED]',
          },
        }
      : false,
  });

  const clock = deps.clock ?? systemClock;
  const services = createServices({
    repos: deps.repos,
    provider: createRuntimeProvider(runtime),
    clock,
    providerModel: runtime.providerModel,
  });

  app.addHook('onRequest', async () => {
    runtime.enterRequest();
  });

  app.addHook('preHandler', async (request) => {
    const path = request.url.split('?', 1)[0];
    if ((path === '/api/config' && request.method !== 'GET') || path === '/api/config/test') {
      const remote = request.ip.replace(/^::ffff:/, '');
      if (!['127.0.0.1', '::1', 'localhost'].includes(remote)) {
        throw new AppError(ApiErrorCode.ValidationError, '提供程序设置仅允许本机访问。');
      }
      const origin = request.headers.origin;
      if (origin) {
        let originHost = '';
        try {
          originHost = new URL(origin).hostname.replace(/^\[(.*)\]$/, '$1');
        } catch {
          throw new AppError(ApiErrorCode.ValidationError, '提供程序设置请求来源无效。');
        }
        if (!['127.0.0.1', '::1', 'localhost'].includes(originHost)) {
          throw new AppError(ApiErrorCode.ValidationError, '提供程序设置仅允许本机页面访问。');
        }
      }
    }
  });

  // Restart policy: a Tutor run can only legitimately be `running` while its
  // request is in flight, so any leftover from a previous process is marked
  // interrupted here. Interrupted runs never altered learning state.
  deps.repos.tutor.markInterruptedRuns(clock.now().toISOString());
  deps.repos.studySessions.markInterruptedTurns(clock.now().toISOString());
  // Durable Agent operations cannot still have a live worker after this
  // process starts. Preserve sent attempts as outcome_unknown and make the
  // command retryable under a new physical attempt/fencing token.
  deps.repos.operations.recoverRunningAfterRestart(clock.now().toISOString());

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

  // Safe runtime state includes non-secret URL/model fields but never the key.
  app.get('/api/config', async () => runtime.safeConfig());
  app.patch('/api/config', async (request) => runtime.update(request.body));
  app.post('/api/config/test', async (request, reply) => {
    ProviderConnectionTestRequestSchema.parse(request.body ?? {});
    return runtime.testConnection(requestSignal(request, reply));
  });

  registerMaterialRoutes(app, services.materials);
  registerStudyRoutes(app, services);
  registerWorkspaceRoutes(app, services);
  registerAgentCourseRoutes(app, services);
  registerStudySessionRoutes(app, services);
  registerFormalProgressionRoutes(app, services);

  return app;
}
