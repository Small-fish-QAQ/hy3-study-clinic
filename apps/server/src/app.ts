import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError, statusForErrorCode } from './errors.js';
import { IngestionError } from './ingestion/ingest.js';
import { ingestionResources } from './ingestion/resources.js';
import { ProviderError } from './llm/errors.js';
import type { CourseProvider } from './llm/courseContract.js';
import type { SqliteDb } from './db/database.js';
import { initializeClinic } from './db/schema.js';
import { ClinicRepository } from './repositories/clinic.js';
import { createClinic, type Clinic } from './services/clinic.js';
import { registerClinicRoutes } from './routes/clinic.js';
import type { ProviderRuntime } from './services/providerRuntime.js';

export interface AppDeps {
  db: SqliteDb;
  provider: CourseProvider;
  providerRuntime?: ProviderRuntime;
  logger?: boolean;
  now?: () => string;
  leaseMs?: number;
  heartbeatMs?: number;
  concurrency?: number;
}
export type ClinicApp = FastifyInstance & { clinic: Clinic };
export function buildApp(deps: AppDeps): ClinicApp {
  initializeClinic(deps.db);
  const resources = ingestionResources();
  const app = Fastify({
    logger: deps.logger ?? false,
    bodyLimit: Math.max(Math.ceil(resources.fileBytes / 3) * 4, resources.textBytes) + 128 * 1024,
  }) as unknown as ClinicApp;
  const selected = () => deps.providerRuntime?.provider ?? deps.provider;
  const clinic = createClinic(new ClinicRepository(deps.db, deps.now), selected, {
    leaseMs: deps.leaseMs,
    heartbeatMs: deps.heartbeatMs,
    concurrency: deps.concurrency,
  });
  app.decorate('clinic', clinic);
  app.addHook('onRequest', async (request, reply) => {
    deps.providerRuntime?.enterRequest();
    const origin = request.headers.origin;
    if (origin) {
      const own = `${request.protocol}://${request.headers.host}`;
      const allowed = [
        own,
        ...['localhost', '127.0.0.1', '[::1]'].flatMap((h) =>
          [5173, 5174].map((p) => `http://${h}:${p}`),
        ),
      ];
      if (!allowed.includes(origin)) {
        reply
          .code(403)
          .send({ error: { code: 'VALIDATION_ERROR', message: '请求来源未获授权。' } });
        return;
      }
      reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin');
      if (request.method === 'OPTIONS') {
        reply
          .header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
          .header('Access-Control-Allow-Headers', 'content-type');
        reply.code(204).send();
      }
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply
        .code(400)
        .send({ error: { code: 'VALIDATION_ERROR', message: '请求不符合当前接口合同。' } });
      return;
    }
    if (
      error instanceof AppError ||
      error instanceof ProviderError ||
      error instanceof IngestionError
    ) {
      reply
        .code(statusForErrorCode(error.code))
        .send({ error: { code: error.code, message: error.message } });
      return;
    }
    if ((error as { statusCode?: number }).statusCode === 413) {
      reply
        .code(413)
        .send({ error: { code: 'SOURCE_TOO_LARGE', message: '请求超过配置的导入资源大小。' } });
      return;
    }
    reply
      .code(500)
      .send({ error: { code: 'INTERNAL', message: '处理未完成，请保留已保存结果并重试。' } });
  });
  registerClinicRoutes(app, clinic, selected, deps.providerRuntime);
  app.addHook('onClose', async () => {
    clinic.operations.close();
    await clinic.operations.idle();
  });
  return app;
}
