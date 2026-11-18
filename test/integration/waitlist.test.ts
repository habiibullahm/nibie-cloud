import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config/env.js';
import { createPrisma } from '../../src/db/client.js';
import { buildServer } from '../../src/http/server.js';
import { AuditService } from '../../src/modules/admin/audit-service.js';
import { IdentityService } from '../../src/modules/auth/identity-service.js';
import { InstanceService } from '../../src/modules/instances/instance-service.js';
import { MAX_INVITE_FAILURES } from '../../src/modules/instances/free-beta.js';
import { CLAIM_WINDOW_MS, WaitlistInviter } from '../../src/modules/waitlist/waitlist-inviter.js';
import type { CaptchaOutcome, CaptchaVerifier } from '../../src/modules/waitlist/turnstile.js';
import { createTestAuth, testConfig } from '../helpers/auth.js';
import { FakeMailer } from '../helpers/billing-env.js';
import { resetDb } from '../helpers/db.js';
import { FakeRuntime } from '../helpers/fake-runtime.js';
import { TEST_MASTER_KEY, seed, silentLogger } from '../helpers/service-env.js';

// Needs Postgres only: the runtime is a fake and the SMTP transport is a fake mailer.
const prisma = createPrisma(process.env.DATABASE_URL!);
const IMAGE = 'hermes-stub:0.2.0';
const MAIL = { host: 'smtp.example.test', port: 465, user: 'u', pass: 'p', from: 'no-reply@example.test' };
const T0 = new Date('2026-12-01T00:00:00.000Z');
const BOSS = 'boss@nibie.app';

let auth: Awaited<ReturnType<typeof createTestAuth>>;
let s: Awaited<ReturnType<typeof seed>>;
let clock: Date;
let mailer: FakeMailer;

function app(cfg: Partial<Config> = {}, captcha: CaptchaVerifier | null = null) {
  const service = new InstanceService({
    prisma, runtime: new FakeRuntime(), image: IMAGE, production: false, logger: silentLogger,
    masterKey: TEST_MASTER_KEY, diskQuota: 'off', egressPolicy: 'off', pollIntervalMs: 10, healthTimeoutMs: 2000,
  });
  return buildServer({
    service, logger: silentLogger,
    config: testConfig(IMAGE, TEST_MASTER_KEY, { freeBetaSlots: 2, adminEmails: [BOSS], ...cfg }),
    customer: { verify: auth.verify, identity: new IdentityService({ prisma }), prisma },
    admin: { verify: auth.verify, prisma, audit: new AuditService({ prisma }) },
    mailer,
    captcha,
  });
}
const inviter = (slots = 2) => new WaitlistInviter({
  prisma, mailer, logger: silentLogger, slots, registerUrl: 'https://cloud.example.test/dashboard/register', now: () => clock, minIntervalMs: 0,
});
const join = (a: ReturnType<typeof app>, body: unknown, ip = '203.0.113.7') =>
  a.inject({ method: 'POST', url: '/api/v1/public/waitlist', headers: { 'x-forwarded-for': ip }, payload: body as object });
