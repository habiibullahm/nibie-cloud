import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';

const base = {
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5433/db',
  HERMES_IMAGE: 'hermes-stub:0.1.0',
  ADMIN_TOKEN: 'a'.repeat(24),
  HERMES_MASTER_KEY: 'k'.repeat(32),
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
});
