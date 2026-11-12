import type { Instance, InstanceStatus, Prisma, PrismaClient } from '@prisma/client';
import type { Lease } from './lease.js';
import { ConflictError, NotFoundError } from '../../shared/errors.js';
import { isUuid } from '../../shared/uuid.js';
import { canTransition } from './state-machine.js';

export const TRANSITIONAL_STATUSES: readonly InstanceStatus[] = [
  'PENDING', 'PROVISIONING', 'CONFIGURING', 'STARTING', 'STOPPING', 'DELETING',
];

export interface TransitionOpts {
  id: string;
  from: InstanceStatus;
  to: InstanceStatus;
  /** Fixed, pre-sanitized reason code (never a raw error message). */
  reason?: string | null;
  eventType: string;
  /** Pre-sanitized. */
  message: string;
  data?: Prisma.InstanceUpdateManyMutationInput;
  /** Take the operation lease. Only meaningful when entering a transitional status. */
  lease?: Lease;
  /** The write only applies while this operation still owns the lease (fencing). */
  owner?: string;
  /** Extra guard, e.g. "lease has expired" for the reaper. */
  fence?: Prisma.InstanceWhereInput;
}

/**
 * Compare-and-set status change plus an event, atomically. If another caller already
 * moved the instance, nothing changes and ConflictError is thrown.
 */
export async function transition(prisma: PrismaClient, o: TransitionOpts): Promise<void> {
  if (!canTransition(o.from, o.to)) throw new Error(`Illegal transition ${o.from} -> ${o.to}`);
  await casAndRecord(prisma, o);
}

/** Undo a transitional status after a runtime outage. Bypasses the transition table on purpose. */
export async function revert(prisma: PrismaClient, o: TransitionOpts): Promise<void> {
  await casAndRecord(prisma, o).catch((e) => {
    if (!(e instanceof ConflictError)) throw e; // someone else already moved it; leave it
  });
}

async function casAndRecord(prisma: PrismaClient, o: TransitionOpts): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Entering a stable status releases the lease; staying transitional keeps it.
    const leaseData = TRANSITIONAL_STATUSES.includes(o.to)
      ? o.lease ? { operationOwner: o.lease.owner, leaseExpiresAt: o.lease.expiresAt } : {}
      : { operationOwner: null, leaseExpiresAt: null };
    const res = await tx.instance.updateMany({
      where: {
        id: o.id,
        status: o.from,
        ...(o.owner ? { operationOwner: o.owner } : {}),
        ...(o.fence ? { AND: [o.fence] } : {}),
      },
      data: { ...o.data, ...leaseData, status: o.to, statusReason: o.reason ?? null },
    });
    if (res.count === 0) throw new ConflictError('Instance state changed concurrently');
    await tx.instanceEvent.create({ data: { instanceId: o.id, type: o.eventType, message: o.message } });
  });
}

export async function recordEvent(prisma: PrismaClient, instanceId: string, type: string, message: string) {
  await prisma.instanceEvent.create({ data: { instanceId, type, message } });
}

/**
 * A volume's quota differs from its plan (a plan change shows up this way, since quotas are set at
 * creation only). Informational: never changes state and never blocks recovery. Pre-sanitized text.
 */
export async function noteQuotaMismatch(
  prisma: PrismaClient, instanceId: string, volumeQuotaMb: number | null, planStorageMb: number,
): Promise<void> {
  if (volumeQuotaMb === null || volumeQuotaMb === planStorageMb) return;
  await recordEvent(prisma, instanceId, 'disk.quota_mismatch', 'Volume quota differs from plan');
}

/** Tenant-scoped lookup. A foreign or malformed id is indistinguishable from a missing one. */
export async function findOwned(prisma: PrismaClient, tenantId: string, instanceId: string): Promise<Instance> {
  if (!isUuid(tenantId) || !isUuid(instanceId)) throw new NotFoundError('Instance not found');
  const row = await prisma.instance.findFirst({ where: { id: instanceId, tenantId } });
  if (!row) throw new NotFoundError('Instance not found');
  return row;
}
