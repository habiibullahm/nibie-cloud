import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import Docker from 'dockerode';
import { createPrisma } from '../../src/db/client.js';
import { BillingService } from '../../src/modules/billing/billing-service.js';
import { InstanceCommands } from '../../src/modules/instances/instance-commands.js';
import { InstanceService } from '../../src/modules/instances/instance-service.js';
import { NodeScheduler } from '../../src/modules/instances/node-scheduler.js';
import { createBullQueue } from '../../src/modules/jobs/bullmq-queue.js';
import { RuntimeFleet } from '../../src/modules/runtime/fleet.js';
import { DockerRuntimeManager } from '../../src/modules/runtime/docker-runtime-manager.js';
import { WaitlistInviter } from '../../src/modules/waitlist/waitlist-inviter.js';
import { CapacityFullError } from '../../src/shared/errors.js';
import { FakeMailer, FakeSumoPod, PRICE, WEBHOOK_TOKEN, webhookBody } from '../helpers/billing-env.js';
import { silentLogger } from '../helpers/service-env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const runtimeEnv = JSON.parse(readFileSync(resolve(__dirname, '../../e2e/.local/fleet-runtime.env.json'), 'utf8')) as {
  adminToken: string;
  masterKey: string;
  databaseUrl: string;
  redisUrl: string;
  apiOrigin: string;
  dashboardOrigin: string;
  fleetFile: string;
  hermesImage: string;
};

async function api(path: string, body?: unknown, key?: string, method = body === undefined ? 'GET' : 'POST') {
  return fetch(`${runtimeEnv.apiOrigin}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${runtimeEnv.adminToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
}

async function checked(res: Response, expected: number) {
  assert.equal(res.status, expected, await res.clone().text());
  return res;
}

const prisma = createPrisma(runtimeEnv.databaseUrl);
const docker = new Docker({ socketPath: process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock' });
const localRuntime = new DockerRuntimeManager({ docker, logger: silentLogger });
const fleet = await RuntimeFleet.open({
  file: runtimeEnv.fleetFile,
  prisma,
  local: localRuntime,
  ping: () => docker.ping(),
});
const placement = new NodeScheduler(() => fleet.placementNodes());
const queue = createBullQueue({ redisUrl: runtimeEnv.redisUrl, logger: silentLogger });
const service = new InstanceService({
  prisma,
  placement,
  runtime: fleet,
  logger: silentLogger,
  image: runtimeEnv.hermesImage,
  production: false,
  masterKey: runtimeEnv.masterKey,
  diskQuota: 'off',
  egressPolicy: 'off',
  localNodeId: fleet.localNodeId(),
});
const commands = new InstanceCommands({ service, queue, logger: silentLogger });
const gateway = new FakeSumoPod();
const mailer = new FakeMailer();
const billing = new BillingService({
  prisma,
  placement,
  paymentClient: gateway,
  commands,
  mailer,
  sumopodAuth: { webhookToken: WEBHOOK_TOKEN },
  dashboardOrigin: runtimeEnv.dashboardOrigin,
  maxInstancesPerTenant: 2,
  logger: silentLogger,
});

async function waitForStatus(id: string, expected: string) {
  for (let i = 0; i < 80; i++) {
    const row = await prisma.instance.findUniqueOrThrow({ where: { id }, include: { node: true } });
    if (row.status === expected) return row;
    if (row.status === 'FAILED' && expected !== 'DELETED') throw new Error(`Instance failed: ${row.statusReason}`);
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${id} -> ${expected}`);
}

const createdTenants: string[] = [];
const createdPlans: string[] = [];
const buyerEmail = `${randomUUID()}@example.test`;
let subscriptionId: string | undefined;

