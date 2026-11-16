import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerReadyz } from '../../src/http/readyz.js';

function app(checks: Parameters<typeof registerReadyz>[1], timeoutMs?: number) {
  const a = Fastify();
  registerReadyz(a, checks, timeoutMs);
  return a;
}

describe('GET /readyz', () => {
  it('answers 200 ok when every check passes, and with no checks', async () => {
    const res = await app({ database: async () => undefined, redis: async () => undefined }).inject('/readyz');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect((await app({}).inject('/readyz')).statusCode).toBe(200);
  });

  it('answers 503 with only the failing names, never an error message', async () => {
    const res = await app({
      database: async () => undefined,
      redis: async () => { throw new Error('redis://:hunter2@127.0.0.1:6380 refused'); },
    }).inject('/readyz');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'fail', failed: ['redis'] });
    expect(res.body).not.toContain('hunter2');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('counts a check that never answers as failed once the timeout passes', async () => {
    const res = await app({ docker: () => new Promise<void>(() => undefined) }, 50).inject('/readyz');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'fail', failed: ['docker'] });
  });
});
