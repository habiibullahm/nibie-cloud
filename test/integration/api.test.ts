import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/db/client.js';
import { buildServer } from '../../src/http/server.js';
import { InstanceService } from '../../src/modules/instances/instance-service.js';
import type { RuntimeManager } from '../../src/modules/runtime/types.js';
import { RuntimeUnavailableError } from '../../src/shared/errors.js';
import { createLogger } from '../../src/shared/logger.js';
import { resetDb } from '../helpers/db.js';
import { cleanupDocker, realRuntime, seed, silentLogger, waitFor, wrapRuntime } from '../helpers/service-env.js';
import { ensureStubImage } from '../helpers/stub-image.js';

const TOKEN = 'test-admin-token-0123456789abcdef';
const prisma = createPrisma(process.env.DATABASE_URL!);
let image: string;
let s: Awaited<ReturnType<typeof seed>>;
let logs = '';
const logStream = new Writable({ write(c, _e, cb) { logs += c.toString(); cb(); } });

function app(runtime: RuntimeManager = realRuntime()): FastifyInstance {
  const logger = createLogger({ level: 'debug', stream: logStream });
  const service = new InstanceService({ prisma, runtime, image, production: false, logger: silentLogger, pollIntervalMs: 200, healthTimeoutMs: 15_000 });
  return buildServer({
    service, logger,
    config: { nodeEnv: 'test', databaseUrl: 'x', hermesImage: image, port: 0, adminToken: TOKEN, dockerSocketPath: '' },
  });
}
const auth = { authorization: `Bearer ${TOKEN}` };
const base = () => `/api/v1/tenants/${s.tenant.id}/instances`;

