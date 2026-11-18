import { createHmac, timingSafeEqual } from 'node:crypto';

/** Svix's own tolerance: a signed message older or newer than this is refused, so a captured one cannot be replayed later. */
export const SVIX_TOLERANCE_SEC = 5 * 60;

/** `whsec_` followed by base64: the "Signing Secret" SumoPod shows for a webhook endpoint. */
export const SVIX_SECRET_PATTERN = /^whsec_[A-Za-z0-9+/]+={0,2}$/;

export interface SvixHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

/**
 * Verifies a Svix-signed webhook (the scheme SumoPod documents as `svix-id`, `svix-timestamp`, `svix-signature`):
 * `v1,<base64 HMAC-SHA256(secret, "<id>.<timestamp>.<raw body>")>`, the secret being the base64 after `whsec_`. The
 * signature header may list several space-separated signatures (during a secret rotation); one valid `v1` is enough.
 * `rawBody` must be the exact bytes received: a re-serialized object would not match.
 */
export function verifySvixSignature(secret: string, h: SvixHeaders, rawBody: string, nowMs: number): boolean {
  const { id, timestamp, signature } = h;
  if (!id || !timestamp || !signature || id.length > 256 || signature.length > 4096) return false;
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > SVIX_TOLERANCE_SEC) return false;
  if (!SVIX_SECRET_PATTERN.test(secret)) return false;
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest();
  for (const part of signature.split(' ')) {
    const comma = part.indexOf(',');
    if (comma < 0 || part.slice(0, comma) !== 'v1') continue;
    const given = Buffer.from(part.slice(comma + 1), 'base64');
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}
