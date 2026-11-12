import type { Instance, Prisma, PrismaClient } from '@prisma/client';
import { ConflictError, RuntimeUnavailableError } from '../../shared/errors.js';
import type { Logger } from '../../shared/logger.js';
import { deriveApiKey } from '../runtime/api-key.js';
import { AUTH_REJECTED_DETAIL, type RuntimeInspection, type DiskQuotaMode, type RuntimeManager, type SupportedRuntime } from '../runtime/types.js';
import { TRANSITIONAL_STATUSES, noteQuotaMismatch, recordEvent, revert, transition } from './instance-repo.js';
import { newLease, startHeartbeat } from './lease.js';

export type ReconcileResult = 'ok' | 'recovered' | 'waiting' | 'degraded' | 'exhausted' | 'skipped';

/** min(60s, 2s * 2^attempt), jittered into [50%, 100%]. */
export function backoffMs(attempt: number, rand: () => number = Math.random): number {
  return Math.round(Math.min(60_000, 2_000 * 2 ** attempt) * (0.5 + rand() * 0.5));
}

export interface ReconcilerDeps {
  prisma: PrismaClient;
  runtime: RuntimeManager;
  logger: Logger;
  /** Source of every instance's derived API server key. Never logged or stored. */
  masterKey: string;
  /** OCI runtime for recreated containers (`runc` or `runsc`); the daemon default when omitted. */
  containerRuntime?: SupportedRuntime;
  /** `enforce` creates tenant volumes with the plan's size quota and refuses to run without one. */
  diskQuota: DiskQuotaMode;
  now?: () => Date;
  maxRecoveryAttempts?: number;
  unhealthyThreshold?: number;
  pollIntervalMs?: number;
  healthTimeoutMs?: number;
  /** A restarted container must stay up this long before its recovery attempts are forgiven. */
  stabilityWindowMs?: number;
  /**
   * Fallback for transitional rows that carry no lease (written before leases existed, or
   * abandoned before one was taken): considered abandoned after this long without updates.
   */
  staleTransitionMs?: number;
  /** Lease TTL for recovery operations; renewed every TTL/3 by a heartbeat. */
  leaseTtlMs?: number;
  maxOperationMs?: number;
}

const WATCHED = ['ACTIVE', 'DEGRADED'] as const;

function describeState(i: RuntimeInspection): string {
  if (i.state === 'absent') return 'container missing';
  if (i.oomKilled) return `out of memory (exit code ${i.exitCode ?? 'unknown'})`;
  return `container ${i.state}${i.exitCode !== null ? ` (exit code ${i.exitCode})` : ''}`;
}

/**
 * Compares database state with Docker state and repairs it with bounded, backed-off
 * retries (PRD 13.2). Only gateway readiness is probed, so an upstream model-provider
 * outage never triggers a restart. Before it touches Docker it claims the instance
 * (ACTIVE|DEGRADED -> STARTING) so user operations answer 409 instead of racing it.
 */
export class Reconciler {
  private readonly d: Required<Omit<ReconcilerDeps, 'prisma' | 'runtime' | 'logger' | 'masterKey' | 'containerRuntime' | 'diskQuota'>> &
    Pick<ReconcilerDeps, 'prisma' | 'runtime' | 'logger' | 'masterKey' | 'containerRuntime' | 'diskQuota'>;

  constructor(deps: ReconcilerDeps) {
    this.d = {
      now: () => new Date(),
      maxRecoveryAttempts: 3,
      unhealthyThreshold: 3,
      pollIntervalMs: 500,
      healthTimeoutMs: 15_000,
      stabilityWindowMs: 5 * 60_000,
      staleTransitionMs: 5 * 60_000,
      leaseTtlMs: 60_000,
      maxOperationMs: 10 * 60_000,
      ...deps,
    };
  }

  async reconcileAll(): Promise<void> {
    await this.reapStale().catch((e) => this.d.logger.error({ errName: (e as Error).name }, 'stale reaper failed'));
    const rows = await this.d.prisma.instance.findMany({ where: { status: { in: [...WATCHED] } }, select: { id: true } });
    for (const { id } of rows) {
      try {
        await this.reconcileInstance(id);
      } catch (e) {
        this.d.logger.error({ instanceId: id, errName: (e as Error).name }, 'reconcile failed');
      }
    }
  }

