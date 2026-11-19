import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/db/client.js';
import { buildServer } from '../../src/http/server.js';
import { AuditService } from '../../src/modules/admin/audit-service.js';
import { IdentityService } from '../../src/modules/auth/identity-service.js';
import type { Mailer, MailMessage } from '../../src/modules/billing/mailer.js';
import { InstanceService } from '../../src/modules/instances/instance-service.js';
import { createTestAuth, testConfig } from '../helpers/auth.js';
import { resetDb } from '../helpers/db.js';
import { FakeRuntime } from '../helpers/fake-runtime.js';
import { TEST_MASTER_KEY, seed, silentLogger } from '../helpers/service-env.js';

const prisma = createPrisma(process.env.DATABASE_URL!);
const IMAGE = 'hermes-stub:0.2.0';
const BOSS = 'boss@nibie.app';
const ALICE = 'alice@example.test';
const EVE = 'eve@example.test';

let auth: Awaited<ReturnType<typeof createTestAuth>>;
let sent: MailMessage[];

function app() {
  const mailer: Mailer = { enabled: true, send: async (m) => { sent.push(m); } };
  const service = new InstanceService({ prisma, runtime: new FakeRuntime(), image: IMAGE, production: false, logger: silentLogger, masterKey: TEST_MASTER_KEY, diskQuota: 'off', egressPolicy: 'off' });
  return buildServer({
    service, logger: silentLogger, mailer,
    config: testConfig(IMAGE, TEST_MASTER_KEY, { adminEmails: [BOSS], dashboardOrigin: 'https://cloud.example.test' }),
    customer: { verify: auth.verify, identity: new IdentityService({ prisma }), prisma },
    admin: { verify: auth.verify, prisma, audit: new AuditService({ prisma }) },
  });
}

/** One token per person for the whole test, so the same `sub` maps to the same tenant. */
const subs = new Map<string, string>();
const as = async (email: string, aal = 'aal2') => {
  if (!subs.has(email)) subs.set(email, randomUUID());
  return { authorization: `Bearer ${await auth.signToken({ sub: subs.get(email)!, email, aal })}` };
};
type A = ReturnType<typeof app>;
const post = async (a: A, email: string, url: string, payload: object) => a.inject({ method: 'POST', url, headers: await as(email), payload });
const get = async (a: A, email: string, url: string) => a.inject({ method: 'GET', url, headers: await as(email) });
const open = (a: A, email: string, body: object = {}) =>
  post(a, email, '/api/v1/support/tickets', { subject: 'Bot tidak menjawab', category: 'TECHNICAL', message: 'Sejak tadi pagi\nbot diam.', ...body });

