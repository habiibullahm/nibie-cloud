import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';

const base = {
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5433/db',
  HERMES_IMAGE: 'hermes-stub:0.1.0',
  ADMIN_TOKEN: 'a'.repeat(24),
  HERMES_MASTER_KEY: 'k'.repeat(32),
  HERMES_CANARY_IMAGE: `alpine@sha256:${'a'.repeat(64)}`,
};

describe('loadConfig', () => {
  it.each(['DATABASE_URL', 'HERMES_IMAGE', 'ADMIN_TOKEN', 'HERMES_MASTER_KEY'])('throws when %s is missing', (key) => {
    const env: Record<string, string> = { ...base };
    delete env[key];
    expect(() => loadConfig(env)).toThrow(key);
  });

  it('throws when ADMIN_TOKEN is shorter than 24 chars', () => {
    expect(() => loadConfig({ ...base, ADMIN_TOKEN: 'short' })).toThrow('ADMIN_TOKEN');
  });

  it('defaults port to 3000, nodeEnv to development and socket path', () => {
    const cfg = loadConfig(base);
    expect(cfg.port).toBe(3000);
    expect(cfg.nodeEnv).toBe('development');
    expect(cfg.dockerSocketPath).toBe('/var/run/docker.sock');
  });

  it('does not echo secret values in validation errors', () => {
    let message = '';
    try {
      loadConfig({ ...base, ADMIN_TOKEN: 'tooshort-secret' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain('tooshort-secret');
  });

  it('rejects a 31 character HERMES_MASTER_KEY and accepts 32', () => {
    expect(() => loadConfig({ ...base, HERMES_MASTER_KEY: 'k'.repeat(31) })).toThrow('HERMES_MASTER_KEY');
    expect(loadConfig({ ...base, HERMES_MASTER_KEY: 'k'.repeat(32) }).masterKey).toBe('k'.repeat(32));
  });

  it('does not echo HERMES_MASTER_KEY in errors', () => {
    let message = '';
    try {
      loadConfig({ ...base, HERMES_MASTER_KEY: 'short-master-secret' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('HERMES_MASTER_KEY');
    expect(message).not.toContain('short-master-secret');
  });

  it('defaults HERMES_RUNTIME to runc and accepts runsc (with HERMES_DNS_RESOLVERS set)', () => {
    expect(loadConfig(base).runtime).toBe('runc');
    expect(loadConfig({ ...base, HERMES_RUNTIME: 'runsc', HERMES_DNS_RESOLVERS: '1.1.1.1' }).runtime).toBe('runsc');
  });

  it('rejects an unknown HERMES_RUNTIME', () => {
    expect(() => loadConfig({ ...base, HERMES_RUNTIME: 'kata' })).toThrow('HERMES_RUNTIME');
  });

  it('defaults HERMES_DISK_QUOTA to enforce', () => {
    expect(loadConfig(base).diskQuota).toBe('enforce');
  });

  it('rejects HERMES_DISK_QUOTA=off when NODE_ENV=production without echoing the value', () => {
    let message = '';
    try {
      loadConfig({ ...base, NODE_ENV: 'production', HERMES_DISK_QUOTA: 'off' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('HERMES_DISK_QUOTA');
    expect(message).not.toContain('off');
  });

  it('accepts HERMES_DISK_QUOTA=off outside production', () => {
    expect(loadConfig({ ...base, HERMES_DISK_QUOTA: 'off' }).diskQuota).toBe('off');
    expect(loadConfig({ ...base, NODE_ENV: 'test', HERMES_DISK_QUOTA: 'off' }).diskQuota).toBe('off');
  });

  it('rejects an unknown HERMES_DISK_QUOTA', () => {
    expect(() => loadConfig({ ...base, HERMES_DISK_QUOTA: 'soft' })).toThrow('HERMES_DISK_QUOTA');
  });

  it('defaults HERMES_DISK_CHECK_INTERVAL_MS to 300000 and rejects a non-integer', () => {
    expect(loadConfig(base).diskCheckIntervalMs).toBe(300000);
    expect(loadConfig({ ...base, HERMES_DISK_CHECK_INTERVAL_MS: '60000' }).diskCheckIntervalMs).toBe(60000);
    expect(() => loadConfig({ ...base, HERMES_DISK_CHECK_INTERVAL_MS: '1.5' })).toThrow('HERMES_DISK_CHECK_INTERVAL_MS');
  });

  it('defaults HERMES_EGRESS_POLICY to enforce', () => {
    expect(loadConfig(base).egressPolicy).toBe('enforce');
  });

  it('rejects HERMES_EGRESS_POLICY=off when NODE_ENV=production without echoing the value', () => {
    let message = '';
    try {
      loadConfig({ ...base, NODE_ENV: 'production', HERMES_EGRESS_POLICY: 'off' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('HERMES_EGRESS_POLICY');
    expect(message).not.toContain('off');
  });

  it('requires HERMES_RUNTIME=runsc in production, and keeps runc as the default elsewhere', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow('HERMES_RUNTIME');
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', HERMES_RUNTIME: 'runc' })).toThrow('HERMES_RUNTIME');
    expect(loadConfig(base).runtime).toBe('runc');
    let message = '';
    try {
      loadConfig({ ...base, NODE_ENV: 'production', HERMES_RUNTIME: 'runsc', HERMES_DNS_RESOLVERS: '1.1.1.1' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain('HERMES_RUNTIME');
  });

  it('rejects an unknown HERMES_EGRESS_POLICY', () => {
    expect(() => loadConfig({ ...base, HERMES_EGRESS_POLICY: 'soft' })).toThrow('HERMES_EGRESS_POLICY');
  });

  it('accepts HERMES_EGRESS_POLICY=off outside production without a canary image', () => {
    const env: Record<string, string> = { ...base, HERMES_EGRESS_POLICY: 'off' };
    delete env.HERMES_CANARY_IMAGE;
    const cfg = loadConfig(env);
    expect(cfg.egressPolicy).toBe('off');
    expect(cfg.canaryImage).toBeUndefined();
  });

  it('requires HERMES_CANARY_IMAGE when enforce', () => {
    const env: Record<string, string> = { ...base };
    delete env.HERMES_CANARY_IMAGE;
    expect(() => loadConfig(env)).toThrow('HERMES_CANARY_IMAGE');
  });

  it('requires HERMES_CANARY_IMAGE pinned by digest under runsc even when egress is off', () => {
    const env: Record<string, string> = { ...base, HERMES_EGRESS_POLICY: 'off', HERMES_RUNTIME: 'runsc', HERMES_DNS_RESOLVERS: '1.1.1.1' };
    delete env.HERMES_CANARY_IMAGE;
    expect(() => loadConfig(env)).toThrow('HERMES_CANARY_IMAGE');
    expect(loadConfig({ ...env, HERMES_CANARY_IMAGE: `alpine@sha256:${'a'.repeat(64)}` }).canaryImage).toBe(`alpine@sha256:${'a'.repeat(64)}`);
  });

  it('rejects a tag-only HERMES_CANARY_IMAGE and accepts name@sha256:<64 hex>', () => {
    expect(() => loadConfig({ ...base, HERMES_CANARY_IMAGE: 'alpine:3.20' })).toThrow('HERMES_CANARY_IMAGE');
    expect(() => loadConfig({ ...base, HERMES_CANARY_IMAGE: 'alpine@sha256:abc' })).toThrow('HERMES_CANARY_IMAGE');
    expect(loadConfig(base).canaryImage).toBe(`alpine@sha256:${'a'.repeat(64)}`);
  });

  it('does not echo HERMES_CANARY_IMAGE in errors', () => {
    let message = '';
    try {
      loadConfig({ ...base, HERMES_CANARY_IMAGE: 'registry.example/secret-canary:latest' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain('secret-canary');
  });

  it('accepts an IPv4 HERMES_CANARY_PRIVATE_IP, treats empty as unset, and rejects anything else', () => {
    expect(loadConfig({ ...base, HERMES_CANARY_PRIVATE_IP: '192.0.2.10' }).canaryPrivateIp).toBe('192.0.2.10');
    expect(loadConfig({ ...base, HERMES_CANARY_PRIVATE_IP: '' }).canaryPrivateIp).toBeUndefined();
    expect(loadConfig(base).canaryPrivateIp).toBeUndefined();
    for (const bad of ['not-an-ip', '2001:db8::1', '300.1.1.1', '10.0.0']) {
      expect(() => loadConfig({ ...base, HERMES_CANARY_PRIVATE_IP: bad })).toThrow('HERMES_CANARY_PRIVATE_IP');
    }
  });

  it('leaves HERMES_DNS_RESOLVERS empty by default under runc', () => {
    expect(loadConfig(base).dnsResolvers).toEqual([]);
  });

  it('parses space- or comma-separated IPv4 HERMES_DNS_RESOLVERS', () => {
    expect(loadConfig({ ...base, HERMES_DNS_RESOLVERS: '1.1.1.1 9.9.9.9' }).dnsResolvers).toEqual(['1.1.1.1', '9.9.9.9']);
    expect(loadConfig({ ...base, HERMES_DNS_RESOLVERS: '1.1.1.1, 9.9.9.9' }).dnsResolvers).toEqual(['1.1.1.1', '9.9.9.9']);
  });

  it('rejects a non-IPv4 entry in HERMES_DNS_RESOLVERS', () => {
    expect(() => loadConfig({ ...base, HERMES_DNS_RESOLVERS: '1.1.1.1 not-an-ip' })).toThrow('HERMES_DNS_RESOLVERS');
    expect(() => loadConfig({ ...base, HERMES_DNS_RESOLVERS: '2001:db8::1' })).toThrow('HERMES_DNS_RESOLVERS');
  });

  it('requires HERMES_DNS_RESOLVERS when HERMES_RUNTIME is runsc, and accepts it when set', () => {
    expect(() => loadConfig({ ...base, HERMES_RUNTIME: 'runsc' })).toThrow('HERMES_DNS_RESOLVERS');
    expect(loadConfig({ ...base, HERMES_RUNTIME: 'runsc', HERMES_DNS_RESOLVERS: '1.1.1.1' }).dnsResolvers).toEqual(['1.1.1.1']);
  });
});

describe('loadConfig: customer API settings', () => {
  it('leaves the customer API disabled when SUPABASE_URL and DASHBOARD_ORIGIN are unset', () => {
    const cfg = loadConfig(base);
    expect(cfg.supabaseUrl).toBeNull();
    expect(cfg.dashboardOrigin).toBeNull();
  });

  it('strips a trailing slash from SUPABASE_URL', () => {
    expect(loadConfig({ ...base, SUPABASE_URL: 'https://abcd.supabase.co/' }).supabaseUrl).toBe('https://abcd.supabase.co');
  });

  it('allows loopback http SUPABASE_URL outside production, and rejects it in production', () => {
    expect(loadConfig({ ...base, SUPABASE_URL: 'http://127.0.0.1:54421/' }).supabaseUrl).toBe('http://127.0.0.1:54421');
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', SUPABASE_URL: 'http://127.0.0.1:54421', HERMES_RUNTIME: 'runsc', REDIS_URL: 'redis://127.0.0.1:6379', SECRETS_KEK: '0'.repeat(64) })).toThrow('SUPABASE_URL');
  });

  it.each(['http://abcd.supabase.co', 'not a url', 'https://abcd.supabase.co/auth/v1'])(
    'rejects SUPABASE_URL %s',
    (v) => {
      expect(() => loadConfig({ ...base, SUPABASE_URL: v })).toThrow('SUPABASE_URL');
    },
  );

  it('does not echo SUPABASE_URL in errors', () => {
    let message = '';
    try {
      loadConfig({ ...base, SUPABASE_URL: 'http://secret-project-ref.example' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('SUPABASE_URL');
    expect(message).not.toContain('secret-project-ref');
  });

  it('CORS_EXTRA_ORIGINS: a list of bare origins in development, refused with a path or in production', () => {
    expect(loadConfig({ ...base }).corsExtraOrigins).toEqual([]);
    expect(loadConfig({ ...base, CORS_EXTRA_ORIGINS: ' http://localhost:3300 , http://127.0.0.1:3300 ' }).corsExtraOrigins)
      .toEqual(['http://localhost:3300', 'http://127.0.0.1:3300']);
    expect(() => loadConfig({ ...base, CORS_EXTRA_ORIGINS: 'http://localhost:3300/landing' })).toThrow('CORS_EXTRA_ORIGINS');
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', CORS_EXTRA_ORIGINS: 'http://localhost:3300' })).toThrow('CORS_EXTRA_ORIGINS');
  });

  it('accepts a bare origin for DASHBOARD_ORIGIN and rejects a path', () => {
    expect(loadConfig({ ...base, DASHBOARD_ORIGIN: 'https://cloud.nibie.app' }).dashboardOrigin).toBe('https://cloud.nibie.app');
    expect(() => loadConfig({ ...base, DASHBOARD_ORIGIN: 'https://cloud.nibie.app/dashboard' })).toThrow('DASHBOARD_ORIGIN');
  });

  it('parses BETA_ALLOWED_EMAILS lowercased and trimmed, empty means nobody', () => {
    expect(loadConfig({ ...base, BETA_ALLOWED_EMAILS: ' A@x.com, b@x.com ,' }).betaAllowedEmails).toEqual(['a@x.com', 'b@x.com']);
    expect(loadConfig(base).betaAllowedEmails).toEqual([]);
    expect(loadConfig({ ...base, BETA_ALLOWED_EMAILS: '' }).betaAllowedEmails).toEqual([]);
  });

  it('defaults MAX_INSTANCES_PER_TENANT to 1 and rejects 0 and non-numbers', () => {
    expect(loadConfig(base).maxInstancesPerTenant).toBe(1);
    expect(loadConfig({ ...base, MAX_INSTANCES_PER_TENANT: '3' }).maxInstancesPerTenant).toBe(3);
    expect(() => loadConfig({ ...base, MAX_INSTANCES_PER_TENANT: '0' })).toThrow('MAX_INSTANCES_PER_TENANT');
    expect(() => loadConfig({ ...base, MAX_INSTANCES_PER_TENANT: 'abc' })).toThrow('MAX_INSTANCES_PER_TENANT');
  });
});

describe('loadConfig: admin dashboard settings', () => {
  it('has no admin when ADMIN_EMAILS is unset or empty (fail closed)', () => {
    expect(loadConfig(base).adminEmails).toEqual([]);
    expect(loadConfig({ ...base, ADMIN_EMAILS: '' }).adminEmails).toEqual([]);
    expect(loadConfig({ ...base, ADMIN_EMAILS: ' , ' }).adminEmails).toEqual([]);
  });

  it('parses ADMIN_EMAILS lowercased and trimmed', () => {
    expect(loadConfig({ ...base, ADMIN_EMAILS: ' Boss@Nibie.App , ops@nibie.app ' }).adminEmails).toEqual([
      'boss@nibie.app',
      'ops@nibie.app',
    ]);
  });

  it('rejects a malformed ADMIN_EMAILS entry without echoing the value', () => {
    let message = '';
    try {
      loadConfig({ ...base, ADMIN_EMAILS: 'not-an-email' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('ADMIN_EMAILS');
    expect(message).not.toContain('not-an-email');
  });
});

describe('loadConfig: Redis', () => {
  it('leaves Redis unset by default', () => {
    expect(loadConfig(base).redisUrl).toBeNull();
    expect(loadConfig({ ...base, REDIS_URL: '' }).redisUrl).toBeNull();
  });

  it('accepts redis: and rediss: URLs', () => {
    expect(loadConfig({ ...base, REDIS_URL: 'redis://:pw@127.0.0.1:6379' }).redisUrl).toBe('redis://:pw@127.0.0.1:6379');
    expect(loadConfig({ ...base, REDIS_URL: 'rediss://:pw@cache.example:6380' }).redisUrl).toBe('rediss://:pw@cache.example:6380');
  });

  it('rejects another scheme without echoing the value', () => {
    let message = '';
    try {
      loadConfig({ ...base, REDIS_URL: 'http://:topsecretpw@127.0.0.1:6379' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('REDIS_URL');
    expect(message).not.toContain('topsecretpw');
  });

  it('requires REDIS_URL in production', () => {
    const prod = { ...base, NODE_ENV: 'production', HERMES_RUNTIME: 'runsc', HERMES_DNS_RESOLVERS: '1.1.1.1', HERMES_DISK_QUOTA: 'enforce', HERMES_EGRESS_POLICY: 'enforce', HERMES_CANARY_IMAGE: 'busybox@sha256:' + 'a'.repeat(64), SECRETS_KEK: Buffer.alloc(32, 7).toString('base64') };
    expect(() => loadConfig(prod)).toThrow('REDIS_URL');
    expect(loadConfig({ ...prod, REDIS_URL: 'redis://:pw@127.0.0.1:6379' }).redisUrl).not.toBeNull();
  });
});

describe('loadConfig secrets key', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  const key2 = Buffer.alloc(32, 9).toString('base64');

  it('is null when SECRETS_KEK is unset outside production', () => {
    expect(loadConfig(base).secrets).toBeNull();
  });

  it('parses the current key with version 1 by default', () => {
    const cfg = loadConfig({ ...base, SECRETS_KEK: key });
    expect(cfg.secrets?.current.version).toBe(1);
    expect(cfg.secrets?.current.key.length).toBe(32);
    expect(cfg.secrets?.previous).toBeNull();
  });

  it('parses a previous key for rotation', () => {
    const cfg = loadConfig({ ...base, SECRETS_KEK: key2, SECRETS_KEK_VERSION: '2', SECRETS_KEK_PREVIOUS: key, SECRETS_KEK_PREVIOUS_VERSION: '1' });
    expect(cfg.secrets?.current.version).toBe(2);
    expect(cfg.secrets?.previous?.version).toBe(1);
  });

  it('rejects a key that is not 32 bytes of base64, naming SECRETS_KEK without echoing it', () => {
    const bad = Buffer.alloc(16, 1).toString('base64');
    let message = '';
    try {
      loadConfig({ ...base, SECRETS_KEK: bad });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('SECRETS_KEK');
    expect(message).not.toContain(bad);
  });

  it('rejects the same version number for two different keys and a previous key without a current one', () => {
    expect(() => loadConfig({ ...base, SECRETS_KEK: key2, SECRETS_KEK_PREVIOUS: key })).toThrow('SECRETS_KEK_PREVIOUS_VERSION');
    expect(() => loadConfig({ ...base, SECRETS_KEK_PREVIOUS: key })).toThrow('SECRETS_KEK_PREVIOUS');
  });

  it('is required in production', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', REDIS_URL: 'redis://127.0.0.1:6379', HERMES_IMAGE: `h@sha256:${'a'.repeat(64)}` }),
    ).toThrow('SECRETS_KEK');
  });
});

describe('loadConfig: outbound mail (SumoPod SMTP)', () => {
  const mail = {
    SUMOPOD_SMTP_HOST: 'smtp.sumopod.com',
    SUMOPOD_SMTP_PORT: '465',
    SUMOPOD_SMTP_USER: 'user',
    SUMOPOD_SMTP_PASS: 'smtp-pass-value',
    MAIL_FROM: 'no-reply@example.com',
  };

  it('is null when nothing is set, including empty values from a .env file', () => {
    expect(loadConfig(base).mail).toBeNull();
    expect(loadConfig({ ...base, SUMOPOD_SMTP_HOST: '', SUMOPOD_SMTP_PASS: '', MAIL_FROM: '' }).mail).toBeNull();
  });

  it('parses a complete block', () => {
    expect(loadConfig({ ...base, ...mail }).mail).toEqual({
      host: 'smtp.sumopod.com',
      port: 465,
      user: 'user',
      pass: 'smtp-pass-value',
      from: 'no-reply@example.com',
    });
  });

  it.each(Object.keys(mail))('rejects a block without %s and names the key', (key) => {
    const env: Record<string, string> = { ...base, ...mail };
    delete env[key];
    expect(() => loadConfig(env)).toThrow(key);
  });

  it('rejects a bad port or sender without echoing the password', () => {
    expect(() => loadConfig({ ...base, ...mail, SUMOPOD_SMTP_PORT: '70000' })).toThrow('SUMOPOD_SMTP_PORT');
    let message = '';
    try {
      loadConfig({ ...base, ...mail, MAIL_FROM: 'not-an-address' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('MAIL_FROM');
    expect(message).not.toContain('smtp-pass-value');
  });
});

describe('SumoPod billing configuration', () => {
  const sumopod = {
    SUMOPOD_API_KEY: 'sumopod-api-key-value',
    SUMOPOD_WEBHOOK_TOKEN: 'whtok_test_value',
    SUMOPOD_CALLBACK_URL: 'https://api.example.test/api/v1/billing/sumopod/webhook',
    DASHBOARD_ORIGIN: 'https://cloud.example.test',
  };

  it('requires DASHBOARD_ORIGIN for the return URL', () => {
    const { DASHBOARD_ORIGIN: _omit, ...rest } = sumopod;
    expect(() => loadConfig({ ...base, ...rest })).toThrow('DASHBOARD_ORIGIN');
  });

  it('is null when nothing is set, including empty values from a .env file', () => {
    expect(loadConfig(base).billing).toBeNull();
    expect(loadConfig({ ...base, SUMOPOD_API_KEY: '', SUMOPOD_WEBHOOK_TOKEN: '', SUMOPOD_CALLBACK_URL: '' }).billing).toBeNull();
  });

  it('parses a complete block and defaults the environment to sandbox', () => {
    expect(loadConfig({ ...base, ...sumopod }).billing).toEqual({
      sumopod: {
        apiKey: 'sumopod-api-key-value',
        webhookToken: 'whtok_test_value',
        webhookSecret: null,
        env: 'sandbox',
        callbackUrl: 'https://api.example.test/api/v1/billing/sumopod/webhook',
      },
    });
  });

  it('ignores the removed Duitku variables, so an old env file still starts', () => {
    const old = { BILLING_GATEWAY: 'duitku', DUITKU_MERCHANT_CODE: 'DS00000', DUITKU_API_KEY: 'x', DUITKU_ENV: 'production' };
    expect(loadConfig({ ...base, ...old }).billing).toBeNull();
    expect(loadConfig({ ...base, ...sumopod, ...old }).billing?.sumopod.env).toBe('sandbox');
  });

  it.each(['SUMOPOD_API_KEY', 'SUMOPOD_WEBHOOK_TOKEN', 'SUMOPOD_CALLBACK_URL'])('rejects a block without %s and names the key', (key) => {
    const env: Record<string, string> = { ...base, ...sumopod };
    delete env[key];
    expect(() => loadConfig(env)).toThrow(key);
  });

  it('rejects an unknown SUMOPOD_ENV and a non-https callback URL', () => {
    expect(() => loadConfig({ ...base, ...sumopod, SUMOPOD_ENV: 'staging' })).toThrow('SUMOPOD_ENV');
    expect(() => loadConfig({ ...base, ...sumopod, SUMOPOD_CALLBACK_URL: 'http://api.example.test/cb' })).toThrow('SUMOPOD_CALLBACK_URL');
  });

  it('refuses the production SumoPod environment outside NODE_ENV=production', () => {
    expect(() => loadConfig({ ...base, ...sumopod, SUMOPOD_ENV: 'production' })).toThrow('SUMOPOD_ENV');
  });

  it('never echoes the API key in an error', () => {
    let message = '';
    try {
      loadConfig({ ...base, ...sumopod, SUMOPOD_ENV: 'staging' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('SUMOPOD_ENV');
    expect(message).not.toContain('sumopod-api-key-value');
  });
});

describe('SumoPod webhook signing secret', () => {
  const sumopod = {
    SUMOPOD_API_KEY: 'sk_test_value', SUMOPOD_WEBHOOK_TOKEN: 'whtok_test_value', SUMOPOD_CALLBACK_URL: 'https://api.example.test/api/v1/billing/sumopod/webhook',
    DASHBOARD_ORIGIN: 'https://cloud.example.test',
  };
  const secret = `whsec_${Buffer.alloc(24, 5).toString('base64')}`;
  const prod = {
    ...base, ...sumopod, NODE_ENV: 'production', HERMES_RUNTIME: 'runsc', HERMES_DNS_RESOLVERS: '1.1.1.1',
    REDIS_URL: 'redis://127.0.0.1:6379', SECRETS_KEK: Buffer.alloc(32, 7).toString('base64'), HERMES_IMAGE: `h@sha256:${'a'.repeat(64)}`,
  };

  it('is optional outside production and passed through when set', () => {
    expect(loadConfig({ ...base, ...sumopod }).billing?.sumopod?.webhookSecret).toBeNull();
    expect(loadConfig({ ...base, ...sumopod, SUMOPOD_WEBHOOK_SECRET: secret }).billing?.sumopod?.webhookSecret).toBe(secret);
  });

  it('is required in production when SumoPod is configured', () => {
    expect(() => loadConfig(prod)).toThrow('SUMOPOD_WEBHOOK_SECRET');
    expect(loadConfig({ ...prod, SUMOPOD_WEBHOOK_SECRET: secret }).billing?.sumopod?.webhookSecret).toBe(secret);
  });

  it('rejects a value that is not whsec_ base64, without echoing it', () => {
    let message = '';
    try {
      loadConfig({ ...base, ...sumopod, SUMOPOD_WEBHOOK_SECRET: 'whtok_not_a_secret' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('SUMOPOD_WEBHOOK_SECRET');
    expect(message).not.toContain('whtok_not_a_secret');
  });
});

describe('waiting-list captcha (Turnstile)', () => {
  const mail = { SUMOPOD_SMTP_HOST: 'smtp.example.test', SUMOPOD_SMTP_PORT: '465', SUMOPOD_SMTP_USER: 'u', SUMOPOD_SMTP_PASS: 'p', MAIL_FROM: 'no-reply@example.test' };
  const prod = {
    ...base, ...mail, NODE_ENV: 'production', HERMES_RUNTIME: 'runsc', HERMES_DNS_RESOLVERS: '1.1.1.1', REDIS_URL: 'redis://127.0.0.1:6379',
    SECRETS_KEK: Buffer.alloc(32, 7).toString('base64'), HERMES_IMAGE: `h@sha256:${'a'.repeat(64)}`, FREE_BETA_SLOTS: '10',
  };

  it('is required in production while the waiting list is on, and only then', () => {
    expect(() => loadConfig(prod)).toThrow('TURNSTILE_SECRET_KEY');
    expect(loadConfig({ ...prod, TURNSTILE_SECRET_KEY: 'ts-secret' }).turnstileSecret).toBe('ts-secret');
    expect(loadConfig({ ...prod, FREE_BETA_SLOTS: '0' }).turnstileSecret).toBeNull();
    expect(loadConfig({ ...base, ...mail, FREE_BETA_SLOTS: '10' }).turnstileSecret).toBeNull();
  });
});

describe('loadConfig: NibieRouter', () => {
  it('is off by default', () => {
    expect(loadConfig(base).router).toBeNull();
  });

  it('is on when the admin key and the default model are both set, with the documented defaults', () => {
    const cfg = loadConfig({ ...base, NIBIEROUTER_ADMIN_KEY: 'sk-admin-test-0123456789', NIBIEROUTER_DEFAULT_MODEL: 'some-model' });
    expect(cfg.router).toEqual({ apiUrl: 'https://router.nibie.app', adminKey: 'sk-admin-test-0123456789', defaultModel: 'some-model', emailDomain: 'cloud.nibie.app' });
  });

  it.each([
    ['only the admin key', { NIBIEROUTER_ADMIN_KEY: 'sk-admin-test-0123456789' }],
    ['only the model', { NIBIEROUTER_DEFAULT_MODEL: 'some-model' }],
  ])('refuses %s', (_label, extra) => {
    expect(() => loadConfig({ ...base, ...extra })).toThrow('NIBIEROUTER_ADMIN_KEY');
  });

  it.each(['http://router.example.test', 'https://router.example.test/v1', 'https://router.example.test/?a=1', 'not a url'])('refuses API URL %s', (u) => {
    expect(() => loadConfig({ ...base, NIBIEROUTER_API_URL: u })).toThrow('NIBIEROUTER_API_URL');
  });

  it('does not echo the admin key in a validation error', () => {
    let message = '';
    try {
      loadConfig({ ...base, NIBIEROUTER_ADMIN_KEY: 'sk-admin-canary-value-123' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('NIBIEROUTER_ADMIN_KEY');
    expect(message).not.toContain('sk-admin-canary-value-123');
  });
});

describe('operator alerting settings', () => {
  const token = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

  it('is off by default', () => {
    expect(loadConfig(base).ops).toEqual({ telegram: null });
  });

  it('reads the Telegram channel', () => {
    const cfg = loadConfig({ ...base, OPS_TELEGRAM_BOT_TOKEN: token, OPS_TELEGRAM_CHAT_ID: '-1001234567890' });
    expect(cfg.ops).toEqual({ telegram: { botToken: token, chatId: '-1001234567890' } });
  });

  it.each([
    ['only the token', { OPS_TELEGRAM_BOT_TOKEN: token }],
    ['only the chat id', { OPS_TELEGRAM_CHAT_ID: '42' }],
  ])('refuses %s', (_l, extra) => {
    expect(() => loadConfig({ ...base, ...extra })).toThrow('OPS_TELEGRAM_BOT_TOKEN');
  });

  it('does not echo the bot token in an error', () => {
    let message = '';
    try {
      loadConfig({ ...base, OPS_TELEGRAM_BOT_TOKEN: token });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain('AAHdqTcv');
  });
});

describe('PAID_NODE_REGIONS', () => {
  it('is undefined when unset or empty, and parses a trimmed comma-separated list', () => {
    expect(loadConfig(base).paidNodeRegions).toBeUndefined();
    expect(loadConfig({ ...base, PAID_NODE_REGIONS: '' }).paidNodeRegions).toBeUndefined();
    expect(loadConfig({ ...base, PAID_NODE_REGIONS: ' , ' }).paidNodeRegions).toBeUndefined();
    expect(loadConfig({ ...base, PAID_NODE_REGIONS: 'id-jakarta' }).paidNodeRegions).toEqual(['id-jakarta']);
    expect(loadConfig({ ...base, PAID_NODE_REGIONS: ' id-jakarta , sg-singapore ' }).paidNodeRegions).toEqual([
      'id-jakarta',
      'sg-singapore',
    ]);
  });
});
