import { readFile } from 'node:fs/promises';
import { z } from 'zod';

/** Written every 5 minutes by `ops/host/hermes-usage.sh`; the backend mounts its folder read-only (deploy/compose.prod.yaml). */
export const HOST_USAGE_FILE = '/var/lib/hermes-usage/node.json';

const mb = z.number().int().min(0);
const snapshot = z.object({
  ts: z.string().datetime(),
  cpus: z.number().int().min(1),
  load1: z.number().min(0),
  memTotalMb: mb, memUsedMb: mb, memAvailableMb: mb,
  diskTotalMb: mb, diskUsedMb: mb,
  volumesTotalMb: mb, volumesUsedMb: mb,
  tenants: mb, tenantMemMb: mb,
});
export type HostUsage = z.infer<typeof snapshot>;

/**
 * The latest host snapshot, or null when the file is missing or malformed (timer not installed yet, or a dev machine).
 * One small file read per admin request: the backend never runs `docker stats` or polls anything for this.
 */
export async function readHostUsage(file: string = HOST_USAGE_FILE): Promise<HostUsage | null> {
  try {
    const parsed = snapshot.safeParse(JSON.parse(await readFile(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
