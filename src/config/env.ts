import { z } from 'zod';
import { SVIX_SECRET_PATTERN } from '../modules/billing/svix.js';
import type { DiskQuotaMode, EgressPolicyMode, SupportedRuntime } from '../modules/runtime/types.js';
import type { Kek } from '../modules/secrets/crypto.js';

const DIGEST_PINNED = /^[^\s@]+@sha256:[0-9a-f]{64}$/;

/** An unset variable and an empty one (`VAR=` in a .env file) both mean "not configured". */
const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const splitList = (v: string): string[] => v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);

function parseOrigin(v: string, opts: { httpsOnly: boolean; allowTrailingSlash: boolean }): string | null {
  const raw = opts.allowTrailingSlash ? v.replace(/\/$/, '') : v;
  try {
    const u = new URL(raw);
    if (opts.httpsOnly && u.protocol !== 'https:') return null;
    return u.origin === raw ? raw : null;
  } catch {
    return null;
  }
}

const supabaseUrl = z.preprocess(
  emptyToUndefined,
  z.string().refine((v) => parseOrigin(v, { httpsOnly: true, allowTrailingSlash: true }) !== null).optional(),
);
const dashboardOrigin = z.preprocess(
  emptyToUndefined,
  z.string().refine((v) => parseOrigin(v, { httpsOnly: false, allowTrailingSlash: false }) !== null).optional(),
);

const redisUrl = z.preprocess(
  emptyToUndefined,
  z.string().refine((v) => {
    try {
      const p = new URL(v).protocol;
      return p === 'redis:' || p === 'rediss:';
    } catch {
      return false;
    }
  }).optional(),
);

/** Base64 of exactly 32 bytes. Anything else is rejected without echoing the value. */
const kekB64 = z.preprocess(
  emptyToUndefined,
  z.string().refine((v) => /^[A-Za-z0-9+/]+={0,2}$/.test(v) && Buffer.from(v, 'base64').length === 32).optional(),
);
const kekVersion = z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(1_000_000).optional());

const optionalText = z.preprocess(emptyToUndefined, z.string().optional());
const mailAddress = z.preprocess(emptyToUndefined, z.string().regex(/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/).optional());

