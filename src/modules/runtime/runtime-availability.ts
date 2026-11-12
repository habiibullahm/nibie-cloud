import type { SupportedRuntime } from './types.js';

/**
 * Fail fast at startup when the configured OCI runtime is not installed on the Docker host,
 * instead of failing every provision later. `runc` is the daemon default and always present.
 */
export async function assertRuntimeAvailable(
  docker: { info(): Promise<{ Runtimes?: Record<string, unknown> }> },
  runtime: SupportedRuntime,
): Promise<void> {
  if (runtime === 'runc') return;
  const info = await docker.info();
  if (!info.Runtimes || !(runtime in info.Runtimes)) {
    throw new Error(`Docker runtime "${runtime}" is not available on this host`);
  }
}
