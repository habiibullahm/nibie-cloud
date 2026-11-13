const sleep = (ms: number) => new Promise<'timeout'>((r) => { setTimeout(() => r('timeout'), ms).unref(); });

/**
 * Closes something that waits for in-flight work, but never for longer than `ms`: after the deadline it
 * forces the close (best effort, also bounded) so a dead Redis cannot keep the process from exiting.
 */
export async function closeWithin(ms: number, graceful: () => Promise<unknown>, force: () => Promise<unknown> | void): Promise<void> {
  const first = await Promise.race([graceful().then(() => 'ok' as const, () => 'ok' as const), sleep(ms)]);
  if (first === 'timeout') await Promise.race([Promise.resolve(force()).catch(() => undefined), sleep(1000)]);
}
