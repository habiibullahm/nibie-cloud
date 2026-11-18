import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SVIX_TOLERANCE_SEC, verifySvixSignature } from '../../src/modules/billing/svix.js';

// Svix's published test vector.
const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const ID = 'msg_p5jXN8AQM9LWM0D4loKWxJek';
const TS = '1614265330';
const BODY = '{"test": 2432232314}';
const SIG = 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=';
const NOW = Number(TS) * 1000;

const h = (over: Partial<{ id: string; timestamp: string; signature: string }> = {}) => ({ id: ID, timestamp: TS, signature: SIG, ...over });

describe('verifySvixSignature', () => {
  it('accepts the published Svix test vector', () => {
    expect(verifySvixSignature(SECRET, h(), BODY, NOW)).toBe(true);
  });

  it('accepts when one of several space-separated signatures is valid', () => {
    expect(verifySvixSignature(SECRET, h({ signature: `v1,AAAA v2,xyz ${SIG}` }), BODY, NOW)).toBe(true);
  });

  it('rejects a changed body, id or timestamp', () => {
    expect(verifySvixSignature(SECRET, h(), '{"test": 2432232315}', NOW)).toBe(false);
    expect(verifySvixSignature(SECRET, h({ id: 'msg_other' }), BODY, NOW)).toBe(false);
    expect(verifySvixSignature(SECRET, h({ timestamp: String(Number(TS) + 1) }), BODY, NOW + 1000)).toBe(false);
  });

  it('rejects another secret', () => {
    expect(verifySvixSignature('whsec_' + Buffer.alloc(24, 1).toString('base64'), h(), BODY, NOW)).toBe(false);
  });

  it('rejects a message outside the tolerance window, in either direction', () => {
    expect(verifySvixSignature(SECRET, h(), BODY, NOW + (SVIX_TOLERANCE_SEC + 1) * 1000)).toBe(false);
    expect(verifySvixSignature(SECRET, h(), BODY, NOW - (SVIX_TOLERANCE_SEC + 1) * 1000)).toBe(false);
    expect(verifySvixSignature(SECRET, h(), BODY, NOW + (SVIX_TOLERANCE_SEC - 1) * 1000)).toBe(true);
  });

  it('rejects missing or malformed headers and a non-v1 signature', () => {
    expect(verifySvixSignature(SECRET, h({ id: '' }), BODY, NOW)).toBe(false);
    expect(verifySvixSignature(SECRET, { id: ID, timestamp: undefined, signature: SIG }, BODY, NOW)).toBe(false);
    expect(verifySvixSignature(SECRET, h({ timestamp: 'abc' }), BODY, NOW)).toBe(false);
    expect(verifySvixSignature(SECRET, h({ signature: SIG.replace('v1,', 'v2,') }), BODY, NOW)).toBe(false);
    expect(verifySvixSignature(SECRET, h({ signature: 'garbage' }), BODY, NOW)).toBe(false);
  });

  it('rejects a secret that is not whsec_ base64', () => {
    const raw = 'not-a-whsec-secret';
    const sig = `v1,${createHmac('sha256', raw).update(`${ID}.${TS}.${BODY}`).digest('base64')}`;
    expect(verifySvixSignature(raw, h({ signature: sig }), BODY, NOW)).toBe(false);
  });
});
