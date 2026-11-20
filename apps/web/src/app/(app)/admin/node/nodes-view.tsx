"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { PageHeader } from "@/components/app/page-header"
import { AdminTable, TableCell, TableHead, TableRow } from "@/components/app/admin-table"
import { useAdminNodes } from "@/hooks/use-admin"
import type { AdminHostUsage } from "@/lib/api/admin-types"
import { formatMb, formatRelative } from "@/lib/format"
import { hostRoom, isStale, percent, RAM_BUDGET } from "@/lib/host-capacity"

function Meter({ label, used, total, detail }: { label: string; used: number; total: number; detail?: string }) {
  const p = percent(used, total)
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-foreground">{label}</span>
        <span className="type-mono tabular-nums text-muted-foreground">
          {formatMb(used)} / {formatMb(total)} ({p} %)
        </span>
      </div>
      <Progress value={p} aria-label={`${label}: ${p} persen terpakai`} />
      {detail ? <span className="text-muted-foreground">{detail}</span> : null}
    </div>
  )
}

/** `now` is when the page fetched the snapshot, so render stays pure. */
function HostCapacity({ host, now }: { host: AdminHostUsage; now: number }) {
  const { perInstanceMb, room } = hostRoom(host)
  const stale = isStale(host.ts, now)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Kapasitas host</CardTitle>
        <CardDescription>
          Diperbarui {formatRelative(host.ts, now, "id")} oleh timer hermes-usage (tiap 5 menit).
          {stale ? " Data lama: periksa timer hermes-usage di VPS." : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <Meter
          label="RAM"
          used={host.memUsedMb}
          total={host.memTotalMb}
          detail={`${formatMb(host.memAvailableMb)} masih bisa dipakai. ${host.tenants} instance berjalan memakai ${formatMb(host.tenantMemMb)}.`}
        />
        <Meter label="Disk sistem" used={host.diskUsedMb} total={host.diskTotalMb} />
        <Meter label="Disk volume pelanggan" used={host.volumesUsedMb} total={host.volumesTotalMb} />
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-foreground">Beban CPU (1 menit)</span>
          <span className="type-mono tabular-nums text-muted-foreground">
            {host.load1.toLocaleString("id-ID")} dari {host.cpus} core
          </span>
        </div>
        <p className="text-muted-foreground">
          Perkiraan sisa ruang: <span className="type-mono text-foreground">{room}</span> instance lagi sampai RAM{" "}
          {Math.round(RAM_BUDGET * 100)} % (sekitar {formatMb(perInstanceMb)} per instance
          {host.tenants > 0 ? ", rata-rata instance yang berjalan" : ", ukuran instance idle yang terukur"}).
        </p>
      </CardContent>
    </Card>
  )
}

export function AdminNodesView() {
  const nodes = useAdminNodes()
  const host = nodes.data?.host ?? null

  return (
    <div className="grid gap-6">
      <PageHeader title="Node" description="Host yang menjalankan container pelanggan." />

      {host ? <HostCapacity host={host} now={nodes.dataUpdatedAt} /> : null}
      {nodes.data && !host ? (
        <p className="text-muted-foreground">
          Belum ada data kapasitas dari VPS. Timer hermes-usage belum menulis /var/lib/hermes-usage/node.json.
        </p>
      ) : null}

      <AdminTable
        what="node"
        rows={nodes.data?.nodes ?? []}
        queries={[nodes]}
        empty="Belum ada node terdaftar."
        caption="Daftar node"
        head={
          <>
            <TableHead scope="col">Nama</TableHead>
            <TableHead scope="col">Region</TableHead>
            <TableHead scope="col">Bisa dijadwalkan</TableHead>
            <TableHead scope="col">Instance</TableHead>
          </>
        }
        row={(n) => (
          <TableRow key={n.id}>
            <TableCell className="type-mono">{n.name}</TableCell>
            <TableCell className="type-mono text-muted-foreground">{n.region}</TableCell>
            <TableCell className="type-label">{n.schedulable ? "Ya" : "Tidak"}</TableCell>
            <TableCell className="type-mono">{n.instanceCount}</TableCell>
          </TableRow>
        )}
      />
    </div>
  )
}
