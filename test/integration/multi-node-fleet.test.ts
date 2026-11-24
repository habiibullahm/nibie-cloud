import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/db/client.js';
import { buildServer } from '../../src/http/server.js';
import { BillingService } from '../../src/modules/billing/billing-service.js';
import { InstanceCommands } from '../../src/modules/instances/instance-commands.js';
import { InstanceService } from '../../src/modules/instances/instance-service.js';
import { NodeRecovery, retireDeletedCopies } from '../../src/modules/instances/node-recovery.js';
import { NodeScheduler } from '../../src/modules/instances/node-scheduler.js';
import { noRuntimeConfig } from '../../src/modules/integrations/runtime-env.js';
import type { PlacementNode, RuntimeFleet } from '../../src/modules/runtime/fleet.js';
import type { RuntimeInspection, RuntimeManager, RuntimeSpec } from '../../src/modules/runtime/types.js';
import { WaitlistInviter } from '../../src/modules/waitlist/waitlist-inviter.js';
import { CapacityFullError, ConflictError, RuntimeUnavailableError } from '../../src/shared/errors.js';
import { TEST_ADMIN_TOKEN, testConfig } from '../helpers/auth.js';
import { FakeMailer, FakeSumoPod, PRICE, WEBHOOK_TOKEN, webhookBody } from '../helpers/billing-env.js';
import { resetDb } from '../helpers/db.js';
import { FakeRuntime } from '../helpers/fake-runtime.js';
import { TEST_MASTER_KEY, silentLogger } from '../helpers/service-env.js';

const prisma = createPrisma(process.env.DATABASE_URL!);
const IMAGE = 'hermes-stub:0.2.0';

class NodeFakeRuntime extends FakeRuntime {
  private readonly volumes = new Set<string>();
  override async ensure(spec: RuntimeSpec) {
    this.volumes.add(spec.instanceId);
    return super.ensure(spec);
  }
  override async inspect(id: string): Promise<RuntimeInspection> {
    const base = await super.inspect(id);
    return { ...base, volumePresent: this.volumes.has(id) };
  }
  override async remove(id: string, opts?: { deleteVolume?: boolean }) {
    await super.remove(id);
    if (opts?.deleteVolume) this.volumes.delete(id);
  }
}

class InMemoryFleet {
  readonly runtimes = new Map<string, NodeFakeRuntime>();
  readonly online = new Map<string, boolean>();
  readonly capacity = new Map<string, { cpuMillis: number; memoryMb: number; storageMb: number }>();

  register(id: string, cap: { cpuMillis: number; memoryMb: number; storageMb: number }) {
    this.runtimes.set(id, new NodeFakeRuntime());
    this.online.set(id, true);
    this.capacity.set(id, cap);
  }

  placementNodes(): PlacementNode[] {
    return [...this.capacity.entries()]
      .filter(([id]) => this.online.get(id))
      .map(([id, cap]) => ({ id, ...cap }));
  }

  nodeStatus(id: string) {
    return { online: this.online.get(id) ?? false, host: null };
  }

  runtimeForNode(id: string): RuntimeManager {
    const rt = this.runtimes.get(id);
    if (!rt || !this.online.get(id)) throw new RuntimeUnavailableError();
    return rt;
  }

  async inspect(instanceId: string) {
    const row = await prisma.instance.findUniqueOrThrow({ where: { id: instanceId }, select: { nodeId: true } });
    return this.runtimeForNode(row.nodeId).inspect(instanceId);
  }

  asRuntimeManager(): RuntimeManager {
    const route = async (id: string) => {
      const row = await prisma.instance.findUniqueOrThrow({ where: { id }, select: { nodeId: true } });
      return this.runtimeForNode(row.nodeId);
    };
    return {
      ensure: async (spec) => (await route(spec.instanceId)).ensure(spec),
      recreate: async (spec) => (await route(spec.instanceId)).recreate(spec),
      assertVolumeQuota: async (id, m) => (await route(id)).assertVolumeQuota(id, m),
      assertNetworkPolicy: async (id, m) => (await route(id)).assertNetworkPolicy(id, m),
      logs: async (id, o) => (await route(id)).logs(id, o),
      start: async (id) => (await route(id)).start(id),
      stop: async (id, t) => (await route(id)).stop(id, t),
      restart: async (id) => (await route(id)).restart(id),
      inspect: async (id) => (await route(id)).inspect(id),
      checkHealth: async (id, k) => (await route(id)).checkHealth(id, k),
      volumeUsage: async () => new Map(),
      remove: async (id, o) => (await route(id)).remove(id, o),
    };
  }
}

