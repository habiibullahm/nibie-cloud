import type { EventEmitter } from 'node:events';
import type { Logger } from '../../shared/logger.js';

/**
 * Makes a Redis outage visible without flooding the log: connection errors are logged at warn level at
 * most once per window, with the error class name only (messages can carry the URL and password).
 */
export function watchConnection(
  conn: EventEmitter,
  logger: Logger,
  name: string,
  o: { everyMs?: number; now?: () => number } = {},
): void {
  const every = o.everyMs ?? 30_000;
  const now = o.now ?? Date.now;
  let last = Number.NEGATIVE_INFINITY;
  conn.on('error', (e: Error) => {
    if (now() - last < every) return;
    last = now();
    logger.warn({ connection: name, errName: e?.name ?? 'Error' }, 'redis connection error');
  });
  conn.on('ready', () => logger.info({ connection: name }, 'redis connection ready'));
}
