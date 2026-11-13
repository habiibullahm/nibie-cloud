import { request, type RequestOptions } from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { OutboundBlockedError, OutboundFailedError } from '../../shared/errors.js';
import { isForbiddenAddress } from './ip-ranges.js';

export interface SafeFetchOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  /** Whole-request deadline, connection and body included. */
  timeoutMs: number;
  /** Response body cap in bytes; reading stops and the call fails when it is exceeded. */
  maxBytes: number;
  /** When set, only these exact hostnames may be called. */
  allowHosts?: string[];
  /** Test seams. Production uses DNS and `isForbiddenAddress`. */
  resolver?: (hostname: string) => Promise<string[]>;
  ipPolicy?: (ip: string) => boolean;
  tls?: Pick<RequestOptions, 'ca'>;
}

export interface SafeFetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const defaultResolver = async (hostname: string): Promise<string[]> => (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/**
 * The only way the control plane calls a URL a customer supplied (PRD 7.3). https only, no userinfo, no
 * redirects. The hostname is resolved once; every answer must pass the policy, and the connection is then
 * pinned to that validated address (so a second, different DNS answer is never used) while the TLS name and
 * `Host` header stay the original hostname. Errors are fixed and coarse: they never echo the URL, an
 * address, a header or a body. This does not replace the network-level egress policy (PRD 7.3).
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new OutboundBlockedError();
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hostname === '') throw new OutboundBlockedError();
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (opts.allowHosts && !opts.allowHosts.includes(hostname)) throw new OutboundBlockedError();

  const forbidden = opts.ipPolicy ?? isForbiddenAddress;
  let addresses: string[];
  if (isIP(hostname) !== 0) {
    addresses = [hostname];
  } else {
    try {
      addresses = await (opts.resolver ?? defaultResolver)(hostname);
    } catch {
      throw new OutboundFailedError('unreachable');
    }
  }
  if (addresses.length === 0) throw new OutboundFailedError('unreachable');
  if (addresses.some((a) => forbidden(a))) throw new OutboundBlockedError();
  const pinned = addresses[0] as string;

  return new Promise<SafeFetchResult>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const req = request(
      {
        host: hostname,
        port: url.port === '' ? 443 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: opts.method ?? 'GET',
        headers: opts.headers,
        servername: isIP(hostname) === 0 ? hostname : undefined,
        // Pin the connection to the address validated above; no second DNS lookup happens.
        lookup: (_h, _o, cb) => (_o as { all?: boolean }).all ? (cb as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [{ address: pinned, family: isIP(pinned) }]) : cb(null, pinned, isIP(pinned)),
        ...(opts.tls ?? {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          done(() => reject(new OutboundFailedError('redirect')));
          res.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > opts.maxBytes) {
            done(() => reject(new OutboundFailedError('too_large')));
            res.destroy();
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on('end', () =>
          done(() =>
            resolve({
              status,
              headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : (v ?? '')])),
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          ),
        );
        res.on('error', () => done(() => reject(new OutboundFailedError('unreachable'))));
        res.on('aborted', () => done(() => reject(new OutboundFailedError('unreachable'))));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      done(() => reject(new OutboundFailedError('timeout')));
    }, opts.timeoutMs);
    req.on('error', () => done(() => reject(new OutboundFailedError('unreachable'))));
    req.end(opts.body);
  });
}
