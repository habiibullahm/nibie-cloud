import { pino, type Logger } from 'pino';
import type { DestinationStream } from 'pino';

export type { Logger };

/** Paths whose values must never reach a log sink (PRD 7.4). */
export const REDACT_PATHS = [
  'adminToken',
  'token',
  '*.token',
  '*.apiKey',
  '*.password',
  '*.secret',
  'env.*',
  '*.env.*',
  'req.headers.authorization',
  'headers.authorization',
];

export function createLogger(opts: { level?: string; stream?: DestinationStream } = {}): Logger {
  return pino(
    {
      level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    opts.stream,
  );
}
