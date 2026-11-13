import type { Instance, InstanceStatus, Plan, Prisma, PrismaClient } from '@prisma/client';
import { ConflictError, InstanceLimitError, NetworkPolicyMissingError, NotFoundError, RuntimeUnavailableError, ValidationError, VolumeQuotaMissingError } from '../../shared/errors.js';
import type { Logger } from '../../shared/logger.js';
import { isUuid } from '../../shared/uuid.js';
import { noRuntimeConfig, type RuntimeConfigLoader } from '../integrations/runtime-env.js';
import { deriveApiKey } from '../runtime/api-key.js';
import { ConfigUnreadableError } from '../runtime/hermes-config.js';
import { assertPinnedImage } from '../runtime/image-policy.js';
import type { DiskQuotaMode, EgressPolicyMode, RuntimeManager, SupportedRuntime } from '../runtime/types.js';
import { findOwned, noteQuotaMismatch, revert, transition } from './instance-repo.js';
import { newLease, startHeartbeat, type Lease } from './lease.js';
import { markApplied, runtimeSpec, startOrRecreate } from './runtime-apply.js';

export interface InstanceView {
  id: string;
  tenantId: string;
  name: string;
  status: InstanceStatus;
  statusReason: string | null;
  accessUrl: string | null;
  createdAt: Date;
}

export interface ProvisionInput {
  tenantId: string;
  name: string;
  planId: string;
  idempotencyKey: string;
  maxInstances?: number;
  activePlanOnly?: boolean;
}

export interface InstanceServiceDeps {
  prisma: PrismaClient;
  runtime: RuntimeManager;
  image: string;
  production: boolean;
  logger: Logger;
  /** Source of every instance's derived API server key. Never logged or stored. */
  masterKey: string;
  /** OCI runtime for new containers (`runc` or `runsc`); the daemon default when omitted. */
  containerRuntime?: SupportedRuntime;
  /** `enforce` creates tenant volumes with the plan's size quota and refuses to run without one. */
  diskQuota: DiskQuotaMode;
  /** `enforce` refuses to reuse a tenant network that lacks the bridge name the host ruleset matches. */
  egressPolicy: EgressPolicyMode;
  pollIntervalMs?: number;
  healthTimeoutMs?: number;
  /** Operation lease TTL; a heartbeat renews it every TTL/3 while the operation runs. */
  leaseTtlMs?: number;
  /** A single operation stops renewing its lease after this long (hung-operation backstop). */
  maxOperationMs?: number;
  /** Customer configuration (Telegram, provider) containers are created with. Default: none. */
  runtimeConfig?: RuntimeConfigLoader;
  /** Removes the instance's provider and Telegram configuration and secrets once its runtime is gone. */
  purgeIntegrations?: (tenantId: string, instanceId: string) => Promise<void>;
  now?: () => Date;
}

class HealthTimeout extends Error {}

const RESET_RECOVERY = { consecutiveFailures: 0, recoveryAttempts: 0, nextRecoveryAt: null };

/** Whether an operation on an instance in `status` still has work to do. Throws 409 when it cannot run. */
export function decideOp(op: 'start' | 'restart' | 'stop' | 'delete', status: InstanceStatus): 'noop' | 'run' {
  const running = status === 'ACTIVE' || status === 'DEGRADED';
  switch (op) {
    case 'start':
      if (running) return 'noop';
      if (status === 'STOPPED') return 'run';
      break;
    case 'restart':
      if (running || status === 'STOPPED') return 'run';
      break;
    case 'stop':
      if (status === 'STOPPED') return 'noop';
      if (running) return 'run';
      break;
    case 'delete':
      if (status === 'DELETED') return 'noop';
      if (running || status === 'STOPPED' || status === 'FAILED') return 'run';
      break;
  }
  throw new ConflictError(`Cannot ${op} an instance in state ${status}`);
}

export function toView(i: Instance): InstanceView {
  const reachable = i.hostPort !== null && (i.status === 'ACTIVE' || i.status === 'DEGRADED');
  return {
    id: i.id,
    tenantId: i.tenantId,
    name: i.name,
    status: i.status,
    statusReason: i.statusReason,
    accessUrl: reachable ? `http://127.0.0.1:${i.hostPort}` : null,
    createdAt: i.createdAt,
  };
}

