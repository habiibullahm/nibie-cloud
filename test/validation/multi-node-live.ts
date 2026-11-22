import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createPrisma } from '../../src/db/client.js';
import { RuntimeAgentClient } from '../../src/modules/runtime/agent-client.js';
import { loadAgentTls } from '../../src/modules/runtime/fleet.js';
import { BillingService } from '../../src/modules/billing/billing-service.js';
import { InstanceService } from '../../src/modules/instances/instance-service.js';
import { InstanceCommands } from '../../src/modules/instances/instance-commands.js';
import { NodeScheduler } from '../../src/modules/instances/node-scheduler.js';
import { createBullQueue } from '../../src/modules/jobs/bullmq-queue.js';
import { WaitlistInviter } from '../../src/modules/waitlist/waitlist-inviter.js';
import { CapacityFullError } from '../../src/shared/errors.js';
import { FakeMailer, FakeSumoPod, PRICE, WEBHOOK_TOKEN, webhookBody } from '../helpers/billing-env.js';
import { FakeRuntime } from '../helpers/fake-runtime.js';
import { silentLogger, TEST_MASTER_KEY } from '../helpers/service-env.js';

// Dedicated staging database and two small nodes, each with capacity for one test instance.
if (process.env.HERMES_FLEET_DRILL !== 'staging') throw new Error('Run only on dedicated staging resources');
const { DATABASE_URL, ADMIN_TOKEN, FLEET_TEST_TLS_DIR, FLEET_TEST_AGENT_ORIGIN } = process.env;
if (!DATABASE_URL || !ADMIN_TOKEN || !FLEET_TEST_TLS_DIR || !FLEET_TEST_AGENT_ORIGIN) throw new Error('Missing staging configuration');
const origin = process.env.FLEET_TEST_API_ORIGIN ?? 'http://127.0.0.1:3301';
const prisma = createPrisma(DATABASE_URL);
const agent = new RuntimeAgentClient('jkt-2', FLEET_TEST_AGENT_ORIGIN, await loadAgentTls(FLEET_TEST_TLS_DIR));
const tenantIds: string[] = [];
const run = promisify(execFile);
const sshAlias = process.env.FLEET_TEST_SSH_ALIAS;
if (sshAlias && !/^[a-z0-9][a-z0-9-]*$/.test(sshAlias)) throw new Error('Invalid staging SSH alias');

async function api(path: string, body?: unknown, key?: string, method = body === undefined ? 'GET' : 'POST') {
  return fetch(`${origin}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
}

async function waitForStatus(id: string, expected: string) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const row = await prisma.instance.findUniqueOrThrow({ where: { id }, include: { node: true } });
    if (row.status === expected) return row;
    if (row.status === 'FAILED' && expected !== 'DELETED') throw new Error(`Instance failed: ${row.statusReason}`);
    await delay(750);
  }
  throw new Error(`Timed out waiting for ${expected}`);
}

async function checked(response: Response, status: number) {
  assert.equal(response.status, status, await response.clone().text());
  return response;
}

async function waitNode(online: boolean) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const payload = await (await checked(await api('/runtime-nodes'), 200)).json() as {
      nodes: { name: string; online: boolean }[];
    };
    if (payload.nodes.find((node) => node.name === 'jkt-2')?.online === online) return;
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for jkt-2 online=${online}`);
}

async function ssh(command: string) {
  return run('ssh', ['-T', '-o', 'BatchMode=yes', sshAlias!, command], { timeout: 120_000 });
}

