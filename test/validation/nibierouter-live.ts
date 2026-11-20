/**
 * Manual check of the REAL NibieRouter admin API (milestone E). Not part of `pnpm test`.
 *
 *   NIBIEROUTER_ADMIN_KEY=sk-admin-... pnpm tsx test/validation/nibierouter-live.ts [--credit-usd 0.01]
 *
 * Run it from the machine whose address the admin key is allowed from (the VPS). It creates ONE throwaway
 * router user, then tries, in order: create a key for that user (with an rpm limit), list the user's keys, change the
 * key's limit, grant a small credit, read the balance history and read the user (balance and usage). It prints, per step, only whether it worked and the FIELD NAMES of the answer,
 * never the admin key or the created key. The throwaway user stays at the router (delete it in the NibieRouter
 * admin dashboard); the credit is small (default US$0.01).
 *
 * The step that matters most is "create key": the SumoRouter docs list it for admins but do not describe its
 * body or answer, so the production client's guess (POST /users/{id}/keys, answer with `id` and `key`) is only
 * confirmed here. If it fails, the plan's fallback (sign in as the user and create the key with a spend cap) is built.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { NANO_PER_USD } from '../../src/modules/nibierouter/nibierouter-client.js';

const adminKey = process.env.NIBIEROUTER_ADMIN_KEY;
const origin = process.env.NIBIEROUTER_API_URL ?? 'https://router.nibie.app';
const emailDomain = process.env.NIBIEROUTER_USER_EMAIL_DOMAIN ?? 'cloud.nibie.app';
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
if (!adminKey) {
  console.error('Set NIBIEROUTER_ADMIN_KEY in the environment (never on the command line).');
  process.exit(1);
}
const creditUsd = Number(arg('--credit-usd') ?? '0.01');
if (!(creditUsd > 0 && creditUsd <= 1)) {
  console.error('--credit-usd must be above 0 and at most 1 for this check.');
  process.exit(1);
}

async function call(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${origin}/api/admin${path}`, {
    method,
    headers: { authorization: `Bearer ${adminKey}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    redirect: 'manual',
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json };
}
const names = (v: unknown): string => {
  const first = Array.isArray(v) ? v[0] : v;
  return first && typeof first === 'object' ? Object.keys(first as object).join(', ') : typeof first;
};
const idOf = (v: unknown): string | null => {
  const o = (v && typeof v === 'object' ? ((v as Record<string, unknown>).user ?? v) : null) as Record<string, unknown> | null;
  const id = o?.id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
};

/** The router's own error text on a failure (a short code or sentence, cut at 120 characters), to tell an IP rejection from a bad key. */
const errText = (r: { status: number; json: unknown }): string => {
  if (r.status >= 200 && r.status < 300) return '';
  const e = r.json && typeof r.json === 'object' ? (r.json as Record<string, unknown>).error : undefined;
  const msg = typeof e === 'string' ? e : e && typeof e === 'object' ? JSON.stringify(e) : '';
  return msg ? `; router says: ${msg.replaceAll(adminKey as string, '[key]').slice(0, 120)}` : '';
};
const results: [string, string][] = [];
const note = (step: string, ok: boolean, extra = '') => {
  results.push([step, ok ? 'OK' : 'FAILED']);
  console.log(`${ok ? 'ok    ' : 'FAILED'} ${step}${extra ? ` (${extra})` : ''}`);
};

const email = `live-check-${randomUUID().slice(0, 8)}@${emailDomain}`;
const user = await call('POST', '/users', { email, password: randomBytes(24).toString('base64url'), name: 'Nibie Cloud live check', is_admin: false, balance_nano: 0 });
const userId = idOf(user.json);
note('create user', user.status >= 200 && user.status < 300 && userId !== null, `HTTP ${user.status}; fields: ${names(user.json)}${errText(user)}`);
if (!userId) {
  console.error(user.status === 401 || user.status === 403 ? 'The admin key was rejected: check the key and that this machine is on its IP allowlist.' : 'Could not create the user; stopping.');
  process.exit(2);
}
console.log(`throwaway user: ${email} (id ${userId})`);

