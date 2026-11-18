import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { clientIp, rateLimitKey } from '../../src/http/public-routes.js';

const req = (xff: string | undefined, ip = '127.0.0.1'): FastifyRequest =>
  ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, ip }) as unknown as FastifyRequest;

describe('clientIp', () => {
  it('takes the last X-Forwarded-For entry, the one the proxy wrote', () => {
    expect(clientIp(req('198.51.100.7, 203.0.113.9'))).toBe('203.0.113.9');
  });

  it('falls back to the socket address when the header is missing or not an address', () => {
    expect(clientIp(req(undefined))).toBe('127.0.0.1');
    expect(clientIp(req('not-an-ip'))).toBe('127.0.0.1');
  });
});

describe('rateLimitKey', () => {
  it('keeps an IPv4 address as it is', () => {
    expect(rateLimitKey(req('203.0.113.9'))).toBe('203.0.113.9');
  });

  it('gives every address in one IPv6 /64 the same key', () => {
    const a = rateLimitKey(req('2001:db8:aa:bb:1:2:3:4'));
    expect(a).toBe('2001:db8:aa:bb::/64');
    expect(rateLimitKey(req('2001:db8:aa:bb:ffff::1'))).toBe(a);
    expect(rateLimitKey(req('2001:0db8:00aa:00bb::9'))).toBe(a);
  });

  it('gives different /64 networks different keys', () => {
    expect(rateLimitKey(req('2001:db8:aa:bc::1'))).not.toBe(rateLimitKey(req('2001:db8:aa:bb::1')));
  });

  it('expands compressed forms before taking the prefix', () => {
    expect(rateLimitKey(req('2001:db8::1'))).toBe('2001:db8:0:0::/64');
    expect(rateLimitKey(req('::1'))).toBe('0:0:0:0::/64');
    expect(rateLimitKey(req('64:ff9b::192.0.2.1'))).toBe('64:ff9b:0:0::/64');
  });

  it('treats an IPv4-mapped IPv6 address as the IPv4 address', () => {
    expect(rateLimitKey(req('::ffff:203.0.113.9'))).toBe('203.0.113.9');
  });

  it('uses the socket address when the header is unusable', () => {
    expect(rateLimitKey(req('garbage', '2001:db8:1:2::5'))).toBe('2001:db8:1:2::/64');
  });
});