const ipv4 = z.ipv4();
const dnsResolvers = z.preprocess(emptyToUndefined, z.string().optional());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  HERMES_IMAGE: z.string().min(1),
  ADMIN_TOKEN: z.string().min(24),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DOCKER_SOCKET_PATH: z.string().default('/var/run/docker.sock'),
  HERMES_MASTER_KEY: z.string().min(32),
  HERMES_RUNTIME: z.enum(['runc', 'runsc']).default('runc'),
  HERMES_DISK_QUOTA: z.enum(['enforce', 'off']).default('enforce'),
  HERMES_DISK_CHECK_INTERVAL_MS: z.coerce.number().int().min(1000).default(300_000),
  HERMES_EGRESS_POLICY: z.enum(['enforce', 'off']).default('enforce'),
  /** Also seeds the tenant resolv.conf volume under runsc (see HERMES_DNS_RESOLVERS, dns-resolv-conf.ts). */
  HERMES_CANARY_IMAGE: z.preprocess(emptyToUndefined, z.string().optional()),
  HERMES_CANARY_PRIVATE_IP: z.preprocess(emptyToUndefined, z.ipv4().optional()),
  /**
   * Space- or comma-separated IPv4 DNS resolvers for every tenant container. Under `runsc` they are
   * written into a dedicated Docker volume (`dns-resolv-conf.ts`) that is bind-mounted over the
   * container's own `/etc/resolv.conf`: Docker's embedded resolver, which otherwise owns that file on
   * a user-defined network, is not reachable from inside a gVisor sandbox, and `Dns` alone (below)
   * only changes what that embedded resolver forwards to, not what the container itself queries
   * (verified on a real runsc host, 2026-11-14). Under `runc` they are only given directly as Docker
   * `Dns`, which keeps today's behaviour (the embedded resolver) when unset. Required when
   * `HERMES_RUNTIME` is `runsc`; optional under `runc`. A resolver on a private address also needs a
   * matching entry in `ops/egress/egress.conf`'s `RESOLVERS`, or the host ruleset blocks it.
   */
  HERMES_DNS_RESOLVERS: dnsResolvers,
  /** `https://<project-ref>.supabase.co`. Unset disables the customer API. */
  SUPABASE_URL: supabaseUrl,
  /** Exact browser origin of the dashboard (no path). Unset sends no CORS headers. */
  DASHBOARD_ORIGIN: dashboardOrigin,
  /**
   * Development only: more exact origins (comma-separated, no path) that get CORS, e.g. the landing page on another local
   * port. Refused when NODE_ENV=production, where the landing and the dashboard share one origin.
   */
  CORS_EXTRA_ORIGINS: z.preprocess(emptyToUndefined, z.string().optional()),
  /** Comma-separated emails allowed to create instances until payments exist. Empty: nobody. */
  BETA_ALLOWED_EMAILS: z.string().optional(),
  /**
   * Comma-separated emails allowed into the admin dashboard (`/api/v1/admin/*`). Empty: nobody
   * (fail closed). Every entry must look like an address, so a typo cannot silently widen the list.
   */
  ADMIN_EMAILS: z.preprocess(
    emptyToUndefined,
    z.string().refine(
      (v) => v.split(',').map((s) => s.trim()).filter((s) => s.length > 0).every((s) => mailAddress.safeParse(s).success),
      'must be comma-separated email addresses',
    ).optional(),
  ),
  /** `redis://[:password@]host:port`. Unset runs operations inline (no queue); required in production. */
  REDIS_URL: redisUrl,
  /** Key-encryption key for stored secrets: base64 of 32 bytes. Never stored in the database. */
  SECRETS_KEK: kekB64,
  SECRETS_KEK_VERSION: kekVersion,
  /** Previous key, kept only while old secrets are rewrapped after a rotation. */
  SECRETS_KEK_PREVIOUS: kekB64,
  SECRETS_KEK_PREVIOUS_VERSION: kekVersion,
  MAX_INSTANCES_PER_TENANT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(1000).default(1)),
  /** Whole-server cap on live instances plus purchases in progress; new purchases and creations are refused at the cap. Unset: no cap. */
  MAX_TOTAL_INSTANCES: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(100000).optional()),
  /** Free beta preview: how many instances on the unpriced plan any signed-in user may take, first come first served. 0: only invited accounts. */
  FREE_BETA_SLOTS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).max(100000).default(0)),
  /**
   * Cloudflare Turnstile secret key for the public waiting-list form (same widget as the dashboard sign-up). When set, a
   * join must carry a valid `captchaToken`. Required in production while the waiting list is on (free slots and email).
   */
  TURNSTILE_SECRET_KEY: z.preprocess(emptyToUndefined, z.string().max(200).optional()),
  /** `false` hides the priced plans and refuses checkout for everyone except invited accounts (a launch switch). Default: open. */
  PAID_CHECKOUT_OPEN: z.preprocess(emptyToUndefined, z.enum(['true', 'false']).default('true')),
  /** `true` opens the customer wallet (top-up saldo) routes and the admin adjustment. Default: off (routes 404). */
  WALLET_ENABLED: z.preprocess(emptyToUndefined, z.enum(['true', 'false']).default('false')),
  /** `true` lets the billing tick renew subscriptions from the wallet (with WALLET_ENABLED). Default: off. */
  WALLET_AUTO_RENEW: z.preprocess(emptyToUndefined, z.enum(['true', 'false']).default('false')),
  /** Outbound email over SumoPod SMTP. All unset: the backend sends no email. Set together or not at all. */
  SUMOPOD_SMTP_HOST: optionalText,
  SUMOPOD_SMTP_PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(65535).optional()),
  SUMOPOD_SMTP_USER: optionalText,
  SUMOPOD_SMTP_PASS: optionalText,
  /** Bare sender address on the domain verified with the SMTP provider. */
  MAIL_FROM: mailAddress,
  /** SumoPod Managed Payment (QRIS), the only payment gateway. All of API key, webhook token and callback URL, or none (billing off). */
  SUMOPOD_API_KEY: optionalText,
  SUMOPOD_WEBHOOK_TOKEN: optionalText,
  /**
   * The webhook's Svix "Signing Secret" (`whsec_...`). When set, every webhook must carry a valid Svix signature over its
   * body and timestamp, and the token is no longer accepted on its own. Required in production when SumoPod is configured.
   */
  SUMOPOD_WEBHOOK_SECRET: z.preprocess(emptyToUndefined, z.string().regex(SVIX_SECRET_PATTERN).optional()),
  SUMOPOD_ENV: z.preprocess(emptyToUndefined, z.enum(['sandbox', 'production']).default('sandbox')),
  SUMOPOD_CALLBACK_URL: z.preprocess(
    emptyToUndefined,
    z.string().max(255).refine((v) => {
      try {
        return new URL(v).protocol === 'https:';
      } catch {
        return false;
      }
    }).optional(),
  ),
  /** NibieRouter provisioning (a SumoRouter instance). Admin key and default model together, or none (credit and key provisioning off). */
  NIBIEROUTER_ADMIN_KEY: optionalText,
  NIBIEROUTER_DEFAULT_MODEL: optionalText,
  /** Admin API origin, not the `/v1` inference URL. */
  NIBIEROUTER_API_URL: z.preprocess(
    emptyToUndefined,
    z.string().max(255).refine((v) => {
      try {
        const u = new URL(v);
        return u.protocol === 'https:' && u.pathname === '/' && u.search === '';
      } catch {
        return false;
      }
    }, 'must be an https origin such as https://router.nibie.app').default('https://router.nibie.app'),
  ),
  /** Domain of the synthetic address each tenant's NibieRouter user gets (the customer never signs in there). */
  NIBIEROUTER_USER_EMAIL_DOMAIN: z.preprocess(emptyToUndefined, z.string().max(100).regex(/^[a-z0-9.-]+\.[a-z]{2,}$/).default('cloud.nibie.app')),
  /** Operator alerts to one Telegram chat (bot token and chat id together, or none: alerts are recorded but not delivered). */
  OPS_TELEGRAM_BOT_TOKEN: z.preprocess(emptyToUndefined, z.string().regex(/^\d{6,}:[A-Za-z0-9_-]{30,}$/).optional()),
  OPS_TELEGRAM_CHAT_ID: z.preprocess(emptyToUndefined, z.string().regex(/^-?\d{1,20}$/).optional()),
}).superRefine((e, ctx) => {
  // A half-filled alert channel would only fail when the first alert is due.
  if ((e.OPS_TELEGRAM_BOT_TOKEN === undefined) !== (e.OPS_TELEGRAM_CHAT_ID === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['OPS_TELEGRAM_BOT_TOKEN'], message: 'OPS_TELEGRAM_BOT_TOKEN and OPS_TELEGRAM_CHAT_ID are set together or not at all' });
  }
  // A half-filled router block would only fail when the first paid instance is created.
  if ((e.NIBIEROUTER_ADMIN_KEY === undefined) !== (e.NIBIEROUTER_DEFAULT_MODEL === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['NIBIEROUTER_ADMIN_KEY'], message: 'NIBIEROUTER_ADMIN_KEY and NIBIEROUTER_DEFAULT_MODEL are set together or not at all' });
  }
  // Without enforcement a tenant can fill the node's disk, so it is never allowed in production.
  if (e.NODE_ENV === 'production' && e.HERMES_DISK_QUOTA === 'off') {
    ctx.addIssue({ code: 'custom', path: ['HERMES_DISK_QUOTA'], message: 'must be enforce in production' });
  }
  // Without the host ruleset a tenant can reach the host, cloud metadata and private networks.
  if (e.NODE_ENV === 'production' && e.HERMES_EGRESS_POLICY === 'off') {
    ctx.addIssue({ code: 'custom', path: ['HERMES_EGRESS_POLICY'], message: 'must be enforce in production' });
  }
  // Tenants run code of their own choosing; in production that code runs in the gVisor sandbox, never directly on the host kernel.
  if (e.NODE_ENV === 'production' && e.HERMES_RUNTIME !== 'runsc') {
    ctx.addIssue({ code: 'custom', path: ['HERMES_RUNTIME'], message: 'must be runsc in production' });
  }
  // Without the queue a request runs the whole operation inline and a crash loses it.
  if (e.NODE_ENV === 'production' && !e.REDIS_URL) {
    ctx.addIssue({ code: 'custom', path: ['REDIS_URL'], message: 'required in production' });
  }
  // Without the key nothing can be encrypted, and a stored secret could never be opened again.
  if (e.NODE_ENV === 'production' && !e.SECRETS_KEK) {
    ctx.addIssue({ code: 'custom', path: ['SECRETS_KEK'], message: 'required in production' });
  }
  if (e.SECRETS_KEK_PREVIOUS && !e.SECRETS_KEK) {
    ctx.addIssue({ code: 'custom', path: ['SECRETS_KEK_PREVIOUS'], message: 'needs SECRETS_KEK' });
  }
  if (e.SECRETS_KEK_PREVIOUS && (e.SECRETS_KEK_PREVIOUS_VERSION === undefined || e.SECRETS_KEK_PREVIOUS_VERSION === (e.SECRETS_KEK_VERSION ?? 1))) {
    ctx.addIssue({ code: 'custom', path: ['SECRETS_KEK_PREVIOUS_VERSION'], message: 'required and must differ from SECRETS_KEK_VERSION' });
  }
  if (e.CORS_EXTRA_ORIGINS !== undefined) {
    if (e.NODE_ENV === 'production') {
      ctx.addIssue({ code: 'custom', path: ['CORS_EXTRA_ORIGINS'], message: 'is for development only and must be unset in production' });
    } else if (splitList(e.CORS_EXTRA_ORIGINS).some((o) => parseOrigin(o, { httpsOnly: false, allowTrailingSlash: false }) === null)) {
      ctx.addIssue({ code: 'custom', path: ['CORS_EXTRA_ORIGINS'], message: 'must be comma-separated origins without a path' });
    }
  }
  // A half-filled mail block would only fail later, when the first email is sent.
  const mailKeys = ['SUMOPOD_SMTP_HOST', 'SUMOPOD_SMTP_PORT', 'SUMOPOD_SMTP_USER', 'SUMOPOD_SMTP_PASS', 'MAIL_FROM'] as const;
  if (mailKeys.some((k) => e[k] !== undefined)) {
    for (const k of mailKeys) {
      if (e[k] === undefined) ctx.addIssue({ code: 'custom', path: [k], message: 'required when any mail variable is set' });
    }
  }
  // A half-filled SumoPod block would only fail when the first customer pays.
  const sumopodKeys = ['SUMOPOD_API_KEY', 'SUMOPOD_WEBHOOK_TOKEN', 'SUMOPOD_CALLBACK_URL'] as const;
  if (sumopodKeys.some((k) => e[k] !== undefined)) {
    for (const k of sumopodKeys) {
      if (e[k] === undefined) ctx.addIssue({ code: 'custom', path: [k], message: 'required when any SumoPod variable is set' });
    }
  }
  // The invoice's return URL points back at the dashboard.
  if (e.SUMOPOD_API_KEY !== undefined && e.DASHBOARD_ORIGIN === undefined) {
    ctx.addIssue({ code: 'custom', path: ['DASHBOARD_ORIGIN'], message: 'required when SumoPod billing is configured' });
  }
  // Real money only from a production backend: a dev or test process must not talk to the live API.
  if (e.SUMOPOD_ENV === 'production' && e.NODE_ENV !== 'production') {
    ctx.addIssue({ code: 'custom', path: ['SUMOPOD_ENV'], message: 'production requires NODE_ENV=production' });
  }
  // The waiting list mails any address typed into a public form; in production a person must have solved the captcha.
  if (e.NODE_ENV === 'production' && e.FREE_BETA_SLOTS > 0 && e.SUMOPOD_SMTP_HOST !== undefined && e.TURNSTILE_SECRET_KEY === undefined) {
    ctx.addIssue({ code: 'custom', path: ['TURNSTILE_SECRET_KEY'], message: 'required in production while the waiting list is on' });
  }
  // A static token can be replayed by anyone who ever saw one webhook; a production backend takes signed webhooks only.
  if (e.NODE_ENV === 'production' && e.SUMOPOD_API_KEY !== undefined && e.SUMOPOD_WEBHOOK_SECRET === undefined) {
    ctx.addIssue({ code: 'custom', path: ['SUMOPOD_WEBHOOK_SECRET'], message: 'required in production when SumoPod is configured' });
  }
  // The startup canary needs an image pinned by digest, like every other image. Under runsc the
  // same image also seeds the tenant resolv.conf volume (see dns-resolv-conf.ts), so it is required
  // there too, even if egress enforcement is off.
  if (
    (e.HERMES_EGRESS_POLICY === 'enforce' || e.HERMES_RUNTIME === 'runsc')
    && (!e.HERMES_CANARY_IMAGE || !DIGEST_PINNED.test(e.HERMES_CANARY_IMAGE))
  ) {
    ctx.addIssue({ code: 'custom', path: ['HERMES_CANARY_IMAGE'], message: 'must be name@sha256:<digest> when egress policy is enforce or runtime is runsc' });
  }
  // Under runsc a tenant container cannot use Docker's embedded resolver at all, so it needs an
  // explicit one; under runc leaving it unset keeps the embedded resolver (today's behaviour).
  const dnsList = (e.HERMES_DNS_RESOLVERS ?? '').split(/[,\s]+/).map((s) => s.trim()).filter((s) => s.length > 0);
  if (e.HERMES_RUNTIME === 'runsc' && dnsList.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['HERMES_DNS_RESOLVERS'], message: 'required (space or comma separated IPv4 addresses) when HERMES_RUNTIME is runsc' });
  }
  if (dnsList.some((ip) => !ipv4.safeParse(ip).success)) {
    ctx.addIssue({ code: 'custom', path: ['HERMES_DNS_RESOLVERS'], message: 'must be space or comma separated IPv4 addresses' });
  }
});

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  databaseUrl: string;
  hermesImage: string;
  port: number;
  adminToken: string;
  dockerSocketPath: string;
  masterKey: string;
  runtime: SupportedRuntime;
  diskQuota: DiskQuotaMode;
  diskCheckIntervalMs: number;
  egressPolicy: EgressPolicyMode;
  canaryImage: string | undefined;
  canaryPrivateIp: string | undefined;
  /** Empty when unset: tenant containers keep Docker's embedded resolver (see `HERMES_DNS_RESOLVERS`). */
  dnsResolvers: string[];
  /** Origin without a trailing slash, or null when the customer API is disabled. */
  supabaseUrl: string | null;
  dashboardOrigin: string | null;
  /** Development only (never set in production): more origins that get CORS. Absent or empty: none. */
  corsExtraOrigins?: string[];
  /** Lowercased, trimmed. Empty means nobody may provision (fail closed). */
  betaAllowedEmails: string[];
  /** Lowercased, trimmed. Empty means nobody may use the admin API (fail closed). */
  adminEmails: string[];
  maxInstancesPerTenant: number;
  /** Null: no whole-server cap. */
  maxTotalInstances: number | null;
  /** Free beta preview slots on the unpriced plan (0: invited accounts only). */
  freeBetaSlots: number;
  /** False: priced plans and checkout are for invited accounts only. */
  paidCheckoutOpen: boolean;
  /** True: customer wallet routes and admin wallet adjustment exist. Absent or false: off. */
  walletEnabled?: boolean;
  /** True: the billing tick renews from the wallet (only together with `walletEnabled`). */
  walletAutoRenew?: boolean;
  /** Turnstile secret for the waiting-list form, or null/absent (no captcha check). A secret: never log it. */
  turnstileSecret?: string | null;
  /** Operator alerting. Absent or `telegram: null`: alerts are recorded but not delivered. `botToken` is a secret: never log it. */
  ops?: { telegram: { botToken: string; chatId: string } | null };
  /** Null: no job queue, operations run inline in the request. */
  redisUrl: string | null;
  /** Null: secret routes answer 503 `secrets_unavailable`. */
  secrets: { current: Kek; previous: Kek | null } | null;
  /** Null: outbound email is not configured. `pass` is a secret: never log it. */
  mail: { host: string; port: number; user: string; pass: string; from: string } | null;
  /** Null: billing is off (checkout and callbacks answer 404). */
    billing: {
      /** SumoPod config. `apiKey` and `webhookToken` are secrets: never log them. */
      /** `webhookSecret` (Svix signing secret) is null when unset: then the token alone authenticates webhooks. */
      sumopod: { apiKey: string; webhookToken: string; webhookSecret?: string | null; env: 'sandbox' | 'production'; callbackUrl: string };
    } | null;
  /** Null: NibieRouter key and credit provisioning is off. `adminKey` is a secret: never log it. */
  router: { apiUrl: string; adminKey: string; defaultModel: string; emailDomain: string } | null;
}

