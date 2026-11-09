import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from './errors.js';

interface Entry {
  status: number;
  payload: string | null;
  until: number;
}

const TTL = 24 * 3600_000;
const MAX = 10_000;
const CHANGES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * A change sent with an Idempotency-Key header runs once per caller, address and key: a retry or a
 * double click gets the first answer back instead of making a second change. Kept in memory for a
 * day, per server process. Register it in a scope after the hook that signs the caller in, so
 * `who` knows them; a request it can't tie to a caller runs as usual.
 */
export function registerIdempotency(
  scope: FastifyInstance,
  who: (request: FastifyRequest) => string | undefined,
): void {
  const entries = new Map<string, Entry | 'running'>();
  const keyOf = (request: FastifyRequest) => {
    const header = request.headers['idempotency-key'];
    if (!CHANGES.has(request.method) || typeof header !== 'string' || !header) return null;
    const caller = who(request);
    if (!caller) return null;
    return `${caller}|${request.method}|${request.url}|${header.slice(0, 100)}`;
  };

  scope.addHook('preHandler', async (request, reply) => {
    const key = keyOf(request);
    if (!key) return;
    const entry = entries.get(key);
    if (entry === 'running') throw new AppError('conflict', 'That request is still running.');
    if (entry && entry.until > Date.now()) {
      void reply.header('Idempotent-Replayed', 'true').code(entry.status).type('application/json');
      return reply.send(entry.payload);
    }
    entries.set(key, 'running');
  });

  scope.addHook('onSend', async (request, reply, payload) => {
    const key = keyOf(request);
    if (!key || entries.get(key) !== 'running') return payload;
    if (reply.statusCode >= 500) entries.delete(key);
    else {
      if (entries.size > MAX) entries.clear();
      entries.set(key, {
        status: reply.statusCode,
        payload: typeof payload === 'string' ? payload : null,
        until: Date.now() + TTL,
      });
    }
    return payload;
  });

  // A request that fails before it sends anything mustn't stay "running" forever.
  scope.addHook('onResponse', (request, _reply, done) => {
    const key = keyOf(request);
    if (key && entries.get(key) === 'running') entries.delete(key);
    done();
  });
}
