import { AppError } from '../../shared/errors.js';
import { safeFetch, type SafeFetchOptions, type SafeFetchResult } from '../net/safe-fetch.js';

/** The captcha was missing, wrong, expired or already used. The form shows a fresh one. */
export class CaptchaFailedError extends AppError {
  constructor() {
    super('The anti-bot check failed. Please try again.', 400, 'captcha_failed');
  }
}

const HOST = 'challenges.cloudflare.com';
const SITEVERIFY = `https://${HOST}/turnstile/v0/siteverify`;

/** `ok`: a person solved it. `invalid`: missing, wrong, expired or reused token. `unavailable`: Cloudflare could not be asked. */
export type CaptchaOutcome = 'ok' | 'invalid' | 'unavailable';

export type CaptchaVerifier = (token: string | undefined, remoteIp: string) => Promise<CaptchaOutcome>;

type Fetcher = (url: string, opts: SafeFetchOptions) => Promise<SafeFetchResult>;

/**
 * Cloudflare Turnstile server-side check (siteverify). A token is valid once and for five minutes; Cloudflare enforces
 * both. Nothing is logged: the secret, the token and the answer stay inside this call. A Cloudflare outage is
 * `unavailable`, never `ok` (the form fails closed).
 */
export function createTurnstileVerifier(o: { secret: string; fetcher?: Fetcher; timeoutMs?: number }): CaptchaVerifier {
  const fetcher = o.fetcher ?? safeFetch;
  return async (token, remoteIp) => {
    if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return 'invalid';
    const form = new URLSearchParams({ secret: o.secret, response: token });
    if (remoteIp) form.set('remoteip', remoteIp);
    let res: SafeFetchResult;
    try {
      res = await fetcher(SITEVERIFY, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        timeoutMs: o.timeoutMs ?? 5_000,
        maxBytes: 16 * 1024,
        allowHosts: [HOST],
      });
    } catch {
      return 'unavailable';
    }
    if (res.status !== 200) return 'unavailable';
    try {
      const body = JSON.parse(res.body) as { success?: unknown };
      return body.success === true ? 'ok' : 'invalid';
    } catch {
      return 'unavailable';
    }
  };
}