describe('multi-node fleet placement, reservations, and recovery', () => {
  let localNode: { id: string; name: string };
  let remoteNode: { id: string; name: string };
  let freePlan: { id: string };
  let paidPlan: { id: string };
  let bigPlan: { id: string };
  let fleet: InMemoryFleet;
  let placement: NodeScheduler;
  let service: InstanceService;
  let commands: InstanceCommands;
  let recovery: NodeRecovery;
  let app: ReturnType<typeof buildServer>;

  beforeEach(async () => {
    await resetDb(prisma);
    localNode = await prisma.runtimeNode.create({ data: { name: 'jkt-1', region: 'jkt', schedulable: true, agentManaged: false } });
    remoteNode = await prisma.runtimeNode.create({ data: { name: 'jkt-2', region: 'jkt', schedulable: true, agentManaged: true } });
    freePlan = await prisma.plan.create({
      data: { slug: `free-${randomUUID()}`, name: 'Free', cpuMillis: 1000, memoryMb: 512, pids: 128, storageMb: 1024, monthlyPriceIdr: null },
    });
    paidPlan = await prisma.plan.create({
      data: { slug: `paid-${randomUUID()}`, name: 'Paid', cpuMillis: 1000, memoryMb: 512, pids: 128, storageMb: 1024, monthlyPriceIdr: PRICE },
    });
    bigPlan = await prisma.plan.create({
      data: { slug: `big-${randomUUID()}`, name: 'Big', cpuMillis: 2000, memoryMb: 1024, pids: 256, storageMb: 2048, monthlyPriceIdr: PRICE },
    });

    fleet = new InMemoryFleet();
    // Each node fits exactly 1 free/paid instance (1000m CPU, 512 MB RAM, 1024 MB disk).
    fleet.register(localNode.id, { cpuMillis: 1000, memoryMb: 512, storageMb: 1024 });
    fleet.register(remoteNode.id, { cpuMillis: 1000, memoryMb: 512, storageMb: 1024 });

    placement = new NodeScheduler(() => fleet.placementNodes());
    const retireCopies = (instanceId: string) => retireDeletedCopies({ prisma, fleet: fleet as unknown as RuntimeFleet, logger: silentLogger }, instanceId);
    service = new InstanceService({
      prisma, runtime: fleet.asRuntimeManager(), image: IMAGE, production: false, logger: silentLogger,
      masterKey: TEST_MASTER_KEY, diskQuota: 'off', egressPolicy: 'off', placement, localNodeId: localNode.id, retireCopies,
    });
    commands = new InstanceCommands({ service, queue: null, logger: silentLogger });
    recovery = new NodeRecovery({
      prisma, fleet: fleet as unknown as RuntimeFleet, placement, loadConfig: noRuntimeConfig,
      config: { masterKey: TEST_MASTER_KEY, diskQuota: 'off', egressPolicy: 'off' },
    });
    app = buildServer({
      service, commands, queue: null, logger: silentLogger, config: testConfig(IMAGE, TEST_MASTER_KEY),
      nodes: { prisma, fleet: fleet as unknown as RuntimeFleet, recovery, placement },
    });
  });

  afterAll(() => prisma.$disconnect());

  const auth = { authorization: `Bearer ${TEST_ADMIN_TOKEN}` };

  it('places across nodes, enforces capacity, scopes volume-quotas to local node, and honours cordon/offline', async () => {
    const t1 = await prisma.tenant.create({ data: { name: 't1' } });
    const t2 = await prisma.tenant.create({ data: { name: 't2' } });
    const t3 = await prisma.tenant.create({ data: { name: 't3' } });

    const r1 = await commands.provision({ tenantId: t1.id, name: 'a', planId: freePlan.id, idempotencyKey: 'k1' });
    const r2 = await commands.provision({ tenantId: t2.id, name: 'b', planId: freePlan.id, idempotencyKey: 'k2' });
    const i1 = await prisma.instance.findUniqueOrThrow({ where: { id: r1.instance.id } });
    const i2 = await prisma.instance.findUniqueOrThrow({ where: { id: r2.instance.id } });
    expect([i1.nodeId, i2.nodeId].sort()).toEqual([localNode.id, remoteNode.id].sort());

    // Both nodes full -> third fails with CapacityFullError
    await expect(commands.provision({ tenantId: t3.id, name: 'c', planId: freePlan.id, idempotencyKey: 'k3' }))
      .rejects.toBeInstanceOf(CapacityFullError);

    // volume-quotas returns only local node instances
    const qRes = await app.inject({ method: 'GET', url: '/api/v1/volume-quotas', headers: auth });
    expect(qRes.statusCode).toBe(200);
    const localInstId = i1.nodeId === localNode.id ? i1.id : i2.id;
    expect(qRes.json()).toEqual({ volumes: [{ instanceId: localInstId, storageMb: 1024 }] });

    // runtime-backup-live returns fleet-wide non-deleted instances
    const liveRes = await app.inject({ method: 'GET', url: '/api/v1/runtime-backup-live', headers: auth });
    expect(liveRes.statusCode).toBe(200);
    expect((liveRes.json() as { instanceIds: string[] }).instanceIds.sort()).toEqual([i1.id, i2.id].sort());

    // Cordon jkt-2 via operator API, delete remote instance, verify new placement is refused
    const remoteInst = i1.nodeId === remoteNode.id ? i1 : i2;
    const cordonRes = await app.inject({
      method: 'POST', url: '/api/v1/runtime-nodes/jkt-2/schedulable', headers: auth, payload: { schedulable: false },
    });
    expect(cordonRes.statusCode).toBe(200);
    await commands.delete(remoteInst.tenantId, remoteInst.id);
    await expect(commands.provision({ tenantId: t3.id, name: 'c2', planId: freePlan.id, idempotencyKey: 'k4' }))
      .rejects.toBeInstanceOf(CapacityFullError);

    // Uncordon but take offline -> still excluded from placement
    await app.inject({ method: 'POST', url: '/api/v1/runtime-nodes/jkt-2/schedulable', headers: auth, payload: { schedulable: true } });
    fleet.online.set(remoteNode.id, false);
    await expect(commands.provision({ tenantId: t3.id, name: 'c3', planId: freePlan.id, idempotencyKey: 'k5' }))
      .rejects.toBeInstanceOf(CapacityFullError);

    // Proxied request to operator runtime-nodes is hidden (404)
    const proxied = await app.inject({
      method: 'GET', url: '/api/v1/runtime-nodes', headers: { ...auth, 'x-forwarded-for': '203.0.113.9' },
    });
    expect(proxied.statusCode).toBe(404);
  });

  it('reserves node capacity on checkout, rejects over-budget upgrade, and reserves/claims beta waitlist invites', async () => {
    const t1 = await prisma.tenant.create({ data: { name: 't1' } });
    const t2 = await prisma.tenant.create({ data: { name: 't2' } });
    const t3 = await prisma.tenant.create({ data: { name: 't3' } });
    const gateway = new FakeSumoPod();
    const mailer = new FakeMailer();
    const billing = new BillingService({
      prisma, placement, paymentClient: gateway, commands, mailer,
      sumopodAuth: { webhookToken: WEBHOOK_TOKEN }, dashboardOrigin: 'https://cloud.example.test',
      maxInstancesPerTenant: 1, logger: silentLogger,
    });

    // Occupy jkt-1 with a free instance
    const free = await commands.provision({ tenantId: t1.id, name: 'local-free', planId: freePlan.id, idempotencyKey: 'f1' });

    // Upgrade to bigPlan exceeds jkt-1 capacity -> rejected before creating invoice
    await expect(billing.upgrade({
      tenantId: t1.id, email: 't1@example.test', instanceId: free.instance.id, planId: bigPlan.id, idempotencyKey: 'u1',
    })).rejects.toBeInstanceOf(CapacityFullError);

    // Checkout reserves jkt-2, blocking t3 from taking jkt-2
    const sale = await billing.checkout({
      tenantId: t2.id, email: 't2@example.test', name: 'paid-one', planId: paidPlan.id, idempotencyKey: 's1',
    });
    const subBefore = await prisma.subscription.findUniqueOrThrow({ where: { id: sale.subscription.id } });
    expect(subBefore.reservedNodeId).toBe(remoteNode.id);
    await expect(commands.provision({ tenantId: t3.id, name: 'overflow', planId: freePlan.id, idempotencyKey: 'o1' }))
      .rejects.toBeInstanceOf(CapacityFullError);

    // Paid webhook fulfills onto reserved jkt-2 and clears reservation
    const hook = await billing.handleSumoPodWebhook({ token: WEBHOOK_TOKEN }, webhookBody({ orderId: gateway.invoices[0]!.merchantOrderId }));
    expect(hook.accepted).toBe(true);
    if (hook.accepted) await hook.postActions();
    const subAfter = await prisma.subscription.findUniqueOrThrow({ where: { id: sale.subscription.id } });
    expect(subAfter.reservedNodeId).toBeNull();
    expect(subAfter.instanceId).toBeTruthy();
    const paidInst = await prisma.instance.findUniqueOrThrow({ where: { id: subAfter.instanceId! } });
    expect(paidInst.nodeId).toBe(remoteNode.id);

    // Delete paid instance so jkt-2 is free for a waitlist invite reservation
    await commands.delete(t2.id, paidInst.id);
    await billing.endForInstance(t2.id, paidInst.id);

    const inviteEmail = 'beta@example.test';
    await prisma.waitlistEntry.create({ data: { email: inviteEmail, name: 'Beta', useCase: 'test', status: 'WAITING' } });
    const inviter = new WaitlistInviter({ prisma, placement, mailer, slots: 2, registerUrl: 'https://cloud.example.test', logger: silentLogger });
    expect((await inviter.runOnce()).invited).toBe(1);
    expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { email: inviteEmail } })).reservedNodeId).toBe(remoteNode.id);

    // Stranger blocked while invite holds jkt-2
    await expect(commands.provision({ tenantId: t3.id, name: 'stranger', planId: freePlan.id, idempotencyKey: 'o2' }))
      .rejects.toBeInstanceOf(CapacityFullError);

    // Invited user claims their reserved capacity on jkt-2
    const claimed = await commands.provision({
      tenantId: t3.id, name: 'invited', planId: freePlan.id, waitlistEmail: inviteEmail, idempotencyKey: 'o3',
    });
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: claimed.instance.id } })).nodeId).toBe(remoteNode.id);
    expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { email: inviteEmail } })).reservedNodeId).toBeNull();
  });

  it('runs recovery prepare -> cancel, then prepare -> finish -> retire while preserving disk accounting', async () => {
    const t1 = await prisma.tenant.create({ data: { name: 't1' } });
    const t2 = await prisma.tenant.create({ data: { name: 't2' } });
    const { instance } = await commands.provision({ tenantId: t1.id, name: 'app', planId: freePlan.id, idempotencyKey: 'r1' });

    // Refuses prepare while running and not fenced
    await expect(recovery.prepare(t1.id, instance.id, 'jkt-2', false)).rejects.toBeInstanceOf(ConflictError);

    // Stop source, then prepare onto jkt-2
    await commands.stop(t1.id, instance.id);
    await recovery.prepare(t1.id, instance.id, 'jkt-2', false);

    // Start is blocked while recovery is in progress
    await expect(commands.start(t1.id, instance.id)).rejects.toBeInstanceOf(ConflictError);

    // Cancel releases staged copy on jkt-2
    await recovery.cancel(t1.id, instance.id);
    expect((await fleet.runtimeForNode(remoteNode.id).inspect(instance.id)).volumePresent).toBe(false);

    // Prepare again and finish
    await recovery.prepare(t1.id, instance.id, 'jkt-2', false);
    await recovery.finish(t1.id, instance.id, false);
    const moved = await prisma.instance.findUniqueOrThrow({ where: { id: instance.id } });
    expect(moved.nodeId).toBe(remoteNode.id);
    expect(moved.recoveryNodeId).toBeNull();
    expect(moved.configRevision).toBe(1);

    // Old disk on jkt-1 is still held by RetiredRuntime, blocking a new instance on jkt-1
    expect(await prisma.retiredRuntime.count({ where: { nodeId: localNode.id, instanceId: instance.id } })).toBe(1);
    await expect(commands.provision({ tenantId: t2.id, name: 'blocked', planId: freePlan.id, idempotencyKey: 'r2' }))
      .rejects.toBeInstanceOf(CapacityFullError);

    // Retiring old source discards old volume and frees jkt-1 disk capacity
    await recovery.retire(t1.id, instance.id, 'jkt-1');
    expect(await prisma.retiredRuntime.count({ where: { instanceId: instance.id } })).toBe(0);
    expect((await fleet.runtimeForNode(localNode.id).inspect(instance.id)).volumePresent).toBe(false);
    const placed = await commands.provision({ tenantId: t2.id, name: 'fits-now', planId: freePlan.id, idempotencyKey: 'r3' });
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: placed.instance.id } })).nodeId).toBe(localNode.id);
  });

  it('migrates open upgrade reservations during recovery and cleans up retired copies on delete', async () => {
    const t1 = await prisma.tenant.create({ data: { name: 't1' } });
    const t2 = await prisma.tenant.create({ data: { name: 't2' } });
    const gateway = new FakeSumoPod();
    const billing = new BillingService({
      prisma, placement, paymentClient: gateway, commands, mailer: new FakeMailer(),
      sumopodAuth: { webhookToken: WEBHOOK_TOKEN }, dashboardOrigin: 'https://cloud.example.test',
      maxInstancesPerTenant: 1, logger: silentLogger,
    });

    // Give jkt-1 and jkt-2 room for bigPlan (2000m CPU, 1024 MB RAM, 2048 MB disk)
    fleet.capacity.set(localNode.id, { cpuMillis: 2000, memoryMb: 1024, storageMb: 2048 });
    fleet.capacity.set(remoteNode.id, { cpuMillis: 1000, memoryMb: 512, storageMb: 1024 });

    const { instance } = await commands.provision({ tenantId: t1.id, name: 'app', planId: freePlan.id, idempotencyKey: 'm1' });
    const up = await billing.upgrade({
      tenantId: t1.id, email: 't1@example.test', instanceId: instance.id, planId: bigPlan.id, idempotencyKey: 'up1',
    });
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: up.subscription.id } })).reservedNodeId).toBe(localNode.id);

    // Stop and try recovering to jkt-2 while jkt-2 is too small for the pending upgrade -> rejected
    await commands.stop(t1.id, instance.id);
    await expect(recovery.prepare(t1.id, instance.id, 'jkt-2', false)).rejects.toBeInstanceOf(CapacityFullError);

    // Expand jkt-2 to fit bigPlan, prepare -> finish
    fleet.capacity.set(remoteNode.id, { cpuMillis: 2000, memoryMb: 1024, storageMb: 2048 });
    await recovery.prepare(t1.id, instance.id, 'jkt-2', false);
    await expect(billing.upgrade({
      tenantId: t1.id, email: 't1@example.test', instanceId: instance.id, planId: bigPlan.id, idempotencyKey: 'up2',
    })).rejects.toBeInstanceOf(ConflictError);

    await recovery.finish(t1.id, instance.id, false);
    const subAfterMove = await prisma.subscription.findUniqueOrThrow({ where: { id: up.subscription.id } });
    expect(subAfterMove.reservedNodeId).toBe(remoteNode.id);

    // jkt-1 only holds RetiredRuntime (1024 MB of 2048 MB), so a freePlan (1024 MB) still fits on jkt-1
    const onOld = await commands.provision({ tenantId: t2.id, name: 'fits-old', planId: freePlan.id, idempotencyKey: 'm2' });
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: onOld.instance.id } })).nodeId).toBe(localNode.id);

    // Completing the upgrade payment applies onto jkt-2 and clears the migrated reservation
    const hook = await billing.handleSumoPodWebhook({ token: WEBHOOK_TOKEN }, webhookBody({ orderId: gateway.invoices[0]!.merchantOrderId }));
    expect(hook.accepted).toBe(true);
    if (hook.accepted) await hook.postActions();
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: instance.id } })).planId).toBe(bigPlan.id);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: up.subscription.id } })).reservedNodeId).toBeNull();

    // Deleting the recovered instance before /recovery/retire automatically cleans up its retired copy on jkt-1
    await commands.delete(t1.id, instance.id);
    expect(await prisma.retiredRuntime.count({ where: { instanceId: instance.id } })).toBe(0);
    expect((await fleet.runtimeForNode(localNode.id).inspect(instance.id)).volumePresent).toBe(false);
  });

  it('select with regions skips nodes outside them', async () => {
    await prisma.runtimeNode.update({ where: { id: localNode.id }, data: { region: 'id-jakarta' } });
    await prisma.runtimeNode.update({ where: { id: remoteNode.id }, data: { region: 'sg-singapore' } });

    const t1 = await prisma.tenant.create({ data: { name: 't1' } });
    await prisma.instance.create({
      data: {
        tenantId: t1.id, planId: freePlan.id, nodeId: localNode.id,
        name: 'jkt-full', idempotencyKey: 'jkt-full', image: IMAGE, status: 'ACTIVE',
      },
    });

    const demand = { cpuMillis: 1000, memoryMb: 512, storageMb: 1024 };
    const now = new Date();
    await expect(
      prisma.$transaction((tx) => placement.select(tx, demand, now, { regions: ['id-jakarta'] })),
    ).rejects.toBeInstanceOf(CapacityFullError);

    const chosen = await prisma.$transaction((tx) => placement.select(tx, demand, now));
    expect(chosen).toBe(remoteNode.id);
  });
});