describe('support tickets', () => {
  beforeAll(async () => { auth = await createTestAuth(); });
  beforeEach(async () => { await resetDb(prisma); sent = []; subs.clear(); });
  afterAll(() => prisma.$disconnect());

  it('a customer opens a ticket; the support inbox gets an email; other tenants cannot see it', async () => {
    const a = app();
    await prisma.supportContact.create({ data: { id: 1, email: 'support@nibie.app' } });
    const res = await open(a, ALICE);
    expect(res.statusCode).toBe(201);
    const t = res.json().ticket as { id: string; status: string; subject: string };
    expect(t).toMatchObject({ status: 'OPEN', subject: 'Bot tidak menjawab' });
    expect(sent.map((m) => [m.to, m.subject])).toEqual([['support@nibie.app', 'Tiket baru: Bot tidak menjawab']]);
    expect(sent[0]!.text).toContain(`https://cloud.example.test/dashboard/admin/tiket/${t.id}`);

    expect((await get(a, ALICE, '/api/v1/support/tickets')).json().tickets).toHaveLength(1);
    expect((await get(a, EVE, '/api/v1/support/tickets')).json().tickets).toHaveLength(0);
    expect((await get(a, EVE, `/api/v1/support/tickets/${t.id}`)).statusCode).toBe(404);
    expect((await post(a, EVE, `/api/v1/support/tickets/${t.id}/messages`, { message: 'hi' })).statusCode).toBe(404);
    expect((await post(a, EVE, `/api/v1/support/tickets/${t.id}/close`, {})).statusCode).toBe(404);
  });

  it('runs the thread: admin reply (ANSWERED, customer emailed, audited), customer reply (OPEN), close, reopen', async () => {
    const a = app();
    const t = (await open(a, ALICE)).json().ticket as { id: string };
    sent = [];

    const reply = await post(a, BOSS, `/api/v1/admin/tickets/${t.id}/messages`, { message: 'Sudah kami restart, coba lagi ya.' });
    expect(reply.statusCode).toBe(200);
    expect(reply.json().ticket.status).toBe('ANSWERED');
    expect(sent.map((m) => [m.to, m.subject])).toEqual([[ALICE, 'Balasan untuk tiket: Bot tidak menjawab']]);
    expect(sent[0]!.text).toContain(`https://cloud.example.test/dashboard/support/tickets/${t.id}`);
    const audits = await prisma.auditLog.findMany({ where: { targetType: 'ticket', targetId: t.id } });
    expect(audits.map((r) => [r.actorEmail, r.action])).toEqual([[BOSS, 'POST /tickets/:ticketId/messages']]);
    // The reply text lives in the ticket only, not in the audit trail.
    expect(JSON.stringify(audits[0]!.detail)).not.toContain('restart');

    sent = [];
    // No support email set: the team email goes to the first admin.
    expect((await post(a, ALICE, `/api/v1/support/tickets/${t.id}/messages`, { message: 'Masih diam.' })).json().ticket.status).toBe('OPEN');
    expect(sent.map((m) => [m.to, m.subject])).toEqual([[BOSS, 'Balasan pelanggan: Bot tidak menjawab']]);

    expect((await post(a, ALICE, `/api/v1/support/tickets/${t.id}/close`, {})).json().ticket.status).toBe('CLOSED');
    expect((await post(a, ALICE, `/api/v1/support/tickets/${t.id}/messages`, { message: 'Muncul lagi.' })).json().ticket.status).toBe('OPEN');

    const detail = (await get(a, ALICE, `/api/v1/support/tickets/${t.id}`)).json().ticket as { messages: { author: string; body: string }[] };
    expect(detail.messages.map((m) => m.author)).toEqual(['CUSTOMER', 'ADMIN', 'CUSTOMER', 'CUSTOMER']);
    expect(detail.messages[0]!.body).toBe('Sejak tadi pagi\nbot diam.');

    const adminList = (await get(a, BOSS, '/api/v1/admin/tickets?status=OPEN')).json().tickets as { id: string; createdByEmail: string }[];
    expect(adminList.map((x) => [x.id, x.createdByEmail])).toEqual([[t.id, ALICE]]);
    expect((await get(a, BOSS, '/api/v1/admin/overview')).json().counts.openTickets).toBe(1);
    expect((await post(a, BOSS, `/api/v1/admin/tickets/${t.id}/close`, {})).json().ticket.status).toBe('CLOSED');
  });

  it('links only the customer\'s own instance and refuses bad input', async () => {
    const a = app();
    await get(a, ALICE, '/api/v1/me');
    const eveTenant = (await get(a, EVE, '/api/v1/me')).json().tenantId as string;
    const s = await seed(prisma);
    const eveInstance = await prisma.instance.create({ data: { tenantId: eveTenant, planId: s.plan.id, nodeId: s.node.id, name: 'eve-bot', idempotencyKey: randomUUID(), image: IMAGE } });
    expect((await open(a, ALICE, { instanceId: eveInstance.id })).statusCode).toBe(404);
    expect((await open(a, EVE, { instanceId: eveInstance.id })).json().ticket.instance).toEqual({ id: eveInstance.id, name: 'eve-bot' });

    // A fresh person: opening is limited to 5 per 10 minutes, refused attempts included.
    for (const body of [{ subject: 'x' }, { category: 'SALES' }, { message: '' }, { subject: 'line\nbreak' }, { extra: 1 }]) {
      expect((await open(a, 'bob@example.test', body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await open(a, 'bob@example.test')).statusCode).toBe(429);
    expect((await get(a, ALICE, '/api/v1/admin/tickets')).statusCode).toBe(403);
  });

  it('is forwarded by the production proxy', () => {
    const caddy = readFileSync(new URL('../../deploy/Caddyfile', import.meta.url), 'utf8');
    const paths = (/@public \{\s*path ([^\n]+)/.exec(caddy)?.[1] ?? '').split(/\s+/);
    expect(paths).toEqual(expect.arrayContaining(['/api/v1/support/tickets', '/api/v1/support/tickets/*']));
  });
});
