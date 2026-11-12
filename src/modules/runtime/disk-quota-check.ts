import { randomUUID } from 'node:crypto';
import type { DiskQuotaMode } from './types.js';
import { readVolumeQuotaMb, sizedVolumeOpts } from './volume-quota.js';

interface DockerLike {
  createVolume(o: { Name: string; Driver: string; DriverOpts: Record<string, string> }): Promise<unknown>;
  getVolume(name: string): {
    inspect(): Promise<{ Options?: Record<string, string> | null }>;
    remove(): Promise<unknown>;
  };
}

/**
 * Fail fast at startup when Docker cannot create size-limited volumes, instead of failing every
 * provision later. Creates and removes a small probe volume. This proves Docker accepts the size
 * option and records it; whether the kernel then enforces it is checked by the live harness.
 */
export async function assertDiskQuotaSupported(docker: DockerLike, mode: DiskQuotaMode): Promise<void> {
  if (mode === 'off') return;
  const name = `hermes-quota-probe-${randomUUID()}`;
  let created = false;
  try {
    await docker.createVolume({ Name: name, Driver: 'local', DriverOpts: sizedVolumeOpts(64) });
    created = true;
    if (readVolumeQuotaMb(await docker.getVolume(name).inspect()) === null) {
      throw new Error('probe volume has no quota');
    }
  } catch {
    // Never forward Docker's text: it can embed host paths.
    throw new Error(
      'HERMES_DISK_QUOTA=enforce but Docker cannot create size-limited volumes on this host ' +
        '(needs XFS with project quotas; see docs/setup.md)',
    );
  } finally {
    if (created) await docker.getVolume(name).remove().catch(() => undefined);
  }
}