async function reservationDrill(local: { id: string; tenantId: string }, buyer: string, freePlanId: string) {
  const notBuyer = await prisma.tenant.create({ data: { name: 'Over-capacity fixture' } });
  tenantIds.push(notBuyer.id);
  const request = () => api(`/tenants/${notBuyer.id}/instances`, { name: 'Overflow', planId: freePlanId }, 'overflow');
  const nodeRows = await prisma.runtimeNode.findMany();
  const remoteId = nodeRows.find((node) => node.name === 'jkt-2')!.id;
  const placement = new NodeScheduler(() => nodeRows.map(({ id }) => ({ id, cpuMillis: 1_000, memoryMb: 1_024, storageMb: 4_096 })));
  const queue = createBullQueue({ redisUrl: process.env.FLEET_TEST_REDIS_URL ?? 'redis://127.0.0.1:6380/2', logger: silentLogger });
  const service = new InstanceService({
    prisma, placement, runtime: new FakeRuntime(), logger: silentLogger, image: 'hermes-stub:0.2.0',
    production: false, masterKey: TEST_MASTER_KEY, diskQuota: 'off', egressPolicy: 'off',
  });
  const commands = new InstanceCommands({ service, queue, logger: silentLogger });
  const gateway = new FakeSumoPod();
  const mailer = new FakeMailer();
  const billing = new BillingService({
    prisma, placement, paymentClient: gateway, commands, mailer, sumopodAuth: { webhookToken: WEBHOOK_TOKEN },
    dashboardOrigin: 'https://cloud.example.test', maxInstancesPerTenant: 1, logger: silentLogger,
  });
  const email = `${randomUUID()}@example.test`;
  let subscriptionId: string | undefined;
  try {
    const paidPlan = await prisma.plan.create({
      data: { slug: `paid-${randomUUID()}`, name: 'Paid fixture', cpuMillis: 1_000, memoryMb: 256, storageMb: 128, pids: 128, monthlyPriceIdr: PRICE },
    });
    await checked(await api('/runtime-nodes/jkt-2/schedulable', { schedulable: true }), 200);
    const sale = await billing.checkout({ tenantId: buyer, email, name: 'Buyer fixture', planId: paidPlan.id, idempotencyKey: randomUUID() });
    subscriptionId = sale.subscription.id;
    const subscription = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    assert.equal(subscription.reservedNodeId, remoteId);
    await checked(await request(), 409);
    const event = await billing.handleSumoPodWebhook({ token: WEBHOOK_TOKEN }, webhookBody({ orderId: gateway.invoices[0]!.merchantOrderId }));
    assert.ok(event.accepted && event.outcome === 'activated');
    await event.postActions();
    const paid = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    assert.ok(paid.instanceId);
    assert.equal(paid.reservedNodeId, null);
    assert.equal((await waitForStatus(paid.instanceId, 'ACTIVE')).nodeId, remoteId);
    const tooLarge = await prisma.plan.create({
      data: { slug: `upgrade-${randomUUID()}`, name: 'Upgrade fixture', cpuMillis: 1_100, memoryMb: 256, storageMb: 256, pids: 128, monthlyPriceIdr: PRICE },
    });
    await assert.rejects(() => billing.upgrade({
      tenantId: local.tenantId, email, instanceId: local.id, planId: tooLarge.id, idempotencyKey: randomUUID(),
    }), CapacityFullError);
    await checked(await api(`/tenants/${buyer}/instances/${paid.instanceId}`, undefined, undefined, 'DELETE'), 202);
    await waitForStatus(paid.instanceId, 'DELETED');
    await billing.endForInstance(buyer, paid.instanceId);

    await prisma.waitlistEntry.create({ data: { email, name: 'Invite fixture', useCase: 'Capacity drill', status: 'WAITING' } });
    const inviter = new WaitlistInviter({ prisma, placement, mailer, slots: 2, registerUrl: 'https://cloud.example.test', logger: silentLogger });
    assert.equal((await inviter.runOnce()).invited, 1);
    assert.equal((await prisma.waitlistEntry.findUniqueOrThrow({ where: { email } })).reservedNodeId, remoteId);
    await checked(await request(), 409);
    const { instance } = await commands.provision({ tenantId: buyer, name: 'Invite fixture', planId: freePlanId, waitlistEmail: email, idempotencyKey: randomUUID() });
    assert.equal((await waitForStatus(instance.id, 'ACTIVE')).nodeId, remoteId);
    assert.equal((await prisma.waitlistEntry.findUniqueOrThrow({ where: { email } })).reservedNodeId, null);
    await checked(await api(`/tenants/${buyer}/instances/${instance.id}`, undefined, undefined, 'DELETE'), 202);
    await waitForStatus(instance.id, 'DELETED');
    console.log('Fleet reservations passed: purchase/webhook, in-place upgrade rejection and beta invitation claim');
  } finally {
    await prisma.waitlistEntry.deleteMany({ where: { email } });
    if (subscriptionId) await prisma.subscription.updateMany({ where: { id: subscriptionId }, data: { reservedNodeId: null } });
    await queue.close();
  }
}

