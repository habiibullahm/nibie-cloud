import { randomUUID } from 'node:crypto';

/** Redis for integration tests, from `REDIS_URL` (see docs/setup.md). Fails loudly, never skips. */
export function redisTestUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL must be set to run the job queue tests (see docs/setup.md)');
  return url;
}

/** A key prefix per test file, so parallel or repeated runs never touch each other's keys. */
export function uniquePrefix(): string {
  return `test-${randomUUID().slice(0, 8)}`;
}

/** A throwaway redis-server on its own port, for tests that kill Redis. Call `kill()` when done. */
export async function startPrivateRedis(port: number): Promise<{ url: string; kill(): Promise<void> }> {
  const { spawn } = await import('node:child_process');
  let exited = false;
  const child = spawn('redis-server', ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  child.once('exit', () => { exited = true; });
  const { Redis } = await import('ioredis');
  const url = `redis://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    const probe = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
    try {
      await probe.connect();
      await probe.ping();
      probe.disconnect();
      break;
    } catch {
      probe.disconnect();
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return {
    url,
    kill: async () => {
      if (exited) return;
      child.kill('SIGKILL');
      await new Promise((r) => child.once('exit', r));
    },
  };
}
