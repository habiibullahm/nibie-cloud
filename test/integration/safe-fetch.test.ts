import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isForbiddenAddress } from '../../src/modules/net/ip-ranges.js';
import { safeFetch } from '../../src/modules/net/safe-fetch.js';
import { OutboundBlockedError, OutboundFailedError } from '../../src/shared/errors.js';

let server: Server;
let port: number;
let cert: string;
let hits: Array<{ url: string; host: string | undefined; auth: string | undefined }> = [];
/** Production policy, except that the local test server on loopback is reachable. */
const policy = (ip: string) => ip !== '127.0.0.1' && isForbiddenAddress(ip);
const tls = () => ({ ca: cert });

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=pinned.example.test', '-addext', 'subjectAltName=DNS:pinned.example.test'], { stdio: 'ignore' });
  cert = readFileSync(join(dir, 'c.pem'), 'utf8');
  server = createServer({ key: readFileSync(join(dir, 'k.pem')), cert }, (req, res) => {
    hits.push({ url: req.url ?? '', host: req.headers.host, auth: req.headers.authorization });
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'https://169.254.169.254/latest/meta-data' }).end();
    } else if (req.url === '/big') {
      res.writeHead(200).end('x'.repeat(5000));
    } else if (req.url === '/slow') {
      res.writeHead(200);
      res.write('start');
      // never ends
    } else {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const base = () => ({ timeoutMs: 2000, maxBytes: 1000, ipPolicy: policy, tls: tls() });
const resolverTo = (ip: string, calls?: { n: number }) => async () => {
  if (calls) calls.n += 1;
  return [ip];
};

describe('safeFetch', () => {
  it('connects to the validated address, keeps Host and SNI, and resolves exactly once', async () => {
    hits = [];
    const calls = { n: 0 };
    const r = await safeFetch(`https://pinned.example.test:${port}/ok`, { ...base(), resolver: resolverTo('127.0.0.1', calls), headers: { authorization: 'Bearer abc' } });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true });
    expect(calls.n).toBe(1);
    expect(hits[0]?.host).toBe(`pinned.example.test:${port}`);
    expect(hits[0]?.auth).toBe('Bearer abc');
  });

  it.each([
    'https://127.0.0.1/x', 'https://2130706433/x', 'https://0x7f.1/x', 'https://0177.0.0.1/x', 'https://[::1]/x',
    'https://[::ffff:127.0.0.1]/x', 'https://169.254.169.254/latest', 'https://10.0.0.5/x', 'https://192.168.0.1/x',
    'https://100.64.0.1/x', 'https://[fe80::1]/x', 'https://[fd00::1]/x', 'https://0.0.0.0/x',
  ])('blocks the literal address %s without any network call', async (url) => {
    await expect(safeFetch(url, { timeoutMs: 500, maxBytes: 100 })).rejects.toBeInstanceOf(OutboundBlockedError);
  });

  it('blocks a hostname that resolves to a forbidden address, even if another answer is public', async () => {
    await expect(safeFetch('https://innocent.example.test/', { timeoutMs: 500, maxBytes: 100, resolver: async () => ['8.8.8.8', '10.0.0.1'] })).rejects.toBeInstanceOf(OutboundBlockedError);
    await expect(safeFetch('https://innocent.example.test/', { timeoutMs: 500, maxBytes: 100, resolver: async () => ['169.254.169.254'] })).rejects.toBeInstanceOf(OutboundBlockedError);
  });

  it('does not re-resolve at connection time (rebinding): the second answer is never used', async () => {
    let n = 0;
    const flipping = async () => (++n === 1 ? ['127.0.0.1'] : ['10.0.0.1']);
    hits = [];
    const r = await safeFetch(`https://pinned.example.test:${port}/ok`, { ...base(), resolver: flipping });
    expect(r.status).toBe(200);
    expect(n).toBe(1);
  });

  it('refuses http, userinfo, and non-URLs', async () => {
    for (const url of ['http://example.com/', 'https://user:pw@example.com/', 'ftp://example.com/', 'not a url', 'https://']) {
      await expect(safeFetch(url, { timeoutMs: 500, maxBytes: 100, resolver: resolverTo('8.8.8.8') })).rejects.toBeInstanceOf(OutboundBlockedError);
    }
  });

  it('does not follow redirects, and never contacts the redirect target', async () => {
    await expect(safeFetch(`https://pinned.example.test:${port}/redirect`, { ...base(), resolver: resolverTo('127.0.0.1') })).rejects.toMatchObject({ reason: 'redirect' });
  });

  it('aborts when the body exceeds maxBytes', async () => {
    await expect(safeFetch(`https://pinned.example.test:${port}/big`, { ...base(), resolver: resolverTo('127.0.0.1') })).rejects.toMatchObject({ reason: 'too_large' });
  });

  it('aborts at the timeout when the body never ends', async () => {
    const t0 = Date.now();
    await expect(safeFetch(`https://pinned.example.test:${port}/slow`, { ...base(), timeoutMs: 400, resolver: resolverTo('127.0.0.1') })).rejects.toMatchObject({ reason: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('enforces allowHosts', async () => {
    await expect(safeFetch('https://other.example.test/', { timeoutMs: 500, maxBytes: 100, allowHosts: ['api.telegram.org'], resolver: resolverTo('8.8.8.8') })).rejects.toBeInstanceOf(OutboundBlockedError);
  });

  it('errors never echo the URL, the address or the headers', async () => {
    const secret = 'Bearer super-secret-canary';
    for (const url of ['https://10.1.2.3/path?x=1', `https://pinned.example.test:${port}/redirect`]) {
      try {
        await safeFetch(url, { ...base(), headers: { authorization: secret }, resolver: resolverTo('127.0.0.1') });
      } catch (e) {
        expect(e).toSatisfy((x: unknown) => x instanceof OutboundBlockedError || x instanceof OutboundFailedError);
        const text = `${(e as Error).message} ${JSON.stringify(e)}`;
        for (const leak of ['10.1.2.3', '/path', 'x=1', 'canary', '127.0.0.1', 'pinned.example.test']) expect(text).not.toContain(leak);
      }
    }
  });

  it('an unreachable host reports a coarse reason only', async () => {
    await expect(safeFetch('https://pinned.example.test:1/', { ...base(), resolver: resolverTo('127.0.0.1') })).rejects.toMatchObject({ reason: 'unreachable' });
  });
});
