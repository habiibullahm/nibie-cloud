import { Writable } from 'node:stream';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import { describe, expect, it } from 'vitest';
import { maskIp } from '../../src/shared/ip.js';
import { createLogger } from '../../src/shared/logger.js';

function capture() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { stream, output: () => chunks.join('') };
}

describe('createLogger redaction', () => {
  it('redacts tokens, api keys, env values and authorization headers', () => {
    const { stream, output } = capture();
    const log = createLogger({ stream });
    log.info({
      adminToken: 'sekret-admin',
      env: { TELEGRAM_BOT_TOKEN: 'sekret-bot' },
      provider: { apiKey: 'sekret-key', password: 'sekret-pw', token: 'sekret-tok' },
      req: { headers: { authorization: 'Bearer sekret-bearer' } },
    }, 'hello');
    const out = output();
    for (const s of ['sekret-admin', 'sekret-bot', 'sekret-key', 'sekret-pw', 'sekret-tok', 'sekret-bearer']) {
      expect(out).not.toContain(s);
    }
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('hello');
  });
});

describe('maskIp', () => {
  it('keeps the /24 of an IPv4 address and the /48 of an IPv6 address', () => {
    expect(maskIp('203.0.113.77')).toBe('203.0.113.0');
    expect(maskIp('2001:db8:aa:bb:1:2:3:4')).toBe('2001:db8:aa::');
    expect(maskIp('2001:0db8:00aa::9')).toBe('2001:db8:aa::');
  });

  it('treats an IPv4-mapped IPv6 address as the IPv4 address it wraps', () => {
    expect(maskIp('::ffff:203.0.113.77')).toBe('203.0.113.0');
  });

  it('returns nothing for a value that is not an IP address', () => {
    expect(maskIp(undefined)).toBeUndefined();
    expect(maskIp('')).toBeUndefined();
    expect(maskIp('alice@example.com')).toBeUndefined();
  });
});

describe('request log', () => {
  it('writes the path and the client network, not the query string, the exact address or the port', async () => {
    const { stream, output } = capture();
    const app = Fastify({ loggerInstance: createLogger({ stream }) as unknown as FastifyBaseLogger });
    app.get('/api/v1/admin/customers', async () => ({ ok: true }));
    await app.inject({ url: '/api/v1/admin/customers?q=alice@example.com', remoteAddress: '203.0.113.77' });
    await app.close();
    const out = output();
    expect(out).toContain('/api/v1/admin/customers');
    expect(out).toContain('203.0.113.0');
    expect(out).not.toContain('alice@example.com');
    expect(out).not.toContain('203.0.113.77');
    expect(out).not.toContain('remotePort');
  });
});