  start(intervalMs: number): () => void {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      this.reconcileAll()
        .catch((e) => this.d.logger.error({ errName: (e as Error).name }, 'reconcile loop failed'))
        .finally(() => { running = false; });
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  async reconcileInstance(instanceId: string): Promise<ReconcileResult> {
    const inst = await this.d.prisma.instance.findUnique({ where: { id: instanceId } });
    if (!inst || !(WATCHED as readonly string[]).includes(inst.status)) return 'ok';
    try {
      const insp = await this.d.runtime.inspect(instanceId);
      if (insp.state !== 'running') return await this.attemptRecovery(inst, 'start', describeState(insp));
      return await this.onRunning(inst, insp);
    } catch (e) {
      if (e instanceof RuntimeUnavailableError) return 'skipped';
      throw e;
    }
  }

  /**
   * Resolves operations abandoned mid-flight (crashed control plane, DB blip), so no instance
   * is wedged in a transitional state with no way out. An operation is abandoned only when its
   * lease has expired: live operations renew their lease with a heartbeat and are never touched.
   * Rows without a lease fall back to `staleTransitionMs` since the last update. Every write is
   * fenced on the lease still being expired, so a lease renewed after the scan wins.
   * Returns how many instances were resolved.
   */
  async reapStale(): Promise<number> {
    const { prisma, now, staleTransitionMs } = this.d;
    const at = now();
    const staleWhere: Prisma.InstanceWhereInput = {
      OR: [
        { leaseExpiresAt: { lt: at } },
        { leaseExpiresAt: null, updatedAt: { lt: new Date(at.getTime() - staleTransitionMs) } },
      ],
    };
    const rows = await prisma.instance.findMany({
      where: { status: { in: [...TRANSITIONAL_STATUSES] }, AND: [staleWhere] },
    });
    let resolved = 0;
    for (const i of rows) {
      try {
        await this.resolveStale(i, staleWhere);
        resolved++;
      } catch (e) {
        if (e instanceof ConflictError || e instanceof RuntimeUnavailableError) continue;
        this.d.logger.error({ instanceId: i.id, errName: (e as Error).name }, 'resolving stale instance failed');
      }
    }
    return resolved;
  }

  private async resolveStale(i: Instance, fence: Prisma.InstanceWhereInput): Promise<void> {
    const { prisma, runtime } = this.d;
    const reason = 'stalled';
    switch (i.status) {
      case 'PENDING':
      case 'PROVISIONING':
      case 'CONFIGURING':
        await transition(prisma, {
          id: i.id, from: i.status, to: 'FAILED', reason, fence, eventType: 'provisioning.stalled',
          message: 'Provisioning stalled; retry with the same idempotency key or delete',
        });
        return;
      case 'STARTING':
        await transition(prisma, {
          id: i.id, from: 'STARTING', to: 'DEGRADED', reason, fence, eventType: 'instance.degraded',
          message: 'Operation stalled; automated recovery will take over',
        });
        return;
      case 'STOPPING':
      case 'DELETING': {
        // Take over the lease first (fenced), so nothing else acts while we finish the job.
        const lease = newLease(this.d.leaseTtlMs, this.d.now);
        const took = await prisma.instance.updateMany({
          where: { id: i.id, status: i.status, AND: [fence] },
          data: { operationOwner: lease.owner, leaseExpiresAt: lease.expiresAt },
        });
        if (took.count === 0) throw new ConflictError('Lease renewed concurrently');
        const stopBeat = this.heartbeat(i.id, lease.owner);
        try {
          if (i.status === 'STOPPING') {
            await runtime.stop(i.id);
            await transition(prisma, { id: i.id, from: 'STOPPING', to: 'STOPPED', owner: lease.owner, eventType: 'instance.stopped', message: 'Instance stopped' });
          } else {
            await runtime.remove(i.id, { deleteVolume: true });
            await transition(prisma, {
              id: i.id, from: 'DELETING', to: 'DELETED', owner: lease.owner, eventType: 'instance.deleted', message: 'Instance and data deleted',
              data: { deletedAt: new Date(), hostPort: null },
            });
          }
        } finally {
          stopBeat();
        }
        return;
      }
      default:
    }
  }

  private apiKey(instanceId: string): string {
    return deriveApiKey(this.d.masterKey, instanceId);
  }

  private heartbeat(instanceId: string, owner: string): () => void {
    return startHeartbeat({
      prisma: this.d.prisma, instanceId, owner, ttlMs: this.d.leaseTtlMs,
      maxOperationMs: this.d.maxOperationMs, logger: this.d.logger, now: this.d.now,
    });
  }

  private async onRunning(inst: Instance, insp: RuntimeInspection): Promise<ReconcileResult> {
    const { prisma, now, stabilityWindowMs } = this.d;
    const health = await this.d.runtime.checkHealth(inst.id, this.apiKey(inst.id));
    if (health.ok) {
      const stable = insp.startedAt !== null && now().getTime() - insp.startedAt.getTime() >= stabilityWindowMs;
      const data = {
        consecutiveFailures: 0,
        lastHealthAt: now(),
        ...(insp.hostPort !== null ? { hostPort: insp.hostPort } : {}),
        // Forgive past restarts only once the container has proven it stays up.
        ...(stable ? { recoveryAttempts: 0, nextRecoveryAt: null } : {}),
      };
      if (inst.status === 'DEGRADED') {
        await transition(prisma, {
          id: inst.id, from: 'DEGRADED', to: 'ACTIVE', eventType: 'instance.active', message: 'Instance is healthy again', data,
        }).catch((e) => { if (!(e instanceof ConflictError)) throw e; });
        return 'recovered';
      }
      await prisma.instance.updateMany({ where: { id: inst.id, status: 'ACTIVE' }, data });
      return 'ok';
    }
    if (health.detail === AUTH_REJECTED_DETAIL) {
      // A restart keeps the container's old key, so it cannot fix a key mismatch (for example a
      // changed HERMES_MASTER_KEY). Say so instead of restarting every tenant until recovery is exhausted.
      await this.setDegraded(inst, 'auth_rejected', 'instance.degraded', 'Gateway rejected the instance API key; recreate the container');
      return 'degraded';
    }
    const failures = inst.consecutiveFailures + 1;
    if (failures >= this.d.unhealthyThreshold) {
      return this.attemptRecovery(inst, 'restart', `health check failing (${failures} consecutive)`);
    }
    await prisma.instance.updateMany({ where: { id: inst.id, status: inst.status }, data: { consecutiveFailures: failures } });
    await this.setDegraded(inst, 'health_check_failed', 'instance.degraded', 'Health check failing');
    return 'degraded';
  }

  private async attemptRecovery(inst: Instance, mode: 'start' | 'restart', why: string): Promise<ReconcileResult> {
    const { prisma, runtime, now, maxRecoveryAttempts } = this.d;
    if (inst.recoveryAttempts >= maxRecoveryAttempts) return this.markExhausted(inst);
    if (inst.nextRecoveryAt && now() < inst.nextRecoveryAt) return 'waiting';

    const from = inst.status as 'ACTIVE' | 'DEGRADED';
    const attempts = inst.recoveryAttempts + 1;
    const lease = newLease(this.d.leaseTtlMs, now);
    // Claim first: from here user stop/delete/restart answer 409 until we finish.
    try {
      await transition(prisma, {
        id: inst.id, from, to: 'STARTING', lease, reason: inst.statusReason, eventType: 'recovery.attempted',
        message: `Recovery attempt ${attempts}/${maxRecoveryAttempts}: ${why}`,
        data: { recoveryAttempts: attempts, nextRecoveryAt: new Date(now().getTime() + backoffMs(inst.recoveryAttempts)) },
      });
    } catch (e) {
      if (e instanceof ConflictError) return 'skipped'; // someone else is operating on it
      throw e;
    }

    const stopBeat = this.heartbeat(inst.id, lease.owner);
    try {
      return await this.recoverSteps(inst, mode, from, attempts, lease.owner);
    } finally {
      stopBeat();
    }
  }

  private async recoverSteps(
    inst: Instance, mode: 'start' | 'restart', from: 'ACTIVE' | 'DEGRADED', attempts: number, owner: string,
  ): Promise<ReconcileResult> {
    const { prisma, runtime, now, maxRecoveryAttempts } = this.d;
    let healthy = false;
    try {
      if (mode === 'restart') {
        await runtime.assertVolumeQuota(inst.id, this.d.diskQuota);
        await runtime.restart(inst.id);
      } else {
        const plan = await prisma.plan.findUniqueOrThrow({ where: { id: inst.planId } });
        const ensured = await runtime.ensure({
          instanceId: inst.id,
          tenantId: inst.tenantId,
          image: inst.image,
          limits: { cpuMillis: plan.cpuMillis, memoryMb: plan.memoryMb, pids: plan.pids, storageMb: plan.storageMb },
          diskQuota: this.d.diskQuota,
          env: { HERMES_INSTANCE_ID: inst.id },
          apiServerKey: this.apiKey(inst.id),
          runtime: this.d.containerRuntime,
        });
        await noteQuotaMismatch(prisma, inst.id, ensured.volumeQuotaMb, plan.storageMb);
        await runtime.start(inst.id);
      }
      healthy = await this.waitHealthy(inst.id);
    } catch (e) {
      if (e instanceof RuntimeUnavailableError) {
        // An outage must not burn recovery attempts or change the visible state.
        await revert(prisma, {
          id: inst.id, from: 'STARTING', to: from, owner, reason: inst.statusReason, eventType: 'runtime.unavailable',
          message: 'Recovery could not be completed',
          data: { recoveryAttempts: inst.recoveryAttempts, nextRecoveryAt: inst.nextRecoveryAt },
        });
        return 'skipped';
      }
      this.d.logger.error({ instanceId: inst.id, errName: (e as Error).name }, 'recovery attempt failed');
    }

    if (healthy) {
      const port = (await runtime.inspect(inst.id).catch(() => null))?.hostPort ?? null;
      await transition(prisma, {
        id: inst.id, from: 'STARTING', to: 'ACTIVE', owner, eventType: 'recovery.succeeded', message: 'Recovery succeeded',
        data: { hostPort: port, lastHealthAt: now(), consecutiveFailures: 0 },
      });
      return 'recovered';
    }
    const exhausted = attempts >= maxRecoveryAttempts;
    await transition(prisma, {
      id: inst.id, from: 'STARTING', to: 'DEGRADED', owner,
      reason: exhausted ? 'recovery_exhausted' : 'recovery_failed',
      eventType: exhausted ? 'recovery.exhausted' : 'instance.degraded',
      message: exhausted ? 'Automated recovery exhausted; operator attention required' : 'Recovery attempt failed',
    });
    return exhausted ? 'exhausted' : 'degraded';
  }

  private async markExhausted(inst: Instance): Promise<ReconcileResult> {
    if (inst.statusReason !== 'recovery_exhausted' || inst.status !== 'DEGRADED') {
      await this.setDegraded(
        inst, 'recovery_exhausted', 'recovery.exhausted', 'Automated recovery exhausted; operator attention required',
      );
    }
    return 'exhausted';
  }

  private async setDegraded(inst: Instance, reason: string, eventType: string, message: string): Promise<void> {
    const { prisma } = this.d;
    if (inst.status === 'ACTIVE') {
      await transition(prisma, { id: inst.id, from: 'ACTIVE', to: 'DEGRADED', reason, eventType, message }).catch(() => undefined);
    } else if (inst.status === 'DEGRADED' && inst.statusReason !== reason) {
      const res = await prisma.instance.updateMany({ where: { id: inst.id, status: 'DEGRADED' }, data: { statusReason: reason } });
      if (res.count === 1) await recordEvent(prisma, inst.id, eventType, message);
    }
  }

  /** Polls readiness; gives up early if the container has already died. */
  private async waitHealthy(instanceId: string): Promise<boolean> {
    const { runtime, pollIntervalMs, healthTimeoutMs } = this.d;
    const end = Date.now() + healthTimeoutMs;
    for (;;) {
      if ((await runtime.checkHealth(instanceId, this.apiKey(instanceId))).ok) return true;
      if (Date.now() >= end) return false;
      const { state } = await runtime.inspect(instanceId);
      if (state === 'exited' || state === 'dead' || state === 'absent') return false;
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }
}
