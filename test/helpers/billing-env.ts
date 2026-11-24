import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { BillingService } from '../../src/modules/billing/billing-service.js';
import type { InvoiceRequest, PaymentClient } from '../../src/modules/billing/payment-client.js';
import type { Mailer, MailMessage } from '../../src/modules/billing/mailer.js';
import type { NodeScheduler } from '../../src/modules/instances/node-scheduler.js';
import { InstanceCommands } from '../../src/modules/instances/instance-commands.js';
import { InstanceService } from '../../src/modules/instances/instance-service.js';
import { PaymentProviderUnavailableError } from '../../src/shared/errors.js';
import { createLogger } from '../../src/shared/logger.js';
import { FakeRuntime } from './fake-runtime.js';
import { TEST_MASTER_KEY } from './service-env.js';

export const WEBHOOK_TOKEN = 'whtok_test_value_for_billing';
export const PRICE = 50_000;

export class FakeSumoPod implements PaymentClient {
  readonly invoices: InvoiceRequest[] = [];
  failNext = false;
  async createInvoice(input: InvoiceRequest) {
    if (this.failNext) { this.failNext = false; throw new PaymentProviderUnavailableError(); }
    this.invoices.push(input);
    return { reference: `REF-${this.invoices.length}`, paymentUrl: `https://sandbox.sumopod.test/pay/${input.merchantOrderId}` };
  }
}

export class FakeMailer implements Mailer {
  enabled = true;
  readonly sent: MailMessage[] = [];
  failNext = false;
  async send(m: MailMessage) {
    if (this.failNext) { this.failNext = false; throw new Error('smtp down'); }
    this.sent.push(m);
  }
}

export interface Clock { now: Date; advanceDays(d: number): void }
export const makeClock = (start = new Date('2026-12-01T00:00:00.000Z')): Clock => ({
  now: start,
  advanceDays(d) { this.now = new Date(this.now.getTime() + d * 86_400_000); },
});

/** A tenant with an owner, a priced plan and one node. */
export async function seedBilling(prisma: PrismaClient, o: { price?: number | null; email?: string } = {}) {
  const tenant = await prisma.tenant.create({ data: { name: 'tenant-a' } });
  const other = await prisma.tenant.create({ data: { name: 'tenant-b' } });
  const user = await prisma.user.create({ data: { id: randomUUID(), email: o.email ?? 'owner@example.test' } });
  await prisma.tenantMember.create({ data: { tenantId: tenant.id, userId: user.id } });
  const plan = await prisma.plan.create({
    data: { slug: 'test-small', name: 'Test small', cpuMillis: 500, memoryMb: 256, pids: 128, storageMb: 1024, monthlyPriceIdr: o.price === undefined ? PRICE : o.price },
  });
  const node = await prisma.runtimeNode.create({ data: { name: 'local', region: 'local' } });
  return { tenant, other, user, plan, node };
}

export function makeBilling(
  prisma: PrismaClient,
  o: {
    clock?: Clock;
    maxInstances?: number;
    maxTotal?: number | null;
    router?: NonNullable<ConstructorParameters<typeof BillingService>[0]['router']>;
    wallet?: boolean;
    placement?: NodeScheduler;
    paidNodeRegions?: readonly string[];
  } = {},
) {
  const logger = createLogger({ level: 'silent' });
  const runtime = new FakeRuntime();
  const clock = o.clock ?? makeClock();
  const service = new InstanceService({
    prisma, runtime, image: 'hermes-stub:0.2.0', production: false, logger, pollIntervalMs: 20, healthTimeoutMs: 300,
    masterKey: TEST_MASTER_KEY, diskQuota: 'off', egressPolicy: 'off', containerRuntime: 'runc', now: () => clock.now,
    ...(o.placement ? { placement: o.placement } : {}),
  });
  const commands = new InstanceCommands({ service, queue: null, logger });
  const sumopod = new FakeSumoPod();
  const mailer = new FakeMailer();
  const billing = new BillingService({
      prisma, paymentClient: sumopod, sumopodAuth: { webhookToken: WEBHOOK_TOKEN }, commands, mailer,
      dashboardOrigin: 'https://cloud.example.test', maxInstancesPerTenant: o.maxInstances ?? 1, maxTotalInstances: o.maxTotal ?? null, logger, now: () => clock.now,
      ...(o.router ? { router: o.router } : {}),
      ...(o.placement ? { placement: o.placement } : {}),
      ...(o.paidNodeRegions !== undefined ? { paidNodeRegions: o.paidNodeRegions } : {}),
      walletEnabled: o.wallet ?? false,
    });
  return { billing, sumopod, mailer, runtime, service, commands, clock, logger };
}

/** A SumoPod webhook body (svix-style envelope); `status` 'paid' unless overridden. */
export function webhookBody(o: { orderId: string; amount?: number; status?: string; reference?: string }) {
  const status = o.status ?? 'paid';
  return {
    event_type: status === 'paid' ? 'payment.completed' : 'payment.failed',
    data: { order_id: o.orderId, payment_id: o.reference ?? 'REF-1', amount: o.amount ?? PRICE, status },
  };
}
