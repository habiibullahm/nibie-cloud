import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('injection guard', () => {
  it('builds SQL only with tagged templates: no unsafe raw query or Prisma.raw in src', () => {
    // `$queryRaw`...`` binds every `${}` as a parameter; the Unsafe variants and Prisma.raw splice text into the SQL.
    for (const f of files('src')) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/\$(queryRawUnsafe|executeRawUnsafe)\b|Prisma\.raw\s*\(/);
    }
  });

  it('runs no shell and evaluates no strings in src', () => {
    for (const f of files('src')) {
      const src = readFileSync(f, 'utf8');
      // A bare `eval(`; `redis.eval(SCRIPT, ...)` runs a constant Lua script with its values as arguments.
      expect(src, f).not.toMatch(/\bnew Function\s*\(|(?<![.\w])eval\s*\(/);
      expect(src, f).not.toMatch(/child_process/);
    }
  });
});
