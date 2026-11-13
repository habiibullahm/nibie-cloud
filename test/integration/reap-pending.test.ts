import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/db/client.js';
import { Reconciler } from '../../src/modules/instances/reconciler.js';
import { resetDb } from '../helpers/db.js';
import { FakeRuntime } from '../helpers/fake-runtime.js';
import { TEST_MASTER_KEY, seed, silentLogger } from '../helpers/service-env.js';

const prisma = createPrisma(process.env.DATABASE_URL!);
let s: Awaited<ReturnType<typeof seed>>;

const reconciler = (reapPending?: boolean) =>
  new Reconciler({
    prisma, runtime: new FakeRuntime(), logger: silentLogger, masterKey: TEST_MASTER_KEY, diskQuota: 'off', egressPolicy: 'off',
    now: () => new Date(Date.now() + 10 * 60_000), // ten minutes later
    ...(reapPending === undefined ? {} : { reapPending }),
  });

describe('stale PENDING rows', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    s = await seed(prisma);
  });
  afterAll(() => prisma.$disconnect());

  const pending = () =>
    prisma.instance.create({ data: { tenantId: s.tenant.id, planId: s.plan.id, nodeId: s.node.id, name: 'x', idempotencyKey: crypto.randomUUID(), image: 'hermes-stub:0.2.0' } });

  it('are failed as stalled by default (inline mode has no other recovery)', async () => {
    const i = await pending();
    expect(await reconciler().reapStale()).toBe(1);
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: i.id } })).status).toBe('FAILED');
  });

  it('are left alone when the queue sweeper owns them (reapPending: false)', async () => {
    const i = await pending();
    expect(await reconciler(false).reapStale()).toBe(0);
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: i.id } })).status).toBe('PENDING');
  });
});