try {
  await checked(await api('/runtime-nodes/jkt-2/schedulable', { schedulable: true }), 200);
  const nodes = await prisma.runtimeNode.findMany();
  const localId = fleet.localNodeId();
  const remoteId = nodes.find((n) => n.name === 'jkt-2')!.id;

  const occupantTenant = await prisma.tenant.create({ data: { name: 'Billing Occupant' } });
  const buyerTenant = await prisma.tenant.create({ data: { name: 'Billing Buyer' } });
  const overflowTenant = await prisma.tenant.create({ data: { name: 'Billing Overflow' } });
  createdTenants.push(occupantTenant.id, buyerTenant.id, overflowTenant.id);

  const fullPlan = await prisma.plan.create({
    data: { slug: `bill-full-${randomUUID()}`, name: 'Full Slot', cpuMillis: 4000, memoryMb: 4096, storageMb: 1024, pids: 128 },
  });
  const paidPlan = await prisma.plan.create({
    data: { slug: `bill-paid-${randomUUID()}`, name: 'Paid Slot', cpuMillis: 4000, memoryMb: 4096, storageMb: 1024, pids: 128, monthlyPriceIdr: PRICE },
  });
  const tooLarge = await prisma.plan.create({
    data: { slug: `bill-xl-${randomUUID()}`, name: 'XL Slot', cpuMillis: 5000, memoryMb: 4096, storageMb: 1024, pids: 128, monthlyPriceIdr: PRICE },
  });
  createdPlans.push(fullPlan.id, paidPlan.id, tooLarge.id);

  // Cordon jkt-2 briefly so occupant lands on jkt-1 cleanly, then uncordon jkt-2
  await checked(await api('/runtime-nodes/jkt-2/schedulable', { schedulable: false }), 200);
  const occRes = await checked(
    await api(`/tenants/${occupantTenant.id}/instances`, { name: 'Occupant', planId: fullPlan.id }, 'occ-1'),
    202,
  );
  const occBody = await occRes.json() as { instance: { id: string } };
  const occRow = await waitForStatus(occBody.instance.id, 'ACTIVE');
  assert.equal(occRow.nodeId, localId);
  await checked(await api('/runtime-nodes/jkt-2/schedulable', { schedulable: true }), 200);

  // 1) Checkout reserves jkt-2; non-paying request gets 409
  const sale = await billing.checkout({
    tenantId: buyerTenant.id,
    email: buyerEmail,
    name: 'Paid Fleet',
    planId: paidPlan.id,
    idempotencyKey: randomUUID(),
  });
  subscriptionId = sale.subscription.id;
  const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
  assert.equal(sub.reservedNodeId, remoteId);

  await checked(
    await api(`/tenants/${overflowTenant.id}/instances`, { name: 'Blocked', planId: fullPlan.id }, 'blocked-checkout'),
    409,
  );

  // 2) FakeSumoPod webhook settles and spawns instance onto reserved jkt-2
  const event = await billing.handleSumoPodWebhook(
    { token: WEBHOOK_TOKEN },
    webhookBody({ orderId: gateway.invoices[0]!.merchantOrderId }),
  );
  assert.ok(event.accepted && event.outcome === 'activated');
  await event.postActions();

  const paidSub = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
  assert.ok(paidSub.instanceId);
  assert.equal(paidSub.reservedNodeId, null);
  const paidInstance = await waitForStatus(paidSub.instanceId, 'ACTIVE');
  assert.equal(paidInstance.nodeId, remoteId);

  // 3) Upgrade larger than node capacity rejects cleanly
  await assert.rejects(() => billing.upgrade({
    tenantId: occupantTenant.id,
    email: buyerEmail,
    instanceId: occRow.id,
    planId: tooLarge.id,
    idempotencyKey: randomUUID(),
  }), CapacityFullError);

  // Free jkt-2 for waitlist reservation drill
  await checked(await api(`/tenants/${buyerTenant.id}/instances/${paidInstance.id}`, undefined, undefined, 'DELETE'), 202);
  await waitForStatus(paidInstance.id, 'DELETED');
  await billing.endForInstance(buyerTenant.id, paidInstance.id);

  // 4) Waitlist invite reserves jkt-2, stranger gets 409, invite claim deploys onto jkt-2
  await prisma.waitlistEntry.create({
    data: { email: buyerEmail, name: 'Invite Fleet', useCase: 'Fleet drill', status: 'WAITING' },
  });
  const inviter = new WaitlistInviter({
    prisma,
    placement,
    mailer,
    slots: 5,
    registerUrl: `${runtimeEnv.dashboardOrigin}/dashboard/register`,
    logger: silentLogger,
  });
  assert.equal((await inviter.runOnce()).invited, 1);
  assert.equal((await prisma.waitlistEntry.findUniqueOrThrow({ where: { email: buyerEmail } })).reservedNodeId, remoteId);

  await checked(
    await api(`/tenants/${overflowTenant.id}/instances`, { name: 'Blocked', planId: fullPlan.id }, 'blocked-waitlist'),
    409,
  );

  const claimed = await commands.provision({
    tenantId: buyerTenant.id,
    name: 'Invited Instance',
    planId: fullPlan.id,
    waitlistEmail: buyerEmail,
    idempotencyKey: randomUUID(),
  });
  const claimedRow = await waitForStatus(claimed.instance.id, 'ACTIVE');
  assert.equal(claimedRow.nodeId, remoteId);
  assert.equal((await prisma.waitlistEntry.findUniqueOrThrow({ where: { email: buyerEmail } })).reservedNodeId, null);

  console.log('Scenario 4 passed: checkout reservation, webhook spawn on jkt-2, upgrade capacity rejection, waitlist reservation & claim');
} finally {
  for (const tenantId of createdTenants) {
    const rows = await prisma.instance.findMany({
      where: { tenantId, status: { in: ['ACTIVE', 'DEGRADED', 'STOPPED', 'FAILED'] } },
    });
    for (const r of rows) {
      await api(`/tenants/${tenantId}/instances/${r.id}`, undefined, undefined, 'DELETE').catch(() => undefined);
      await waitForStatus(r.id, 'DELETED').catch(() => undefined);
    }
  }
  if (subscriptionId) {
    const payments = await prisma.payment.findMany({ where: { subscriptionId }, select: { merchantOrderId: true } }).catch(() => []);
    const orderIds = payments.map((p) => p.merchantOrderId);
    if (orderIds.length > 0) {
      await prisma.paymentEvent.deleteMany({ where: { merchantOrderId: { in: orderIds } } }).catch(() => undefined);
    }
    await prisma.invoice.deleteMany({ where: { payment: { subscriptionId } } }).catch(() => undefined);
    await prisma.payment.deleteMany({ where: { subscriptionId } }).catch(() => undefined);
    await prisma.subscription.deleteMany({ where: { id: subscriptionId } }).catch(() => undefined);
  }
  await prisma.waitlistEntry.deleteMany({ where: { email: buyerEmail } }).catch(() => undefined);
  if (createdTenants.length > 0) {
    await prisma.instanceEvent.deleteMany({ where: { instance: { tenantId: { in: createdTenants } } } }).catch(() => undefined);
    await prisma.instance.deleteMany({ where: { tenantId: { in: createdTenants } } }).catch(() => undefined);
    await prisma.tenant.deleteMany({ where: { id: { in: createdTenants } } }).catch(() => undefined);
  }
  if (createdPlans.length > 0) {
    await prisma.plan.deleteMany({ where: { id: { in: createdPlans } } }).catch(() => undefined);
  }
  fleet.close();
  await queue.close();
  await prisma.$disconnect();
}
