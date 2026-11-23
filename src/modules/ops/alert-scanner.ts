import type { PrismaClient } from '@prisma/client';
import type { Logger } from '../../shared/logger.js';
import { ADMIN_DENIED, ADMIN_SIGN_IN } from '../admin/audit-service.js';
import { maskEmail } from '../beta/invites.js';
import type { FailedJob } from '../jobs/types.js';
import { MAX_ATTEMPTS as ROUTER_MAX_ATTEMPTS } from '../nibierouter/router-provisioner.js';
import type { AlertStore } from './alert-store.js';
import type { AlertInput, Alerter } from './alerter.js';

const MIN = 60_000;
/** A condition must last this long before the operator is told, so the normal self-repair gets its chance first. */
const DEGRADED_AFTER_MS = 10 * MIN;
const FAILED_AFTER_MS = 2 * MIN;
const PAID_WITHOUT_INSTANCE_AFTER_MS = 15 * MIN;
const ROUTER_WARN_AT = 5;
/** Daily summary goes out from 09:00 WIB (02:00 UTC). */
const SUMMARY_FROM_UTC_HOUR = 2;
const RESOLVED_KEEP_DAYS = 30;
/** Admin sign-ins are reported for this long after the sign-in, so one missed scan never loses one. */
const ADMIN_SIGN_IN_WINDOW_MS = 30 * MIN;
const ADMIN_ACTIVITY_WINDOW_MS = 60 * MIN;
/** Data-changing admin actions by one account within an hour that look like a script or a stolen session, not a person. */
const ADMIN_BURST_AT = 30;

export interface AlertScannerDeps {
  prisma: PrismaClient;
  alerter: Alerter;
  store: AlertStore;
  logger: Logger;
  /** Failed queue jobs (exhausted retries). Omitted without a queue. */
  failedJobs?: () => Promise<FailedJob[]>;
  now?: () => Date;
  /** `run()` does nothing when called again sooner than this (the scheduler ticks every 15 s). Default 60 s. */
  minIntervalMs?: number;
}

export interface ScanSummary {
  checks: number;
  failedChecks: number;
  summarySent: boolean;
}

const short = (id: string): string => id;

/**
 * Derives operator alerts from the state the platform already records and reports them through the Alerter.
 * Each check lists the conditions that hold now; the Alerter sends new ones, repeats stale ones, and closes
 * the ones that are gone (with a recovery message). A check that cannot read its data neither raises nor
 * resolves anything, so a database blip never produces false "recovered" messages.
 */
export class AlertScanner {
  private lastRun = 0;
  private summaryDone: string | null = null;
  private readonly now: () => Date;

  constructor(private readonly d: AlertScannerDeps) {
    this.now = d.now ?? (() => new Date());
  }

  /** Throttled entry point for the scheduler. Never throws. */
  async run(): Promise<ScanSummary | null> {
    const t = Date.now();
    if (t - this.lastRun < (this.d.minIntervalMs ?? MIN)) return null;
    this.lastRun = t;
    try {
      return await this.scanOnce();
    } catch (e) {
      this.d.logger.error({ errName: (e as Error).name }, 'alert scan failed');
      return null;
    }
  }

  async scanOnce(): Promise<ScanSummary> {
    const sum: ScanSummary = { checks: 0, failedChecks: 0, summarySent: false };
    const checks: Array<[string, () => Promise<AlertInput[]>]> = [
      ['instance-degraded:', () => this.degradedInstances()],
      ['instance-failed:', () => this.failedInstances()],
      ['paid-no-instance:', () => this.paidWithoutInstance()],
      ['router-provisioning:', () => this.routerProvisioning()],
      ['credit-grant:', () => this.creditGrants()],
      ['disk-full:', () => this.fullDisks()],
      ['wallet-mismatch:', () => this.walletMismatches()],
      ['retired-copy:', () => this.unretiredDeletedCopies()],
      ['admin-signin:', () => this.adminSignIns()],
      ['admin-denied', () => this.adminDenied()],
      ['admin-burst', () => this.adminBursts()],
      ...(this.d.failedJobs ? [['job-failed:', () => this.failedQueueJobs()] as [string, () => Promise<AlertInput[]>]] : []),
    ];
    for (const [prefix, fn] of checks) {
      sum.checks += 1;
      let found: AlertInput[];
      try {
        found = await fn();
      } catch (e) {
        sum.failedChecks += 1;
        this.d.logger.error({ check: prefix, errName: (e as Error).name }, 'alert check could not read its data');
        continue;
      }
      for (const a of found) await this.d.alerter.raise(a);
      await this.d.alerter.resolveMissing(prefix, new Set(found.map((a) => a.key)));
    }
    sum.summarySent = await this.dailySummary();
    await this.d.store.purgeResolvedBefore(new Date(this.now().getTime() - RESOLVED_KEEP_DAYS * 86_400_000)).catch(() => undefined);
    return sum;
  }

