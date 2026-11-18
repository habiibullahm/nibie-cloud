// Dev tool, not backend code: runs the Node `loadConfig` over a fixed set of env cases and writes
//   server/testdata/golden/config-cases.json   (inputs)
//   server/testdata/golden/config.golden.json  (what Node did with each one)
// The Go config must reproduce the golden file (server/internal/config/parity_test.go).
//
//   pnpm tsx server/testdata/golden/gen/config.ts           # write
//   pnpm tsx server/testdata/golden/gen/config.ts --check   # exit 1 if either file would change
//
// Every value is fake. The repository is public.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../../../src/config/env.js';

type Env = Record<string, string>;
const cases: { name: string; env: Env }[] = [];
const add = (name: string, env: Env): void => {
  if (cases.some((c) => c.name === name)) throw new Error(`duplicate case ${name}`);
  cases.push({ name, env });
};
const without = (env: Env, ...keys: string[]): Env => {
  const out = { ...env };
  for (const k of keys) delete out[k];
  return out;
};

const digest = 'a'.repeat(64);
const base: Env = {
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5433/db',
  HERMES_IMAGE: 'hermes-stub:0.1.0',
  ADMIN_TOKEN: 'a'.repeat(24),
  HERMES_MASTER_KEY: 'k'.repeat(32),
  HERMES_CANARY_IMAGE: `alpine@sha256:${digest}`,
};
const key = Buffer.alloc(32, 7).toString('base64');
const key2 = Buffer.alloc(32, 9).toString('base64');
const prodCore: Env = {
  ...base, NODE_ENV: 'production', HERMES_RUNTIME: 'runsc', HERMES_DNS_RESOLVERS: '192.0.2.53',
  REDIS_URL: 'redis://127.0.0.1:6380', SECRETS_KEK: key, HERMES_IMAGE: `h@sha256:${digest}`,
};