const key = await call('POST', `/users/${encodeURIComponent(userId)}/keys`, { name: 'live-check', rpm_limit: 20 });
const secret = key.json && typeof key.json === 'object' ? ((key.json as Record<string, unknown>).key ?? ((key.json as Record<string, unknown>).api_key as Record<string, unknown> | undefined)?.key) : undefined;
note('create key for user', key.status >= 200 && key.status < 300 && typeof secret === 'string' && secret.startsWith('sk-'), `HTTP ${key.status}; fields: ${names(key.json)}${errText(key)}`);

const keys = await call('GET', `/users/${encodeURIComponent(userId)}/keys`);
const keyRows = (Array.isArray(keys.json) ? keys.json : (keys.json as Record<string, unknown> | null)?.keys ?? (keys.json as Record<string, unknown> | null)?.items) as Record<string, unknown>[] | undefined;
const made = keyRows?.find((k) => k.name === 'live-check');
note('list keys (new key has rpm_limit 20)', keys.status >= 200 && keys.status < 300 && made?.rpm_limit === 20, `HTTP ${keys.status}; fields: ${names(keyRows)}`);

// The update replaces every setting with exactly what is sent (RouterKeySettings in the client).
const keyId = typeof made?.id === 'string' ? made.id : '';
const upd = await call('PUT', `/users/${encodeURIComponent(userId)}/keys/${encodeURIComponent(keyId)}`, { name: 'live-check', rpm_limit: 25, max_parallel: null, credit_limit_nano: null, budget_period: null, allowed_models: null, allowed_ips: null, expires_at: null, redact_secrets: false });
note('update key limit', upd.status >= 200 && upd.status < 300 && (upd.json as Record<string, unknown> | null)?.rpm_limit === 25, `HTTP ${upd.status}; fields: ${names(upd.json)}${errText(upd)}`);

const nano = BigInt(Math.round(creditUsd * 1e9));
const credit = await call('POST', `/users/${encodeURIComponent(userId)}/credit`, { delta_nano: Number(nano), note: `nibie-cloud live check ${email}` });
const balance = credit.json && typeof credit.json === 'object' ? (credit.json as Record<string, unknown>).balance_nano : undefined;
note('grant credit', credit.status >= 200 && credit.status < 300 && typeof balance === 'number', `HTTP ${credit.status}; fields: ${names(credit.json)}${errText(credit)}; US$1 = ${NANO_PER_USD} nano`);

const hist = await call('GET', `/users/${encodeURIComponent(userId)}/balance-history?limit=200`);
const rows = Array.isArray(hist.json) ? hist.json : ((hist.json as Record<string, unknown> | null)?.history ?? (hist.json as Record<string, unknown> | null)?.items);
const found = Array.isArray(rows) && rows.some((r) => { const o = r as Record<string, unknown>; const want = `nibie-cloud live check ${email}`; return o?.note === want || o?.reference === want; });
note('balance history shows the credit note', hist.status >= 200 && hist.status < 300 && found, `HTTP ${hist.status}; fields: ${names(rows)}`);

const got = await call('GET', `/users/${encodeURIComponent(userId)}`);
const g = got.json as { user?: { balance_nano?: unknown }; stats?: { spend_30d_nano?: unknown }; daily?: unknown; models?: unknown } | null;
note('read user (balance, 30-day spend, daily, models)', got.status >= 200 && got.status < 300 && typeof g?.user?.balance_nano === 'number' && typeof g?.stats?.spend_30d_nano === 'number' && Array.isArray(g?.daily) && Array.isArray(g?.models), `HTTP ${got.status}; fields: ${names(got.json)}${errText(got)}`);

console.log('\nSummary:');
for (const [step, r] of results) console.log(`  ${r.padEnd(6)} ${step}`);
if (results.some(([, r]) => r !== 'OK')) {
  console.log('\nAt least one step failed: send this summary (it holds no secrets) so the client can be adjusted before real use.');
  process.exit(3);
}