  private async degradedInstances(): Promise<AlertInput[]> {
    const before = new Date(this.now().getTime() - DEGRADED_AFTER_MS);
    const rows = await this.d.prisma.instance.findMany({ where: { status: 'DEGRADED', updatedAt: { lte: before } }, take: 100, orderBy: { updatedAt: 'asc' } });
    return rows.map((i) => {
      const exhausted = i.statusReason === 'recovery_exhausted';
      return {
        key: `instance-degraded:${i.id}`,
        severity: exhausted ? 'CRITICAL' : 'WARNING',
        title: exhausted ? 'Agen pelanggan tidak bisa dipulihkan otomatis' : 'Agen pelanggan bermasalah lebih dari 10 menit',
        detail: `Instance ${short(i.id)}, tenant ${short(i.tenantId)}. Alasan: ${i.statusReason ?? 'tidak dicatat'}. Pemulihan otomatis ${exhausted ? 'sudah habis (3 percobaan)' : 'masih berjalan atau menunggu'}. Tindakan: lihat event instance ini lalu mulai ulang lewat API operator.`,
      };
    });
  }

  private async failedInstances(): Promise<AlertInput[]> {
    const before = new Date(this.now().getTime() - FAILED_AFTER_MS);
    const rows = await this.d.prisma.instance.findMany({
      where: { status: 'FAILED', updatedAt: { lte: before } }, take: 100, orderBy: { updatedAt: 'asc' },
      include: { subscription: { select: { status: true } } },
    });
    return rows.map((i) => {
      const paid = i.subscription !== null && (i.subscription.status === 'ACTIVE' || i.subscription.status === 'GRACE');
      return {
        key: `instance-failed:${i.id}`,
        severity: paid ? 'CRITICAL' : 'WARNING',
        title: paid ? 'Instance gagal dibuat padahal pelanggan sudah membayar' : 'Instance gagal dibuat',
        detail: `Instance ${short(i.id)}, tenant ${short(i.tenantId)}. Alasan: ${i.statusReason ?? 'tidak dicatat'}. Tindakan: periksa event instance; jika tidak bisa diperbaiki, siapkan pengembalian dana manual.`,
      };
    });
  }

  private async paidWithoutInstance(): Promise<AlertInput[]> {
    const before = new Date(this.now().getTime() - PAID_WITHOUT_INSTANCE_AFTER_MS);
    const rows = await this.d.prisma.payment.findMany({
      where: { status: 'PAID', paidAt: { lte: before }, subscription: { instanceId: null, status: { not: 'ENDED' } } },
      select: { subscriptionId: true, merchantOrderId: true, paidAt: true, subscription: { select: { tenantId: true } } },
      take: 50, orderBy: { paidAt: 'asc' },
    });
    return rows.map((p) => ({
      key: `paid-no-instance:${p.subscriptionId}`,
      severity: 'CRITICAL' as const,
      title: 'Pembayaran masuk tetapi instance belum ada',
      detail: `Langganan ${short(p.subscriptionId)}, tenant ${short(p.subscription.tenantId)}, order ${p.merchantOrderId}, dibayar lebih dari 15 menit lalu. Perbaikan otomatis mencoba lagi tiap 5 menit. Tindakan: jika masih ada setelah 30 menit, periksa log backend dan kapasitas VPS.`,
    }));
  }

  private async routerProvisioning(): Promise<AlertInput[]> {
    const rows = await this.d.prisma.routerProvisioning.findMany({ where: { status: 'PENDING', attempts: { gte: ROUTER_WARN_AT } }, take: 100 });
    return rows.map((r) => {
      const gaveUp = r.attempts >= ROUTER_MAX_ATTEMPTS;
      return {
        key: `router-provisioning:${r.instanceId}`,
        severity: gaveUp ? 'CRITICAL' : 'WARNING',
        title: gaveUp ? 'Kunci/kredit NibieRouter berhenti dicoba' : 'Kunci/kredit NibieRouter belum berhasil dibuat',
        detail: `Instance ${short(r.instanceId)}, ${r.attempts} percobaan, galat terakhir: ${r.lastError ?? 'tidak dicatat'}. ${gaveUp ? 'Tindakan: perbaiki penyebabnya (router, kunci admin) lalu atur ulang percobaan secara manual.' : 'Percobaan berlanjut tiap 5 menit.'}`,
      };
    });
  }

