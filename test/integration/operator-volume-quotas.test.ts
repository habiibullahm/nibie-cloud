import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/db/client.js';
import { buildServer } from '../../src/http/server.js';
import { InstanceCommands } from '../../src/modules/instances/instance-commands.js';
import { InstanceService } from '../../src/modules/instances/instance-service.js';
import { TEST_ADMIN_TOKEN, testConfig } from '../helpers/auth.js';
import { resetDb } from '../helpers/db.js';
import { FakeRuntime } from '../helpers/fake-runtime.js';
import { TEST_MASTER_KEY, seed, silentLogger } from '../helpers/service-env.js';

// GET /api/v1/volume-quotas feeds the host job that raises tenant volume quotas (ops/host/hermes-volume-quota.sh).
const prisma = createPrisma(process.env.DATABASE_URL!);
const IMAGE = 'hermes-stub:0.2.0';

describe('operator volume quotas', () => {
  let s: Awaited<ReturnType<typeof seed>>;
  let app: ReturnType<typeof buildServer>;

  beforeEach(async () => {
    await resetDb(prisma);
    s = await seed(prisma);
    const service = new InstanceService({
      prisma, runtime: new FakeRuntime(), image: IMAGE, production: false, logger: silentLogger, masterKey: TEST_MASTER_KEY,
      diskQuota: 'off', egressPolicy: 'off',
    });
    app = buildServer({
      service, queue: null, commands: new InstanceCommands({ service, queue: null, logger: silentLogger }),
      logger: silentLogger, config: testConfig(IMAGE, TEST_MASTER_KEY),
    });
  });
  afterAll(() => prisma.$disconnect());

  const mk = (status: 'ACTIVE' | 'STOPPED' | 'DELETED') => prisma.instance.create({
    data: { tenantId: s.tenant.id, planId: s.plan.id, nodeId: s.node.id, name: status, idempotencyKey: status, image: IMAGE, status },
  });

  it('lists the plan disk of every live instance, only with the admin token and never through a proxy', async () => {
    const active = await mk('ACTIVE');
    const stopped = await mk('STOPPED');
    await mk('DELETED');

    expect((await app.inject({ method: 'GET', url: '/api/v1/volume-quotas' })).statusCode).toBe(401);
    const proxied = await app.inject({
      method: 'GET', url: '/api/v1/volume-quotas',
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}`, 'x-forwarded-for': '203.0.113.9' },
    });
    expect(proxied.statusCode).toBe(404);

    const r = await app.inject({ method: 'GET', url: '/api/v1/volume-quotas', headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` } });
    expect(r.statusCode).toBe(200);
    const volumes = (r.json() as { volumes: Array<{ instanceId: string; storageMb: number }> }).volumes;
    expect(volumes.sort((a, b) => a.instanceId.localeCompare(b.instanceId))).toEqual(
      [active, stopped].map((i) => ({ instanceId: i.id, storageMb: s.plan.storageMb })).sort((a, b) => a.instanceId.localeCompare(b.instanceId)),
    );
  });
});