function validateName(name: string): void {
  if (typeof name !== 'string' || name.length < 1 || name.length > 63 || /\p{Cc}/u.test(name)) {
    throw new ValidationError('name must be 1-63 characters without control characters');
  }
}

export class InstanceService {
  private readonly prisma: PrismaClient;
  private readonly runtime: RuntimeManager;
  private readonly image: string;
  private readonly masterKey: string;
  private readonly containerRuntime: SupportedRuntime | undefined;
  private readonly diskQuota: DiskQuotaMode;
  private readonly egressPolicy: EgressPolicyMode;
  private readonly logger: Logger;
  private readonly pollIntervalMs: number;
  private readonly healthTimeoutMs: number;
  private readonly leaseTtlMs: number;
  private readonly maxOperationMs: number;
  private readonly now: () => Date;
  private readonly runtimeConfig: RuntimeConfigLoader;
  private readonly purgeIntegrations: (tenantId: string, instanceId: string) => Promise<void>;

  constructor(deps: InstanceServiceDeps) {
    assertPinnedImage(deps.image, { production: deps.production });
    this.prisma = deps.prisma;
    this.runtime = deps.runtime;
    this.image = deps.image;
    this.masterKey = deps.masterKey;
    this.containerRuntime = deps.containerRuntime;
    this.diskQuota = deps.diskQuota;
    this.egressPolicy = deps.egressPolicy;
    this.logger = deps.logger;
    this.pollIntervalMs = deps.pollIntervalMs ?? 500;
    this.healthTimeoutMs = deps.healthTimeoutMs ?? 30_000;
    this.leaseTtlMs = deps.leaseTtlMs ?? 60_000;
    this.maxOperationMs = deps.maxOperationMs ?? 10 * 60_000;
    this.now = deps.now ?? (() => new Date());
    this.runtimeConfig = deps.runtimeConfig ?? noRuntimeConfig;
    this.purgeIntegrations = deps.purgeIntegrations ?? (async () => undefined);
  }

  /**
   * `maxInstances` caps the tenant's non-deleted instances (customer API). Replaying an existing
   * idempotency key is never blocked by the cap. The operator API passes no cap. `activePlanOnly`
   * hides retired plans (customer API); the operator may still use them.
   */
  async provision(input: ProvisionInput): Promise<InstanceView> {
    const { instance, plan, needsRun } = await this.createProvisioning(input);
    return needsRun ? this.runProvision(instance, plan) : toView(instance);
  }

  /**
   * Validates and records the request (idempotent per tenant and key) without running it.
   * `needsRun` is true for a new row and for a FAILED one being retried with the same key.
   */
  async createProvisioning(input: ProvisionInput): Promise<{ instance: Instance; plan: Plan; needsRun: boolean }> {
    validateName(input.name);
    if (!input.idempotencyKey || input.idempotencyKey.length > 128) throw new ValidationError('invalid idempotency key');
    // Malformed ids are "not found"; real database failures are left to surface (HTTP 503).
    if (!isUuid(input.tenantId)) throw new NotFoundError('Tenant not found');
    if (!isUuid(input.planId)) throw new NotFoundError('Plan not found');
    const tenant = await this.prisma.tenant.findUnique({ where: { id: input.tenantId } });
    if (!tenant) throw new NotFoundError('Tenant not found');
    const plan = await this.prisma.plan.findUnique({ where: { id: input.planId } });
    if (!plan || (input.activePlanOnly && !plan.active)) throw new NotFoundError('Plan not found');
    const node = await this.prisma.runtimeNode.findFirst({ where: { schedulable: true }, orderBy: { name: 'asc' } });
    if (!node) throw new RuntimeUnavailableError('No schedulable runtime node');

    let row: Instance;
    try {
      const data = {
        tenantId: tenant.id, planId: plan.id, nodeId: node.id, name: input.name,
        idempotencyKey: input.idempotencyKey, image: this.image,
      };
      row = input.maxInstances === undefined
        ? await this.prisma.instance.create({ data })
        : await this.createWithinLimit(data, input.maxInstances);
    } catch (e) {
      if ((e as { code?: string }).code !== 'P2002') throw e;
      const existing = await this.prisma.instance.findFirstOrThrow({
        where: { tenantId: tenant.id, idempotencyKey: input.idempotencyKey },
      });
      // The key is bound to its original request: reuse with another payload is a client error.
      if (existing.name !== input.name || existing.planId !== plan.id) {
        throw new ConflictError('Idempotency-Key was already used with a different request');
      }
      return { instance: existing, plan, needsRun: existing.status === 'FAILED' };
    }
    return { instance: row, plan, needsRun: true };
  }

