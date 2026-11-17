import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/db/client.js';
import { AlertScanner } from '../../src/modules/ops/alert-scanner.js';
import { PrismaAlertStore } from '../../src/modules/ops/alert-store.js';
import { Alerter } from '../../src/modules/ops/alerter.js';
import { createLogger } from '../../src/shared/logger.js';
import { resetDb } from '../helpers/db.js';
import { seedBilling } from '../helpers/billing-env.js';

// Needs Postgres only: the alert channel is an in-memory sink and the clock is injected.
const prisma = createPrisma(process.env.DATABASE_URL!);
const logger = createLogger({ level: 'silent' });
let s: Awaited<ReturnType<typeof seedBilling>>;
let now: Date;
let sent: string[];
let scanner: AlertScanner;
let failedJobs: Array<{ jobId: string; op: 'start'; instanceId: string; attempts: number; reason: string; failedAt: Date }>;
const store = new PrismaAlertStore(prisma);

const at = (min: number) => new Date(Date.parse('2026-11-16T00:00:00Z') + min * 60_000);
const instance = (data: Record<string, unknown>) =>
  prisma.instance.create({ data: { tenantId: s.tenant.id, planId: s.plan.id, nodeId: s.node.id, name: `i-${randomUUID().slice(0, 8)}`, idempotencyKey: randomUUID(), image: 'hermes-stub:0.2.0', updatedAt: at(0), ...data } as never });