// --- test/unit/config.test.ts, describe('loadConfig') ---
for (const k of ['DATABASE_URL', 'HERMES_IMAGE', 'ADMIN_TOKEN', 'HERMES_MASTER_KEY']) add(`missing-${k}`, without(base, k));
add('admin-token-short', { ...base, ADMIN_TOKEN: 'short' });
add('base', base);
add('admin-token-secret-not-echoed', { ...base, ADMIN_TOKEN: 'tooshort-secret' });
add('master-key-31', { ...base, HERMES_MASTER_KEY: 'k'.repeat(31) });
add('master-key-32', { ...base, HERMES_MASTER_KEY: 'k'.repeat(32) });
add('master-key-not-echoed', { ...base, HERMES_MASTER_KEY: 'short-master-secret' });
add('runtime-runsc-with-dns', { ...base, HERMES_RUNTIME: 'runsc', HERMES_DNS_RESOLVERS: '192.0.2.53' });
add('runtime-unknown', { ...base, HERMES_RUNTIME: 'kata' });
add('disk-quota-off-production', { ...base, NODE_ENV: 'production', HERMES_DISK_QUOTA: 'off' });
add('disk-quota-off-development', { ...base, HERMES_DISK_QUOTA: 'off' });
add('disk-quota-off-test', { ...base, NODE_ENV: 'test', HERMES_DISK_QUOTA: 'off' });
add('disk-quota-unknown', { ...base, HERMES_DISK_QUOTA: 'soft' });
add('disk-interval-60000', { ...base, HERMES_DISK_CHECK_INTERVAL_MS: '60000' });
add('disk-interval-fraction', { ...base, HERMES_DISK_CHECK_INTERVAL_MS: '1.5' });
add('disk-interval-below-min', { ...base, HERMES_DISK_CHECK_INTERVAL_MS: '999' });
add('egress-off-production', { ...base, NODE_ENV: 'production', HERMES_EGRESS_POLICY: 'off' });
add('production-default-runtime', { ...base, NODE_ENV: 'production' });
add('production-runtime-runc', { ...base, NODE_ENV: 'production', HERMES_RUNTIME: 'runc' });
add('production-runtime-runsc', { ...base, NODE_ENV: 'production', HERMES_RUNTIME: 'runsc', HERMES_DNS_RESOLVERS: '192.0.2.53' });
add('egress-unknown', { ...base, HERMES_EGRESS_POLICY: 'soft' });
add('egress-off-no-canary', without({ ...base, HERMES_EGRESS_POLICY: 'off' }, 'HERMES_CANARY_IMAGE'));
add('enforce-no-canary', without(base, 'HERMES_CANARY_IMAGE'));
add('runsc-egress-off-no-canary', without({ ...base, HERMES_EGRESS_POLICY: 'off', HERMES_RUNTIME: 'runsc', HERMES_DNS_RESOLVERS: '192.0.2.53' }, 'HERMES_CANARY_IMAGE'));
add('runsc-egress-off-canary', { ...base, HERMES_EGRESS_POLICY: 'off', HERMES_RUNTIME: 'runsc', HERMES_DNS_RESOLVERS: '192.0.2.53' });
add('canary-tag-only', { ...base, HERMES_CANARY_IMAGE: 'alpine:3.20' });
add('canary-short-digest', { ...base, HERMES_CANARY_IMAGE: 'alpine@sha256:abc' });
add('canary-uppercase-digest', { ...base, HERMES_CANARY_IMAGE: `alpine@sha256:${'A'.repeat(64)}` });
add('canary-not-echoed', { ...base, HERMES_CANARY_IMAGE: 'registry.example/secret-canary:latest' });
add('canary-private-ip', { ...base, HERMES_CANARY_PRIVATE_IP: '192.0.2.10' });
add('canary-private-ip-empty', { ...base, HERMES_CANARY_PRIVATE_IP: '' });
for (const [i, bad] of ['not-an-ip', '2001:db8::1', '300.1.1.1', '10.0.0', '01.2.3.4', ' 192.0.2.10'].entries()) {
  add(`canary-private-ip-bad-${i}`, { ...base, HERMES_CANARY_PRIVATE_IP: bad });
}
add('dns-space', { ...base, HERMES_DNS_RESOLVERS: '192.0.2.1 198.51.100.1' });
add('dns-comma-space', { ...base, HERMES_DNS_RESOLVERS: '192.0.2.1, 198.51.100.1' });
add('dns-mixed', { ...base, HERMES_DNS_RESOLVERS: ' 192.0.2.1,, 192.0.2.2  198.51.100.1 ' });
add('dns-not-ip', { ...base, HERMES_DNS_RESOLVERS: '192.0.2.1 not-an-ip' });
add('dns-ipv6', { ...base, HERMES_DNS_RESOLVERS: '2001:db8::1' });
add('dns-leading-zero', { ...base, HERMES_DNS_RESOLVERS: '192.0.2.01' });
add('runsc-without-dns', { ...base, HERMES_RUNTIME: 'runsc' });
add('runsc-blank-dns', { ...base, HERMES_RUNTIME: 'runsc', HERMES_DNS_RESOLVERS: ' , ' });

// --- PORT and other numbers (JavaScript Number() semantics) ---
for (const [n, v] of Object.entries({ space: ' 3000', hex: '0x10', exp: '1e3', fraction: '3000.5', empty: '', plus: '+80', zero: '0', big: '65536', word: 'abc', octal: '0o17', bin: '0b11', tab: '\t81\n' })) {
  add(`port-${n}`, { ...base, PORT: v });
}
add('node-env-unknown', { ...base, NODE_ENV: 'staging' });
add('node-env-empty', { ...base, NODE_ENV: '' });
add('socket-path', { ...base, DOCKER_SOCKET_PATH: '/run/docker.sock' });

