import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const timestamp = z.iso.datetime({ offset: true });
const inventorySchema = z.object({
  observedAt: timestamp,
  retentionDays: z.number().int().positive(),
  snapshots: z.record(z.uuid(), timestamp),
});
const verificationSchema = z.object({
  snapshotAt: timestamp,
  checkedAt: timestamp,
  status: z.enum(['passed', 'failed']),
});

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/** The caller must resolve the instance through the tenant-scoped service before reading its metadata. */
export async function readBackupMetadata(instanceId: string, dir = '/var/lib/hermes-backup-metadata') {
  const [inventory, verification] = await Promise.all([
    readJson(join(dir, 'snapshots.json')),
    readJson(join(dir, `verify-${instanceId}.json`)),
  ]);
  const snapshots = inventorySchema.safeParse(inventory).data;
  return {
    observedAt: snapshots?.observedAt ?? null,
    snapshotAt: snapshots?.snapshots[instanceId] ?? null,
    retentionDays: snapshots?.retentionDays ?? null,
    verification: verificationSchema.safeParse(verification).data ?? null,
  };
}
