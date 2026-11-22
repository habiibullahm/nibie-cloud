import { isIP } from 'node:net';
import type { PrismaClient } from '@prisma/client';
import { AppError, NotFoundError, OutboundBlockedError, OutboundFailedError, RouterUnavailableError, ValidationError } from '../../shared/errors.js';
import type { Logger } from '../../shared/logger.js';
import { isForbiddenAddress } from '../net/ip-ranges.js';
import type { CatalogModel, ModelCatalog } from '../nibierouter/model-catalog.js';
import type { SecretStore } from '../secrets/secret-store.js';
import { defaultFetcher, type Fetcher } from './fetcher.js';

/** Public, not a secret. The key for it is attached by the operator (no service account to mint keys yet). */
export const NIBIEROUTER_BASE_URL = 'https://router.nibie.app/v1';
const PURPOSE = 'provider_api_key';
const MODEL_FORMAT = /^[A-Za-z0-9._:/@+-]{1,100}$/;
const KEY_FORMAT = /^[\x21-\x7e]{8,512}$/;
const MAX_URL_LENGTH = 200;
/** Public `/models` catalogues (e.g. NibieRouter ~72 KB, OpenRouter ~925 KB) exceed `defaultFetcher`'s 64 KB cap. */
const TEST_MAX_BYTES = 4 * 1024 * 1024;

export interface ProviderView {
  id: string;
  kind: 'BYOK' | 'NIBIEROUTER';
  baseUrl: string;
  model: string;
  status: 'UNTESTED' | 'OK' | 'FAILED';
  /** Last four characters of a customer-supplied key; null for the operator-attached NibieRouter key. */
  keyHint: string | null;
  lastTestedAt: Date | null;
  lastErrorCode: string | null;
  restartRequired: boolean;
}

export interface ByokInput {
  baseUrl: string;
  model: string;
  apiKey: string;
}

interface Deps {
  prisma: PrismaClient;
  secrets: SecretStore;
  logger: Logger;
  fetcher?: Fetcher;
  /** NibieRouter's model list. Without it the customer cannot choose a NibieRouter model (503 router_unavailable). */
  catalog?: ModelCatalog;
}

export class ProviderService {
  private readonly fetcher: Fetcher;
  constructor(private readonly d: Deps) {
    this.fetcher = d.fetcher ?? defaultFetcher;
  }

  async list(tenantId: string, instanceId: string): Promise<ProviderView[]> {
    const inst = await this.instance(tenantId, instanceId);
    const v = await this.view(instanceId, inst.configRevision > inst.appliedRevision);
    return v ? [v] : [];
  }

  async put(tenantId: string, instanceId: string, input: ByokInput): Promise<ProviderView> {
    const baseUrl = validateBaseUrl(input.baseUrl);
    const model = validateModel(input.model);
    const apiKey = validateKey(input.apiKey);
    await this.instance(tenantId, instanceId);
    return this.store(tenantId, instanceId, { kind: 'BYOK', baseUrl, model, apiKey });
  }

  /** Operator only. Replaces any existing provider config with NibieRouter. */
  async attachNibieRouter(tenantId: string, instanceId: string, input: { apiKey: string; model: string }): Promise<ProviderView> {
    const model = validateModel(input.model);
    const apiKey = validateKey(input.apiKey);
    await this.instance(tenantId, instanceId);
    return this.store(tenantId, instanceId, { kind: 'NIBIEROUTER', baseUrl: NIBIEROUTER_BASE_URL, model, apiKey });
  }

  /** The NibieRouter models this instance may choose. A free plan has a router balance of 0, so it gets the free models only. */
  async models(tenantId: string, instanceId: string): Promise<{ freeOnly: boolean; models: CatalogModel[] }> {
    const freeOnly = await this.onFreePlan(tenantId, instanceId);
    const all = await this.catalog().list();
    return { freeOnly, models: freeOnly ? all.filter((m) => m.free) : all };
  }