// --- describe('loadConfig: customer API settings') ---
add('supabase-trailing-slash', { ...base, SUPABASE_URL: 'https://abcd.supabase.co/' });
for (const [n, v] of Object.entries({
  http: 'http://abcd.supabase.co', 'not-url': 'not a url', path: 'https://abcd.supabase.co/auth/v1', upper: 'https://ABCD.supabase.co',
  'default-port': 'https://abcd.supabase.co:443', 'other-port': 'https://abcd.supabase.co:8443', userinfo: 'https://user@abcd.supabase.co',
  query: 'https://abcd.supabase.co?x=1', 'two-slashes': 'https://abcd.supabase.co//', empty: '',
})) add(`supabase-${n}`, { ...base, SUPABASE_URL: v });
add('supabase-not-echoed', { ...base, SUPABASE_URL: 'http://secret-project-ref.example' });
add('cors-extra-list', { ...base, CORS_EXTRA_ORIGINS: ' http://localhost:3300 , http://127.0.0.1:3300 ' });
add('cors-extra-path', { ...base, CORS_EXTRA_ORIGINS: 'http://localhost:3300/landing' });
add('cors-extra-production', { ...base, NODE_ENV: 'production', CORS_EXTRA_ORIGINS: 'http://localhost:3300' });
add('cors-extra-empty-items', { ...base, CORS_EXTRA_ORIGINS: ',http://localhost:3300,' });
for (const [n, v] of Object.entries({
  bare: 'https://cloud.example.test', path: 'https://cloud.example.test/dashboard', 'trailing-slash': 'https://cloud.example.test/',
  query: 'https://cloud.example.test?q', fragment: 'https://cloud.example.test#f', http: 'http://localhost:3100', upper: 'https://Cloud.example.test',
  'default-port': 'http://localhost:80', ftp: 'ftp://cloud.example.test',
})) add(`dashboard-origin-${n}`, { ...base, DASHBOARD_ORIGIN: v });
add('beta-emails', { ...base, BETA_ALLOWED_EMAILS: ' A@x.example, b@x.example ,' });
add('beta-emails-empty', { ...base, BETA_ALLOWED_EMAILS: '' });
for (const [n, v] of Object.entries({ three: '3', zero: '0', word: 'abc', empty: '', max: '1000', over: '1001' })) {
  add(`max-instances-${n}`, { ...base, MAX_INSTANCES_PER_TENANT: v });
}
for (const [n, v] of Object.entries({ set: '50', zero: '0', empty: '' })) add(`max-total-${n}`, { ...base, MAX_TOTAL_INSTANCES: v });
for (const [n, v] of Object.entries({ ten: '10', negative: '-1', empty: '' })) add(`free-beta-${n}`, { ...base, FREE_BETA_SLOTS: v });
for (const [n, v] of Object.entries({ false: 'false', true: 'true', yes: 'yes', empty: '' })) add(`paid-checkout-${n}`, { ...base, PAID_CHECKOUT_OPEN: v });

// --- describe('loadConfig: admin dashboard settings') ---
add('admin-emails-empty', { ...base, ADMIN_EMAILS: '' });
add('admin-emails-blank-items', { ...base, ADMIN_EMAILS: ' , ' });
add('admin-emails', { ...base, ADMIN_EMAILS: ' Boss@Example.Test , ops@example.test ' });
add('admin-emails-trailing-comma', { ...base, ADMIN_EMAILS: ' A@Example.test ,b@example.test,' });
add('admin-emails-malformed', { ...base, ADMIN_EMAILS: 'not-an-email' });
add('admin-emails-one-bad', { ...base, ADMIN_EMAILS: 'a@example.test, b@example' });

// --- describe('loadConfig: Redis') (ignored by Go; see the parity test) ---
add('redis-empty', { ...base, REDIS_URL: '' });
add('redis-url', { ...base, REDIS_URL: 'redis://:pw@127.0.0.1:6379' });
add('rediss-url', { ...base, REDIS_URL: 'rediss://:pw@cache.example.test:6380' });
add('redis-url-not-redis', { ...base, REDIS_URL: 'http://:topsecretpw@127.0.0.1:6379' });
add('production-without-redis', without(prodCore, 'REDIS_URL'));
add('production-core', prodCore);