  /** Count and insert under a per-tenant advisory lock, so concurrent requests cannot exceed the cap. */
  private async createWithinLimit(data: Prisma.InstanceUncheckedCreateInput, max: number): Promise<Instance> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${data.tenantId}))`;
      const replay = await tx.instance.findFirst({
        where: { tenantId: data.tenantId, idempotencyKey: data.idempotencyKey }, select: { id: true },
      });
      if (!replay) {
        const count = await tx.instance.count({ where: { tenantId: data.tenantId, status: { not: 'DELETED' } } });
        if (count >= max) throw new InstanceLimitError();
      }
      return tx.instance.create({ data });
    });
  }

  async get(tenantId: string, instanceId: string): Promise<InstanceView> {
    return toView(await findOwned(this.prisma, tenantId, instanceId));
  }

  async list(tenantId: string): Promise<InstanceView[]> {
    if (!isUuid(tenantId)) throw new NotFoundError('Tenant not found');
    const rows = await this.prisma.instance.findMany({ where: { tenantId, deletedAt: null }, orderBy: { createdAt: 'asc' } });
    return rows.map(toView);
  }

  async events(tenantId: string, instanceId: string) {
    await findOwned(this.prisma, tenantId, instanceId);
    const rows = await this.prisma.instanceEvent.findMany({ where: { instanceId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return rows.map((e) => ({ type: e.type, message: e.message, createdAt: e.createdAt }));
  }

  async start(tenantId: string, instanceId: string): Promise<InstanceView> {
    const i = await findOwned(this.prisma, tenantId, instanceId);
    if (decideOp('start', i.status) === 'noop') return toView(i);
    return this.startFlow(i, 'start');
  }

  async restart(tenantId: string, instanceId: string): Promise<InstanceView> {
    const i = await findOwned(this.prisma, tenantId, instanceId);
    decideOp('restart', i.status);
    return this.startFlow(i, i.status === 'STOPPED' ? 'start' : 'restart');
  }

  async stop(tenantId: string, instanceId: string): Promise<InstanceView> {
    const i = await findOwned(this.prisma, tenantId, instanceId);
    if (decideOp('stop', i.status) === 'noop') return toView(i);
    const from = i.status;
    const lease = this.newLease();
    await transition(this.prisma, { id: i.id, from, to: 'STOPPING', eventType: 'instance.stopping', message: 'Instance stopping', lease });
    await this.leased(i.id, lease, async (owner) => {
      try {
        await this.runtime.stop(i.id);
      } catch (e) {
        await revert(this.prisma, {
          id: i.id, from: 'STOPPING', to: from, owner, eventType: 'runtime.unavailable', message: 'Stop could not be completed',
        });
        throw e;
      }
      await transition(this.prisma, { id: i.id, from: 'STOPPING', to: 'STOPPED', owner, eventType: 'instance.stopped', message: 'Instance stopped' });
    });
    return this.get(tenantId, instanceId);
  }

  async delete(tenantId: string, instanceId: string): Promise<InstanceView> {
    const i = await findOwned(this.prisma, tenantId, instanceId);
    if (decideOp('delete', i.status) === 'noop') return toView(i);
    const from = i.status;
    const lease = this.newLease();
    await transition(this.prisma, { id: i.id, from, to: 'DELETING', eventType: 'deletion.started', message: 'Deletion started', lease });
    await this.leased(i.id, lease, async (owner) => {
      try {
        await this.runtime.remove(i.id, { deleteVolume: true });
      } catch (e) {
        await revert(this.prisma, {
          id: i.id, from: 'DELETING', to: from, owner, eventType: 'deletion.failed', message: 'Deletion could not be completed',
        });
        throw e;
      }
      // Only after the runtime is really gone. If this fails the lease expires and the reaper finishes the job.
      await this.purgeIntegrations(i.tenantId, i.id);
      await transition(this.prisma, {
        id: i.id, from: 'DELETING', to: 'DELETED', owner, eventType: 'instance.deleted', message: 'Instance and data deleted',
        data: { deletedAt: new Date(), hostPort: null },
      });
    });
    return this.get(tenantId, instanceId);
  }

  private newLease(): Lease {
    return newLease(this.leaseTtlMs, this.now);
  }

  /** Runs `fn` while a heartbeat keeps the operation lease alive. `fn` writes only as `owner`. */
  private async leased<T>(instanceId: string, lease: Lease, fn: (owner: string) => Promise<T>): Promise<T> {
    const stop = startHeartbeat({
      prisma: this.prisma, instanceId, owner: lease.owner, ttlMs: this.leaseTtlMs,
      maxOperationMs: this.maxOperationMs, logger: this.logger, now: this.now,
    });
    try {
      return await fn(lease.owner);
    } finally {
      stop();
    }
  }

  /**
   * Job entry point: runs provisioning for a row created earlier. A row that is no longer PENDING or
   * FAILED (done, or another operation owns it) is returned as is, so redelivered jobs are harmless.
   */
  async runProvisionById(tenantId: string, instanceId: string): Promise<InstanceView> {
    const inst = await findOwned(this.prisma, tenantId, instanceId);
    if (inst.status !== 'PENDING' && inst.status !== 'FAILED') return toView(inst);
    const plan = await this.prisma.plan.findUniqueOrThrow({ where: { id: inst.planId } });
    return this.runProvision(inst, plan);
  }

  private async runProvision(inst: Instance, plan: Plan): Promise<InstanceView> {
    const lease = this.newLease();
    try {
      await transition(this.prisma, {
        id: inst.id, from: inst.status, to: 'PROVISIONING', eventType: 'provisioning.started', message: 'Provisioning started', lease,
      });
    } catch (e) {
      if (e instanceof ConflictError) return this.get(inst.tenantId, inst.id); // another caller is driving it
      throw e;
    }
    return this.leased(inst.id, lease, (owner) => this.provisionSteps(inst, plan, owner));
  }

  private async provisionSteps(inst: Instance, plan: Plan, owner: string): Promise<InstanceView> {
    const tenantId = inst.tenantId;
    let current: InstanceStatus = 'PROVISIONING';
    try {
      const cfg = await this.runtimeConfig(tenantId, inst.id);
      const spec = runtimeSpec(this.specDeps(), inst, plan, cfg);
      // A retry after a failed attempt can find a container created before the latest configuration; `ensure`
      // leaves an existing container alone, so recreate it (volume kept) rather than claim it is up to date.
      const ensured = inst.appliedRevision < cfg.revision ? await this.runtime.recreate(spec) : await this.runtime.ensure(spec);
      await markApplied(this.prisma, inst.id, cfg.revision);
      await noteQuotaMismatch(this.prisma, inst.id, ensured.volumeQuotaMb, plan.storageMb);
      await transition(this.prisma, { id: inst.id, from: 'PROVISIONING', to: 'CONFIGURING', owner, eventType: 'runtime.created', message: 'Runtime created' });
      current = 'CONFIGURING';
      await transition(this.prisma, { id: inst.id, from: 'CONFIGURING', to: 'STARTING', owner, eventType: 'runtime.starting', message: 'Runtime starting' });
      current = 'STARTING';
      await this.runtime.start(inst.id);
      await this.waitHealthy(inst.id);
      const port = (await this.runtime.inspect(inst.id)).hostPort;
      await transition(this.prisma, {
        id: inst.id, from: 'STARTING', to: 'ACTIVE', owner, eventType: 'instance.active', message: 'Instance is active',
        data: { hostPort: port, lastHealthAt: new Date(), ...RESET_RECOVERY },
      });
    } catch (e) {
      const reason =
        e instanceof RuntimeUnavailableError ? 'runtime_unavailable'
          : e instanceof VolumeQuotaMissingError ? 'volume_quota_missing'
          : e instanceof NetworkPolicyMissingError ? 'network_policy_missing'
          : e instanceof HealthTimeout ? 'health_check_timeout'
            : 'runtime_create_failed';
      this.logger.error({ instanceId: inst.id, reason }, 'provisioning failed');
      let stillOurs = true;
      try {
        await transition(this.prisma, {
          id: inst.id, from: current, to: 'FAILED', reason, owner, eventType: 'provisioning.failed', message: `Provisioning failed: ${reason}`,
        });
      } catch {
        stillOurs = false; // lost the lease (reaped/taken over): do not overwrite the outcome
      }
      // A failed instance must not keep consuming node capacity (best effort; the daemon may be down).
      // If we lost ownership, only touch Docker when no other operation has taken the instance since.
      const settled = stillOurs || (await this.prisma.instance.findUnique({ where: { id: inst.id } }).catch(() => null))?.status === 'FAILED';
      if (settled) await this.runtime.stop(inst.id).catch(() => undefined);
      if (e instanceof RuntimeUnavailableError) throw e;
    }
    return this.get(tenantId, inst.id);
  }

  private async startFlow(i: Instance, op: 'start' | 'restart'): Promise<InstanceView> {
    const from = i.status;
    const lease = this.newLease();
    await transition(this.prisma, {
      id: i.id, from, to: 'STARTING', lease, eventType: `runtime.${op}`, message: op === 'start' ? 'Runtime starting' : 'Runtime restarting',
    });
    return this.leased(i.id, lease, (owner) => this.startSteps(i, op, from, owner));
  }

  private async startSteps(i: Instance, op: 'start' | 'restart', from: InstanceStatus, owner: string): Promise<InstanceView> {
    try {
      await this.runtime.assertVolumeQuota(i.id, this.diskQuota);
      await this.runtime.assertNetworkPolicy(i.id, this.egressPolicy);
      await startOrRecreate({ ...this.specDeps(), prisma: this.prisma, runtime: this.runtime, loader: this.runtimeConfig }, i, op);
    } catch (e) {
      if (e instanceof VolumeQuotaMissingError || e instanceof NetworkPolicyMissingError || e instanceof ConfigUnreadableError) {
        const why = e instanceof VolumeQuotaMissingError ? 'volume has no disk quota'
          : e instanceof ConfigUnreadableError ? 'configuration file could not be read' : 'network does not match the egress policy';
        await revert(this.prisma, { id: i.id, from: 'STARTING', to: from, owner, eventType: 'runtime.start_refused', message: `Start refused: ${why}` });
        throw e;
      }
      if (e instanceof RuntimeUnavailableError) {
        await revert(this.prisma, { id: i.id, from: 'STARTING', to: from, owner, eventType: 'runtime.unavailable', message: 'Operation could not be completed' });
        throw e;
      }
      this.logger.error({ instanceId: i.id, errName: (e as Error).name }, 'start failed');
      await this.degradeAfterStart(i.id, owner, 'runtime_start_failed');
      return this.get(i.tenantId, i.id);
    }
    // From here the container may be running, so never revert to STOPPED: hand over to the Reconciler.
    try {
      await this.waitHealthy(i.id);
      const port = (await this.runtime.inspect(i.id)).hostPort;
      await transition(this.prisma, {
        id: i.id, from: 'STARTING', to: 'ACTIVE', owner, eventType: 'instance.active', message: 'Instance is active',
        data: { hostPort: port, lastHealthAt: new Date(), ...RESET_RECOVERY },
      });
    } catch (e) {
      const reason = e instanceof HealthTimeout ? 'health_check_timeout'
        : e instanceof RuntimeUnavailableError ? 'runtime_unavailable' : 'runtime_start_failed';
      this.logger.error({ instanceId: i.id, reason }, 'start did not complete');
      await this.degradeAfterStart(i.id, owner, reason);
    }
    return this.get(i.tenantId, i.id);
  }

  private async degradeAfterStart(instanceId: string, owner: string, reason: string): Promise<void> {
    await transition(this.prisma, {
      id: instanceId, from: 'STARTING', to: 'DEGRADED', reason, owner, eventType: 'instance.degraded', message: `Instance degraded: ${reason}`,
    }).catch(() => undefined);
  }

  private specDeps() {
    return { masterKey: this.masterKey, diskQuota: this.diskQuota, egressPolicy: this.egressPolicy, containerRuntime: this.containerRuntime };
  }

  private apiKey(instanceId: string): string {
    return deriveApiKey(this.masterKey, instanceId);
  }

  private async waitHealthy(instanceId: string): Promise<void> {
    const end = Date.now() + this.healthTimeoutMs;
    for (;;) {
      if ((await this.runtime.checkHealth(instanceId, this.apiKey(instanceId))).ok) return;
      if (Date.now() >= end) throw new HealthTimeout();
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
  }
}
