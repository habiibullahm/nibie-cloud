import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { RouterUnavailableError } from '../../shared/errors.js';
import type { Logger } from '../../shared/logger.js';
import type { ProviderService } from '../integrations/provider-service.js';
import type { NibieRouterClient, RouterConfig } from './nibierouter-client.js';

/** A run that keeps failing is left for an operator after this many attempts (the billing tick retries every 5 minutes). */
export const MAX_ATTEMPTS = 24;

export interface RouterProvisionerDeps {
  prisma: PrismaClient;
  client: NibieRouterClient;
  providers: Pick<ProviderService, 'attachNibieRouter'>;
  cfg: Pick<RouterConfig, 'defaultModel' | 'emailDomain'>;
  logger: Logger;
  /**
   * Makes a running instance pick up the key that was just attached (a restart recreates the container).
   * Its failure is logged and ignored: the key is stored, and the next start or restart applies it anyway.
   */
  applyConfig?: (tenantId: string, instanceId: string) => Promise<unknown>;
}

export type RunOutcome = 'done' | 'pending' | 'skipped';

class OrphanKeyError extends Error {}

/**
 * Gives a paid instance its AI provider: one NibieRouter user per tenant, a one-time credit grant for plans that
 * include one, and one API key per instance attached as the instance's NIBIEROUTER provider. Every step is
 * idempotent, so `run` can be repeated by the billing tick until it reaches DONE. A failure never touches the
 * payment or the instance: it only leaves the row PENDING with a short machine code.
 */
export class RouterProvisioner {
  constructor(private readonly d: RouterProvisionerDeps) {}

  /** Records that this instance needs provisioning (once) and tries it. Never throws. */
  async begin(input: { tenantId: string; instanceId: string; subscriptionId: string | null }): Promise<RunOutcome> {
    try {
      const row = await this.d.prisma.routerProvisioning.upsert({
        where: { instanceId: input.instanceId },
        create: { instanceId: input.instanceId, tenantId: input.tenantId, subscriptionId: input.subscriptionId },
        update: {},
      });
      // A free instance upgraded to a paid plan already has a row (its key, no subscription): link the subscription and run
      // it again, so the plan's one-time credit is granted. The key is kept (an instance with a provider gets no new one).
      if (input.subscriptionId && row.subscriptionId === null) {
        await this.d.prisma.routerProvisioning.update({
          where: { instanceId: input.instanceId },
          data: { subscriptionId: input.subscriptionId, status: 'PENDING', lastError: null, attempts: 0 },
        });
      }
    } catch (e) {
      this.d.logger.error({ errName: (e as Error).name }, 'router provisioning row could not be written');
      return 'pending';
    }
    return this.run(input.instanceId);
  }

  /**
   * The tick's entry point: rows that were never created (a crash after the instance was linked), free instances that
   * have no provider yet, and rows still pending.
   */
  async runPending(limit = 20): Promise<number> {
    const missing = await this.d.prisma.subscription.findMany({
      where: {
        instanceId: { not: null },
        status: { in: ['ACTIVE', 'GRACE', 'SUSPENDED'] },
        instance: { is: { status: { notIn: ['DELETING', 'DELETED'] } } },
      },
      select: { id: true, tenantId: true, instanceId: true },
      take: 200,
    });
    if (missing.length > 0) {
      const have = new Set(
        (await this.d.prisma.routerProvisioning.findMany({ where: { instanceId: { in: missing.map((m) => m.instanceId as string) } }, select: { instanceId: true } })).map((r) => r.instanceId),
      );
      for (const m of missing) {
        if (!have.has(m.instanceId as string)) {
          await this.d.prisma.routerProvisioning.create({ data: { instanceId: m.instanceId as string, tenantId: m.tenantId, subscriptionId: m.id } }).catch(() => undefined);
        }
      }
    }
    await this.recordFreeInstances();
    const rows = await this.d.prisma.routerProvisioning.findMany({
      where: { status: 'PENDING', attempts: { lt: MAX_ATTEMPTS } },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });
    let done = 0;
    for (const r of rows) if ((await this.run(r.instanceId)) !== 'pending') done += 1;
    return done;
  }

  /**
   * Fast path for free instances that just became ACTIVE, meant for every maintenance run (15 s) rather than the 5-minute
   * billing tick, so a new free agent has its key within seconds. Each new row is tried once here; a failure stays PENDING
   * and is retried by `runPending` at the slower pace, so a router outage does not use up the attempts. Never throws.
   */
  async runNewFree(): Promise<number> {
    let created: string[];
    try {
      created = await this.recordFreeInstances();
    } catch (e) {
      this.d.logger.error({ errName: (e as Error).name }, 'free instances could not be listed for router provisioning');
      return 0;
    }
    let done = 0;
    for (const id of created) if ((await this.run(id)) !== 'pending') done += 1;
    return done;
  }

  /**
   * NibieRouter is the default provider for free beta instances too (owner decision, 2026-11-17). An instance on a plan
   * without a price that is ACTIVE and has no provider gets a row (no subscription, so no credit); `run` then attaches a
   * key with the default model and restarts it. Only ACTIVE ones: a restart is what applies the key, and an instance that
   * is still provisioning would refuse it. A row is made once per instance, so a provider the customer removes later is
   * not put back. Returns the instance ids that got a new row.
   */
  private async recordFreeInstances(): Promise<string[]> {
    const free = await this.d.prisma.instance.findMany({
      where: { status: 'ACTIVE', plan: { monthlyPriceIdr: null }, provider: { is: null } },
      select: { id: true, tenantId: true },
      take: 200,
    });
    if (free.length === 0) return [];
    const have = new Set(
      (await this.d.prisma.routerProvisioning.findMany({ where: { instanceId: { in: free.map((f) => f.id) } }, select: { instanceId: true } })).map((r) => r.instanceId),
    );
    const created: string[] = [];
    for (const f of free) {
      if (!have.has(f.id)) {
        const ok = await this.d.prisma.routerProvisioning
          .create({ data: { instanceId: f.id, tenantId: f.tenantId, subscriptionId: null } })
          .then(() => true, () => false);
        if (ok) created.push(f.id);
      }
    }
    return created;
  }

