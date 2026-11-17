"use client"

import Link from "next/link"
import { CircleX } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { PageHeader } from "@/components/app/page-header"
import { QueryFallback } from "@/components/app/query-fallback"
import { StatusBadge } from "@/components/app/status-badge"
import { KeyValue } from "@/components/app/key-value"
import { useAdminInstance } from "@/hooks/use-admin"
import {
  EMPTY,
  formatBytesId,
  formatDateTimeId,
  instanceStatusId,
  integrationStatusId,
  providerKindId,
} from "@/lib/admin-format"
import { formatCpu, formatMb } from "@/lib/format"
import type { BackendStatus } from "@/lib/api/types"

export function AdminInstanceView({ instanceId }: { instanceId: string }) {
  const q = useAdminInstance(instanceId)

  if (q.isPending || q.error) return <QueryFallback what="instance" queries={[q]} />

  const { instance, events } = q.data!
  const i = instance

  return (
    <div className="grid gap-8">
      <PageHeader
        title={i.name}
        description={`Tenant ${i.tenantId}`}
        eyebrow={
          <>
            <Link href="/admin/instance" className="no-underline hover:underline">
              ← Instance
            </Link>
            {i.email ? (
              <>
                <span aria-hidden="true">·</span>
                <Link href={`/admin/pelanggan/${i.tenantId}`} className="no-underline hover:underline">
                  {i.email}
                </Link>
              </>
            ) : null}
          </>
        }
        actions={<StatusBadge status={i.status as BackendStatus} label={instanceStatusId(i.status)} />}
      />

      {/* Readable text colour; the icon and the border carry the alert (destructive text is under 4.5:1 here). */}
      {i.statusReason ? (
        <p className="flex items-start gap-2 rounded-sm border border-destructive px-4 py-3 text-foreground">
          <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
          <span className="min-w-0 break-words">Alasan: {i.statusReason}</span>
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Keadaan</CardTitle>
            <CardDescription>Dibaca langsung dari baris database.</CardDescription>
          </CardHeader>
          <CardContent>
            <KeyValue
              items={[
                { k: "Instance ID", v: <span className="type-mono">{i.id}</span> },
                { k: "Dibuat", v: formatDateTimeId(i.createdAt) },
                { k: "Diperbarui", v: formatDateTimeId(i.updatedAt) },
                { k: "Health terakhir", v: formatDateTimeId(i.lastHealthAt) },
                { k: "Port host", v: <span className="type-mono">{i.hostPort ?? EMPTY}</span> },
                { k: "Image", v: <span className="type-mono break-all">{i.image}</span> },
                { k: "Disk terpakai", v: `${formatBytesId(i.diskUsedBytes)} (${i.diskLevel})` },
                { k: "Kegagalan berturut", v: String(i.consecutiveFailures) },
                { k: "Percobaan pemulihan", v: String(i.recoveryAttempts) },
                { k: "Config revision", v: <span className="type-mono">{i.configRevision} / diterapkan {i.appliedRevision}</span> },
              ]}
            />
          </CardContent>
        </Card>

        <div className="grid gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Plan &amp; node</CardTitle>
            </CardHeader>
            <CardContent>
              <KeyValue
                items={[
                  { k: "Plan", v: `${i.plan.name} (${i.plan.slug})` },
                  { k: "CPU", v: formatCpu(i.plan.cpuMillis) },
                  { k: "Memori", v: formatMb(i.plan.memoryMb) },
                  { k: "Disk", v: formatMb(i.plan.storageMb) },
                  { k: "PIDs", v: String(i.plan.pids) },
                  { k: "Node", v: `${i.node.name} (${i.node.region})` },
                ]}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Provider &amp; Telegram</CardTitle>
              <CardDescription>Hanya jenis dan statusnya; kuncinya tidak pernah dikirim ke UI.</CardDescription>
            </CardHeader>
            <CardContent>
              {i.provider || i.telegram ? (
                <KeyValue
                  items={[
                    ...(i.provider
                      ? [
                          { k: "Provider", v: `${providerKindId(i.provider.kind)} · ${i.provider.model}` },
                          { k: "Status provider", v: integrationStatusId(i.provider.status) },
                          { k: "Base URL", v: <span className="type-mono break-all">{i.provider.baseUrl}</span> },
                        ]
                      : []),
                    ...(i.telegram
                      ? [
                          { k: "Telegram", v: `@${i.telegram.botUsername}` },
                          { k: "Status Telegram", v: integrationStatusId(i.telegram.status) },
                        ]
                      : []),
                  ]}
                />
              ) : (
                <p className="text-muted-foreground">Belum ada provider atau bot Telegram.</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <section className="grid gap-3">
        <h2 className="type-label text-foreground">Riwayat kejadian ({events.length})</h2>
        {events.length === 0 ? (
          <p className="text-muted-foreground">Belum ada kejadian.</p>
        ) : (
          <ul className="grid gap-2">
            {events.map((e) => (
              <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-3 rounded-sm border px-4 py-3">
                <span className="flex flex-wrap items-baseline gap-3">
                  <span className="type-mono text-muted-foreground">{formatDateTimeId(e.createdAt)}</span>
                  <span className="type-label">{e.type}</span>
                </span>
                <span className="min-w-0 break-words text-muted-foreground">{e.message}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