describe('AlertScanner', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "OperatorAlert", "BillingNotice", "CreditGrant", "Payment", "Subscription" CASCADE');
    s = await seedBilling(prisma);
    now = at(0);
    sent = [];
    failedJobs = [];
    const alerter = new Alerter({ store, sink: async (t) => { sent.push(t); }, logger, now: () => now });
    scanner = new AlertScanner({ prisma, alerter, store, logger, now: () => now, failedJobs: async () => failedJobs });
  });
  afterAll(() => prisma.$disconnect());

  it('stays silent on a healthy platform and sends no summary before 09:00 WIB', async () => {
    await instance({ status: 'ACTIVE' });
    now = new Date('2026-11-16T01:00:00Z');
    const r = await scanner.scanOnce();
    expect(sent).toHaveLength(0);
    expect(r.summarySent).toBe(false);
  });

  it('alerts when recovery is exhausted only after 10 minutes, once, and says when it recovered', async () => {
    const i = await instance({ status: 'DEGRADED', statusReason: 'recovery_exhausted' });
    now = at(5);
    await scanner.scanOnce();
    expect(sent).toHaveLength(0);
    now = at(12);
    await scanner.scanOnce();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('KRITIS');
    expect(sent[0]).toContain(i.id);
    now = at(14);
    await scanner.scanOnce();
    expect(sent).toHaveLength(1);
    await prisma.instance.update({ where: { id: i.id }, data: { status: 'ACTIVE', statusReason: null } });
    now = at(16);
    await scanner.scanOnce();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('PULIH');
    expect(await store.listOpen('instance-degraded:')).toHaveLength(0);
  });

  it('treats a FAILED instance with a running paid subscription as critical, an unpaid one as a warning', async () => {
    const paid = await instance({ status: 'FAILED', statusReason: 'provisioning_failed' });
    await prisma.subscription.create({ data: { tenantId: s.tenant.id, planId: s.plan.id, instanceId: paid.id, intendedName: 'a', status: 'ACTIVE', currentPeriodEnd: at(1000) } });
    const free = await instance({ status: 'FAILED' });
    now = at(5);
    await scanner.scanOnce();
    const kritis = sent.filter((m) => m.includes(paid.id));
    const warn = sent.filter((m) => m.includes(free.id));
    expect(kritis[0]).toContain('KRITIS');
    expect(kritis[0]).toContain('sudah membayar');
    expect(warn[0]).toContain('PERHATIAN');
  });

  it('alerts on a verified payment whose subscription still has no instance after 15 minutes', async () => {
    const sub = await prisma.subscription.create({ data: { tenantId: s.tenant.id, planId: s.plan.id, intendedName: 'a', status: 'ACTIVE', currentPeriodEnd: at(50_000) } });
    await prisma.payment.create({ data: { subscriptionId: sub.id, merchantOrderId: 'ORD-1', amountIdr: 25000, purpose: 'NEW', status: 'PAID', paidAt: at(-1), expiresAt: at(60) } });
    now = at(10);
    await scanner.scanOnce();
    expect(sent).toHaveLength(0);
    now = at(20);
    await scanner.scanOnce();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('ORD-1');
    const inst = await instance({ status: 'ACTIVE' });
    await prisma.subscription.update({ where: { id: sub.id }, data: { instanceId: inst.id } });
    now = at(22);
    await scanner.scanOnce();
    expect(sent.at(-1)).toContain('PULIH');
  });

  it('reports router provisioning from 5 attempts, critical once it has given up', async () => {
    const i = await instance({ status: 'ACTIVE' });
    await prisma.routerProvisioning.create({ data: { instanceId: i.id, tenantId: s.tenant.id, status: 'PENDING', attempts: 3, lastError: 'router_down' } });
    await scanner.scanOnce();
    expect(sent).toHaveLength(0);
    await prisma.routerProvisioning.update({ where: { instanceId: i.id }, data: { attempts: 6 } });
    await scanner.scanOnce();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('PERHATIAN');
    await prisma.routerProvisioning.update({ where: { instanceId: i.id }, data: { attempts: 24 } });
    now = at(1);
    await scanner.scanOnce();
    expect(sent.at(-1)).toContain('berhenti dicoba');
  });

  it('reports exhausted queue jobs and clears them when the job is gone', async () => {
    failedJobs = [{ jobId: 'abc_start', op: 'start', instanceId: randomUUID(), attempts: 4, reason: 'ConflictError', failedAt: now }];
    await scanner.scanOnce();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('ConflictError');
    failedJobs = [];
    now = at(1);
    await scanner.scanOnce();
    expect(sent.at(-1)).toContain('PULIH');
  });

  it('does not raise or resolve anything when a check cannot read its data', async () => {
    failedJobs = [{ jobId: 'x_start', op: 'start', instanceId: randomUUID(), attempts: 4, reason: 'Error', failedAt: now }];
    await scanner.scanOnce();
    expect(sent).toHaveLength(1);
    const broken = new AlertScanner({
      prisma, store, logger, now: () => now, failedJobs: async () => { throw new Error('redis down'); },
      alerter: new Alerter({ store, sink: async (t) => { sent.push(t); }, logger, now: () => now }),
    });
    const r = await broken.scanOnce();
    expect(r.failedChecks).toBe(1);
    expect(sent).toHaveLength(1);
    expect(await store.listOpen('job-failed:')).toHaveLength(1);
  });

  it('sends the daily summary once per day, also after a restart', async () => {
    await instance({ status: 'ACTIVE' });
    now = new Date('2026-11-16T02:30:00Z');
    expect((await scanner.scanOnce()).summarySent).toBe(true);
    expect(sent[0]).toContain('Ringkasan harian 2026-11-16');
    expect(sent[0]).toContain('Agen aktif: 1');
    expect((await scanner.scanOnce()).summarySent).toBe(false);
    const restarted = new AlertScanner({ prisma, store, logger, now: () => now, alerter: new Alerter({ store, sink: async (t) => { sent.push(t); }, logger, now: () => now }) });
    expect((await restarted.scanOnce()).summarySent).toBe(false);
    expect(sent).toHaveLength(1);
    now = new Date('2026-11-17T02:30:00Z');
    expect((await scanner.scanOnce()).summarySent).toBe(true);
    expect(sent).toHaveLength(2);
  });
});
