import { safeFetch, type SafeFetchOptions, type SafeFetchResult } from '../net/safe-fetch.js';

export type FetchOptions = Omit<SafeFetchOptions, 'timeoutMs' | 'maxBytes'> & Partial<Pick<SafeFetchOptions, 'timeoutMs' | 'maxBytes'>>;

/** Outbound HTTP used by the integration services. Tests inject a fake; production uses `safeFetch`. */
export type Fetcher = (url: string, opts: FetchOptions) => Promise<SafeFetchResult>;

export const defaultFetcher: Fetcher = (url, opts) => safeFetch(url, { timeoutMs: 8000, maxBytes: 64 * 1024, ...opts });
