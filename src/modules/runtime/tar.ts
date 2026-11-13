/**
 * Minimal single-file tar (ustar) writer and reader for Docker's archive API. The control plane only ever
 * copies one fixed file name into a tenant volume, so no general tar library is needed. Names are plain file
 * names: no directory part, so nothing can be written outside the target directory.
 */
import { ConfigUnreadableError } from './hermes-config.js';

const BLOCK = 512;

/** Largest `config.yaml` (tar included) the control plane will read from a tenant volume. */
export const MAX_CONFIG_BYTES = 256 * 1024;

/** Collects a stream into one buffer, but gives up (destroying the stream) as soon as it passes `max` bytes. */
export async function collectCapped(stream: AsyncIterable<Buffer | string>, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    total += b.length;
    if (total > max) {
      (stream as { destroy?: () => void }).destroy?.();
      throw new ConfigUnreadableError();
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

export function buildTar(name: string, content: string, opts: { uid: number; gid: number; mode: number }): Buffer {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === '.' || name === '..') throw new Error('Invalid tar entry name');
  const data = Buffer.from(content, 'utf8');
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 'utf8');
  h.write(octal(opts.mode, 8), 100, 'latin1');
  h.write(octal(opts.uid, 8), 108, 'latin1');
  h.write(octal(opts.gid, 8), 116, 'latin1');
  h.write(octal(data.length, 12), 124, 'latin1');
  h.write(octal(Math.floor(Date.now() / 1000), 12), 136, 'latin1');
  h.write('        ', 148, 'latin1'); // checksum placeholder: eight spaces
  h.write('0', 156, 'latin1'); // regular file
  h.write('ustar\0', 257, 'latin1');
  h.write('00', 263, 'latin1');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  const padded = Buffer.alloc(Math.ceil(data.length / BLOCK) * BLOCK);
  data.copy(padded);
  return Buffer.concat([h, padded, Buffer.alloc(BLOCK * 2)]);
}

/** Content of the first entry of a tar archive, or null when the archive has none. */
export function readFirstFile(tar: Buffer): string | null {
  if (tar.length < BLOCK || tar.subarray(0, BLOCK).every((b) => b === 0)) return null;
  const size = parseInt(tar.subarray(124, 136).toString('latin1').replace(/\0.*$/, '').trim() || '0', 8);
  if (!Number.isFinite(size) || size < 0 || BLOCK + size > tar.length) return null;
  return tar.subarray(BLOCK, BLOCK + size).toString('utf8');
}
