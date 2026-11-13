import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { watchConnection } from '../../src/modules/jobs/redis-log.js';

function fakeLogger() {
  const lines: { level: string; obj: unknown; msg: string }[] = [];
  const mk = (level: string) => (obj: unknown, msg?: string) => { lines.push({ level, obj, msg: msg ?? String(obj) }); };
  return { lines, logger: { warn: mk('warn'), info: mk('info'), error: mk('error'), debug: mk('debug') } as never };
}

describe('watchConnection', () => {
  it('logs a connection error once per window, with the class name only', () => {
    const { lines, logger } = fakeLogger();
    let t = 1_000_000;
    const c = new EventEmitter();
    watchConnection(c, logger, 'worker', { everyMs: 30_000, now: () => t });
    for (let n = 0; n < 5; n++) c.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:6379 password=hunter2'));
    expect(lines.filter((l) => l.level === 'warn')).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toContain('hunter2');
    t += 31_000;
    c.emit('error', new Error('again'));
    expect(lines.filter((l) => l.level === 'warn')).toHaveLength(2);
  });

  it('logs when the connection becomes ready', () => {
    const { lines, logger } = fakeLogger();
    const c = new EventEmitter();
    watchConnection(c, logger, 'queue');
    c.emit('ready');
    expect(lines.some((l) => l.level === 'info')).toBe(true);
  });
});