// --- describe('loadConfig secrets key') ---
add('kek', { ...base, SECRETS_KEK: key });
add('kek-unpadded', { ...base, SECRETS_KEK: key.replace(/=+$/, '') });
add('kek-rotation', { ...base, SECRETS_KEK: key2, SECRETS_KEK_VERSION: '2', SECRETS_KEK_PREVIOUS: key, SECRETS_KEK_PREVIOUS_VERSION: '1' });
add('kek-16-bytes', { ...base, SECRETS_KEK: Buffer.alloc(16, 1).toString('base64') });
add('kek-31-bytes', { ...base, SECRETS_KEK: Buffer.alloc(31, 1).toString('base64') });
add('kek-33-bytes', { ...base, SECRETS_KEK: Buffer.alloc(33, 1).toString('base64') });
add('kek-urlsafe', { ...base, SECRETS_KEK: Buffer.alloc(32, 251).toString('base64url') });
add('kek-same-version', { ...base, SECRETS_KEK: key2, SECRETS_KEK_PREVIOUS: key });
add('kek-previous-without-current', { ...base, SECRETS_KEK_PREVIOUS: key });
add('kek-version-zero', { ...base, SECRETS_KEK: key, SECRETS_KEK_VERSION: '0' });
add('kek-production-missing', { ...base, NODE_ENV: 'production', REDIS_URL: 'redis://127.0.0.1:6379', HERMES_IMAGE: `h@sha256:${digest}` });

// --- describe('loadConfig: outbound mail (SumoPod SMTP)') ---
const mail: Env = { SUMOPOD_SMTP_HOST: 'smtp.example.test', SUMOPOD_SMTP_PORT: '465', SUMOPOD_SMTP_USER: 'user', SUMOPOD_SMTP_PASS: 'smtp-pass-value', MAIL_FROM: 'no-reply@example.test' };
add('mail-empty-values', { ...base, SUMOPOD_SMTP_HOST: '', SUMOPOD_SMTP_PASS: '', MAIL_FROM: '' });
add('mail', { ...base, ...mail });
for (const k of Object.keys(mail)) add(`mail-without-${k}`, without({ ...base, ...mail }, k));
add('mail-bad-port', { ...base, ...mail, SUMOPOD_SMTP_PORT: '70000' });
add('mail-bad-from', { ...base, ...mail, MAIL_FROM: 'not-an-address' });
add('mail-from-display-name', { ...base, ...mail, MAIL_FROM: 'Nibie <no-reply@example.test>' });

// --- describe('Duitku billing configuration') ---
const duitku: Env = {
  BILLING_GATEWAY: 'duitku', DUITKU_MERCHANT_CODE: 'DS00000', DUITKU_API_KEY: 'duitku-api-key-value',
  DUITKU_CALLBACK_URL: 'https://api.example.test/api/v1/billing/duitku/callback', DASHBOARD_ORIGIN: 'https://cloud.example.test',
};
add('duitku-without-dashboard', without({ ...base, ...duitku }, 'DASHBOARD_ORIGIN'));
add('duitku-empty-values', { ...base, DUITKU_MERCHANT_CODE: '', DUITKU_API_KEY: '', DUITKU_CALLBACK_URL: '' });
add('duitku', { ...base, ...duitku });
for (const k of ['DUITKU_MERCHANT_CODE', 'DUITKU_API_KEY', 'DUITKU_CALLBACK_URL']) add(`duitku-without-${k}`, without({ ...base, ...duitku }, k));
add('duitku-env-unknown', { ...base, ...duitku, DUITKU_ENV: 'staging' });
add('duitku-callback-http', { ...base, ...duitku, DUITKU_CALLBACK_URL: 'http://api.example.test/cb' });
add('duitku-callback-long', { ...base, ...duitku, DUITKU_CALLBACK_URL: `https://api.example.test/${'c'.repeat(240)}` });
add('duitku-env-production-dev', { ...base, ...duitku, DUITKU_ENV: 'production' });
add('duitku-gateway-sumopod-default', without({ ...base, ...duitku }, 'BILLING_GATEWAY'));