const person = (n: number, over: Record<string, unknown> = {}) => ({ name: `Orang ${n}`, email: `p${n}@example.test`, useCase: 'Asisten pribadi di Telegram', ...over });
/** Adds entries oldest first with one-minute gaps, so the queue order is certain. */
async function queue(n: number) {
  for (let i = 1; i <= n; i++) {
    await prisma.waitlistEntry.create({
      data: { email: `p${i}@example.test`, name: `Orang ${i}`, useCase: 'x', status: 'WAITING', createdAt: new Date(T0.getTime() + i * 60_000), confirmedAt: T0 },
    });
  }
}
/** A free-plan instance owned by this email, the way a registered person has one. */
async function holdSlot(email: string, status: 'ACTIVE' | 'DELETED' = 'ACTIVE') {
  const user = await prisma.user.create({ data: { id: randomUUID(), email } });
  const tenant = await prisma.tenant.create({ data: { name: 'personal' } });
  await prisma.tenantMember.create({ data: { tenantId: tenant.id, userId: user.id, role: 'OWNER' } });
  return prisma.instance.create({
    data: { tenantId: tenant.id, planId: s.plan.id, nodeId: s.node.id, name: 'agent', idempotencyKey: randomUUID(), image: IMAGE, status },
  });
}
const status = async (n: number) => (await prisma.waitlistEntry.findUniqueOrThrow({ where: { email: `p${n}@example.test` } })).status;
/** The confirmation token from the last email sent, as the landing page would read it from the link's fragment. */
const lastToken = () => /#t=([A-Za-z0-9_-]{43})/.exec(mailer.sent.at(-1)!.text)![1]!;
const confirm = (a: ReturnType<typeof app>, token: unknown, ip = '203.0.113.7') =>
  a.inject({ method: 'POST', url: '/api/v1/public/waitlist/confirm', headers: { 'x-forwarded-for': ip }, payload: { token } as object });

