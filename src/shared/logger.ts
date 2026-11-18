import { pino, type Logger } from 'pino';
import type { DestinationStream } from 'pino';
import { maskIp } from './ip.js';

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

interface LoggedRequest {
  method?: string;
  url?: string;
  host?: string;
  ip?: string;
  socket?: { remoteAddress?: string };
}

/**
 * How a request appears in the log. Fastify's default writes the full URL and the exact client address; this keeps the
 * method, the path without its query string (an admin search puts a customer's email there) and the network of the client
 * (see `maskIp`), and drops the port. Fastify merges these over its own serializers, so they apply to every request line.
 */
export function serializeRequest(req: LoggedRequest): Record<string, string | undefined> {
  return {
    method: req.method,
    url: req.url?.split('?')[0],
    host: req.host,
    remoteAddress: maskIp(req.ip ?? req.socket?.remoteAddress),
  };
}

export function createLogger(opts: { level?: string; stream?: DestinationStream } = {}): Logger {
  return pino(
    {
      level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      serializers: { req: serializeRequest },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    opts.stream,
  );
}
