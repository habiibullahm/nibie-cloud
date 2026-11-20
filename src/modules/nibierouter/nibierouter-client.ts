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
 * The router's per-key limit settings, copied from a key row as they are. Updating a key replaces all of them with exactly
 * what is sent (an omitted one is removed), so an update sends back every one it read. Verified on the router 2026-11-20.
 */
const KEY_SETTINGS = ['rpm_limit', 'max_parallel', 'credit_limit_nano', 'budget_period', 'allowed_models', 'allowed_ips', 'expires_at', 'redact_secrets'] as const;
export type RouterKeySettings = Partial<Record<(typeof KEY_SETTINGS)[number], unknown>>;

export interface RouterKeyRow {
  id: string;
  name: string;
  revoked: boolean;
  /** ISO time the router made the key, when it sends one. */
  createdAt: string | null;
  /** Requests per minute; null means no limit. */
  rpmLimit: number | null;
  settings: RouterKeySettings;
}

/** A router user's balance and usage, from `GET /users/:id` (shape checked on the router 2026-11-20). Money in nano-USD. */
export interface RouterUsage {
  balanceNano: bigint;
  spend30dNano: bigint;
  /** One row per day with requests, oldest first as the router sends them. */
  daily: { day: string; requests: number; costNano: bigint }[];
  models: { model: string; requests: number; costNano: bigint }[];
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
  createKey(userId: string, input: { name: string; rpmLimit: number }): Promise<RouterKey>;
  listKeys(userId: string): Promise<RouterKeyRow[]>;
  /** Replaces the key's name and every limit setting with these values. */
  updateKey(userId: string, keyId: string, input: { name: string; settings: RouterKeySettings }): Promise<void>;
  /** The key stops working at once and cannot be restored. */
  revokeKey(userId: string, keyId: string): Promise<void>;
  getUsage(userId: string): Promise<RouterUsage>;
  /** The router's own Rupiah per US$1 (`idr_per_usd` in its payment settings), or null when it has none. */
  getIdrPerUsd(): Promise<number | null>;
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
const keyRow = z
  .object({ id, name: z.string(), revoked_at: z.string().nullable().optional(), created_at: z.string().max(40).nullable().optional(), rpm_limit: z.number().int().positive().nullable().optional() })
  .passthrough();
// The docs list `kind, amount_nano, reference, actor_email, created_at` for a balance entry and no `note` field: the note of an
// admin credit is expected in `reference`. Both are accepted until the live check shows which one carries it.
const noteRow = z.object({ note: z.string().nullable().optional(), reference: z.string().nullable().optional() });
const nano = z.number().int();
const usageAnswer = z.object({
  user: z.object({ balance_nano: nano }),
  stats: z.object({ spend_30d_nano: nano }),
  daily: z.array(z.object({ day: z.string().max(40), requests: z.number().int(), cost_nano: nano })).max(400).default([]),
  models: z.array(z.object({ model_slug: z.string().max(200), requests: z.number().int(), cost_nano: nano })).max(500).default([]),
});
// Only the rate is read from the payment settings; the rest of that answer (provider names, masked key hints) is dropped.
const paymentAnswer = z.object({ idr_per_usd: z.number().positive().nullable().optional() });

/**
 * HTTP client for the NibieRouter admin API. Errors are fixed and coarse (`RouterUnavailableError`): a router
 * message, a header or the admin key can never reach a log line or a customer. The calls go through `safeFetch`
 * (https only, one pinned public address, no redirects), restricted to the router's own host.
 */
export function createNibieRouterClient(cfg: RouterConfig, deps: { fetcher?: Fetcher; timeoutMs?: number } = {}): NibieRouterClient {
  const fetcher = deps.fetcher ?? safeFetch;
  const origin = new URL(cfg.apiUrl);
  const base = `${origin.origin}/api/admin`;

  async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
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
    // A DELETE may answer with no body at all.
    if (res.body.trim() === '') return null;
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
      const out = parse(keyAnswer, await call('POST', `/users/${enc(userId)}/keys`, { name: input.name, rpm_limit: input.rpmLimit }));
      return { id: out.id, secret: out.key };
    },
    async listKeys(userId) {
      const rows = parse(listOf(keyRow), await call('GET', `/users/${enc(userId)}/keys`)) as z.infer<typeof keyRow>[];
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        revoked: r.revoked_at != null,
        createdAt: r.created_at ?? null,
        rpmLimit: r.rpm_limit ?? null,
        settings: Object.fromEntries(KEY_SETTINGS.filter((k) => k in r).map((k) => [k, (r as Record<string, unknown>)[k]])),
      }));
    },
    async updateKey(userId, keyId, input) {
      await call('PUT', `/users/${enc(userId)}/keys/${enc(keyId)}`, { ...input.settings, name: input.name });
    },
    async revokeKey(userId, keyId) {
      // Documented as DELETE on the key (docs.sumorouter.com/api/admin, 2026-11-20); not yet tried on the real router.
      await call('DELETE', `/users/${enc(userId)}/keys/${enc(keyId)}`);
    },
    async getUsage(userId) {
      const out = parse(usageAnswer, await call('GET', `/users/${enc(userId)}`));
      return {
        balanceNano: BigInt(out.user.balance_nano),
        spend30dNano: BigInt(out.stats.spend_30d_nano),
        daily: out.daily.map((d) => ({ day: d.day, requests: d.requests, costNano: BigInt(d.cost_nano) })),
        models: out.models.map((m) => ({ model: m.model_slug, requests: m.requests, costNano: BigInt(m.cost_nano) })),
      };
    },
    async getIdrPerUsd() {
      const rate = parse(paymentAnswer, await call('GET', '/settings/payment')).idr_per_usd;
      return rate ? Math.round(rate) : null;
    },
  };
}
