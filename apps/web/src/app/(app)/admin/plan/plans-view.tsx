"use client"

import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { PageHeader } from "@/components/app/page-header"
import { AdminTable, TableCell, TableHead, TableRow } from "@/components/app/admin-table"
import { useAdminPlans } from "@/hooks/use-admin"
import { formatIdr, formatUsd } from "@/lib/admin-format"
import { formatCpu, formatMb } from "@/lib/format"

export function AdminPlansView() {
  const plans = useAdminPlans()

  return (
    <div className="grid gap-6">
      <PageHeader title="Plan" description="Semua plan, termasuk yang tidak aktif atau belum dijual." />

      <AdminTable
        what="plan"
        rows={plans.data ?? []}
        queries={[plans]}
        empty="Belum ada plan."
        caption="Daftar plan"
        head={
          <>
            <TableHead scope="col">Slug</TableHead>
            <TableHead scope="col">Nama</TableHead>
            <TableHead scope="col">Aktif</TableHead>
            <TableHead scope="col">CPU</TableHead>
            <TableHead scope="col">Memori</TableHead>
            <TableHead scope="col">Disk</TableHead>
            <TableHead scope="col">PIDs</TableHead>
            <TableHead scope="col">Harga</TableHead>
            <TableHead scope="col">Kredit AI</TableHead>
          </>
        }
        row={(p) => (
          <TableRow key={p.id}>
            <TableCell className="type-mono">{p.slug}</TableCell>
            <TableCell>{p.name}</TableCell>
            <TableCell className="type-label">{p.active ? "Aktif" : "Nonaktif"}</TableCell>
            <TableCell className="type-mono">{formatCpu(p.cpuMillis)}</TableCell>
            <TableCell className="type-mono">{formatMb(p.memoryMb)}</TableCell>
            <TableCell className="type-mono">{formatMb(p.storageMb)}</TableCell>
            <TableCell className="type-mono">{p.pids}</TableCell>
            <TableCell className="type-mono">{formatIdr(p.monthlyPriceIdr)}</TableCell>
            <TableCell className="type-mono">{formatUsd(p.includedCreditUsd)}</TableCell>
          </TableRow>
        )}
      />

      <Card>
        <CardHeader>
          <CardTitle>Mengubah plan belum tersedia</CardTitle>
          <CardDescription>
            Edit harga dan plan (Fase B) butuh MFA TOTP dan alasan wajib. Untuk sekarang harga diubah lewat SQL oleh operator.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  )
}