// --- describe('SumoPod webhook signing secret') and gateway consistency ---
const sumopod: Env = { SUMOPOD_API_KEY: 'sk_test_value', SUMOPOD_WEBHOOK_TOKEN: 'whtok_test_value', SUMOPOD_CALLBACK_URL: 'https://api.example.test/api/v1/billing/sumopod/webhook' };
const whsec = `whsec_${Buffer.alloc(24, 5).toString('base64')}`;
add('sumopod', { ...base, ...sumopod });
add('sumopod-secret', { ...base, ...sumopod, SUMOPOD_WEBHOOK_SECRET: whsec });
add('sumopod-production-no-secret', { ...prodCore, ...sumopod });
add('sumopod-production-secret', { ...prodCore, ...sumopod, SUMOPOD_WEBHOOK_SECRET: whsec });
add('sumopod-secret-bad', { ...base, ...sumopod, SUMOPOD_WEBHOOK_SECRET: 'whtok_not_a_secret' });
for (const k of Object.keys(sumopod)) add(`sumopod-without-${k}`, without({ ...base, ...sumopod }, k));
add('sumopod-env-production-dev', { ...base, ...sumopod, SUMOPOD_ENV: 'production' });
add('gateway-both', { ...base, ...duitku, ...sumopod, BILLING_GATEWAY: 'both' });
add('gateway-both-missing-sumopod', { ...base, ...duitku, BILLING_GATEWAY: 'both' });
add('gateway-sumopod-only-duitku', { ...base, ...duitku, BILLING_GATEWAY: 'sumopod' });
add('gateway-duitku-only-sumopod', { ...base, ...sumopod, BILLING_GATEWAY: 'duitku' });
add('gateway-unknown', { ...base, ...sumopod, BILLING_GATEWAY: 'stripe' });
add('gateway-token-only', { ...base, SUMOPOD_WEBHOOK_TOKEN: 'whtok_test_value' });

// --- describe('waiting-list captcha (Turnstile)') ---
const mail2: Env = { SUMOPOD_SMTP_HOST: 'smtp.example.test', SUMOPOD_SMTP_PORT: '465', SUMOPOD_SMTP_USER: 'u', SUMOPOD_SMTP_PASS: 'p', MAIL_FROM: 'no-reply@example.test' };
add('turnstile-production-missing', { ...prodCore, ...mail2, FREE_BETA_SLOTS: '10' });
add('turnstile-production-set', { ...prodCore, ...mail2, FREE_BETA_SLOTS: '10', TURNSTILE_SECRET_KEY: 'ts-secret' });
add('turnstile-production-no-slots', { ...prodCore, ...mail2, FREE_BETA_SLOTS: '0' });
add('turnstile-development', { ...base, ...mail2, FREE_BETA_SLOTS: '10' });
add('turnstile-too-long', { ...base, TURNSTILE_SECRET_KEY: 't'.repeat(201) });

// --- describe('loadConfig: NibieRouter') ---
add('router', { ...base, NIBIEROUTER_ADMIN_KEY: 'sk-admin-test-0123456789', NIBIEROUTER_DEFAULT_MODEL: 'some-model' });
add('router-only-key', { ...base, NIBIEROUTER_ADMIN_KEY: 'sk-admin-test-0123456789' });
add('router-only-model', { ...base, NIBIEROUTER_DEFAULT_MODEL: 'some-model' });
for (const [i, u] of ['http://router.example.test', 'https://router.example.test/v1', 'https://router.example.test/?a=1', 'not a url'].entries()) {
  add(`router-url-bad-${i}`, { ...base, NIBIEROUTER_API_URL: u });
}
add('router-url-trailing-slash', { ...base, NIBIEROUTER_API_URL: 'https://router.example.test/', NIBIEROUTER_ADMIN_KEY: 'k', NIBIEROUTER_DEFAULT_MODEL: 'm' });
add('router-url-no-slash', { ...base, NIBIEROUTER_API_URL: 'https://router.example.test', NIBIEROUTER_ADMIN_KEY: 'k', NIBIEROUTER_DEFAULT_MODEL: 'm' });
add('router-url-fragment', { ...base, NIBIEROUTER_API_URL: 'https://router.example.test/#x' });
add('router-email-domain', { ...base, NIBIEROUTER_USER_EMAIL_DOMAIN: 'tenants.example.test', NIBIEROUTER_ADMIN_KEY: 'k', NIBIEROUTER_DEFAULT_MODEL: 'm' });
add('router-email-domain-bad', { ...base, NIBIEROUTER_USER_EMAIL_DOMAIN: 'Example.TEST' });
add('router-key-not-echoed', { ...base, NIBIEROUTER_ADMIN_KEY: 'sk-admin-canary-value-123' });

