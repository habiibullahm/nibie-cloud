/**
 * End-to-end proof of the milestone: provision -> access -> restart -> kill -> auto-recover,
 * through the backend API only (no manual `docker run`). Uses the Hermes STUB image, not Hermes.
 * Usage: pnpm demo [--keep]
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import Docker from 'dockerode';
import { createPrisma } from '../src/db/client.js';
import { buildServer } from '../src/http/server.js';
import { InstanceService } from '../src/modules/instances/instance-service.js';
import { Reconciler } from '../src/modules/instances/reconciler.js';
import { DockerRuntimeManager } from '../src/modules/runtime/docker-runtime-manager.js';
import { createLogger } from '../src/shared/logger.js';
import { ensureStubImage } from '../test/helpers/stub-image.js';

const keep = process.argv.includes('--keep');
const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://hermes:hermes_dev_only@127.0.0.1:5433/hermes';
const adminToken = randomUUID() + randomUUID(); // ephemeral, never printed
const logger = createLogger({ level: 'warn' });

const image = await ensureStubImage();
const prisma = createPrisma(databaseUrl);
const docker = new Docker();
const runtime = new DockerRuntimeManager({ docker, logger });
const service = new InstanceService({ prisma, runtime, image, production: false, logger, pollIntervalMs: 250 });
const reconciler = new Reconciler({ prisma, runtime, logger, pollIntervalMs: 250 });
const app = buildServer({
  service, logger,
  config: { nodeEnv: 'development', databaseUrl, hermesImage: image, port: 0, adminToken, dockerSocketPath: '' },
});

const step = (m: string) => console.log(`\n== ${m}`);
const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await app.inject({
    method: method as 'GET', url: `/api/v1${path}`, payload: body as object | undefined,
    headers: { authorization: `Bearer ${adminToken}`, ...headers },
  });
  return res.json();
};
const state = async (url: string) => ((await (await fetch(`${url}/state`)).json()) as { boots: number }).boots;
const sh = (id: string, script: string) =>
  execFileSync('docker', ['exec', `hermes-${id}`, 'sh', '-c', script], { encoding: 'utf8' }).trim();

try {
  step('Seed demo tenant, plan, node');
  const tenant = await prisma.tenant.create({ data: { name: `demo-${Date.now()}` } });
  const plan = await prisma.plan.upsert({
    where: { slug: 'demo-small' }, update: {},
    create: { slug: 'demo-small', cpuMillis: 500, memoryMb: 256, pids: 128, storageMb: 1024 },
  });
  await prisma.runtimeNode.upsert({ where: { name: 'local' }, update: {}, create: { name: 'local', region: 'local' } });

  step('Provision via API');
  const created = await api('POST', `/tenants/${tenant.id}/instances`, { name: 'demo agent', planId: plan.id }, { 'idempotency-key': randomUUID() });
  const id = created.instance.id as string;
  console.log(`status=${created.instance.status} accessUrl=${created.instance.accessUrl}`);
  if (created.instance.status !== 'ACTIVE') throw new Error('instance did not become ACTIVE');

  step('Access + persist data');
  let url = created.instance.accessUrl as string;
  console.log(`GET ${url}/healthz ->`, (await fetch(`${url}/healthz`)).status, `boots=${await state(url)}`);
  sh(id, 'echo hello-from-tenant > /data/marker');

  step('Restart via API');
  url = (await api('POST', `/tenants/${tenant.id}/instances/${id}/restart`)).instance.accessUrl;
  console.log(`boots=${await state(url)} marker=${sh(id, 'cat /data/marker')}`);

  step('Simulate crash (docker kill) and let the reconciler recover');
  await docker.getContainer(`hermes-${id}`).kill();
  console.log('reconcile ->', await reconciler.reconcileInstance(id));
  url = (await api('GET', `/tenants/${tenant.id}/instances/${id}`)).instance.accessUrl;
  const boots = await state(url);
  const marker = sh(id, 'cat /data/marker');
  console.log(`boots=${boots} marker=${marker}`);

  step('Event timeline');
  for (const e of (await api('GET', `/tenants/${tenant.id}/instances/${id}/events`)).events) {
    console.log(`${e.createdAt}  ${e.type.padEnd(22)} ${e.message}`);
  }

  if (boots !== 3 || marker !== 'hello-from-tenant') throw new Error('persistence/recovery check failed');
  console.log('\nOK: provisioned -> restarted -> recovered, data intact');

  if (!keep) {
    step('Cleanup');
    console.log('delete ->', (await api('DELETE', `/tenants/${tenant.id}/instances/${id}`)).instance.status);
  } else {
    console.log(`\n--keep: instance ${id} left running at ${url}`);
  }
} finally {
  await app.close();
  await prisma.$disconnect();
}
