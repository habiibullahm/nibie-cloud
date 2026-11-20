import { describe, expect, it, vi } from 'vitest';
import { NANO_PER_USD, createNibieRouterClient } from '../../src/modules/nibierouter/nibierouter-client.js';
import { OutboundBlockedError, OutboundFailedError, RouterUnavailableError } from '../../src/shared/errors.js';

const cfg = { apiUrl: 'https://router.example.test', adminKey: 'sk-admin-canary-0123456789', defaultModel: 'm-1', emailDomain: 'cloud.example.test' };

function fakeFetch(body: unknown, status = 200) {
  return vi.fn(async () => ({ status, headers: {}, body: typeof body === 'string' ? body : JSON.stringify(body) }));
}
type Call = [string, { method: string; headers: Record<string, string>; body?: string; allowHosts: string[] }];
const lastCall = (f: ReturnType<typeof fakeFetch>) => f.mock.calls[0] as unknown as Call;
const reason = async (p: Promise<unknown>) => {
  const e = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(RouterUnavailableError);
  return (e as RouterUnavailableError).reason;
};

describe('createNibieRouterClient', () => {
  it('createUser posts a non-admin, zero-balance user with the bearer admin key, pinned to the router host', async () => {
    const f = fakeFetch({ id: 42 });
    const out = await createNibieRouterClient(cfg, { fetcher: f }).createUser({ email: 't-1@cloud.example.test', password: 'pw-secret-value', name: 'Nibie Cloud 1' });
    expect(out).toEqual({ id: '42' });
    const [url, opts] = lastCall(f);
    expect(url).toBe('https://router.example.test/api/admin/users');
    expect(opts.method).toBe('POST');
    expect(opts.headers.authorization).toBe(`Bearer ${cfg.adminKey}`);
    expect(opts.allowHosts).toEqual(['router.example.test']);
    expect(JSON.parse(opts.body!)).toMatchObject({ is_admin: false, balance_nano: 0, email: 't-1@cloud.example.test' });
  });

  it('accepts a user wrapped in { user: ... }', async () => {
    const f = fakeFetch({ user: { id: 'u-7' } });
    expect(await createNibieRouterClient(cfg, { fetcher: f }).createUser({ email: 'a@b.test', password: 'x'.repeat(12), name: 'n' })).toEqual({ id: 'u-7' });
  });

  it('grantCredit sends nano-USD and the note, and returns the new balance', async () => {
    const f = fakeFetch({ balance_nano: 2_000_000_000 });
    const out = await createNibieRouterClient(cfg, { fetcher: f }).grantCredit('u 1', 2n * NANO_PER_USD, 'nibie-cloud credit x');
    expect(out).toEqual({ balanceNano: 2_000_000_000n });
    const [url, opts] = lastCall(f);
    expect(url).toBe('https://router.example.test/api/admin/users/u%201/credit');
    expect(JSON.parse(opts.body!)).toEqual({ delta_nano: 2_000_000_000, note: 'nibie-cloud credit x' });
  });

  it.each([0n, -1n, 1_001n * NANO_PER_USD])('grantCredit refuses %s before any request', async (delta) => {
    const f = fakeFetch({ balance_nano: 1 });
    expect(await reason(createNibieRouterClient(cfg, { fetcher: f }).grantCredit('u', delta, 'n'))).toBe('rejected');
    expect(f).not.toHaveBeenCalled();
  });

  it('hasCreditNote finds the exact note in a bare array or a wrapped history', async () => {
    const rows = [{ note: 'other' }, { note: 'nibie-cloud credit x' }, { note: null }];
    expect(await createNibieRouterClient(cfg, { fetcher: fakeFetch(rows) }).hasCreditNote('u', 'nibie-cloud credit x')).toBe(true);
    expect(await createNibieRouterClient(cfg, { fetcher: fakeFetch({ history: rows }) }).hasCreditNote('u', 'nibie-cloud credit x')).toBe(true);
    expect(await createNibieRouterClient(cfg, { fetcher: fakeFetch({ items: rows }) }).hasCreditNote('u', 'nibie-cloud credit y')).toBe(false);
  });

  it('hasCreditNote reads the documented balance-history shape: items with the note in `reference`, newest 200', async () => {
    const f = fakeFetch({ items: [{ kind: 'usage', amount_nano: -5, reference: 'day', actor_email: null }, { kind: 'admin', amount_nano: 2_000_000_000, reference: 'nibie-cloud credit x', actor_email: 'a@b.test' }], total: 2 });
    expect(await createNibieRouterClient(cfg, { fetcher: f }).hasCreditNote('u', 'nibie-cloud credit x')).toBe(true);
    expect(lastCall(f)[0]).toBe('https://router.example.test/api/admin/users/u/balance-history?limit=200');
  });

  it('createKey sends the rpm limit and returns the id and the secret; a body without an sk- secret is unexpected', async () => {
    const f = fakeFetch({ id: 'k1', key: 'sk-abcdefghijkl' });
    expect(await createNibieRouterClient(cfg, { fetcher: f }).createKey('u', { name: 'inst-1', rpmLimit: 20 })).toEqual({ id: 'k1', secret: 'sk-abcdefghijkl' });
    expect(JSON.parse(lastCall(f)[1].body!)).toEqual({ name: 'inst-1', rpm_limit: 20 });
    const bad = createNibieRouterClient(cfg, { fetcher: fakeFetch({ id: 'k1', key: 'not-a-secret' }) });
    expect(await reason(bad.createKey('u', { name: 'inst-1', rpmLimit: 20 }))).toBe('unexpected');
  });

  it('listKeys marks revoked keys and keeps the limit settings, nothing else', async () => {
    const f = fakeFetch({ keys: [
      { id: 'k1', name: 'a', revoked_at: null, rpm_limit: null, max_parallel: 2, allowed_models: null, key_prefix: 'sk-****-x', usage_nano: 5 },
      { id: 'k2', name: 'b', revoked_at: '2026-01-01T00:00:00Z', created_at: '2025-12-01T00:00:00Z', rpm_limit: 20 },
      { id: 'k3', name: 'c' },
    ] });
    expect(await createNibieRouterClient(cfg, { fetcher: f }).listKeys('u')).toEqual([
      { id: 'k1', name: 'a', revoked: false, createdAt: null, rpmLimit: null, settings: { rpm_limit: null, max_parallel: 2, allowed_models: null } },
      { id: 'k2', name: 'b', revoked: true, createdAt: '2025-12-01T00:00:00Z', rpmLimit: 20, settings: { rpm_limit: 20 } },
      { id: 'k3', name: 'c', revoked: false, createdAt: null, rpmLimit: null, settings: {} },
    ]);
  });

  it('updateKey PUTs the name and every setting given', async () => {
    const f = fakeFetch({ id: 'k1', name: 'inst-1', rpm_limit: 20 });
    await createNibieRouterClient(cfg, { fetcher: f }).updateKey('u 1', 'k/1', { name: 'inst-1', settings: { rpm_limit: 20, max_parallel: 2, allowed_models: null } });
    const [url, opts] = lastCall(f);
    expect(url).toBe('https://router.example.test/api/admin/users/u%201/keys/k%2F1');
    expect(opts.method).toBe('PUT');
    expect(JSON.parse(opts.body!)).toEqual({ name: 'inst-1', rpm_limit: 20, max_parallel: 2, allowed_models: null });
  });

  it('revokeKey DELETEs the key and accepts an empty or JSON answer', async () => {
    const f = fakeFetch('', 204);
    await createNibieRouterClient(cfg, { fetcher: f }).revokeKey('u 1', 'k/1');
    const [url, opts] = lastCall(f);
    expect(url).toBe('https://router.example.test/api/admin/users/u%201/keys/k%2F1');
    expect(opts.method).toBe('DELETE');
    expect(opts.body).toBeUndefined();
    await createNibieRouterClient(cfg, { fetcher: fakeFetch({ ok: true }) }).revokeKey('u', 'k');
    expect(await reason(createNibieRouterClient(cfg, { fetcher: fakeFetch({}, 404) }).revokeKey('u', 'k'))).toBe('rejected');
  });

  it('getUsage reads balance, 30-day spend, daily and per-model usage in nano-USD', async () => {
    const f = fakeFetch({
      user: { id: 'u', balance_nano: 2_500_000_000, email: 't@x.test' },
      stats: { spend_30d_nano: 120_000_000, requests_30d: 3 },
      daily: [{ day: '2026-11-19', requests: 3, tokens: 29969, cost_nano: 0 }],
      models: [{ model_slug: 'nibierouter-free', requests: 3, tokens: 29969, cost_nano: 0 }],
      estimated: true,
    });
    expect(await createNibieRouterClient(cfg, { fetcher: f }).getUsage('u 1')).toEqual({
      balanceNano: 2_500_000_000n, spend30dNano: 120_000_000n,
      daily: [{ day: '2026-11-19', requests: 3, costNano: 0n }],
      models: [{ model: 'nibierouter-free', requests: 3, costNano: 0n }],
    });
    expect(lastCall(f)[0]).toBe('https://router.example.test/api/admin/users/u%201');
    expect(await reason(createNibieRouterClient(cfg, { fetcher: fakeFetch({ user: {} }) }).getUsage('u'))).toBe('unexpected');
  });

  it('getIdrPerUsd reads only the rate from the payment settings; none is null', async () => {
    const f = fakeFetch({ idr_per_usd: 18600, live: { api_key_hint: '****-d677' }, pay_currency: 'idr' });
    expect(await createNibieRouterClient(cfg, { fetcher: f }).getIdrPerUsd()).toBe(18600);
    expect(lastCall(f)[0]).toBe('https://router.example.test/api/admin/settings/payment');
    expect(await createNibieRouterClient(cfg, { fetcher: fakeFetch({ pay_currency: 'usd' }) }).getIdrPerUsd()).toBeNull();
  });

  it.each([
    [401, 'rejected'], [403, 'rejected'], [404, 'rejected'], [422, 'rejected'], [429, 'unreachable'], [502, 'unreachable'],
  ])('maps HTTP %i to %s', async (status, expected) => {
    const f = fakeFetch({ error: `leaks ${cfg.adminKey}` }, status);
    expect(await reason(createNibieRouterClient(cfg, { fetcher: f }).createUser({ email: 'a@b.test', password: 'x'.repeat(12), name: 'n' }))).toBe(expected);
  });

  it('maps transport failures to unreachable and a non-JSON answer to unexpected', async () => {
    const blocked = vi.fn(async () => { throw new OutboundBlockedError(); });
    const failed = vi.fn(async () => { throw new OutboundFailedError('unreachable'); });
    const u = { email: 'a@b.test', password: 'x'.repeat(12), name: 'n' };
    expect(await reason(createNibieRouterClient(cfg, { fetcher: blocked }).createUser(u))).toBe('unreachable');
    expect(await reason(createNibieRouterClient(cfg, { fetcher: failed }).createUser(u))).toBe('unreachable');
    expect(await reason(createNibieRouterClient(cfg, { fetcher: fakeFetch('<html>') }).createUser(u))).toBe('unexpected');
  });

  it('never puts router text, the admin key or a secret into the error', async () => {
    const f = fakeFetch({ error: `bad key ${cfg.adminKey}` }, 401);
    const e = (await createNibieRouterClient(cfg, { fetcher: f }).listKeys('u').catch((x: unknown) => x)) as Error;
    expect(e.message).not.toContain(cfg.adminKey);
    expect(e.message).not.toContain('bad key');
  });
});
