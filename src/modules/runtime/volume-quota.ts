/**
 * Docker's local volume driver enforces a size limit through XFS project quotas when the volume is
 * created with the `size` driver option. On a filesystem without quota support Docker refuses the
 * create (HTTP 400, "quota size requested but no quota support"). See docs/disk-quota-host-notes.md.
 */

/** Engine API `DriverOpts` for a volume capped at `storageMb`. */
export function sizedVolumeOpts(storageMb: number): Record<string, string> {
  return { size: `${storageMb}m` };
}

/** True when Docker rejected a sized volume because the backing filesystem has no quota support. */
export function isQuotaUnsupported(e: unknown): boolean {
  const status = (e as { statusCode?: number }).statusCode;
  const message = (e as { message?: string }).message ?? '';
  return status === 400 && /no quota support/i.test(message);
}

const UNIT_BYTES: Record<string, number> = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };

/** The quota of an inspected volume in whole MB, or null when it has none (or an unreadable one). */
export function readVolumeQuotaMb(volume: { Options?: Record<string, string> | null }): number | null {
  const raw = volume.Options?.size;
  if (!raw) return null;
  const m = /^(\d+)([kmgt]?)b?$/i.exec(raw.trim());
  if (!m) return null;
  const bytes = Number(m[1]) * (UNIT_BYTES[(m[2] ?? '').toLowerCase()] ?? 1);
  const mb = Math.floor(bytes / 1024 ** 2);
  return mb > 0 ? mb : null;
}
