import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * An AbortSignal that fires when the client disconnects before the response
 * has been fully written — used to cancel in-flight provider calls.
 *
 * IMPORTANT: we listen on the RESPONSE stream's 'close'. The request stream
 * closes as soon as its body has been consumed (i.e. immediately after JSON
 * parsing), which would cancel every request that carries a body. The
 * response stream only closes when the connection tears down or the response
 * finishes; `writableEnded` distinguishes the two.
 */
export function requestSignal(request: FastifyRequest, reply: FastifyReply): AbortSignal {
  void request;
  const controller = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded) {
      controller.abort();
    }
  });
  return controller.signal;
}