  async run(instanceId: string): Promise<RunOutcome> {
    const row = await this.d.prisma.routerProvisioning.findUnique({ where: { instanceId } });
    if (!row || row.status === 'DONE') return 'done';
    try {
      const outcome = await this.runSteps(row);
      await this.d.prisma.routerProvisioning.update({ where: { instanceId }, data: { status: 'DONE', lastError: null, attempts: { increment: 1 } } });
      return outcome;
    } catch (e) {
      const code = e instanceof OrphanKeyError ? 'orphan_key' : e instanceof RouterUnavailableError ? `router_${e.reason}` : 'internal';
      await this.d.prisma.routerProvisioning
        .update({ where: { instanceId }, data: { lastError: code, attempts: { increment: 1 } } })
        .catch(() => undefined);
      this.d.logger.warn({ instanceId, code }, 'router provisioning will be retried');
      return 'pending';
    }
  }

  private async runSteps(row: { instanceId: string; tenantId: string; subscriptionId: string | null }): Promise<RunOutcome> {
    const instance = await this.d.prisma.instance.findUnique({ where: { id: row.instanceId }, select: { id: true, tenantId: true, status: true } });
    if (!instance || instance.status === 'DELETING' || instance.status === 'DELETED') return 'skipped';

    // An instance that already has a provider (the customer's own, or ours from an earlier run) is never replaced.
    const hasProvider = (await this.d.prisma.providerConfig.findUnique({ where: { instanceId: row.instanceId }, select: { id: true } })) !== null;
    const grant = row.subscriptionId ? await this.creditToGrant(row.subscriptionId) : null;
    if (hasProvider && !grant) return 'done';

    const userId = await this.ensureUser(row.tenantId);
    if (!hasProvider) await this.ensureKey(userId, row.tenantId, row.instanceId);
    if (grant) await this.ensureCredit(userId, row.tenantId, grant);
    return 'done';
  }

  private async creditToGrant(subscriptionId: string): Promise<{ subscriptionId: string; amountNano: bigint } | null> {
    const sub = await this.d.prisma.subscription.findUnique({ where: { id: subscriptionId }, select: { plan: { select: { includedCreditNano: true } } } });
    const amount = sub?.plan.includedCreditNano;
    return amount && amount > 0n ? { subscriptionId, amountNano: amount } : null;
  }

  /** One router user per tenant. The advisory lock keeps two workers from creating two. */
  private async ensureUser(tenantId: string): Promise<string> {
    return this.d.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'router-user:' + tenantId}))`;
        const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { routerUserId: true } });
        if (tenant.routerUserId) return tenant.routerUserId;
        // The customer never signs in to the router: a synthetic address and a random password that is not kept.
        const user = await this.d.client.createUser({
          email: `t-${tenantId}@${this.d.cfg.emailDomain}`,
          password: randomBytes(24).toString('base64url'),
          name: `Nibie Cloud ${tenantId.slice(0, 8)}`,
        });
        await tx.tenant.update({ where: { id: tenantId }, data: { routerUserId: user.id } });
        return user.id;
      },
      { maxWait: 30_000, timeout: 30_000 },
    );
  }

  private async ensureKey(userId: string, tenantId: string, instanceId: string): Promise<void> {
    const name = `inst-${instanceId}`;
    // A key with this name that we hold no secret for: the router shows a secret only once, so a duplicate is
    // never created silently. An operator revokes the orphan in the NibieRouter dashboard, then the next run proceeds.
    if ((await this.d.client.listKeys(userId)).some((k) => k.name === name && !k.revoked)) throw new OrphanKeyError();
    const key = await this.d.client.createKey(userId, { name });
    await this.d.providers.attachNibieRouter(tenantId, instanceId, { apiKey: key.secret, model: this.d.cfg.defaultModel });
    try {
      await this.d.applyConfig?.(tenantId, instanceId);
    } catch (e) {
      this.d.logger.warn({ instanceId, errName: (e as Error).name }, 'instance not restarted after attaching the router key; the next restart applies it');
    }
  }

  /** Exactly once: see `CreditGrant` in the Prisma schema. */
  private async ensureCredit(userId: string, tenantId: string, g: { subscriptionId: string; amountNano: bigint }): Promise<void> {
    const note = `nibie-cloud credit ${g.subscriptionId}`;
    const row = await this.d.prisma.creditGrant.upsert({
      where: { subscriptionId: g.subscriptionId },
      create: { tenantId, subscriptionId: g.subscriptionId, amountNano: g.amountNano, note },
      update: {},
    });
    if (row.status === 'DONE') return;
    // An earlier attempt may have reached the router and only its answer got lost: look before posting again.
    if (row.attempts > 0 && (await this.d.client.hasCreditNote(userId, row.note))) {
      await this.d.prisma.creditGrant.update({ where: { id: row.id }, data: { status: 'DONE' } });
      return;
    }
    // Raised before the call, so a crash after the call leaves a trace and the next run checks the history first.
    await this.d.prisma.creditGrant.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
    const { balanceNano } = await this.d.client.grantCredit(userId, row.amountNano, row.note);
    await this.d.prisma.creditGrant.update({ where: { id: row.id }, data: { status: 'DONE', balanceAfterNano: balanceNano } });
  }
}