// --- describe('operator alerting settings') ---
const botToken = '123456:test-bot-token-000000000000000000';
add('ops-telegram', { ...base, OPS_TELEGRAM_BOT_TOKEN: botToken, OPS_TELEGRAM_CHAT_ID: '-1001234567890' });
add('ops-only-token', { ...base, OPS_TELEGRAM_BOT_TOKEN: botToken });
add('ops-only-chat', { ...base, OPS_TELEGRAM_CHAT_ID: '42' });
add('ops-bad-token', { ...base, OPS_TELEGRAM_BOT_TOKEN: 'not-a-token', OPS_TELEGRAM_CHAT_ID: '42' });
add('ops-bad-chat', { ...base, OPS_TELEGRAM_BOT_TOKEN: botToken, OPS_TELEGRAM_CHAT_ID: '12a' });

// --- A fully configured production env (used by the Go no-secrets-in-logs test) ---
add('production-full', {
  ...prodCore, ...mail, ...sumopod, ...duitku, BILLING_GATEWAY: 'both', DUITKU_ENV: 'production', SUMOPOD_ENV: 'production',
  SUMOPOD_WEBHOOK_SECRET: whsec, SUPABASE_URL: 'https://abcd.supabase.co', ADMIN_EMAILS: 'ops@example.test',
  BETA_ALLOWED_EMAILS: 'a@example.test', FREE_BETA_SLOTS: '5', TURNSTILE_SECRET_KEY: 'ts-secret-value',
  SECRETS_KEK: key2, SECRETS_KEK_VERSION: '2', SECRETS_KEK_PREVIOUS: key, SECRETS_KEK_PREVIOUS_VERSION: '1',
  NIBIEROUTER_ADMIN_KEY: 'sk-admin-test-0123456789', NIBIEROUTER_DEFAULT_MODEL: 'some-model',
  OPS_TELEGRAM_BOT_TOKEN: botToken, OPS_TELEGRAM_CHAT_ID: '-1001234567890', MAX_TOTAL_INSTANCES: '40',
  HERMES_CANARY_PRIVATE_IP: '192.0.2.10', PAID_CHECKOUT_OPEN: 'false',
});

// --- Run Node and normalize ---
function normalize(v: unknown): unknown {
  if (Buffer.isBuffer(v)) return v.toString('base64');
  if (Array.isArray(v)) return v.map(normalize);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = normalize(x);
    }
    return out;
  }
  return v;
}

const PREFIX = 'Invalid configuration: ';
const golden: Record<string, unknown> = {};
for (const c of cases) {
  try {
    golden[c.name] = { ok: true, config: normalize(loadConfig(c.env)) };
  } catch (e) {
    const msg = (e as Error).message;
    if (!msg.startsWith(PREFIX)) throw new Error(`case ${c.name}: unexpected error shape`);
    golden[c.name] = { ok: false, keys: [...new Set(msg.slice(PREFIX.length).split(', '))].sort() };
  }
}

const dir = join(dirname(fileURLToPath(import.meta.url)), '..');
const files: [string, string][] = [
  [join(dir, 'config-cases.json'), `${JSON.stringify(cases, null, 2)}\n`],
  [join(dir, 'config.golden.json'), `${JSON.stringify(golden, null, 2)}\n`],
];
if (process.argv.includes('--check')) {
  const stale = files.filter(([p, body]) => {
    try {
      return readFileSync(p, 'utf8') !== body;
    } catch {
      return true;
    }
  });
  for (const [p] of stale) console.error(`stale: ${p}`);
  process.exit(stale.length === 0 ? 0 : 1);
}
for (const [p, body] of files) writeFileSync(p, body);
console.log(`${cases.length} cases written`);
