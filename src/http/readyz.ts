import type { FastifyInstance } from 'fastify';

/** One named dependency check. It resolves when the dependency answers and rejects (or times out) when it does not. */
export type ReadinessCheck = () => Promise<void>;

export const READYZ_TIMEOUT_MS = 3_000;

function withTimeout(check: ReadinessCheck, ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    check().then(
      () => { clearTimeout(timer); resolve(); },
      (e: unknown) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * `GET /readyz`: 200 `{ status: 'ok' }` when every dependency answers, 503 `{ status: 'fail', failed: [names] }` otherwise.
 * Meant for the host watchdog on loopback; the public proxy does not forward it. The answer carries only dependency names,
 * never an error message, so nothing about the host or credentials can leak through it.
 */
export function registerReadyz(app: FastifyInstance, checks: Record<string, ReadinessCheck>, timeoutMs = READYZ_TIMEOUT_MS): void {
  app.get('/readyz', async (_req, reply) => {
    const names = Object.keys(checks);
    const results = await Promise.allSettled(names.map((n) => withTimeout(checks[n]!, timeoutMs)));
    const failed = names.filter((_, i) => results[i]!.status === 'rejected');
    reply.header('cache-control', 'no-store');
    if (failed.length === 0) return { status: 'ok' };
    return reply.status(503).send({ status: 'fail', failed });
  });
}
