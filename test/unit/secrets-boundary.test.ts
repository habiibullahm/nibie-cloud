import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('secret boundary', () => {
  it('no HTTP module imports the secret store (plaintext is worker-side only)', () => {
    for (const f of files('src/http')) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/secrets\/secret-store/);
    }
  });

  it('the admin module never imports the secret store or the crypto helper', () => {
    // The admin API reads rows only; a credential must never be in reach of a read handler.
    for (const f of files('src/modules/admin')) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/secrets\/(secret-store|crypto)/);
    }
  });

  it('the admin routes never select the ciphertext columns of Secret', () => {
    // `select: { ...secret: true }` on a relation would pull ciphertext/wrappedKey into a response.
    const src = readFileSync('src/http/admin-routes.ts', 'utf8');
    expect(src).not.toMatch(/ciphertext|wrappedKey|wrapIv|wrapTag/);
    expect(src).not.toMatch(/secret:\s*true/);
  });
});