describe('waiting list', () => {
  beforeAll(async () => { auth = await createTestAuth(); });
  beforeEach(async () => { await resetDb(prisma); s = await seed(prisma); clock = T0; mailer = new FakeMailer(); });
  afterAll(() => prisma.$disconnect());

  describe('POST /api/v1/public/waitlist', () => {
    it('stores a normalized entry and answers the same for a duplicate, without changing the first one', async () => {
      const a = app();
      const first = await join(a, person(1, { email: '  Orang1@Example.TEST ', name: ' Siti ' }));
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ ok: true });
      expect(first.headers['cache-control']).toBe('no-store');
      const again = await join(a, { name: 'Lain', email: 'orang1@example.test', useCase: 'Mau coba juga' });
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual({ ok: true });
      const rows = await prisma.waitlistEntry.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ email: 'orang1@example.test', name: 'Siti', useCase: 'Asisten pribadi di Telegram', status: 'UNCONFIRMED' });
      // One confirmation email: the duplicate a moment later does not send another.
      expect(mailer.sent.map((m) => m.to)).toEqual(['orang1@example.test']);
    });

    it('does not reveal an entry that was already invited or registered', async () => {
      const a = app();
      await queue(2);
      await prisma.waitlistEntry.update({ where: { email: 'p1@example.test' }, data: { status: 'INVITED' } });
      await prisma.waitlistEntry.update({ where: { email: 'p2@example.test' }, data: { status: 'REGISTERED' } });
      for (const n of [1, 2, 3]) {
        const res = await join(a, person(n));
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ ok: true });
      }
      expect(await status(1)).toBe('INVITED');
      expect(await status(2)).toBe('REGISTERED');
      // Only the new address gets a confirmation email.
      expect(mailer.sent.map((m) => m.to)).toEqual(['p3@example.test']);
    });

    it('stores nothing for a bot that fills the honeypot, and answers like a person', async () => {
      const res = await join(app(), person(1, { website: 'http://spam.example' }));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(await prisma.waitlistEntry.count()).toBe(0);
      expect(mailer.sent).toHaveLength(0);
      // An empty honeypot is what a person sends.
      expect((await join(app(), person(2, { website: '' }))).statusCode).toBe(200);
      expect(await prisma.waitlistEntry.count()).toBe(1);
    });

    it.each([
      ['an unknown key', person(1, { admin: true })],
      ['a bad email', person(1, { email: 'not-an-email' })],
      ['an empty name', person(1, { name: '   ' })],
      ['a name with a line break', person(1, { name: 'Siti\nBcc: x@example.test' })],
      ['a too short use case', person(1, { useCase: 'ab' })],
      ['a use case over 500 characters', person(1, { useCase: 'x'.repeat(501) })],
      ['a missing field', { name: 'Siti', email: 'a@example.test' }],
      ['a wrong type', person(1, { name: 5 })],
    ])('answers 400 for %s and stores nothing', async (_label, body) => {
      const res = await join(app(), body);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('validation_error');
      expect(await prisma.waitlistEntry.count()).toBe(0);
    });

    it('accepts a use case of exactly 500 characters', async () => {
      expect((await join(app(), person(1, { useCase: 'x'.repeat(500) }))).statusCode).toBe(200);
    });

    it('limits one visitor to 5 entries per 10 minutes, per address and not per proxy', async () => {
      const a = app();
      for (let i = 1; i <= 5; i++) expect((await join(a, person(i), '198.51.100.1')).statusCode).toBe(200);
      const limited = await join(a, person(6), '198.51.100.1');
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error.code).toBe('rate_limited');
      // Another visitor behind the same proxy is not affected.
      expect((await join(a, person(7), '198.51.100.2')).statusCode).toBe(200);
      // A forged left-hand entry does not change the address: Caddy's value is the last one.
      expect((await join(a, person(8), '1.2.3.4, 198.51.100.1')).statusCode).toBe(429);
    });

    it('answers 503 waitlist_full beyond the cap instead of growing without bound', async () => {
      const { MAX_WAITING } = await import('../../src/modules/waitlist/waitlist.js');
      await prisma.waitlistEntry.createMany({
        data: Array.from({ length: MAX_WAITING }, (_v, i) => ({ email: `bulk${i}@example.test`, name: 'x', useCase: 'x', status: 'WAITING' as const })),
      });
      const res = await join(app(), person(1));
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('waitlist_full');
    });

    it('needs no sign-in and the Caddy allowlist forwards it', async () => {
      expect((await join(app(), person(1))).statusCode).toBe(200);
    });

    it('answers 503 waitlist_unavailable and stores nothing when email cannot be sent', async () => {
      mailer.enabled = false;
      const res = await join(app(), person(1));
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('waitlist_unavailable');
      expect(await prisma.waitlistEntry.count()).toBe(0);
    });

    describe('captcha', () => {
      /** A stand-in for Turnstile: `good` passes, anything else fails, and every call is recorded. */
      function fakeCaptcha(outcome?: CaptchaOutcome) {
        const calls: Array<{ token: string | undefined; ip: string }> = [];
        const verify: CaptchaVerifier = async (token, ip) => {
          calls.push({ token, ip });
          return outcome ?? (token === 'good' ? 'ok' : 'invalid');
        };
        return { verify, calls };
      }

      it('refuses a join without a solved captcha before anything is stored or sent', async () => {
        const c = fakeCaptcha();
        for (const extra of [{}, { captchaToken: 'bad' }]) {
          const res = await join(app({}, c.verify), person(1, extra));
          expect(res.statusCode).toBe(400);
          expect(res.json().error.code).toBe('captcha_failed');
        }
        expect(await prisma.waitlistEntry.count()).toBe(0);
        expect(mailer.sent).toHaveLength(0);
      });

      it('accepts a solved captcha and checks it against the visitor address', async () => {
        const c = fakeCaptcha();
        const res = await join(app({}, c.verify), person(1, { captchaToken: 'good' }), '198.51.100.23');
        expect(res.statusCode).toBe(200);
        expect(mailer.sent.map((m) => m.to)).toEqual(['p1@example.test']);
        expect(c.calls).toEqual([{ token: 'good', ip: '198.51.100.23' }]);
      });

      it('fails closed with 503 when the captcha service cannot be reached', async () => {
        const res = await join(app({}, fakeCaptcha('unavailable').verify), person(1, { captchaToken: 'good' }));
        expect(res.statusCode).toBe(503);
        expect(res.json().error.code).toBe('waitlist_unavailable');
        expect(await prisma.waitlistEntry.count()).toBe(0);
      });
    });

    it('a failed confirmation email answers 503 and the person may ask again at once', async () => {
      const a = app();
      mailer.failNext = true;
      const res = await join(a, person(1));
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('waitlist_unavailable');
      // The failed send is given back: it does not use up one of the address's links.
      expect(await prisma.waitlistEntry.findUniqueOrThrow({ where: { email: 'p1@example.test' } })).toMatchObject({ confirmSentAt: null, confirmSends: 0 });
      expect((await join(a, person(1))).statusCode).toBe(200);
      expect(mailer.sent.map((m) => m.to)).toEqual(['p1@example.test']);
      expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { email: 'p1@example.test' } })).confirmSends).toBe(1);
    });

    it('caps unconfirmed entries separately, so a flood of unconfirmed addresses does not fill the queue', async () => {
      const { MAX_UNCONFIRMED } = await import('../../src/modules/waitlist/waitlist.js');
      await prisma.waitlistEntry.createMany({
        data: Array.from({ length: MAX_UNCONFIRMED }, (_v, i) => ({ email: `bulk${i}@example.test`, name: 'x', useCase: 'x' })),
      });
      const res = await join(app(), person(1));
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('waitlist_full');
    });
  });

  describe('confirmation (double opt-in)', () => {
    it('emails a link to the landing page with the token in the fragment; confirming makes the entry WAITING', async () => {
      const a = app();
      await join(a, person(1, { name: '<b>Siti</b>' }));
      const m = mailer.sent[0]!;
      expect(m.subject).toBe('Konfirmasi email daftar tunggu - Nibie Cloud');
      expect(m.html).toMatch(/href="https:\/\/[^"]+\/daftar-tunggu\/konfirmasi#t=[A-Za-z0-9_-]{43}"/);
      // The address is not confirmed yet, so nothing typed on the form is put in the email.
      expect(m.html).not.toContain('Siti');
      expect(m.text).not.toContain('Siti');
      expect(m.text).toContain('WIB');
      const token = lastToken();
      // Only a hash is stored, never the token.
      const row = await prisma.waitlistEntry.findUniqueOrThrow({ where: { email: 'p1@example.test' } });
      expect(row.confirmTokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(row)).not.toContain(token);

      const res = await confirm(a, token);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(res.headers['cache-control']).toBe('no-store');
      expect(await status(1)).toBe('WAITING');
      // A second click is not an error and changes nothing.
      expect((await confirm(a, token)).statusCode).toBe(200);
      expect(await status(1)).toBe('WAITING');
    });

    it.each([
      ['an unknown token', 'A'.repeat(43)],
      ['a malformed token', 'short'],
      ['a token that is not a string', 42],
    ])('answers 400 confirm_link_invalid for %s', async (_label, token) => {
      const res = await confirm(app(), token);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('confirm_link_invalid');
    });

    it('refuses an expired link, and the entry stays unconfirmed', async () => {
      const a = app();
      await join(a, person(1));
      await prisma.waitlistEntry.update({ where: { email: 'p1@example.test' }, data: { confirmExpiresAt: new Date(Date.now() - 1000) } });
      expect((await confirm(a, lastToken())).json().error.code).toBe('confirm_link_invalid');
      expect(await status(1)).toBe('UNCONFIRMED');
    });

    it('sends a fresh link when an unconfirmed address joins again after the resend interval; the old link stops working', async () => {
      const a = app();
      await join(a, person(1));
      const old = lastToken();
      await prisma.waitlistEntry.update({ where: { email: 'p1@example.test' }, data: { confirmSentAt: new Date(Date.now() - 11 * 60_000) } });
      await join(a, person(1, { name: 'Lain' }));
      expect(mailer.sent).toHaveLength(2);
      const fresh = lastToken();
      expect(fresh).not.toBe(old);
      expect((await confirm(a, old)).statusCode).toBe(400);
      expect((await confirm(a, fresh)).statusCode).toBe(200);
      // The first name is kept.
      expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { email: 'p1@example.test' } })).name).toBe('Orang 1');
    });

    it('stops sending links to one address after MAX_CONFIRM_SENDS, with the same answer as before', async () => {
      const { MAX_CONFIRM_SENDS } = await import('../../src/modules/waitlist/waitlist.js');
      const a = app();
      for (let i = 0; i < MAX_CONFIRM_SENDS + 2; i++) {
        const res = await join(a, person(1), `203.0.113.${10 + i}`);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ ok: true });
        // Past the resend interval each time, so only the per-address cap can stop the next link.
        await prisma.waitlistEntry.update({ where: { email: 'p1@example.test' }, data: { confirmSentAt: new Date(Date.now() - 11 * 60_000) } });
      }
      expect(mailer.sent).toHaveLength(MAX_CONFIRM_SENDS);
      expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { email: 'p1@example.test' } })).confirmSends).toBe(MAX_CONFIRM_SENDS);
    });

    it('refuses every new link once the platform-wide hourly cap is reached, and only sends from the last hour count', async () => {
      const { MAX_CONFIRM_SENDS_PER_HOUR } = await import('../../src/modules/waitlist/waitlist.js');
      await prisma.waitlistEntry.createMany({
        data: Array.from({ length: MAX_CONFIRM_SENDS_PER_HOUR }, (_v, i) => ({
          email: `bulk${i}@example.test`, name: 'x', useCase: 'x', confirmSends: 1, confirmSentAt: new Date(Date.now() - 5 * 60_000),
        })),
      });
      const a = app();
      const res = await join(a, person(1));
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('waitlist_unavailable');
      expect(mailer.sent).toHaveLength(0);
      expect(await prisma.waitlistEntry.count({ where: { email: 'p1@example.test' } })).toBe(0);

      await prisma.waitlistEntry.updateMany({ data: { confirmSentAt: new Date(Date.now() - 61 * 60_000) } });
      expect((await join(a, person(1))).statusCode).toBe(200);
      expect(mailer.sent.map((m) => m.to)).toEqual(['p1@example.test']);
    });

    it('an unconfirmed entry holds nothing: it is not counted, not invited, and deleted once its link expires', async () => {
      const a = app({ freeBetaSlots: 1, mail: MAIL });
      await join(a, person(1));
      expect((await a.inject({ method: 'GET', url: '/api/v1/public/beta-slots' })).json()).toEqual({ total: 1, remaining: 1 });
      mailer.sent.length = 0;
      clock = new Date();
      expect(await inviter(1).runOnce()).toMatchObject({ invited: 0, purged: 0 });
      expect(mailer.sent).toHaveLength(0);

      clock = new Date(Date.now() + 25 * 3_600_000);
      expect(await inviter(1).runOnce()).toMatchObject({ invited: 0, purged: 1 });
      expect(await prisma.waitlistEntry.count()).toBe(0);
    });

    it('once confirmed, the entry is counted and invited like any other', async () => {
      const a = app({ freeBetaSlots: 1, mail: MAIL });
      await join(a, person(1));
      await confirm(a, lastToken());
      expect((await a.inject({ method: 'GET', url: '/api/v1/public/beta-slots' })).json()).toEqual({ total: 1, remaining: 0 });
      clock = new Date();
      expect(await inviter(1).runOnce()).toMatchObject({ invited: 1 });
      expect(mailer.sent.at(-1)!.subject).toBe('Slot beta gratis Anda sudah siap - Nibie Cloud');
    });
  });

  describe('automatic invitations', () => {
    it('invites nobody while the slots are used, and the oldest first when one opens', async () => {
      await queue(3);
      const a = await holdSlot('a@example.test');
      await holdSlot('b@example.test');
      expect(await inviter().runOnce()).toMatchObject({ invited: 0 });
      expect(mailer.sent).toHaveLength(0);

      await prisma.instance.update({ where: { id: a.id }, data: { status: 'DELETED' } });
      const run = await inviter().runOnce();
      expect(run).toEqual({ registered: 0, invited: 1, failed: 0, purged: 0 });
      expect(mailer.sent.map((m) => m.to)).toEqual(['p1@example.test']);
      expect([await status(1), await status(2), await status(3)]).toEqual(['INVITED', 'WAITING', 'WAITING']);
      const e = await prisma.waitlistEntry.findUniqueOrThrow({ where: { email: 'p1@example.test' } });
      expect(e.invitedAt).toEqual(T0);
      expect(e.inviteExpiresAt).toEqual(new Date(T0.getTime() + CLAIM_WINDOW_MS));
    });

    it('is idempotent: running again, or from two places at once, never invites more than the free slots', async () => {
      await queue(5);
      await Promise.all([inviter().runOnce(), inviter().runOnce(), inviter().runOnce()]);
      await inviter().runOnce();
      // Two free slots (FREE_BETA_SLOTS=2, none used): exactly two invitations, never a third.
      expect(mailer.sent.map((m) => m.to).sort()).toEqual(['p1@example.test', 'p2@example.test']);
      expect(await prisma.waitlistEntry.count({ where: { status: 'INVITED' } })).toBe(2);
    });

    it('counts slots held by open invitations, so a slot is never offered twice', async () => {
      await queue(3);
      await holdSlot('a@example.test');
      await inviter().runOnce(); // one free slot: p1 invited
      await holdSlot('b@example.test'); // somebody else takes ... nothing is free now
      expect(await inviter().runOnce()).toMatchObject({ invited: 0 });
      expect(mailer.sent).toHaveLength(1);
    });

    it('moves on to the next in line when the 48 hour window passes, and does not invite the lapsed person again', async () => {
      await queue(2);
      await holdSlot('a@example.test');
      await inviter(2).runOnce();
      expect(mailer.sent.map((m) => m.to)).toEqual(['p1@example.test']);

      clock = new Date(T0.getTime() + CLAIM_WINDOW_MS - 1000);
      await inviter(2).runOnce();
      expect(mailer.sent).toHaveLength(1); // still inside the window

      clock = new Date(T0.getTime() + CLAIM_WINDOW_MS + 1000);
      await inviter(2).runOnce();
      expect(mailer.sent.map((m) => m.to)).toEqual(['p1@example.test', 'p2@example.test']);
      expect(await status(1)).toBe('INVITED'); // lapsed: expiry in the past, never re-invited
      clock = new Date(clock.getTime() + 10 * CLAIM_WINDOW_MS);
      await inviter(2).runOnce();
      expect(mailer.sent).toHaveLength(2);
    });

    it('marks a person REGISTERED once they hold a free instance, and the slot is counted once', async () => {
      await queue(3);
      await holdSlot('p1@example.test'); // took a slot on their own
      const run = await inviter(2).runOnce();
      expect(run.registered).toBe(1);
      expect(await status(1)).toBe('REGISTERED');
      // One slot used by p1, one free: p2 invited, p3 not.
      expect(mailer.sent.map((m) => m.to)).toEqual(['p2@example.test']);
      // p2 now registers for real: still one invitation in total, and p3 is invited only when a slot is free.
      await holdSlot('P2@example.test');
      await inviter(2).runOnce();
      expect(await status(2)).toBe('REGISTERED');
      expect(mailer.sent).toHaveLength(1);
      expect(await status(3)).toBe('WAITING');
    });

    it('puts a failed send back in line with its place, and skips an address that keeps failing', async () => {
      await queue(2);
      for (let i = 1; i <= MAX_INVITE_FAILURES; i++) {
        mailer.failNext = true;
        const run = await inviter(1).runOnce();
        expect(run).toMatchObject({ invited: 0, failed: 1 });
        const e = await prisma.waitlistEntry.findUniqueOrThrow({ where: { email: 'p1@example.test' } });
        expect(e).toMatchObject({ status: 'WAITING', invitedAt: null, inviteExpiresAt: null, inviteFailures: i });
      }
      // After three failures p1 is skipped and p2 gets the slot.
      await inviter(1).runOnce();
      expect(mailer.sent.map((m) => m.to)).toEqual(['p2@example.test']);
      expect(await status(1)).toBe('WAITING');
    });

    it('invites nobody without mail or without slots', async () => {
      await queue(2);
      mailer.enabled = false;
      expect(await inviter(2).runOnce()).toMatchObject({ invited: 0 });
      mailer.enabled = true;
      expect(await inviter(0).runOnce()).toMatchObject({ invited: 0 });
      expect(await prisma.waitlistEntry.count({ where: { status: 'INVITED' } })).toBe(0);
    });

    it('writes an Indonesian email with the registration link, the deadline, and escapes what the visitor typed', async () => {
      await prisma.waitlistEntry.create({ data: { email: 'x@example.test', name: '<b>Siti</b> & "Co"', useCase: 'x', status: 'WAITING' } });
      await inviter(1).runOnce();
      const m = mailer.sent[0]!;
      expect(m.subject).toBe('Slot beta gratis Anda sudah siap - Nibie Cloud');
      expect(m.html).toContain('href="https://cloud.example.test/dashboard/register"');
      expect(m.html).toContain('&lt;b&gt;Siti&lt;/b&gt; &amp; &quot;Co&quot;');
      expect(m.html).not.toContain('<b>Siti');
      expect(m.text).toContain('Daftar sekarang: https://cloud.example.test/dashboard/register');
      expect(m.text).toContain('WIB');
    });

    it('run() is throttled and never throws', async () => {
      await queue(1);
      const t = new WaitlistInviter({ prisma, mailer, logger: silentLogger, slots: 1, registerUrl: 'https://x.test/r', now: () => clock, minIntervalMs: 60_000 });
      expect(await t.run()).toMatchObject({ invited: 1 });
      expect(await t.run()).toBeNull();
      const broken = { $queryRaw: async () => { throw new Error('db down'); } } as unknown as typeof prisma;
      expect(await new WaitlistInviter({ prisma: broken, mailer, logger: silentLogger, slots: 1, registerUrl: 'https://x.test/r', minIntervalMs: 0 }).run()).toBeNull();
    });
  });

  describe('slots in the API', () => {
    const userHeaders = async (email: string) => ({ authorization: `Bearer ${await auth.signToken({ sub: randomUUID(), email })}` });
    const create = (a: ReturnType<typeof app>, headers: Record<string, string>) =>
      a.inject({ method: 'POST', url: '/api/v1/instances', headers: { ...headers, 'idempotency-key': randomUUID() }, payload: { name: 'agent', planId: s.plan.id } });
    const counter = async (a: ReturnType<typeof app>) => (await a.inject({ method: 'GET', url: '/api/v1/public/beta-slots' })).json();

    it('holds the freed slot for the invited person: a stranger meets beta_full, the invitee is let in and becomes REGISTERED', async () => {
      const a = app({ freeBetaSlots: 1, mail: MAIL });
      await queue(1);
      const used = await holdSlot('other@example.test');
      await prisma.instance.update({ where: { id: used.id }, data: { status: 'DELETED' } });
      // The slot is free but p1 waits: a visitor cannot take it, the counter says 0.
      expect(await counter(a)).toEqual({ total: 1, remaining: 0 });
      const stranger = await userHeaders('stranger@example.test');
      expect((await create(a, stranger)).json().error.code).toBe('beta_full');

      await new WaitlistInviter({ prisma, mailer, logger: silentLogger, slots: 1, registerUrl: 'https://x.test/r' }).runOnce();
      expect(await status(1)).toBe('INVITED');
      expect(await counter(a)).toEqual({ total: 1, remaining: 0 });
      expect((await create(a, stranger)).json().error.code).toBe('beta_full');

      const invitee = await userHeaders('P1@Example.test');
      const plans = (await a.inject({ method: 'GET', url: '/api/v1/plans', headers: invitee })).json().plans as Array<{ slug: string }>;
      expect(plans.map((p) => p.slug)).toEqual(['test-small']);
      const made = await create(a, invitee);
      expect(made.statusCode).toBe(202);
      expect(await status(1)).toBe('REGISTERED');
      // The slot is used by the instance now, counted once.
      expect(await counter(a)).toEqual({ total: 1, remaining: 0 });
    });

    it('without mail the queue cannot invite, so a freed slot is not held back for the people waiting', async () => {
      const a = app({ freeBetaSlots: 1, mail: null });
      await queue(2);
      expect(await counter(a)).toEqual({ total: 1, remaining: 1 });
      expect((await create(a, await userHeaders('stranger@example.test'))).statusCode).toBe(202);
    });

    it('after the window an invitation holds nothing: the slot is open to anyone again', async () => {
      const a = app({ freeBetaSlots: 1, mail: MAIL });
      await prisma.waitlistEntry.create({
        data: { email: 'late@example.test', name: 'x', useCase: 'x', status: 'INVITED', invitedAt: new Date(Date.now() - 3 * 86_400_000), inviteExpiresAt: new Date(Date.now() - 86_400_000) },
      });
      expect(await counter(a)).toEqual({ total: 1, remaining: 1 });
    });
  });

  describe('admin view', () => {
    const adminGet = async (a: ReturnType<typeof app>, aal = 'aal2') =>
      a.inject({ method: 'GET', url: '/api/v1/admin/waitlist', headers: { authorization: `Bearer ${await auth.signToken({ email: BOSS, aal })}` } });

    it('lists the queue oldest first with counts, read only, for admins only', async () => {
      await queue(4);
      await prisma.waitlistEntry.update({ where: { email: 'p1@example.test' }, data: { status: 'REGISTERED', registeredAt: T0 } });
      await prisma.waitlistEntry.update({ where: { email: 'p2@example.test' }, data: { status: 'INVITED', invitedAt: new Date(Date.now() - 1000), inviteExpiresAt: new Date(Date.now() + 86_400_000) } });
      await prisma.waitlistEntry.update({ where: { email: 'p3@example.test' }, data: { status: 'INVITED', invitedAt: new Date(Date.now() - 3 * 86_400_000), inviteExpiresAt: new Date(Date.now() - 86_400_000) } });
      const a = app();
      const res = await adminGet(a);
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = res.json();
      expect(body.counts).toEqual({ unconfirmed: 0, waiting: 1, invited: 1, lapsed: 1, registered: 1 });
      expect(JSON.stringify(body)).not.toContain('confirmTokenHash');
      expect(body.entries.map((e: { email: string }) => e.email)).toEqual(['p1@example.test', 'p2@example.test', 'p3@example.test', 'p4@example.test']);
      expect(body.entries[2].lapsed).toBe(true);
      expect(body.entries[1].lapsed).toBe(false);
      // Nobody but an admin reads it.
      const other = await a.inject({ method: 'GET', url: '/api/v1/admin/waitlist', headers: { authorization: `Bearer ${await auth.signToken({ email: 'x@example.test' })}` } });
      expect(other.statusCode).toBe(403);
      expect((await a.inject({ method: 'GET', url: '/api/v1/admin/waitlist' })).statusCode).toBe(401);
      // There is no write route.
      expect((await a.inject({ method: 'DELETE', url: '/api/v1/admin/waitlist', headers: { authorization: `Bearer ${await auth.signToken({ email: BOSS, aal: 'aal2' })}` } })).statusCode).toBe(404);
    });
  });
});
