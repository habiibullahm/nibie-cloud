/**
 * Docker returns container logs for non-TTY containers as frames: 8-byte header (stream id, three zero
 * bytes, big-endian payload size) then the payload. Returns the lines of stdout and stderr in order. Output
 * that does not look framed (TTY containers) is treated as plain text, and a truncated last frame is kept.
 */
export function demuxLogs(buf: Buffer): string[] {
  if (buf.length === 0) return [];
  const framed = buf.length >= 8 && (buf[0] === 0 || buf[0] === 1 || buf[0] === 2) && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
  let text: string;
  if (!framed) {
    text = buf.toString('utf8');
  } else {
    const parts: Buffer[] = [];
    let at = 0;
    while (at + 8 <= buf.length) {
      const size = buf.readUInt32BE(at + 4);
      const end = Math.min(at + 8 + size, buf.length);
      parts.push(buf.subarray(at + 8, end));
      at = end;
    }
    text = Buffer.concat(parts).toString('utf8');
  }
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => l.replace(/\r$/, ''));
}
