import { describe, expect, it } from 'vitest';
import { Alerter, sanitizeAlertText } from '../../src/modules/ops/alerter.js';
import { createLogger } from '../../src/shared/logger.js';
import { MemoryAlertStore } from '../helpers/memory-alert-store.js';

const logger = createLogger({ level: 'silent' });
const HOUR = 3_600_000;

function setup(opts: { sink?: ((text: string) => Promise<void>) | null; start?: number } = {}) {
  let t = opts.start ?? Date.parse('2026-11-15T10:00:00Z');
  const sent: string[] = [];
  const sink = opts.sink === undefined ? async (text: string) => { sent.push(text); } : opts.sink;
  const store = new MemoryAlertStore();
  const alerter = new Alerter({ store, sink, logger, now: () => new Date(t) });
  return { alerter, store, sent, advance: (ms: number) => { t += ms; } };
}

const critical = { key: 'instance-degraded:abc', severity: 'CRITICAL' as const, title: 'Instance tidak pulih', detail: 'Alasan: recovery_exhausted' };

describe('Alerter.raise', () => {
  it('sends the first alert once and suppresses repeats inside the cooldown', async () => {
    const { alerter, sent, advance } = setup();
    expect(await alerter.raise(critical)).toBe('sent');
    advance(10 * 60_000);
    expect(await alerter.raise(critical)).toBe('suppressed');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('KRITIS');
    expect(sent[0]).toContain('Instance tidak pulih');
  });

  it('reminds again after the cooldown (critical 1 hour, warning 6 hours)', async () => {
    const { alerter, sent, advance } = setup();
    await alerter.raise(critical);
    advance(HOUR + 1);
    expect(await alerter.raise(critical)).toBe('sent');
    expect(sent).toHaveLength(2);

    await alerter.raise({ key: 'disk-full:x', severity: 'WARNING', title: 'Disk penuh' });
    advance(2 * HOUR);
    expect(await alerter.raise({ key: 'disk-full:x', severity: 'WARNING', title: 'Disk penuh' })).toBe('suppressed');
    advance(5 * HOUR);
    expect(await alerter.raise({ key: 'disk-full:x', severity: 'WARNING', title: 'Disk penuh' })).toBe('sent');
  });

  it('reports a condition that gets worse at once, even inside the cooldown', async () => {
    const { alerter, sent, advance } = setup();
    await alerter.raise({ key: 'router:x', severity: 'WARNING', title: 'Belum berhasil' });
    advance(60_000);
    expect(await alerter.raise({ key: 'router:x', severity: 'CRITICAL', title: 'Berhenti dicoba' })).toBe('sent');
    expect(sent).toHaveLength(2);
    advance(60_000);
    expect(await alerter.raise({ key: 'router:x', severity: 'WARNING', title: 'Belum berhasil' })).toBe('suppressed');
  });

  it('sends an INFO alert only once per condition', async () => {
    const { alerter, sent, advance } = setup();
    const info = { key: 'daily:2026-11-15', severity: 'INFO' as const, title: 'Ringkasan' };
    expect(await alerter.raise(info)).toBe('sent');
    advance(48 * HOUR);
    expect(await alerter.raise(info)).toBe('suppressed');
    expect(sent).toHaveLength(1);
  });

  it('keeps the alert unsent when delivery fails, and tries again on the next raise', async () => {
    let fail = true;
    const calls: string[] = [];
    const { alerter, store } = setup({ sink: async (t) => { if (fail) throw new Error('boom'); calls.push(t); } });
    expect(await alerter.raise(critical)).toBe('unsent');
    expect((await store.get(critical.key))!.lastSentAt).toBeNull();
    fail = false;
    expect(await alerter.raise(critical)).toBe('sent');
    expect(calls).toHaveLength(1);
  });

  it('never throws when the sink throws', async () => {
    const { alerter } = setup({ sink: async () => { throw new Error('telegram down'); } });
    await expect(alerter.raise(critical)).resolves.toBe('unsent');
  });

  it('records the alert but sends nothing when no sink is configured', async () => {
    const { alerter, store } = setup({ sink: null });
    expect(await alerter.raise(critical)).toBe('unsent');
    expect((await store.get(critical.key))!.resolvedAt).toBeNull();
  });

  it('limits a storm to 20 messages per 10 minutes and sends the rest later', async () => {
    const { alerter, sent, advance } = setup();
    const results: string[] = [];
    for (let i = 0; i < 25; i++) results.push(await alerter.raise({ key: `instance-failed:${i}`, severity: 'WARNING', title: `t${i}` }));
    expect(results.filter((r) => r === 'sent')).toHaveLength(20);
    expect(results.filter((r) => r === 'unsent')).toHaveLength(5);
    advance(11 * 60_000);
    expect(await alerter.raise({ key: 'instance-failed:24', severity: 'WARNING', title: 't24' })).toBe('sent');
    expect(sent).toHaveLength(21);
  });

  it('removes token-like strings from what it sends', async () => {
    const { alerter, sent } = setup();
    await alerter.raise({ ...critical, detail: 'galat 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw dan sk-abcdefghijklmnopqrstuvwxyz0123456789' });
    expect(sent[0]).not.toContain('AAHdqTcv');
    expect(sent[0]).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(sent[0]).toContain('[disamarkan]');
  });
});

describe('Alerter.resolve', () => {
  it('sends one recovery message for an alert that had been delivered', async () => {
    const { alerter, sent } = setup();
    await alerter.raise(critical);
    expect(await alerter.resolve(critical.key)).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('PULIH');
    expect(await alerter.resolve(critical.key)).toBe(false);
    expect(sent).toHaveLength(2);
  });

  it('closes silently an alert that was never delivered', async () => {
    const { alerter, sent } = setup({ sink: null });
    await alerter.raise(critical);
    expect(await alerter.resolve(critical.key)).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it('opens a fresh alert (and sends it) when the condition returns after recovery', async () => {
    const { alerter, sent } = setup();
    await alerter.raise(critical);
    await alerter.resolve(critical.key);
    expect(await alerter.raise(critical)).toBe('sent');
    expect(sent).toHaveLength(3);
  });

  it('resolveMissing resolves only open alerts under the prefix that are not active any more', async () => {
    const { alerter, store } = setup();
    await alerter.raise({ key: 'instance-degraded:a', severity: 'CRITICAL', title: 'a' });
    await alerter.raise({ key: 'instance-degraded:b', severity: 'CRITICAL', title: 'b' });
    await alerter.raise({ key: 'disk-full:z', severity: 'WARNING', title: 'z' });
    const n = await alerter.resolveMissing('instance-degraded:', new Set(['instance-degraded:a']));
    expect(n).toBe(1);
    expect((await store.get('instance-degraded:a'))!.resolvedAt).toBeNull();
    expect((await store.get('instance-degraded:b'))!.resolvedAt).not.toBeNull();
    expect((await store.get('disk-full:z'))!.resolvedAt).toBeNull();
  });
});

describe('sanitizeAlertText', () => {
  it('keeps UUIDs and truncates very long text', () => {
    const id = '0b3f3f0e-6c1d-4c53-9d0a-1f7d5e0a9c11';
    expect(sanitizeAlertText(`instance ${id}`)).toContain(id);
    expect(sanitizeAlertText('x '.repeat(2000)).length).toBeLessThanOrEqual(1500);
  });
});

