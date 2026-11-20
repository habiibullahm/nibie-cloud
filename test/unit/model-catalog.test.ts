import { describe, expect, it } from 'vitest';
import { createModelCatalog, parseCatalog } from '../../src/modules/nibierouter/model-catalog.js';
import { OutboundFailedError, RouterUnavailableError } from '../../src/shared/errors.js';

const URL_ = 'https://router.example.test/v1/models';
const model = (id: string, prompt: string, completion: string, extra: object = {}) => ({ id, name: id, context_length: 1000, mode: 'chat', pricing: { prompt, completion }, ...extra });
const BODY = {
  object: 'list',
  data: [
    model('paid-b', '0.000000300000', '0.000002160000'),
    model('free-a', '0', '0.000000000000'),
    model('embed', '0.0000001', '0', { mode: 'embedding' }),
    { id: 'no-pricing' },
    model('bad id!', '0', '0'),
    model('negative', '-1', '0'),
  ],
};
const ok = (body: unknown = BODY) => ({ status: 200, headers: {}, body: JSON.stringify(body) });

describe('parseCatalog', () => {
  it('converts prices to US$ per 1M tokens, marks free models and drops what it cannot use', () => {
    expect(parseCatalog(BODY)).toEqual([
      { id: 'free-a', name: 'free-a', contextLength: 1000, promptUsdPerM: 0, completionUsdPerM: 0, free: true },
      { id: 'paid-b', name: 'paid-b', contextLength: 1000, promptUsdPerM: 0.3, completionUsdPerM: 2.16, free: false },
    ]);
  });

  it('refuses an answer without a data list', () => {
    expect(() => parseCatalog({ models: [] })).toThrow(RouterUnavailableError);
  });
});

describe('createModelCatalog', () => {
  it('calls only the router host and caches for the TTL', async () => {
    let t = 0;
    const calls: { url: string; hosts: string[] | undefined }[] = [];
    const c = createModelCatalog({ url: URL_, ttlMs: 1000, now: () => t, fetcher: async (url, o) => { calls.push({ url, hosts: o.allowHosts }); return ok(); } });
    await c.list();
    t = 999;
    await c.list();
    expect(calls).toEqual([{ url: URL_, hosts: ['router.example.test'] }]);
    t = 1000;
    await c.list();
    expect(calls).toHaveLength(2);
  });

  it('serves the stale copy when the router is down, and fails when there is none', async () => {
    let t = 0;
    let down = false;
    const c = createModelCatalog({ url: URL_, ttlMs: 1000, now: () => t, fetcher: async () => { if (down) throw new OutboundFailedError('timeout'); return ok(); } });
    down = true;
    await expect(c.list()).rejects.toBeInstanceOf(RouterUnavailableError);
    down = false;
    expect(await c.list()).toHaveLength(2);
    down = true;
    t = 5000;
    expect(await c.list()).toHaveLength(2);
  });

  it('treats an error status or a body that is not JSON as unavailable', async () => {
    for (const res of [{ status: 500, headers: {}, body: '{}' }, { status: 200, headers: {}, body: 'not json' }]) {
      const c = createModelCatalog({ url: URL_, fetcher: async () => res });
      await expect(c.list()).rejects.toBeInstanceOf(RouterUnavailableError);
    }
  });
});
