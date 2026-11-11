import type { Instance, PrismaClient } from '@prisma/client';
import { RuntimeUnavailableError } from '../../shared/errors.js';
import type { Logger } from '../../shared/logger.js';
import type { RuntimeInspection, RuntimeManager } from '../runtime/types.js';
import { recordEvent, transition } from './instance-repo.js';

export type ReconcileResult = 'ok' | 'recovered' | 'waiting' | 'degraded' | 'exhausted' | 'skipped';

/** min(60s, 2s * 2^attempt), jittered into [50%, 100%]. */
export function backoffMs(attempt: number, rand: () => number = Math.random): number {
  return Math.round(Math.min(60_000, 2_000 * 2 ** attempt) * (0.5 + rand() * 0.5));
}

export interface ReconcilerDeps {
  prisma: PrismaClient;
  runtime: RuntimeManager;
  logger: Logger;
  now?: () => Date;
  maxRecoveryAttempts?: number;
  unhealthyThreshold?: number;
  pollIntervalMs?: number;
  healthTimeoutMs?: number;
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
 * outage never triggers a restart.
 */
export class Reconciler {
  private readonly d: Required<Omit<ReconcilerDeps, 'prisma' | 'runtime' | 'logger'>> & Pick<ReconcilerDeps, 'prisma' | 'runtime' | 'logger'>;

  constructor(deps: ReconcilerDeps) {
    this.d = {
      now: () => new Date(),
      maxRecoveryAttempts: 3,
      unhealthyThreshold: 3,
      pollIntervalMs: 500,
      healthTimeoutMs: 15_000,
      ...deps,
    };
  }

  async reconcileAll(): Promise<void> {
    const rows = await this.d.prisma.instance.findMany({ where: { status: { in: [...WATCHED] } }, select: { id: true } });
    for (const { id } of rows) {
      try {
        await this.reconcileInstance(id);
      } catch (e) {
        this.d.logger.error({ instanceId: id, err: (e as Error).message }, 'reconcile failed');
      }
    }
  }

  start(intervalMs: number): () => void {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      this.reconcileAll()
        .catch((e) => this.d.logger.error({ err: (e as Error).message }, 'reconcile loop failed'))
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

  private async onRunning(inst: Instance, insp: RuntimeInspection): Promise<ReconcileResult> {
    const health = await this.d.runtime.checkHealth(inst.id);
    if (health.ok) {
      const unwell = inst.status === 'DEGRADED' || inst.consecutiveFailures > 0 || inst.recoveryAttempts > 0;
      await this.markHealthy(inst, insp.hostPort, 'Instance is healthy again');
      return unwell ? 'recovered' : 'ok';
    }
    const failures = inst.consecutiveFailures + 1;
    if (failures >= this.d.unhealthyThreshold) {
      return this.attemptRecovery(inst, 'restart', `health check failing (${failures} consecutive)`);
    }
    await this.d.prisma.instance.update({ where: { id: inst.id }, data: { consecutiveFailures: failures } });
    await this.setDegraded(inst, 'health_check_failed', 'instance.degraded', 'Health check failing');
    return 'degraded';
  }

  private async attemptRecovery(inst: Instance, mode: 'start' | 'restart', why: string): Promise<ReconcileResult> {
    const { prisma, runtime, now, maxRecoveryAttempts } = this.d;
    if (inst.recoveryAttempts >= maxRecoveryAttempts) return this.markExhausted(inst);
    if (inst.nextRecoveryAt && now() < inst.nextRecoveryAt) return 'waiting';

    const attempts = inst.recoveryAttempts + 1;
    await prisma.instance.update({
      where: { id: inst.id },
      data: {
        recoveryAttempts: attempts,
        nextRecoveryAt: new Date(now().getTime() + backoffMs(inst.recoveryAttempts)),
      },
    });
    await recordEvent(prisma, inst.id, 'recovery.attempted', `Recovery attempt ${attempts}/${maxRecoveryAttempts}: ${why}`);

    let healthy = false;
    try {
      if (mode === 'restart') {
        await runtime.restart(inst.id);
      } else {
        const plan = await prisma.plan.findUniqueOrThrow({ where: { id: inst.planId } });
        await runtime.ensure({
          instanceId: inst.id,
          tenantId: inst.tenantId,
          image: inst.image,
          limits: { cpuMillis: plan.cpuMillis, memoryMb: plan.memoryMb, pids: plan.pids },
          env: { HERMES_INSTANCE_ID: inst.id },
        });
        await runtime.start(inst.id);
      }
      healthy = await this.waitHealthy(inst.id);
    } catch (e) {
      if (e instanceof RuntimeUnavailableError) {
        // An outage must not burn recovery attempts.
        await prisma.instance.update({
          where: { id: inst.id },
          data: { recoveryAttempts: inst.recoveryAttempts, nextRecoveryAt: inst.nextRecoveryAt },
        });
        return 'skipped';
      }
      this.d.logger.error({ instanceId: inst.id, err: (e as Error).message }, 'recovery attempt failed');
    }

    const fresh = await prisma.instance.findUniqueOrThrow({ where: { id: inst.id } });
    if (healthy) {
      const port = (await runtime.inspect(inst.id)).hostPort;
      await this.markHealthy(fresh, port, 'Recovery succeeded', 'recovery.succeeded');
      return 'recovered';
    }
    if (attempts >= maxRecoveryAttempts) return this.markExhausted(fresh);
    await this.setDegraded(fresh, 'recovery_failed', 'instance.degraded', 'Recovery attempt failed');
    return 'degraded';
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
      await prisma.instance.updateMany({ where: { id: inst.id, status: 'DEGRADED' }, data: { statusReason: reason } });
      await recordEvent(prisma, inst.id, eventType, message);
    }
  }

  private async markHealthy(inst: Instance, hostPort: number | null, message: string, eventType = 'instance.active') {
    const { prisma, now } = this.d;
    const data = {
      consecutiveFailures: 0, recoveryAttempts: 0, nextRecoveryAt: null, lastHealthAt: now(), hostPort,
    };
    if (inst.status === 'DEGRADED') {
      await transition(prisma, { id: inst.id, from: 'DEGRADED', to: 'ACTIVE', eventType, message, data }).catch(() => undefined);
    } else {
      await prisma.instance.updateMany({ where: { id: inst.id, status: 'ACTIVE' }, data });
      if (eventType !== 'instance.active') await recordEvent(prisma, inst.id, eventType, message);
    }
  }

  /** Polls readiness; gives up early if the container has already died. */
  private async waitHealthy(instanceId: string): Promise<boolean> {
    const { runtime, pollIntervalMs, healthTimeoutMs } = this.d;
    const end = Date.now() + healthTimeoutMs;
    for (;;) {
      if ((await runtime.checkHealth(instanceId)).ok) return true;
      if (Date.now() >= end) return false;
      const { state } = await runtime.inspect(instanceId);
      if (state === 'exited' || state === 'dead' || state === 'absent') return false;
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }
}