describe('REST API', () => {
  beforeAll(async () => { image = await ensureStubImage(); });
  beforeEach(async () => { logs = ''; await cleanupDocker(); await resetDb(prisma); s = await seed(prisma); });
  afterAll(async () => { await cleanupDocker(); await prisma.$disconnect(); });

  it('serves /healthz without auth and without touching Docker', async () => {
    const res = await app().inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });

  it('rejects missing or wrong bearer tokens with 401', async () => {
    const a = app();
    expect((await a.inject({ method: 'GET', url: base() })).statusCode).toBe(401);
    expect((await a.inject({ method: 'GET', url: base(), headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
    expect((await a.inject({ method: 'GET', url: base(), headers: { authorization: `Basic ${TOKEN}` } })).statusCode).toBe(401);
  });

  it('requires an Idempotency-Key header and a valid body', async () => {
    const a = app();
    const noKey = await a.inject({ method: 'POST', url: base(), headers: auth, payload: { name: 'x', planId: s.plan.id } });
    expect(noKey.statusCode).toBe(400);
    const badBody = await a.inject({ method: 'POST', url: base(), headers: { ...auth, 'idempotency-key': randomUUID() }, payload: { name: 1 } });
    expect(badBody.statusCode).toBe(400);
  });

  it('provisions, reports status, restarts, stops, starts and deletes', async () => {
    const a = app();
    const key = randomUUID();
    const create = await a.inject({ method: 'POST', url: base(), headers: { ...auth, 'idempotency-key': key }, payload: { name: 'agent', planId: s.plan.id } });
    expect(create.statusCode).toBe(202);
    const id = create.json().instance.id as string;
    const again = await a.inject({ method: 'POST', url: base(), headers: { ...auth, 'idempotency-key': key }, payload: { name: 'agent', planId: s.plan.id } });
    expect(again.json().instance.id).toBe(id);

    await waitFor(async () => (await a.inject({ method: 'GET', url: `${base()}/${id}/status`, headers: auth })).json().status === 'ACTIVE');
    const got = await a.inject({ method: 'GET', url: `${base()}/${id}`, headers: auth });
    expect(got.json().instance.accessUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(JSON.stringify(got.json())).not.toContain('hostPort');

    expect((await a.inject({ method: 'POST', url: `${base()}/${id}/restart`, headers: auth })).statusCode).toBe(202);
    const stop = await a.inject({ method: 'POST', url: `${base()}/${id}/stop`, headers: auth });
    expect(stop.json().instance.status).toBe('STOPPED');
    const start = await a.inject({ method: 'POST', url: `${base()}/${id}/start`, headers: auth });
    expect(start.json().instance.status).toBe('ACTIVE');
    const events = await a.inject({ method: 'GET', url: `${base()}/${id}/events`, headers: auth });
    expect(events.json().events.length).toBeGreaterThan(3);
    const list = await a.inject({ method: 'GET', url: base(), headers: auth });
    expect(list.json().instances).toHaveLength(1);
    const del = await a.inject({ method: 'DELETE', url: `${base()}/${id}`, headers: auth });
    expect(del.statusCode).toBe(202);
    expect(del.json().instance.status).toBe('DELETED');
  });

  it('answers 404 when the path tenant does not own the instance, or ids are malformed', async () => {
    const a = app();
    const create = await a.inject({ method: 'POST', url: base(), headers: { ...auth, 'idempotency-key': randomUUID() }, payload: { name: 'x', planId: s.plan.id } });
    const id = create.json().instance.id as string;
    const foreign = `/api/v1/tenants/${s.other.id}/instances/${id}`;
    expect((await a.inject({ method: 'GET', url: foreign, headers: auth })).statusCode).toBe(404);
    expect((await a.inject({ method: 'POST', url: `${foreign}/stop`, headers: auth })).statusCode).toBe(404);
    expect((await a.inject({ method: 'DELETE', url: foreign, headers: auth })).statusCode).toBe(404);
    expect((await a.inject({ method: 'GET', url: `${base()}/not-a-uuid`, headers: auth })).statusCode).toBe(404);
  });

  it('answers 409 for one of two racing restart/stop calls', async () => {
    const a = app();
    const create = await a.inject({ method: 'POST', url: base(), headers: { ...auth, 'idempotency-key': randomUUID() }, payload: { name: 'x', planId: s.plan.id } });
    const id = create.json().instance.id as string;
    const codes = (await Promise.all([
      a.inject({ method: 'POST', url: `${base()}/${id}/restart`, headers: auth }),
      a.inject({ method: 'POST', url: `${base()}/${id}/stop`, headers: auth }),
    ])).map((r) => { return r.statusCode; }).sort();
    expect(codes).toEqual([202, 409]);
  });

  it('answers 503 with a sanitized body and leaves an active instance ACTIVE when Docker is down', async () => {
    const ok = app();
    const create = await ok.inject({ method: 'POST', url: base(), headers: { ...auth, 'idempotency-key': randomUUID() }, payload: { name: 'x', planId: s.plan.id } });
    const id = create.json().instance.id as string;
    const down = app(wrapRuntime(realRuntime(), { restart: async () => { throw new RuntimeUnavailableError(); } }));
    const res = await down.inject({ method: 'POST', url: `${base()}/${id}/restart`, headers: auth });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('runtime_unavailable');
    const status = await ok.inject({ method: 'GET', url: `${base()}/${id}/status`, headers: auth });
    expect(status.json().status).toBe('ACTIVE');
  });

  it('never returns 500 details and never logs or echoes the admin token', async () => {
    const boom = app(wrapRuntime(realRuntime(), { ensure: async () => { throw new Error(`secret ${TOKEN}`); } }));
    const res = await boom.inject({ method: 'POST', url: base(), headers: { ...auth, 'idempotency-key': randomUUID() }, payload: { name: 'x', planId: s.plan.id } });
    expect(res.body).not.toContain(TOKEN);
    await app().inject({ method: 'GET', url: base(), headers: auth });
    await app().inject({ method: 'GET', url: base(), headers: { authorization: 'Bearer wrong-token-value' } });
    expect(logs).not.toContain(TOKEN);
    expect(logs).not.toContain('wrong-token-value');
  });
});
