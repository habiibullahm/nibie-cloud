"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PageHeader } from "@/components/app/page-header"
import { QueryFallback } from "@/components/app/query-fallback"
import { StatusBadge } from "@/components/app/status-badge"
import { KeyValue } from "@/components/app/key-value"
import { useAdminCustomer } from "@/hooks/use-admin"
import { formatDateTimeId, formatIdr } from "@/lib/admin-format"
import type { BackendStatus } from "@/lib/api/types"

export function AdminCustomerView({ tenantId }: { tenantId: string }) {
  const q = useAdminCustomer(tenantId)

  if (q.isPending || q.error) return <QueryFallback what="pelanggan" queries={[q]} />

  const { customer, instances, subscriptions, payments } = q.data!

  return (
    <div className="grid gap-8">
      <PageHeader
        title={customer.email ?? "Tanpa akun"}
        description={`Tenant ${customer.tenantId}`}
        eyebrow={<Link href="/admin/pelanggan" className="no-underline hover:underline">← Pelanggan</Link>}
      />

      <Card>
        <CardHeader>
          <CardTitle>Akun</CardTitle>
        </CardHeader>
        <CardContent>
          <KeyValue
            items={[
              { k: "Email", v: customer.email ?? "—" },
              { k: "Nama tenant", v: customer.name },
              { k: "Terdaftar", v: formatDateTimeId(customer.createdAt) },
              { k: "Akun NibieRouter", v: customer.hasRouterUser ? "Ada" : "Belum ada" },
            ]}
          />
        </CardContent>
      </Card>

      <section className="grid gap-3">
        <h2 className="type-label text-foreground">Instance ({instances.length})</h2>
        {instances.length === 0 ? (
          <p className="text-muted-foreground">Belum ada instance.</p>
        ) : (
          <div className="grid gap-2">
            {instances.map((i) => (
              <Link
                key={i.id}
                href={`/admin/instance/${i.id}`}
                className="flex flex-wrap items-center justify-between gap-3 rounded-sm border bg-card px-4 py-3 no-underline transition-colors hover:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <span className="flex items-center gap-3">
                  <StatusBadge status={i.status as BackendStatus} />
                  <span className="text-foreground">{i.name}</span>
                  <span className="type-mono text-muted-foreground">{i.plan.slug} · {i.node.name}</span>
                </span>
                <span className="type-mono text-muted-foreground">{formatDateTimeId(i.createdAt)}</span>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="grid gap-3">
        <h2 className="type-label text-foreground">Langganan ({subscriptions.length})</h2>
        {subscriptions.length === 0 ? (
          <p className="text-muted-foreground">Belum ada langganan.</p>
        ) : (
          <ul className="grid gap-2">
            {subscriptions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 rounded-sm border px-4 py-3">
                <span className="flex flex-wrap items-center gap-3">
                  <span className="type-label">{s.status}</span>
                  <span className="type-mono text-muted-foreground">{s.plan.slug} · {formatIdr(s.plan.monthlyPriceIdr)}</span>
                </span>
                <span className="type-mono text-muted-foreground">
                  {s.currentPeriodEnd ? `sampai ${formatDateTimeId(s.currentPeriodEnd)}` : "belum aktif"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="grid gap-3">
        <h2 className="type-label text-foreground">Pembayaran ({payments.length})</h2>
        {payments.length === 0 ? (
          <p className="text-muted-foreground">Belum ada pembayaran.</p>
        ) : (
          <ul className="grid gap-2">
            {payments.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 rounded-sm border px-4 py-3">
                <span className="flex flex-wrap items-center gap-3">
                  <span className="type-label">{p.status}</span>
                  <span className="type-mono">{formatIdr(p.amountIdr)}</span>
                  <span className="type-mono text-muted-foreground">{p.purpose}</span>
                </span>
                <span className="type-mono text-muted-foreground">{formatDateTimeId(p.paidAt ?? p.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