  private async creditGrants(): Promise<AlertInput[]> {
    const rows = await this.d.prisma.creditGrant.findMany({ where: { status: 'PENDING', attempts: { gte: ROUTER_WARN_AT } }, take: 100 });
    return rows.map((g) => ({
      key: `credit-grant:${g.subscriptionId ?? g.id}`,
      severity: 'WARNING' as const,
      title: 'Kredit NibieRouter pelanggan belum masuk',
      detail: `${g.subscriptionId ? `Langganan ${short(g.subscriptionId)}` : `Pembelian kredit AI dari saldo ${short(g.id)} (saldo sudah terpotong)`}, tenant ${short(g.tenantId)}, ${g.attempts} percobaan. Jangan memberi kredit dengan tangan sebelum memeriksa riwayat saldo (risiko kredit ganda).`,
    }));
  }

  private async fullDisks(): Promise<AlertInput[]> {
    const rows = await this.d.prisma.instance.findMany({ where: { diskLevel: 'full', status: { in: ['ACTIVE', 'DEGRADED', 'STOPPED'] } }, take: 100 });
    return rows.map((i) => ({
      key: `disk-full:${i.id}`,
      severity: 'WARNING' as const,
      title: 'Disk agen pelanggan penuh (99% kuota)',
      detail: `Instance ${short(i.id)}, tenant ${short(i.tenantId)}. Agen bisa berhenti berfungsi. Pelanggan melihat peringatan di dashboard; tidak ada tindakan wajib.`,
    }));
  }

  /** A wallet whose balance is not the sum of its ledger: something wrote one without the other. Never expected. */
  private async walletMismatches(): Promise<AlertInput[]> {
    const rows = await this.d.prisma.$queryRaw<{ tenantId: string; balanceIdr: number; ledgerIdr: bigint }[]>`
      SELECT w."tenantId", w."balanceIdr", COALESCE(SUM(e."amountIdr"), 0)::bigint AS "ledgerIdr"
      FROM "Wallet" w LEFT JOIN "WalletEntry" e ON e."tenantId" = w."tenantId"
      GROUP BY w."tenantId", w."balanceIdr"
      HAVING w."balanceIdr" <> COALESCE(SUM(e."amountIdr"), 0)
      LIMIT 50`;
    return rows.map((r) => ({
      key: `wallet-mismatch:${r.tenantId}`,
      severity: 'CRITICAL' as const,
      title: 'Saldo pelanggan tidak cocok dengan riwayatnya',
      detail: `Tenant ${short(r.tenantId)}: saldo Rp ${r.balanceIdr}, jumlah riwayat Rp ${Number(r.ledgerIdr)}. Tindakan: jangan ubah saldo dengan tangan; periksa WalletEntry dan log backend dulu.`,
    }));
  }

  private async failedQueueJobs(): Promise<AlertInput[]> {
    const jobs = await this.d.failedJobs!();
    return jobs.map((j) => ({
      key: `job-failed:${j.jobId}`,
      severity: 'WARNING' as const,
      title: `Job ${j.op} gagal setelah ${j.attempts} percobaan`,
      detail: `Instance ${short(j.instanceId)}, galat: ${j.reason}. Tindakan: cek instance, lalu coba ulang job lewat API operator (/jobs/failed).`,
    }));
  }

  private async unretiredDeletedCopies(): Promise<AlertInput[]> {
    const rows = await this.d.prisma.retiredRuntime.findMany({
      where: { instance: { status: 'DELETED' } },
      include: { node: { select: { name: true } }, instance: { select: { tenantId: true } } },
      take: 100,
    });
    return rows.map((r) => ({
      key: `retired-copy:${r.nodeId}:${r.instanceId}`,
      severity: 'WARNING' as const,
      title: 'Volume lama instance yang dihapus belum dibersihkan',
      detail: `Instance ${short(r.instanceId)}, tenant ${short(r.instance.tenantId)}, node ${r.node.name} (${r.storageMb} MiB). Tindakan: panggil POST /recovery/retire untuk node ${r.node.name} setelah host terhubung.`,
    }));
  }

