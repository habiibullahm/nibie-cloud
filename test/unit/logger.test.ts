import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/shared/logger.js';

function capture() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { stream, output: () => chunks.join('') };
}

describe('createLogger redaction', () => {
  it('redacts tokens, api keys, env values and authorization headers', () => {
    const { stream, output } = capture();
    const log = createLogger({ stream });
    log.info({
      adminToken: 'sekret-admin',
      env: { TELEGRAM_BOT_TOKEN: 'sekret-bot' },
      provider: { apiKey: 'sekret-key', password: 'sekret-pw', token: 'sekret-tok' },
      req: { headers: { authorization: 'Bearer sekret-bearer' } },
    }, 'hello');
    const out = output();
    for (const s of ['sekret-admin', 'sekret-bot', 'sekret-key', 'sekret-pw', 'sekret-tok', 'sekret-bearer']) {
      expect(out).not.toContain(s);
    }
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('hello');
  });
});
