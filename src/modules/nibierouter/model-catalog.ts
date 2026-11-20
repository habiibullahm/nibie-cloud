import { z } from 'zod';
import { OutboundBlockedError, OutboundFailedError, RouterUnavailableError } from '../../shared/errors.js';
import { safeFetch, type SafeFetchOptions, type SafeFetchResult } from '../net/safe-fetch.js';

/** One chat model the router offers. Prices are US$ per 1 million tokens. */
export interface CatalogModel {
  id: string;
  name: string;
  contextLength: number | null;
  promptUsdPerM: number;
  completionUsdPerM: number;
  /** Every price is 0: usable on a free plan, whose router balance is 0. */
  free: boolean;
}

export interface ModelCatalog {
  list(): Promise<CatalogModel[]>;
}

type Fetcher = (url: string, opts: SafeFetchOptions) => Promise<SafeFetchResult>;

export const CATALOG_TTL_MS = 10 * 60_000;
// Same rule as `ProviderService` uses for a stored model name, so every listed id can be saved.
const MODEL_ID = /^[A-Za-z0-9._:/@+-]{1,100}$/;

// The router sends prices as strings of US$ per token, for example "0.000000300000".
const price = z.union([z.string(), z.number()]).transform(Number).refine((n) => Number.isFinite(n) && n >= 0);
const entry = z.object({
  id: z.string().regex(MODEL_ID),
  name: z.string().max(200).optional(),
  context_length: z.number().int().positive().nullable().optional(),
  mode: z.string().optional(),
  pricing: z.object({ prompt: price, completion: price }),
});
const answer = z.object({ data: z.array(z.unknown()) });

const perMillion = (usdPerToken: number) => Number((usdPerToken * 1_000_000).toFixed(6));

/** Keeps the chat models and drops any entry that does not parse, so one odd model never hides the rest. */
export function parseCatalog(body: unknown): CatalogModel[] {
  const out = answer.safeParse(body);
  if (!out.success) throw new RouterUnavailableError('unexpected');
  const models: CatalogModel[] = [];
  for (const raw of out.data.data) {
    const m = entry.safeParse(raw);
    if (!m.success || (m.data.mode !== undefined && m.data.mode !== 'chat')) continue;
    const { prompt, completion } = m.data.pricing;
    models.push({
      id: m.data.id,
      name: m.data.name || m.data.id,
      contextLength: m.data.context_length ?? null,
      promptUsdPerM: perMillion(prompt),
      completionUsdPerM: perMillion(completion),
      free: prompt === 0 && completion === 0,
    });
  }
  return models.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The router's public model list (`GET {baseUrl}/models`, no key needed), kept in memory for 10 minutes. When the
 * router cannot be reached the last good copy is served; with no copy yet the call fails with `router_unavailable`.
 */
export function createModelCatalog(deps: { url: string; fetcher?: Fetcher; ttlMs?: number; now?: () => number }): ModelCatalog {
  const fetcher = deps.fetcher ?? safeFetch;
  const ttl = deps.ttlMs ?? CATALOG_TTL_MS;
  const now = deps.now ?? Date.now;
  const host = new URL(deps.url).hostname;
  let cached: { at: number; models: CatalogModel[] } | null = null;
  let inflight: Promise<CatalogModel[]> | null = null;

  async function load(): Promise<CatalogModel[]> {
    try {
      let res: SafeFetchResult;
      try {
        res = await fetcher(deps.url, { headers: { accept: 'application/json' }, timeoutMs: 8_000, maxBytes: 1024 * 1024, allowHosts: [host] });
      } catch (e) {
        if (e instanceof OutboundBlockedError || e instanceof OutboundFailedError) throw new RouterUnavailableError('unreachable');
        throw e;
      }
      if (res.status < 200 || res.status >= 300) throw new RouterUnavailableError('unreachable');
      let body: unknown;
      try {
        body = JSON.parse(res.body);
      } catch {
        throw new RouterUnavailableError('unexpected');
      }
      const models = parseCatalog(body);
      cached = { at: now(), models };
      return models;
    } catch (e) {
      if (cached && e instanceof RouterUnavailableError) {
        // Serve the old copy and try the router again in a minute, so customers do not each wait for a timeout.
        cached = { at: now() - ttl + 60_000, models: cached.models };
        return cached.models;
      }
      throw e;
    }
  }

  return {
    async list() {
      if (cached && now() - cached.at < ttl) return cached.models;
      inflight ??= load().finally(() => { inflight = null; });
      return inflight;
    },
  };
}
