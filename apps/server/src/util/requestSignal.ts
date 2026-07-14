import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * An AbortSignal that fires when the client disconnects before the response
 * has been written — used to cancel in-flight provider calls.
 *
 * Aborting after the handler has already responded is a harmless no-op, so
 * the check only needs to be approximately right.
 */
export function requestSignal(request: FastifyRequest, reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  request.raw.on('close', () => {
    if (!reply.raw.writableEnded) {
      controller.abort();
    }
  });
  return controller.signal;
}
