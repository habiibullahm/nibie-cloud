"use client"

import { PageHeader } from "@/components/app/page-header"
import { AdminTable, TableCell, TableHead, TableRow } from "@/components/app/admin-table"
import { useAdminNodes } from "@/hooks/use-admin"

export function AdminNodesView() {
  const nodes = useAdminNodes()

  return (
    <div className="grid gap-6">
      <PageHeader title="Node" description="Host yang menjalankan container pelanggan." />

      <AdminTable
        what="node"
        rows={nodes.data ?? []}
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