  /**
   * Changes the model of the instance's NibieRouter provider. The key stays; the revision is bumped so the next start
   * or restart writes the new `model:` block. Saving the model that is already set changes nothing.
   */
  async setModel(tenantId: string, instanceId: string, raw: unknown): Promise<ProviderView> {
    const model = validateModel(raw);
    const freeOnly = await this.onFreePlan(tenantId, instanceId);
    const cfg = await this.d.prisma.providerConfig.findUnique({ where: { instanceId }, select: { kind: true, model: true } });
    if (cfg?.kind !== 'NIBIEROUTER') throw new AppError('Only the NibieRouter provider has a model to choose here', 409, 'not_nibierouter');
    if (cfg.model !== model) {
      const offered = (await this.catalog().list()).find((m) => m.id === model);
      if (!offered) throw new ValidationError('NibieRouter does not offer this model');
      if (freeOnly && !offered.free) throw new ValidationError('A free plan can only use the free models');
      await this.d.prisma.$transaction(async (tx) => {
        await tx.instance.update({ where: { id: instanceId }, data: { configRevision: { increment: 1 } } });
        // The kind is checked again under the instance row lock: a BYOK key saved meanwhile must not get a router model.
        const { count } = await tx.providerConfig.updateMany({ where: { instanceId, kind: 'NIBIEROUTER' }, data: { model } });
        if (count === 0) throw new AppError('Only the NibieRouter provider has a model to choose here', 409, 'not_nibierouter');
      });
      this.d.logger.info({ instanceId, model }, 'nibierouter model changed');
    }
    const inst = await this.instance(tenantId, instanceId);
    return (await this.view(instanceId, inst.configRevision > inst.appliedRevision))!;
  }

  async remove(tenantId: string, instanceId: string, providerConfigId: string): Promise<{ restartRequired: boolean }> {
    await this.instance(tenantId, instanceId);
    await this.d.prisma.$transaction(async (tx) => {
      await tx.instance.update({ where: { id: instanceId }, data: { configRevision: { increment: 1 } } });
      const existing = await tx.providerConfig.findFirst({ where: { id: providerConfigId, instanceId } });
      if (!existing) throw new NotFoundError('Provider configuration not found'); // rolls the bump back
      await tx.providerConfig.delete({ where: { id: existing.id } });
      await this.d.secrets.revoke(tenantId, existing.secretId, tx);
    });
    const inst = await this.instance(tenantId, instanceId);
    return { restartRequired: inst.configRevision > inst.appliedRevision };
  }

  /**
   * Calls `GET {baseUrl}/models` with the stored key. The result only sets a coarse status and error code;
   * the upstream body is never stored or returned, and a provider problem never changes the instance (PRD 8.3).
   */
  async test(tenantId: string, instanceId: string): Promise<ProviderView> {
    const inst = await this.instance(tenantId, instanceId);
    const cfg = await this.d.prisma.providerConfig.findUnique({ where: { instanceId } });
    if (!cfg) throw new NotFoundError('Provider is not configured');
    const key = await this.d.secrets.get(tenantId, cfg.secretId);
    const record = (status: 'OK' | 'FAILED', code: string | null) =>
      this.d.prisma.providerConfig.update({ where: { id: cfg.id }, data: { status, lastErrorCode: code, lastTestedAt: new Date() } });

    let blocked = false;
    try {
      const res = await this.fetcher(`${cfg.baseUrl}/models`, {
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        maxBytes: TEST_MAX_BYTES,
      });
      if (res.status >= 200 && res.status < 300) await record('OK', null);
      else if (res.status === 401 || res.status === 403) await record('FAILED', 'unauthorized');
      else await record('FAILED', 'unexpected_status');
    } catch (e) {
      if (e instanceof OutboundBlockedError) {
        blocked = true;
        await record('FAILED', 'blocked');
      } else if (e instanceof OutboundFailedError) {
        await record('FAILED', e.reason === 'timeout' ? 'timeout' : 'unreachable');
      } else {
        await record('FAILED', 'unreachable');
      }
    }
    if (blocked) throw new OutboundBlockedError();
    return (await this.view(instanceId, inst.configRevision > inst.appliedRevision))!;
  }

