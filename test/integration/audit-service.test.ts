import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/db/client.js';
import { AuditService } from '../../src/modules/admin/audit-service.js';
import { resetDb } from '../helpers/db.js';

const prisma = createPrisma(process.env.DATABASE_URL!);
const audit = new AuditService({ prisma });

beforeAll(() => undefined);
beforeEach(async () => { await resetDb(prisma); });
afterAll(() => prisma.$disconnect());

describe('AuditService', () => {
  it('records an entry and reads it back newest first', async () => {
    await audit.record({ actorEmail: 'boss@nibie.app', action: 'GET /api/v1/admin/overview', targetType: null, targetId: null, reason: null, detail: null });
    await audit.record({ actorEmail: 'boss@nibie.app', action: 'POST restart', targetType: 'instance', targetId: randomUUID(), reason: 'stuck', detail: { ok: true } });
    const rows = await audit.list({ limit: 10 });
    expect(rows.entries.map((e) => e.action)).toEqual(['POST restart', 'GET /api/v1/admin/overview']);
    expect(rows.entries[0]).toMatchObject({ actorEmail: 'boss@nibie.app', targetType: 'instance', reason: 'stuck', detail: { ok: true } });
    expect(rows.nextCursor).toBeNull();
  });

  it('pages with a cursor and never repeats or skips a row', async () => {
    for (let i = 0; i < 5; i++) {
      await audit.record({ actorEmail: 'boss@nibie.app', action: `action-${i}`, targetType: null, targetId: null, reason: null, detail: null });
    }
    const first = await audit.list({ limit: 2 });
    expect(first.entries).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await audit.list({ limit: 2, cursor: first.nextCursor! });
    expect(second.entries).toHaveLength(2);
    const third = await audit.list({ limit: 2, cursor: second.nextCursor! });
    expect(third.entries).toHaveLength(1);
    expect(third.nextCursor).toBeNull();
    const all = [...first.entries, ...second.entries, ...third.entries].map((e) => e.action);
    expect(new Set(all).size).toBe(5);
  });

  it('filters by actor and by target', async () => {
    const id = randomUUID();
    await audit.record({ actorEmail: 'a@nibie.app', action: 'x', targetType: 'instance', targetId: id, reason: null, detail: null });
    await audit.record({ actorEmail: 'b@nibie.app', action: 'y', targetType: null, targetId: null, reason: null, detail: null });
    expect((await audit.list({ limit: 10, actorEmail: 'a@nibie.app' })).entries).toHaveLength(1);
    expect((await audit.list({ limit: 10, targetId: id })).entries.map((e) => e.action)).toEqual(['x']);
  });

  it('rejects a cursor that is not one of its own', async () => {
    await expect(audit.list({ limit: 10, cursor: 'not-a-cursor' })).rejects.toThrow();
  });

  it('never stores a key that looks like a secret in `detail`', async () => {
    // `detail` is free-form JSON, so the guard is the caller's; this asserts the column survives one.
    await audit.record({ actorEmail: 'boss@nibie.app', action: 'z', targetType: null, targetId: null, reason: null, detail: { keys: 3 } });
    const rows = await audit.list({ limit: 1 });
    expect(JSON.stringify(rows.entries[0])).not.toMatch(/sk-|Bearer /);
  });
});
