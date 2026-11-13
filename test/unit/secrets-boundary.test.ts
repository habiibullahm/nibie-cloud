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
});