/** Parse environment. Errors name the failing keys only, never the values. */
export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const keys = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', ');
    throw new Error(`Invalid configuration: ${keys}`);
  }
  const e = parsed.data;
  return {
    nodeEnv: e.NODE_ENV,
    databaseUrl: e.DATABASE_URL,
    hermesImage: e.HERMES_IMAGE,
    port: e.PORT,
    adminToken: e.ADMIN_TOKEN,
    dockerSocketPath: e.DOCKER_SOCKET_PATH,
    masterKey: e.HERMES_MASTER_KEY,
    runtime: e.HERMES_RUNTIME,
    diskQuota: e.HERMES_DISK_QUOTA,
    diskCheckIntervalMs: e.HERMES_DISK_CHECK_INTERVAL_MS,
    egressPolicy: e.HERMES_EGRESS_POLICY,
    canaryImage: e.HERMES_CANARY_IMAGE,
    canaryPrivateIp: e.HERMES_CANARY_PRIVATE_IP,
    dnsResolvers: (e.HERMES_DNS_RESOLVERS ?? '').split(/[,\s]+/).map((s) => s.trim()).filter((s) => s.length > 0),
    supabaseUrl: e.SUPABASE_URL ? e.SUPABASE_URL.replace(/\/$/, '') : null,
    dashboardOrigin: e.DASHBOARD_ORIGIN ?? null,
    corsExtraOrigins: e.CORS_EXTRA_ORIGINS ? splitList(e.CORS_EXTRA_ORIGINS) : [],
    betaAllowedEmails: (e.BETA_ALLOWED_EMAILS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
    adminEmails: (e.ADMIN_EMAILS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
    maxInstancesPerTenant: e.MAX_INSTANCES_PER_TENANT,
    maxTotalInstances: e.MAX_TOTAL_INSTANCES ?? null,
    freeBetaSlots: e.FREE_BETA_SLOTS,
    paidCheckoutOpen: e.PAID_CHECKOUT_OPEN === 'true',
    walletEnabled: e.WALLET_ENABLED === 'true',
    walletAutoRenew: e.WALLET_AUTO_RENEW === 'true',
    turnstileSecret: e.TURNSTILE_SECRET_KEY ?? null,
    ops: { telegram: e.OPS_TELEGRAM_BOT_TOKEN && e.OPS_TELEGRAM_CHAT_ID ? { botToken: e.OPS_TELEGRAM_BOT_TOKEN, chatId: e.OPS_TELEGRAM_CHAT_ID } : null },
    redisUrl: e.REDIS_URL ?? null,
    secrets: e.SECRETS_KEK
      ? {
          current: { version: e.SECRETS_KEK_VERSION ?? 1, key: Buffer.from(e.SECRETS_KEK, 'base64') },
          previous: e.SECRETS_KEK_PREVIOUS
            ? { version: e.SECRETS_KEK_PREVIOUS_VERSION ?? 1, key: Buffer.from(e.SECRETS_KEK_PREVIOUS, 'base64') }
            : null,
        }
      : null,
    mail:
      e.SUMOPOD_SMTP_HOST && e.SUMOPOD_SMTP_PORT && e.SUMOPOD_SMTP_USER && e.SUMOPOD_SMTP_PASS && e.MAIL_FROM
        ? { host: e.SUMOPOD_SMTP_HOST, port: e.SUMOPOD_SMTP_PORT, user: e.SUMOPOD_SMTP_USER, pass: e.SUMOPOD_SMTP_PASS, from: e.MAIL_FROM }
        : null,
    billing:
      e.SUMOPOD_API_KEY && e.SUMOPOD_WEBHOOK_TOKEN && e.SUMOPOD_CALLBACK_URL
        ? { sumopod: { apiKey: e.SUMOPOD_API_KEY, webhookToken: e.SUMOPOD_WEBHOOK_TOKEN, webhookSecret: e.SUMOPOD_WEBHOOK_SECRET ?? null, env: e.SUMOPOD_ENV, callbackUrl: e.SUMOPOD_CALLBACK_URL } }
        : null,
    router:
      e.NIBIEROUTER_ADMIN_KEY && e.NIBIEROUTER_DEFAULT_MODEL
        ? { apiUrl: e.NIBIEROUTER_API_URL, adminKey: e.NIBIEROUTER_ADMIN_KEY, defaultModel: e.NIBIEROUTER_DEFAULT_MODEL, emailDomain: e.NIBIEROUTER_USER_EMAIL_DOMAIN }
        : null,
  };
}