async function recoveryDrill(instanceId: string, tenantId: string) {
  const temporary = await mkdtemp(join(tmpdir(), 'hermes-multinode-drill-'));
  const marker = randomUUID();
  const base = `/tenants/${tenantId}/instances/${instanceId}`;
  const remoteRoot = `/home/ubuntu/.cache/hermes-fleet-stage/${instanceId}`;
  try {
    await mkdir(join(temporary, 'sqlite'));
    await writeFile(join(temporary, 'password'), randomUUID(), { mode: 0o600 });
    const db = join(temporary, 'sqlite', 'state.db');
    await run('python', ['-c', [
      'import sqlite3,sys',
      'db=sqlite3.connect(sys.argv[1])',
      'db.execute("CREATE TABLE drill (value TEXT)")',
      'db.execute("INSERT INTO drill VALUES (?)", (sys.argv[2],))',
      'db.commit()',
    ].join('\n'), db, marker]);
    await run('docker', ['cp', db, `hermes-${instanceId}:/opt/data/state.db`]);
    await checked(await api(`${base}/stop`, {}), 202);
    await waitForStatus(instanceId, 'STOPPED');
    await run('docker', ['cp', `hermes-${instanceId}:/opt/data/state.db`, db]);

    const data = `/var/lib/docker/volumes/hermes-data-${instanceId}/_data`;
    const sqlite = `/var/lib/hermes-backup-staging/${instanceId}`;
    const restic = [
      'run', '--rm', '-v', `${temporary}:/work`, '-v', `${temporary}/sqlite:${sqlite}:ro`,
      '-v', `hermes-data-${instanceId}:${data}:ro`, 'restic/restic:0.16.4',
      '-r', '/work/repo', '--password-file', '/work/password',
    ];
    await run('docker', [...restic, 'init'], { timeout: 120_000 });
    await run('docker', [...restic, 'backup', '--host', 'stage-local', '--tag', 'tenant-vol', '--tag', `inst-${instanceId}`, data, sqlite]);
    const { stdout } = await run('docker', [...restic, 'snapshots', '--json']);
    const [snapshot] = JSON.parse(stdout) as { id: string }[];
    assert.ok(snapshot && /^[a-f0-9]{64}$/.test(snapshot.id));
    await ssh(`install -d -m 700 ${remoteRoot}`);
    await run('scp', ['-q', '-r', join(temporary, 'repo'), join(temporary, 'password'), `${sshAlias}:${remoteRoot}/`], { timeout: 120_000 });
    await checked(await api(`${base}/recovery/prepare`, { node: 'jkt-2' }), 200);
    await checked(await api(`${base}/start`, {}), 409);
    await ssh(`printf '%s\\n' 'RESTIC_REPOSITORY=${remoteRoot}/repo' 'RESTIC_PASSWORD_FILE=${remoteRoot}/password' > ${remoteRoot}/restic.env
sudo -n env RESTIC_ENV_FILE=${remoteRoot}/restic.env /usr/local/sbin/hermes-tenant-restore --offline ${snapshot.id} ${instanceId} ${tenantId} ${instanceId}`);
    const restored = await ssh(`sudo -n sqlite3 -readonly ${data}/state.db 'SELECT value FROM drill'`);
    assert.equal(restored.stdout.trim(), marker);
    await checked(await api(`${base}/recovery/finish`, { restoreVerified: true }), 200);
    await checked(await api(`${base}/start`, {}), 202);
    assert.equal((await waitForStatus(instanceId, 'ACTIVE')).node.name, 'jkt-2');
    assert.equal((await agent.inspect(instanceId)).state, 'running');
    await ssh(`sudo -n env RESTIC_ENV_FILE=${remoteRoot}/restic.env RESTIC_BACKUP_HOST=jkt-2 RESTIC_RETENTION_MODE=fixture /usr/local/sbin/hermes-tenant-backup`);
    await ssh(`sudo -n env RESTIC_ENV_FILE=${remoteRoot}/restic.env RESTIC_BACKUP_HOST=jkt-2 /usr/local/sbin/hermes-tenant-backup --verify`);
    const backup = await agent.backup(instanceId);
    assert.ok(backup.snapshotAt);
    assert.equal(backup.verification?.status, 'passed');
    await checked(await api(`${base}/recovery/retire`, { node: 'stage-local', discardSource: true }), 200);
    assert.equal(await prisma.retiredRuntime.count({ where: { instanceId } }), 0);
    await assert.rejects(() => run('docker', ['volume', 'inspect', `hermes-data-${instanceId}`]));
    console.log('Fleet recovery passed: encrypted Restic snapshot, same UUID, SQLite marker, restart, verified backup and source retirement');
  } finally {
    if (dirname(resolve(temporary)) === resolve(tmpdir()) && /hermes-multinode-drill-[^/\\]+$/.test(temporary)) {
      await rm(temporary, { force: true, recursive: true }).catch(() => undefined);
    }
    await ssh(`rm -f -- ${remoteRoot}/password ${remoteRoot}/restic.env`).catch(() => undefined);
  }
}