  /** Every new admin session. Admins are few, so each sign-in is worth a line; one the admin did not make is the alarm. */
  private async adminSignIns(): Promise<AlertInput[]> {
    const rows = await this.d.prisma.auditLog.findMany({
      where: { action: ADMIN_SIGN_IN, createdAt: { gte: new Date(this.now().getTime() - ADMIN_SIGN_IN_WINDOW_MS) } },
      take: 50, orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => {
      const d = (r.detail ?? {}) as { network?: string | null };
      return {
        key: `admin-signin:${r.targetId ?? r.id}`,
        severity: 'INFO' as const,
        title: 'Admin masuk ke panel admin',
        detail: `Akun ${maskEmail(r.actorEmail)}, jaringan ${d.network ?? 'tidak diketahui'}, sesi ${r.targetId ?? '-'}. Jika ini bukan Anda atau admin lain: cabut akun dari ADMIN_EMAILS, keluarkan sesinya di Supabase, lalu periksa audit log.`,
      };
    });
  }

  /** Signed-in accounts that are not admins calling the admin API. The dashboard never does that for them. */
  private async adminDenied(): Promise<AlertInput[]> {
    const rows = await this.d.prisma.auditLog.findMany({
      where: { action: ADMIN_DENIED, createdAt: { gte: new Date(this.now().getTime() - ADMIN_ACTIVITY_WINDOW_MS) } },
      select: { actorEmail: true }, take: 200,
    });
    if (rows.length === 0) return [];
    const who = [...new Set(rows.map((r) => maskEmail(r.actorEmail)))];
    return [{
      key: 'admin-denied',
      severity: 'WARNING',
      title: 'Akun bukan admin mencoba membuka API admin',
      detail: `${who.length} akun dalam 1 jam terakhir: ${who.slice(0, 5).join(', ')}${who.length > 5 ? ', ...' : ''}. Akses ditolak. Tindakan: lihat audit log (aksi "${ADMIN_DENIED}"); nonaktifkan akun di Supabase jika berulang.`,
    }];
  }

  /** Many data-changing admin actions from one account in an hour. */
  private async adminBursts(): Promise<AlertInput[]> {
    const rows = await this.d.prisma.auditLog.groupBy({
      by: ['actorEmail'],
      where: {
        createdAt: { gte: new Date(this.now().getTime() - ADMIN_ACTIVITY_WINDOW_MS) },
        OR: ['POST ', 'PUT ', 'PATCH ', 'DELETE '].map((m) => ({ action: { startsWith: m } })),
      },
      _count: { _all: true },
    });
    const busy = rows.filter((r) => r._count._all >= ADMIN_BURST_AT);
    if (busy.length === 0) return [];
    return [{
      key: 'admin-burst',
      severity: 'WARNING',
      title: 'Banyak perubahan data oleh admin dalam 1 jam',
      detail: `${busy.map((r) => `${maskEmail(r.actorEmail)}: ${r._count._all} perubahan`).join('; ')}. Tindakan: pastikan ini disengaja; jika tidak, cabut kunci admin dan sesi akun itu lalu periksa audit log.`,
    }];
  }

  /** One INFO message per UTC day from 02:00 UTC. A missing message is itself a signal that the platform is down. */
  private async dailySummary(): Promise<boolean> {
    const now = this.now();
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() < SUMMARY_FROM_UTC_HOUR || this.summaryDone === day) return false;
    const key = `daily:${day}`;
    const earlier = await this.d.store.get(key);
    if (earlier?.lastSentAt) { this.summaryDone = day; return false; } // sent before a restart
    const { prisma } = this.d;
    const grouped = await prisma.instance.groupBy({ by: ['status'], _count: { _all: true }, where: { status: { notIn: ['DELETED'] } } });
    const n = (...s: string[]) => grouped.filter((g) => s.includes(g.status)).reduce((a, g) => a + g._count._all, 0);
    const paid = await prisma.payment.aggregate({
      where: { status: 'PAID', paidAt: { gte: new Date(now.getTime() - 86_400_000) } }, _count: { _all: true }, _sum: { amountIdr: true },
    });
    const open = await this.d.store.listOpen();
    const outcome = await this.d.alerter.raise({
      key, severity: 'INFO', title: `Ringkasan harian ${day}`,
      detail: [
        `Agen aktif: ${n('ACTIVE')}. Dihentikan: ${n('STOPPED', 'STOPPING')}. Bermasalah: ${n('DEGRADED', 'FAILED')}. Sedang diproses: ${n('PENDING', 'PROVISIONING', 'CONFIGURING', 'STARTING', 'DELETING')}.`,
        `Pembayaran 24 jam terakhir: ${paid._count._all} (Rp ${(paid._sum.amountIdr ?? 0).toLocaleString('id-ID')}).`,
        `Alert terbuka: ${open.filter((a) => !a.dedupeKey.startsWith('daily:')).length}.`,
        'Jika pesan ini tidak datang, anggap platform bermasalah.',
      ].join('\n'),
    });
    if (outcome === 'sent') {
      this.summaryDone = day;
      await this.d.store.resolve(key, now); // closed without a recovery message
      return true;
    }
    return false;
  }
}
