import type { PrismaClient } from '@prisma/client';
import type { Logger } from '../../shared/logger.js';
import type { RuntimeManager } from '../runtime/types.js';

export type DiskLevel = 'ok' | 'warning' | 'full';

const WARN_AT = 90;
const FULL_AT = 99;
/** Hysteresis: a tenant hovering at a threshold must not flap. */
const FULL_CLEAR_BELOW = 97;
const OK_BELOW = 85;

/** Pure: the next level for a measured usage, with hysteresis. Unusable input keeps the previous level. */
export function nextDiskLevel(prev: DiskLevel, usedBytes: number, limitBytes: number): DiskLevel {
  if (!(limitBytes > 0) || !Number.isFinite(usedBytes) || usedBytes < 0) return prev;
  const pct = (usedBytes / limitBytes) * 100;
  if (pct >= FULL_AT) return 'full';
  if (prev === 'full') return pct < OK_BELOW ? 'ok' : pct < FULL_CLEAR_BELOW ? 'warning' : 'full';
  if (prev === 'warning') return pct < OK_BELOW ? 'ok' : 'warning';
  return pct >= WARN_AT ? 'warning' : 'ok';
}

export interface DiskMonitorDeps {
  prisma: PrismaClient;
  runtime: RuntimeManager;
  logger: Logger;
}

const WATCHED = ['ACTIVE', 'DEGRADED', 'STOPPED'] as const;
const MB = 1024 * 1024;

/**
 * Records `disk.warning`, `disk.full` and `disk.ok` per instance when volume usage crosses a level
 * (PRD 13.2). Informational only: it never changes `status` and never restarts a container, because
 * a full disk is not a gateway failure. One Docker call per poll covers every tenant.
 */
export class DiskMonitor {
  constructor(private readonly d: DiskMonitorDeps) {}

  async pollOnce(): Promise<void> {
    const { prisma, runtime, logger } = this.d;
    let usage: Map<string, number>;
    try {
      usage = await runtime.volumeUsage();
    } catch (e) {
      // Docker down (or any read failure): skip this round, change nothing.
      logger.warn({ errName: (e as Error).name }, 'disk usage poll skipped');
      return;
    }
    const rows = await prisma.instance.findMany({
      where: { status: { in: [...WATCHED] } },
      include: { plan: { select: { storageMb: true } } },
    });
    for (const inst of rows) {
      const used = usage.get(inst.id);
      if (used === undefined) continue; // unknown is not 0
      const prev = inst.diskLevel as DiskLevel;
      const next = nextDiskLevel(prev, used, inst.plan.storageMb * MB);
      try {
        await prisma.$transaction(async (tx) => {
          await tx.instance.update({ where: { id: inst.id }, data: { diskUsedBytes: BigInt(Math.round(used)), diskLevel: next } });
          const message = eventFor(prev, next, used, inst.plan.storageMb * MB);
          if (message) await tx.instanceEvent.create({ data: { instanceId: inst.id, type: message.type, message: message.text } });
        });
      } catch (e) {
        logger.error({ instanceId: inst.id, errName: (e as Error).name }, 'disk level update failed');
      }
    }
  }

  start(intervalMs: number): () => void {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      this.pollOnce()
        .catch((e) => this.d.logger.error({ errName: (e as Error).name }, 'disk monitor loop failed'))
        .finally(() => { running = false; });
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}

/** Events fire on upward moves and on the return to ok; falling from full to warning is silent. */
function eventFor(prev: DiskLevel, next: DiskLevel, used: number, limit: number): { type: string; text: string } | null {
  if (prev === next) return null;
  const percent = Math.round((used / limit) * 100);
  if (next === 'ok') return { type: 'disk.ok', text: 'Disk usage back to normal' };
  if (next === 'full') return { type: 'disk.full', text: `Disk usage at ${percent}% of quota` };
  if (prev === 'ok') return { type: 'disk.warning', text: `Disk usage at ${percent}% of quota` };
  return null; // full -> warning
}
