import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/db/client.js';
import { DiskMonitor } from '../../src/modules/instances/disk-monitor.js';
import { RuntimeUnavailableError } from '../../src/shared/errors.js';
import { createLogger } from '../../src/shared/logger.js';
import { resetDb } from '../helpers/db.js';
import { FakeRuntime } from '../helpers/fake-runtime.js';
import { TEST_PLAN, seed } from '../helpers/service-env.js';

// Needs Postgres only (FakeRuntime provides the usage map).
const prisma = createPrisma(process.env.DATABASE_URL!);
const logger = createLogger({ level: 'silent' });
const LIMIT_BYTES = TEST_PLAN.storageMb * 1024 * 1024;
let s: Awaited<ReturnType<typeof seed>>;

const monitor = (rt: FakeRuntime) => new DiskMonitor({ prisma, runtime: rt, logger });
const pct = (p: number) => Math.round((LIMIT_BYTES * p) / 100);

async function instance(status: 'ACTIVE' | 'DEGRADED' | 'STOPPED' | 'FAILED' | 'STARTING' = 'ACTIVE') {
  return prisma.instance.create({
    data: {
      tenantId: s.tenant.id, planId: s.plan.id, nodeId: s.node.id, name: 'a', idempotencyKey: randomUUID(),
      image: 'hermes-stub:0.2.0', status,
    },
  });
}
const events = async (id: string) =>
  (await prisma.instanceEvent.findMany({ where: { instanceId: id }, orderBy: { createdAt: 'asc' } })).map((e) => e.type);
const row = (id: string) => prisma.instance.findUniqueOrThrow({ where: { id } });

describe('DiskMonitor', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    s = await seed(prisma);
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('records disk.warning once for repeated polls at 91%', async () => {
    const rt = new FakeRuntime();
    const i = await instance();
    rt.usage.set(i.id, pct(91));
    for (let n = 0; n < 3; n += 1) await monitor(rt).pollOnce();
    expect(await events(i.id)).toEqual(['disk.warning']);
    expect((await row(i.id)).diskLevel).toBe('warning');
  });

  it('records disk.full then nothing on a stable full level', async () => {
    const rt = new FakeRuntime();
    const i = await instance();
    rt.usage.set(i.id, pct(100));
    await monitor(rt).pollOnce();
    await monitor(rt).pollOnce();
    expect(await events(i.id)).toEqual(['disk.full']);
  });

  it('records disk.ok when usage drops below 85%', async () => {
    const rt = new FakeRuntime();
    const i = await instance();
    rt.usage.set(i.id, pct(95));
    await monitor(rt).pollOnce();
    rt.usage.set(i.id, pct(50));
    await monitor(rt).pollOnce();
    expect(await events(i.id)).toEqual(['disk.warning', 'disk.ok']);
    expect((await row(i.id)).diskLevel).toBe('ok');
  });

  it('a drop from full to warning records no event but updates diskLevel', async () => {
    const rt = new FakeRuntime();
    const i = await instance();
    rt.usage.set(i.id, pct(100));
    await monitor(rt).pollOnce();
    rt.usage.set(i.id, pct(90));
    await monitor(rt).pollOnce();
    expect(await events(i.id)).toEqual(['disk.full']);
    expect((await row(i.id)).diskLevel).toBe('warning');
  });

  it('does not flap at exactly 90% and 99%', async () => {
    const rt = new FakeRuntime();
    const i = await instance();
    for (const p of [90, 89, 90, 89, 99, 98, 99, 98]) {
      rt.usage.set(i.id, pct(p));
      await monitor(rt).pollOnce();
    }
    expect(await events(i.id)).toEqual(['disk.warning', 'disk.full']);
  });

  it('watches ACTIVE, DEGRADED and STOPPED instances only', async () => {
    const rt = new FakeRuntime();
    const watched = [await instance('ACTIVE'), await instance('DEGRADED'), await instance('STOPPED')];
    const skipped = [await instance('FAILED'), await instance('STARTING')];
    for (const i of [...watched, ...skipped]) rt.usage.set(i.id, pct(95));
    await monitor(rt).pollOnce();
    for (const i of watched) expect(await events(i.id)).toEqual(['disk.warning']);
    for (const i of skipped) expect(await events(i.id)).toEqual([]);
  });

  it('skips an instance missing from the usage map instead of treating it as 0 bytes', async () => {
    const rt = new FakeRuntime();
    const i = await instance();
    rt.usage.set(i.id, pct(95));
    await monitor(rt).pollOnce();
    rt.usage.delete(i.id);
    await monitor(rt).pollOnce();
    expect(await events(i.id)).toEqual(['disk.warning']);
    expect(Number((await row(i.id)).diskUsedBytes)).toBe(pct(95));
  });

  it('a RuntimeUnavailableError from volumeUsage writes no events and leaves diskLevel unchanged', async () => {
    const rt = new FakeRuntime();
    const i = await instance();
    rt.usage.set(i.id, pct(95));
    await monitor(rt).pollOnce();
    rt.usageError = new RuntimeUnavailableError();
    await expect(monitor(rt).pollOnce()).resolves.toBeUndefined();
    expect(await events(i.id)).toEqual(['disk.warning']);
    expect((await row(i.id)).diskLevel).toBe('warning');
  });

  it('never changes status or restarts a container', async () => {
    const rt = new FakeRuntime();
    const i = await instance('ACTIVE');
    rt.usage.set(i.id, pct(100));
    await monitor(rt).pollOnce();
    const r = await row(i.id);
    expect(r.status).toBe('ACTIVE');
    expect(r.statusReason).toBeNull();
    expect(rt.restarts).toBe(0);
  });

  it('stores diskUsedBytes', async () => {
    const rt = new FakeRuntime();
    const i = await instance();
    rt.usage.set(i.id, 12345);
    await monitor(rt).pollOnce();
    expect(Number((await row(i.id)).diskUsedBytes)).toBe(12345);
  });

  it('event messages are fixed text with a percentage only', async () => {
    const rt = new FakeRuntime();
    const i = await instance();
    rt.usage.set(i.id, pct(95));
    await monitor(rt).pollOnce();
    const e = await prisma.instanceEvent.findFirstOrThrow({ where: { instanceId: i.id } });
    expect(e.message).toBe('Disk usage at 95% of quota');
  });
});
