import Fastify, { type FastifyInstance } from 'fastify';

export interface BuildAppOptions {
  logger?: boolean;
}

/**
 * Build the Fastify application instance.
 * Kept separate from the listener so tests can use `app.inject()`.
 */
export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger
      ? {
          level: 'info',
          // Never log credential-bearing headers.
          redact: {
            paths: ['req.headers.authorization', 'req.headers.cookie'],
            censor: '[REDACTED]',
          },
        }
      : false,
  });

  app.get('/api/health', async () => {
    return { status: 'ok', service: 'hy3-study-clinic-server' };
  });

  return app;
}