try {
  const nodes = await (await checked(await api('/runtime-nodes'), 200)).json() as {
    nodes: { name: string; online: boolean }[];
  };
  assert.equal(nodes.nodes.length, 2);
  assert.ok(nodes.nodes.every((node) => node.online));
  await agent.ready();
  const ca = (await loadAgentTls(FLEET_TEST_TLS_DIR)).ca;
  const anonymous = new RuntimeAgentClient('jkt-2', FLEET_TEST_AGENT_ORIGIN, { ca });
  try { await assert.rejects(() => anonymous.ready()); } finally { anonymous.close(); }
  await checked(await api('/runtime-nodes/jkt-2/schedulable', { schedulable: true }), 200);

  for (let i = 0; i < 3; i++) {
    const tenant = await prisma.tenant.create({ data: { name: 'Fleet drill' } });
    tenantIds.push(tenant.id);
  }
  const plan = await prisma.plan.create({
    data: { slug: `fleet-${randomUUID()}`, name: 'Fleet drill', cpuMillis: 1_000, memoryMb: 256, storageMb: 128, pids: 128 },
  });
  const create = (tenant: string, key: string) => api(`/tenants/${tenant}/instances`, { name: 'Fleet drill', planId: plan.id }, key);
  const requests = await Promise.all(tenantIds.slice(0, 2).map(async (tenant) => {
    const response = await checked(await create(tenant, 'fleet-drill'), 202);
    const body = await response.json() as { instance: { id: string } };
    return waitForStatus(body.instance.id, 'ACTIVE');
  }));
  const remote = requests.find((row) => row.node.name === 'jkt-2');
  const local = requests.find((row) => row.node.name !== 'jkt-2');
  assert.ok(remote && local, 'one allocation on each node');
  assert.equal((await agent.inspect(remote.id)).state, 'running');
  assert.equal((await agent.inspect(local.id)).state, 'absent');
  if (sshAlias) {
    const runtime = await ssh(`sudo -n docker inspect --format '{{.HostConfig.Runtime}}' hermes-${remote.id}`);
    assert.equal(runtime.stdout.trim(), 'runsc');
    const dns = await ssh(`sudo -n docker exec hermes-${remote.id} cat /etc/resolv.conf`);
    assert.match(dns.stdout, /nameserver 1\.1\.1\.1/);
    await ssh(`sudo -n docker exec hermes-${remote.id} sh -c 'if dd if=/dev/zero of=/opt/data/size-probe bs=1M count=129 2>/tmp/quota-test; then rm -f /opt/data/size-probe; exit 1; fi; rm -f /opt/data/size-probe; grep -E "quota|No space" /tmp/quota-test'`);
  }
  await checked(await create(tenantIds[2]!, 'fleet-drill'), 409);
  const replay = await (await checked(await create(remote.tenantId, 'fleet-drill'), 202)).json() as { instance: { id: string } };
  assert.equal(replay.instance.id, remote.id);

  const base = `/tenants/${remote.tenantId}/instances/${remote.id}`;
  for (const [op, status] of [['stop', 'STOPPED'], ['start', 'ACTIVE'], ['restart', 'ACTIVE']] as const) {
    const request = await checked(await api(`${base}/${op}`, {}), 202);
    const queued = await request.json() as { jobId: string | null };
    assert.ok(queued.jobId);
    if (op === 'restart') {
      for (let attempt = 0; attempt < 80; attempt++) {
        if (await prisma.instanceEvent.count({ where: { instanceId: remote.id, type: 'runtime.restart' } })) break;
        if (attempt === 79) throw new Error('Remote restart job did not run');
        await delay(750);
      }
    }
    await waitForStatus(remote.id, status);
    if (op === 'stop') assert.equal((await agent.inspect(remote.id)).state, 'exited');
  }
  await checked(await api('/runtime-nodes/jkt-2/schedulable', { schedulable: false }), 200);
  await checked(await api(base, undefined, undefined, 'DELETE'), 202);
  await waitForStatus(remote.id, 'DELETED');
  assert.equal((await agent.inspect(remote.id)).volumePresent, false);
  await checked(await create(tenantIds[2]!, 'fleet-drill'), 409);
  console.log('Fleet staging passed: mTLS, parallel placement, capacity, replay, remote lifecycle, disk cleanup and cordon');
  await reservationDrill(local, tenantIds[2]!, plan.id);
  if (sshAlias) {
    try {
      await ssh('sudo -n docker stop hermes-runtime-agent-stage');
      await waitNode(false);
      await checked(await create(tenantIds[2]!, 'fleet-drill'), 409);
      const base = `/tenants/${local.tenantId}/instances/${local.id}`;
      await checked(await api(`${base}/stop`, {}), 202);
      await waitForStatus(local.id, 'STOPPED');
      await checked(await api(`${base}/start`, {}), 202);
      await waitForStatus(local.id, 'ACTIVE');
      console.log('Node outage passed: node removed from placement, local lifecycle stayed available');
    } finally {
      await ssh('sudo -n docker start hermes-runtime-agent-stage');
      await waitNode(true);
    }
    await checked(await api('/runtime-nodes/jkt-2/schedulable', { schedulable: true }), 200);
    await recoveryDrill(local.id, local.tenantId);
  }
} finally {
  for (const tenantId of tenantIds) {
    const rows = await prisma.instance.findMany({ where: { tenantId, status: { in: ['ACTIVE', 'DEGRADED', 'STOPPED', 'FAILED'] } } });
    for (const row of rows) {
      await api(`/tenants/${tenantId}/instances/${row.id}`, undefined, undefined, 'DELETE').catch(() => undefined);
      await waitForStatus(row.id, 'DELETED').catch(() => undefined);
    }
  }
  await api('/runtime-nodes/jkt-2/schedulable', { schedulable: false }).catch(() => undefined);
  agent.close();
  await prisma.$disconnect();
}
