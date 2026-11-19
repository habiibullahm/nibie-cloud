"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { PageHeader } from "@/components/app/page-header"
import { QueryFallback } from "@/components/app/query-fallback"
import { StatusBadge } from "@/components/app/status-badge"
import { useAdminOverview, useAdminSystem } from "@/hooks/use-admin"
import { instanceStatusId } from "@/lib/admin-format"
import type { BackendStatus } from "@/lib/api/types"
import { cn } from "@/lib/utils"

/** The number is the point of the tile, so it gets the heading size (not CardTitle, whose type-label would win in CSS). */
function Stat({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="grid gap-1 rounded-md border bg-card p-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="type-h1 tabular-nums">{value}</span>
      {hint ? <span className="text-muted-foreground">{hint}</span> : null}
    </div>
  )
}

/** "Mati" is drawn differently (dashed, muted) so a switch that is off stands out, not only by its word. */
function Switch({ label, on, detail }: { label: string; on: boolean; detail?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b py-2 last:border-b-0">
      <div className="min-w-0">
        <p className="text-foreground">{label}</p>
        {detail ? <p className="type-mono text-muted-foreground">{detail}</p> : null}
      </div>
      <span
        className={cn(
          "type-label shrink-0 rounded-sm border px-2 py-1",
          on ? "border-input text-foreground" : "border-dashed border-input text-muted-foreground"
        )}
        data-on={on}
      >
        {on ? "Nyala" : "Mati"}
      </span>
    </div>
  )
}

export function AdminOverviewView() {
  const overview = useAdminOverview()
  const system = useAdminSystem()

  if (overview.isPending || system.isPending || overview.error || system.error) {
    return <QueryFallback what="ringkasan" queries={[overview, system]} />
  }

  const c = overview.data!.counts
  const s = system.data!

  return (
    <div className="grid gap-8">
      <PageHeader title="Ringkasan" description="Keadaan Nibie Cloud saat ini, langsung dari backend." />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Tiket perlu dibalas" value={c.openTickets ?? 0} />
        <Stat label="Pelanggan" value={c.customers} />
        <Stat label="Instance" value={c.instances} hint={`${c.activeInstances} aktif`} />
        <Stat label="Langganan" value={c.subscriptions} />
        <Stat label="Pembayaran menunggu" value={c.pendingPayments} />
        <Stat label="Instance gagal" value={c.failedInstances} />
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Instance per status</CardTitle>
            <CardDescription>Status internal backend, apa adanya.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {Object.entries(overview.data!.byStatus).length === 0 ? (
              <p className="text-muted-foreground">Belum ada instance.</p>
            ) : (
              Object.entries(overview.data!.byStatus)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([status, count]) => (
                  <span key={status} className="flex items-center gap-2">
                    <StatusBadge status={status as BackendStatus} label={instanceStatusId(status)} />
                    <span className="type-mono text-muted-foreground">{count}</span>
                  </span>
                ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Saklar sistem</CardTitle>
            <CardDescription>Dibaca dari konfigurasi backend, bukan dari percobaan request.</CardDescription>
          </CardHeader>
          <CardContent className="grid">
            <Switch label="Penagihan" on={s.billing} detail={s.billingGateway ?? undefined} />
            <Switch label="NibieRouter" on={s.router} />
            <Switch label="Redis / antrean job" on={s.redis} />
            <Switch label="Email (SumoPod)" on={s.mail} />
            <Switch label="Customer API (Supabase)" on={s.customerApi} />
          </CardContent>
        </Card>
      </div>

      <p className="text-muted-foreground">
        {s.adminEmails === 0
          ? "Belum ada email admin yang diizinkan (ADMIN_EMAILS kosong)."
          : `${s.adminEmails} email admin diizinkan.`}
      </p>
    </div>
  )
}
