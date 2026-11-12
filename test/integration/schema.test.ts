import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/db/client.js';
import { resetDb } from '../helpers/db.js';

const prisma = createPrisma(process.env.DATABASE_URL!);

async function seed() {
  const tenant = await prisma.tenant.create({ data: { name: 't' } });
  const plan = await prisma.plan.create({
    data: { slug: `p-${randomUUID()}`, cpuMillis: 500, memoryMb: 256, pids: 128, storageMb: 1024 },
  });
  const node = await prisma.runtimeNode.create({ data: { name: `n-${randomUUID()}`, region: 'local' } });
  return { tenant, plan, node };
}

const instanceData = (s: Awaited<ReturnType<typeof seed>>, key: string) => ({
  tenantId: s.tenant.id,
  planId: s.plan.id,
  nodeId: s.node.id,
  name: 'x',
  idempotencyKey: key,
  image: 'hermes-stub:0.1.0',
});

describe('schema constraints', () => {
  beforeEach(() => resetDb(prisma));
  afterAll(() => prisma.$disconnect());

  it('rejects duplicate (tenantId, idempotencyKey) with P2002', async () => {
    const s = await seed();
    await prisma.instance.create({ data: instanceData(s, 'k1') });
    await expect(prisma.instance.create({ data: instanceData(s, 'k1') })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('allows the same idempotencyKey for different tenants', async () => {
    const s = await seed();
    const other = await prisma.tenant.create({ data: { name: 'o' } });
    await prisma.instance.create({ data: instanceData(s, 'k1') });
    await expect(
      prisma.instance.create({ data: { ...instanceData(s, 'k1'), tenantId: other.id } }),
    ).resolves.toBeTruthy();
  });

  it('rejects an unknown tenantId (foreign key)', async () => {
    const s = await seed();
    await expect(
      prisma.instance.create({ data: { ...instanceData(s, 'k2'), tenantId: randomUUID() } }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('refuses to delete an instance row (events must survive)', async () => {
    const s = await seed();
    const inst = await prisma.instance.create({ data: instanceData(s, 'k3') });
    await prisma.instanceEvent.create({ data: { instanceId: inst.id, type: 't', message: 'm' } });
    await expect(prisma.instance.delete({ where: { id: inst.id } })).rejects.toMatchObject({ code: 'P2003' });
  });

  it('defaults status to PENDING with zeroed recovery counters', async () => {
    const s = await seed();
    const inst = await prisma.instance.create({ data: instanceData(s, 'k4') });
    expect(inst.status).toBe('PENDING');
    expect(inst.consecutiveFailures).toBe(0);
    expect(inst.recoveryAttempts).toBe(0);
  });

  it('has disk usage columns: diskUsedBytes nullable, diskLevel defaulting to ok', async () => {
    const s = await seed();
    const i = await prisma.instance.create({ data: instanceData(s, 'disk') });
    expect(i.diskUsedBytes).toBeNull();
    expect(i.diskLevel).toBe('ok');
    const big = await prisma.instance.update({ where: { id: i.id }, data: { diskUsedBytes: 5_000_000_000n } });
    expect(big.diskUsedBytes).toBe(5_000_000_000n);
  });
});
