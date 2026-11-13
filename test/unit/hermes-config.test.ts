import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { applyModelBlock, ConfigUnreadableError } from '../../src/modules/runtime/hermes-config.js';
import { buildTar, collectCapped, readFirstFile } from '../../src/modules/runtime/tar.js';

const model = { default: 'gpt-x', baseUrl: 'https://llm.example.com/v1', keyEnv: 'HERMES_PROVIDER_API_KEY' };

describe('applyModelBlock', () => {
  it('creates a minimal file when none exists', () => {
    const out = applyModelBlock(null, model)!;
    expect(parse(out)).toEqual({ model: { default: 'gpt-x', provider: 'custom', base_url: 'https://llm.example.com/v1', key_env: 'HERMES_PROVIDER_API_KEY' } });
  });

  it('writes nothing when there is no file and no model', () => {
    expect(applyModelBlock(null, null)).toBeNull();
  });

  it('replaces the model block of an existing file and keeps every other key and comment', () => {
    const existing = '# my notes\nterminal:\n  backend: local # keep\nmodel:\n  default: "anthropic/claude-opus-4.6"\n  provider: auto\n  context_length: 32000\n';
    const out = applyModelBlock(existing, model)!;
    const doc = parse(out);
    expect(doc.terminal).toEqual({ backend: 'local' });
    expect(doc.model).toMatchObject({ default: 'gpt-x', provider: 'custom', base_url: model.baseUrl, key_env: 'HERMES_PROVIDER_API_KEY', context_length: 32000 });
    expect(out).toContain('# my notes');
    expect(out).toContain('# keep');
  });

  it('removes a literal api_key so the secret is never stored in the file', () => {
    const out = applyModelBlock('model:\n  api_key: sk-plain-in-file\n  default: x\n', model)!;
    expect(out).not.toContain('sk-plain-in-file');
    expect(parse(out).model.api_key).toBeUndefined();
  });

  it('is a no-op (null) when the file already says the same thing', () => {
    const once = applyModelBlock(null, model)!;
    expect(applyModelBlock(once, model)).toBeNull();
  });

  it('removes only a block it manages when the provider is removed', () => {
    const managed = applyModelBlock('terminal:\n  backend: local\n', model)!;
    const out = applyModelBlock(managed, null)!;
    expect(parse(out)).toEqual({ terminal: { backend: 'local' } });
    const customers = 'model:\n  default: mine\n  provider: custom\n  base_url: https://mine.example/v1\n  key_env: MY_OWN_KEY\n';
    expect(applyModelBlock(customers, null)).toBeNull();
  });

  it('refuses a file it cannot parse instead of overwriting it', () => {
    expect(() => applyModelBlock('model: [unclosed\n  : :', model)).toThrow(ConfigUnreadableError);
  });

  it('refuses a file whose top level is not a map', () => {
    expect(() => applyModelBlock('- a\n- b\n', model)).toThrow(ConfigUnreadableError);
  });
});

describe('collectCapped', () => {
  async function* chunks(...parts: Buffer[]) { for (const p of parts) yield p; }

  it('joins the chunks of a small stream', async () => {
    expect((await collectCapped(chunks(Buffer.from('ab'), Buffer.from('cd')), 10)).toString()).toBe('abcd');
  });

  it('stops reading and refuses once the stream passes the cap', async () => {
    let pulled = 0;
    async function* endless() { for (;;) { pulled += 1; yield Buffer.alloc(1024); } }
    await expect(collectCapped(endless(), 4096)).rejects.toBeInstanceOf(ConfigUnreadableError);
    expect(pulled).toBeLessThanOrEqual(6);
  });
});

describe('tar helpers', () => {
  it('round-trips one file with owner and mode', () => {
    const tar = buildTar('config.yaml', 'model:\n  default: x\n', { uid: 10000, gid: 10000, mode: 0o644 });
    expect(tar.length % 512).toBe(0);
    expect(tar.subarray(100, 108).toString('latin1')).toContain('0000644');
    expect(readFirstFile(tar)).toBe('model:\n  default: x\n');
  });

  it('handles content longer than one block and empty content', () => {
    const big = 'a'.repeat(1500);
    expect(readFirstFile(buildTar('f', big, { uid: 1, gid: 1, mode: 0o600 }))).toBe(big);
    expect(readFirstFile(buildTar('f', '', { uid: 1, gid: 1, mode: 0o600 }))).toBe('');
  });

  it('rejects names that could escape the target directory', () => {
    for (const bad of ['../x', '/etc/passwd', 'a/b', '']) expect(() => buildTar(bad, 'x', { uid: 1, gid: 1, mode: 0o600 })).toThrow();
  });
});
