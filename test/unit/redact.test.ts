import { describe, expect, it } from 'vitest';
import { redactLines } from '../../src/modules/integrations/redact.js';
import { demuxLogs } from '../../src/modules/runtime/docker-logs.js';

const TG = '123456789:AAHcanaryTOKENvalue0123456789abcdefg';
const SK = 'sk-canary-provider-key-0123456789';

describe('redactLines', () => {
  it('removes the instance own secret values wherever they appear', () => {
    const out = redactLines([`calling with key ${SK} now`, `url=https://x/?k=${SK}&b=1`], [SK]);
    expect(out.join('\n')).not.toContain(SK);
    expect(out[0]).toContain('[REDACTED]');
  });

  it('removes token shapes even when they are not known secrets', () => {
    const lines = [
      `Authorization: Bearer abcdefghijklmnop1234567890`,
      `telegram token ${TG}`,
      `key sk-abcdef0123456789abcdef`,
      `derived ${'a'.repeat(64)}`,
      `password=hunter2hunter2 token: abc123def456ghi789`,
      `api_key="quoted-secret-value-1234"`,
    ];
    const joined = redactLines(lines, []).join('\n');
    for (const leak of ['abcdefghijklmnop1234567890', TG, 'sk-abcdef0123456789abcdef', 'a'.repeat(64), 'hunter2hunter2', 'abc123def456ghi789', 'quoted-secret-value-1234']) {
      expect(joined).not.toContain(leak);
    }
  });

  it('keeps ordinary log lines readable', () => {
    const lines = ['2026-11-13T10:00:00Z INFO gateway started on port 8642', 'session 1f2e3d ok'];
    expect(redactLines(lines, [])).toEqual(lines);
  });

  it('strips terminal escape sequences and control characters', () => {
    expect(redactLines(['\u001b[31mred\u001b[0m text\u0007'], [])).toEqual(['red text']);
  });

  it('ignores very short known values (would shred normal text) and truncates huge lines', () => {
    expect(redactLines(['abc abc'], ['abc'])).toEqual(['abc abc']);
    expect(redactLines(['x'.repeat(5000)], [])[0]!.length).toBeLessThanOrEqual(2000);
  });

  it('escapes regex characters in known values', () => {
    const odd = 'k.ey+with(special)[chars]*123';
    expect(redactLines([`value ${odd} end`], [odd]).join('')).not.toContain(odd);
  });
});

describe('demuxLogs', () => {
  const frame = (stream: number, text: string) => {
    const p = Buffer.from(text);
    const h = Buffer.alloc(8);
    h[0] = stream;
    h.writeUInt32BE(p.length, 4);
    return Buffer.concat([h, p]);
  };

  it('splits Docker stream frames into lines from stdout and stderr', () => {
    const buf = Buffer.concat([frame(1, 'one\ntwo\n'), frame(2, 'three\n'), frame(1, 'par')]);
    expect(demuxLogs(buf)).toEqual(['one', 'two', 'three', 'par']);
  });

  it('treats unframed output (TTY containers) as plain text', () => {
    expect(demuxLogs(Buffer.from('plain one\nplain two\n'))).toEqual(['plain one', 'plain two']);
  });

  it('returns nothing for empty input and survives a truncated frame', () => {
    expect(demuxLogs(Buffer.alloc(0))).toEqual([]);
    const cut = frame(1, 'hello world\n').subarray(0, 12);
    expect(() => demuxLogs(cut)).not.toThrow();
  });
});
