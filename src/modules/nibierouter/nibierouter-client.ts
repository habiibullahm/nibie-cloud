import { z } from 'zod';
import type { Config } from '../../config/env.js';
import { OutboundBlockedError, OutboundFailedError, RouterUnavailableError } from '../../shared/errors.js';
import { safeFetch, type SafeFetchOptions, type SafeFetchResult } from '../net/safe-fetch.js';

export type RouterConfig = NonNullable<Config['router']>;

/** US$1 in the router's unit (the SumoRouter admin API counts money in nano-USD). */
export const NANO_PER_USD = 1_000_000_000n;

export interface RouterKey {
  /** The router's id for the key. */
  id: string;
  /** The `sk-...` secret. Shown by the router exactly once. Never log it. */
  secret: string;
}

/**
 * What the control plane needs from NibieRouter (a SumoRouter instance, https://docs.sumorouter.com, admin API).
 * Calls that are not idempotent on the router (`grantCredit`) are guarded by the caller, not here.
 */
export interface NibieRouterClient {
  createUser(input: { email: string; password: string; name: string }): Promise<{ id: string }>;
  grantCredit(userId: string, deltaNano: bigint, note: string): Promise<{ balanceNano: bigint }>;
  /** True when the user's balance history already holds an entry with exactly this note. */
  hasCreditNote(userId: string, note: string): Promise<boolean>;
  createKey(userId: string, input: { name: string }): Promise<RouterKey>;
  listKeys(userId: string): Promise<{ name: string; revoked: boolean }[]>;
}

type Fetcher = (url: string, opts: SafeFetchOptions) => Promise<SafeFetchResult>;

const id = z.union([z.string().min(1).max(100), z.number().int()]).transform(String);
const wrapped = <T extends z.ZodTypeAny>(inner: T, key: string) => z.union([inner, z.object({ [key]: inner })]).transform((v) => ((v as Record<string, unknown>)[key] ?? v) as z.infer<T>);

const userAnswer = wrapped(z.object({ id }), 'user');
const creditAnswer = z.object({ balance_nano: z.number().int() });
// UNVERIFIED against the real router (the docs list "create an API key for a user" without a body or response).
// The shape is accepted loosely: the id and an `sk-` secret are what matters.
const keyAnswer = wrapped(z.object({ id, key: z.string().regex(/^sk-[A-Za-z0-9_-]{8,}$/) }), 'api_key');
const listOf = (item: z.ZodTypeAny) => z.union([z.array(item), z.object({ items: z.array(item) }).transform((v) => v.items), z.object({ keys: z.array(item) }).transform((v) => v.keys), z.object({ history: z.array(item) }).transform((v) => v.history)]);
const keyRow = z.object({ name: z.string(), revoked_at: z.string().nullable().optional() });
// The docs list `kind, amount_nano, reference, actor_email, created_at` for a balance entry and no `note` field: the note of an
// admin credit is expected in `reference`. Both are accepted until the live check shows which one carries it.
const noteRow = z.object({ note: z.string().nullable().optional(), reference: z.string().nullable().optional() });

/**
 * HTTP client for the NibieRouter admin API. Errors are fixed and coarse (`RouterUnavailableError`): a router
 * message, a header or the admin key can never reach a log line or a customer. The calls go through `safeFetch`
 * (https only, one pinned public address, no redirects), restricted to the router's own host.
 */
export function createNibieRouterClient(cfg: RouterConfig, deps: { fetcher?: Fetcher; timeoutMs?: number } = {}): NibieRouterClient {
  const fetcher = deps.fetcher ?? safeFetch;
  const origin = new URL(cfg.apiUrl);
  const base = `${origin.origin}/api/admin`;

  async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    let res: SafeFetchResult;
    try {
      res = await fetcher(base + path, {
        method,
        headers: { authorization: `Bearer ${cfg.adminKey}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        timeoutMs: deps.timeoutMs ?? 10_000,
        maxBytes: 256 * 1024,
        allowHosts: [origin.hostname],
      });
    } catch (e) {
      if (e instanceof OutboundBlockedError || e instanceof OutboundFailedError) throw new RouterUnavailableError('unreachable');
      throw e;
    }
    // 401/403: the admin key is wrong, expired or not allowed from this address. 429 and 5xx: try again later.
    if (res.status === 401 || res.status === 403) throw new RouterUnavailableError('rejected');
    if (res.status === 429 || res.status >= 500) throw new RouterUnavailableError('unreachable');
    if (res.status < 200 || res.status >= 300) throw new RouterUnavailableError('rejected');
    try {
      return JSON.parse(res.body);
    } catch {
      throw new RouterUnavailableError('unexpected');
    }
  }

  function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
    const out = schema.safeParse(data);
    if (!out.success) throw new RouterUnavailableError('unexpected');
    return out.data;
  }

  const enc = encodeURIComponent;
  return {
    async createUser(input) {
      // `is_admin` is pinned to false and `balance_nano` to 0: credit is only ever added through `grantCredit`.
      const out = parse(userAnswer, await call('POST', '/users', { email: input.email, password: input.password, name: input.name, is_admin: false, balance_nano: 0 }));
      return { id: out.id };
    },
    async grantCredit(userId, deltaNano, note) {
      if (deltaNano <= 0n || deltaNano > 1_000n * NANO_PER_USD) throw new RouterUnavailableError('rejected');
      const out = parse(creditAnswer, await call('POST', `/users/${enc(userId)}/credit`, { delta_nano: Number(deltaNano), note }));
      return { balanceNano: BigInt(out.balance_nano) };
    },
    async hasCreditNote(userId, note) {
      // Newest first, 200 is the largest page the router allows.
      const rows = parse(listOf(noteRow), await call('GET', `/users/${enc(userId)}/balance-history?limit=200`)) as { note?: string | null; reference?: string | null }[];
      return rows.some((r) => r.note === note || r.reference === note);
    },
    async createKey(userId, input) {
      const out = parse(keyAnswer, await call('POST', `/users/${enc(userId)}/keys`, { name: input.name }));
      return { id: out.id, secret: out.key };
    },
    async listKeys(userId) {
      const rows = parse(listOf(keyRow), await call('GET', `/users/${enc(userId)}/keys`)) as { name: string; revoked_at?: string | null }[];
      return rows.map((r) => ({ name: r.name, revoked: r.revoked_at != null }));
    },
  };
}
