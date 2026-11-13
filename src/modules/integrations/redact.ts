/** Longest line returned to a customer. */
const MAX_LINE = 2000;
/** Known values shorter than this would shred ordinary text; real keys and tokens are longer. */
const MIN_KNOWN = 8;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Token shapes redacted even when the value is not one the instance owns. */
const SHAPES: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b\d{5,15}:[A-Za-z0-9_-]{30,50}\b/g, // Telegram bot token
  /\bsk-[A-Za-z0-9_-]{8,}/g, // provider-style keys
  /\b[0-9a-f]{40,}\b/gi, // long hex: derived API keys, digests
];
/** `name=value` / `name: value` where the name says it is a credential. The name stays, the value goes. */
const NAMED = /\b((?:api[_-]?key|token|secret|password|passwd|authorization)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi;

const escapeRegex = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Makes container output safe to show a customer (PRD 7.4): terminal escapes and control characters are
 * stripped, this instance's own secret values are removed wherever they appear, and common credential
 * shapes are removed even if the value is not known. Best effort by nature: a secret that the application
 * splits across lines cannot be matched.
 */
export function redactLines(lines: string[], known: string[]): string[] {
  const knownRes = known.filter((v) => v.length >= MIN_KNOWN).map((v) => new RegExp(escapeRegex(v), 'g'));
  return lines.map((raw) => {
    let line = raw.replace(ANSI, '').replace(CONTROL, '');
    for (const re of knownRes) line = line.replace(re, '[REDACTED]');
    for (const re of SHAPES) line = line.replace(re, '[REDACTED]');
    line = line.replace(NAMED, '$1[REDACTED]');
    return line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line;
  });
}
