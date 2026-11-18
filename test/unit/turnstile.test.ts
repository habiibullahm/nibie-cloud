import { describe, expect, it } from 'vitest';
import { createTurnstileVerifier } from '../../src/modules/waitlist/turnstile.js';
import { OutboundFailedError } from '../../src/shared/errors.js';
import type { SafeFetchOptions } from '../../src/modules/net/safe-fetch.js';

const SECRET = 'turnstile-secret-for-tests';

function fake(status: number, body: string, seen: Array<{ url: string; opts: SafeFetchOptions }> = []) {
  return async (url: string, opts: SafeFetchOptions) => {
    seen.push({ url, opts });
    return { status, headers: {}, body };
  };
}

describe('Turnstile verifier', () => {
  it('posts the secret, the token and the visitor address to siteverify, and accepts success', async () => {
    const seen: Array<{ url: string; opts: SafeFetchOptions }> = [];
    const verify = createTurnstileVerifier({ secret: SECRET, fetcher: fake(200, '{"success":true}', seen) });
    expect(await verify('tok', '203.0.113.9')).toBe('ok');
    expect(seen[0]!.url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(seen[0]!.opts.allowHosts).toEqual(['challenges.cloudflare.com']);
    const form = new URLSearchParams(seen[0]!.opts.body);
    expect(form.get('secret')).toBe(SECRET);
    expect(form.get('response')).toBe('tok');
    expect(form.get('remoteip')).toBe('203.0.113.9');
  });

  it('treats a refused token as invalid', async () => {
    const verify = createTurnstileVerifier({ secret: SECRET, fetcher: fake(200, '{"success":false,"error-codes":["timeout-or-duplicate"]}') });
    expect(await verify('tok', '203.0.113.9')).toBe('invalid');
  });

  it('refuses a missing, empty or oversized token without calling Cloudflare', async () => {
    const seen: Array<{ url: string; opts: SafeFetchOptions }> = [];
    const verify = createTurnstileVerifier({ secret: SECRET, fetcher: fake(200, '{"success":true}', seen) });
    expect(await verify(undefined, '203.0.113.9')).toBe('invalid');
    expect(await verify('', '203.0.113.9')).toBe('invalid');
    expect(await verify('x'.repeat(2049), '203.0.113.9')).toBe('invalid');
    expect(seen).toHaveLength(0);
  });

  it('fails closed when Cloudflare cannot be asked or answers oddly', async () => {
    const down = createTurnstileVerifier({ secret: SECRET, fetcher: async () => { throw new OutboundFailedError('timeout'); } });
    expect(await down('tok', '203.0.113.9')).toBe('unavailable');
    expect(await createTurnstileVerifier({ secret: SECRET, fetcher: fake(500, '') })('tok', '1.2.3.4')).toBe('unavailable');
    expect(await createTurnstileVerifier({ secret: SECRET, fetcher: fake(200, 'not json') })('tok', '1.2.3.4')).toBe('unavailable');
  });
});
