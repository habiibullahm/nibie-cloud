import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/db/client.js';
import { IdentityService } from '../../src/modules/auth/identity-service.js';
import { resetDb } from '../helpers/db.js';

const prisma = createPrisma(process.env.DATABASE_URL!);
const identity = new IdentityService({ prisma });

describe('IdentityService.resolve', () => {
  beforeEach(() => resetDb(prisma));
  afterAll(() => prisma.$disconnect());

  it('creates the user, a personal tenant and an OWNER membership on first login', async () => {
    const userId = randomUUID();
    const p = await identity.resolve({ userId, email: 'a@example.test' });
    expect(p).toMatchObject({ userId, email: 'a@example.test' });
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: p.tenantId } });
    expect(tenant.name).toBe('personal');
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.tenantMember.findMany()).toEqual([{ tenantId: p.tenantId, userId, role: 'OWNER' }]);
  });

  it('returns the same principal on later logins and creates nothing', async () => {
    const claims = { userId: randomUUID(), email: 'a@example.test' };
    const first = await identity.resolve(claims);
    const second = await identity.resolve(claims);
    expect(second).toEqual(first);
    expect(await prisma.tenant.count()).toBe(1);
    expect(await prisma.user.count()).toBe(1);
  });

  it('survives ten concurrent first requests: one user, one tenant, one membership', async () => {
    const claims = { userId: randomUUID(), email: 'a@example.test' };
    const results = await Promise.all(Array.from({ length: 10 }, () => identity.resolve(claims)));
    expect(new Set(results.map((r) => r.tenantId)).size).toBe(1);
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.tenant.count()).toBe(1);
    expect(await prisma.tenantMember.count()).toBe(1);
  });

  it('refreshes the stored email when the token carries a new one', async () => {
    const userId = randomUUID();
    await identity.resolve({ userId, email: 'old@example.test' });
    const p = await identity.resolve({ userId, email: 'new@example.test' });
    expect(p.email).toBe('new@example.test');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).email).toBe('new@example.test');
  });

  it('gives different users different tenants', async () => {
    const a = await identity.resolve({ userId: randomUUID(), email: 'a@example.test' });
    const b = await identity.resolve({ userId: randomUUID(), email: 'b@example.test' });
    expect(a.tenantId).not.toBe(b.tenantId);
  });

  it('never puts the email in the tenant name', async () => {
    const p = await identity.resolve({ userId: randomUUID(), email: 'someone@example.test' });
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: p.tenantId } });
    expect(tenant.name).not.toContain('someone');
  });
});