  private async store(
    tenantId: string,
    instanceId: string,
    c: { kind: 'BYOK' | 'NIBIEROUTER'; baseUrl: string; model: string; apiKey: string },
  ): Promise<ProviderView> {
    await this.d.prisma.$transaction(async (tx) => {
      // First statement: the row lock serializes concurrent saves, so each one sees the other's result.
      await tx.instance.update({ where: { id: instanceId }, data: { configRevision: { increment: 1 } } });
      const existing = await tx.providerConfig.findUnique({ where: { instanceId } });
      const secret = await this.d.secrets.put({ tenantId, purpose: PURPOSE, plaintext: c.apiKey }, tx);
      const data = { kind: c.kind, baseUrl: c.baseUrl, model: c.model, secretId: secret.id, status: 'UNTESTED' as const, lastErrorCode: null, lastTestedAt: null };
      if (existing) {
        await tx.providerConfig.update({ where: { instanceId }, data });
        await this.d.secrets.revoke(tenantId, existing.secretId, tx);
      } else {
        await tx.providerConfig.create({ data: { instanceId, ...data } });
      }
    });
    this.d.logger.info({ instanceId, kind: c.kind }, 'provider configuration stored');
    const inst = await this.instance(tenantId, instanceId);
    return (await this.view(instanceId, inst.configRevision > inst.appliedRevision))!;
  }

  private async instance(tenantId: string, instanceId: string) {
    const inst = await this.d.prisma.instance.findFirst({ where: { id: instanceId, tenantId, deletedAt: null }, select: { id: true, configRevision: true, appliedRevision: true } });
    if (!inst) throw new NotFoundError('Instance not found');
    return inst;
  }

  /** Free means the instance's own plan has no price (an upgrade switches `planId` only once it is paid). */
  private async onFreePlan(tenantId: string, instanceId: string): Promise<boolean> {
    const inst = await this.d.prisma.instance.findFirst({ where: { id: instanceId, tenantId, deletedAt: null }, select: { plan: { select: { monthlyPriceIdr: true } } } });
    if (!inst) throw new NotFoundError('Instance not found');
    return inst.plan.monthlyPriceIdr === null;
  }

  private catalog(): ModelCatalog {
    if (!this.d.catalog) throw new RouterUnavailableError('unreachable');
    return this.d.catalog;
  }

  private async view(instanceId: string, restartRequired: boolean): Promise<ProviderView | null> {
    const c = await this.d.prisma.providerConfig.findUnique({ where: { instanceId }, include: { secret: { select: { keyHint: true } } } });
    if (!c) return null;
    return {
      id: c.id,
      kind: c.kind,
      baseUrl: c.baseUrl,
      model: c.model,
      status: c.status,
      keyHint: c.kind === 'BYOK' ? c.secret.keyHint : null,
      lastTestedAt: c.lastTestedAt,
      lastErrorCode: c.lastErrorCode,
      restartRequired,
    };
  }
}

function validateBaseUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) throw new ValidationError('baseUrl must be an https URL of at most 200 characters');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ValidationError('baseUrl must be an https URL');
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '') {
    throw new ValidationError('baseUrl must be an https URL without credentials, query or fragment');
  }
  // Only the standard https port: the test call must not become a way to probe other ports of public hosts.
  if (u.port !== '') throw new ValidationError('baseUrl must use the standard https port (443)');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0 ? isForbiddenAddress(host) : !host.includes('.')) throw new OutboundBlockedError();
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

function validateModel(raw: unknown): string {
  if (typeof raw !== 'string' || !MODEL_FORMAT.test(raw)) throw new ValidationError('model must be 1 to 100 characters: letters, digits and . _ : / @ + -');
  return raw;
}

function validateKey(raw: unknown): string {
  if (typeof raw !== 'string' || !KEY_FORMAT.test(raw)) throw new ValidationError('apiKey must be 8 to 512 printable characters without spaces');
  return raw;
}
