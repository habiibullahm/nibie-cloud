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

  it('defaults HERMES_RUNTIME to runc and accepts runsc', () => {
    expect(loadConfig(base).runtime).toBe('runc');
    expect(loadConfig({ ...base, HERMES_RUNTIME: 'runsc' }).runtime).toBe('runsc');
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
});
