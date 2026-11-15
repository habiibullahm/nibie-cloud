"use client"

import Link from "next/link"
import { useState } from "react"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { PageHeader } from "@/components/app/page-header"
import { StatusBadge } from "@/components/app/status-badge"
import { AdminTable, TableCell, TableHead, TableRow } from "@/components/app/admin-table"
import { useAdminInstances } from "@/hooks/use-admin"
import { formatBytesId, formatDateTimeId } from "@/lib/admin-format"
import { BACKEND_STATUSES, type BackendStatus } from "@/lib/api/types"

const ALL = "semua"

export function AdminInstancesView() {
  const [status, setStatus] = useState<string>(ALL)
  const instances = useAdminInstances(status === ALL ? "" : status)

  return (
    <div className="grid gap-6">
      <PageHeader title="Instance" description="Semua instance dari semua tenant." />

      <div className="grid max-w-xs gap-2">
        <Label htmlFor="admin-instance-status">Status</Label>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger id="admin-instance-status" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Semua status</SelectItem>
            {BACKEND_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <AdminTable
        what="instance"
        rows={instances.data?.items ?? []}
        queries={[instances]}
        empty="Tidak ada instance dengan status itu."
        caption="Daftar instance"
        head={
          <>
            <TableHead scope="col">Status</TableHead>
            <TableHead scope="col">Nama</TableHead>
            <TableHead scope="col">Pemilik</TableHead>
            <TableHead scope="col">Plan</TableHead>
            <TableHead scope="col">Node</TableHead>
            <TableHead scope="col">Disk</TableHead>
            <TableHead scope="col">Dibuat</TableHead>
          </>
        }
        row={(i) => (
          <TableRow key={i.id}>
            <TableCell>
              <StatusBadge status={i.status as BackendStatus} />
            </TableCell>
            <TableCell>
              <Link href={`/admin/instance/${i.id}`} className="no-underline hover:underline">
                {i.name}
              </Link>
            </TableCell>
            <TableCell className="text-muted-foreground">{i.email ?? "—"}</TableCell>
            <TableCell className="type-mono">{i.plan}</TableCell>
            <TableCell className="type-mono">{i.node}</TableCell>
            <TableCell className="type-mono">{formatBytesId(i.diskUsedBytes)}</TableCell>
            <TableCell className="type-mono text-muted-foreground">{formatDateTimeId(i.createdAt)}</TableCell>
          </TableRow>
        )}
      />
    </div>
  )
}
