"use client"

import { PageHeader } from "@/components/app/page-header"
import { AdminTable, TableCell, TableHead, TableRow } from "@/components/app/admin-table"
import { useAdminAudit } from "@/hooks/use-admin"
import { formatDateTimeId } from "@/lib/admin-format"

/** The audit trail: who did what, and (for a change) why. Read-only in Fase A. */
export function AdminAuditView() {
  const audit = useAdminAudit()

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Audit"
        description="Setiap panggilan panel admin dicatat: siapa, aksi apa, dan kapan. Perubahan data (Fase B) juga mencatat alasan."
      />

      <AdminTable
        what="audit"
        rows={audit.data?.items ?? []}
        queries={[audit]}
        empty="Belum ada aktivitas admin."
        caption="Catatan audit admin"
        head={
          <>
            <TableHead scope="col">Waktu</TableHead>
            <TableHead scope="col">Admin</TableHead>
            <TableHead scope="col">Aksi</TableHead>
            <TableHead scope="col">Target</TableHead>
            <TableHead scope="col">Alasan</TableHead>
          </>
        }
        row={(e) => (
          <TableRow key={e.id}>
            <TableCell className="type-mono text-muted-foreground">{formatDateTimeId(e.createdAt)}</TableCell>
            <TableCell>{e.actorEmail}</TableCell>
            <TableCell className="type-mono">{e.action}</TableCell>
            <TableCell className="type-mono text-muted-foreground">{e.targetId ?? "—"}</TableCell>
            <TableCell className="text-muted-foreground">{e.reason ?? "—"}</TableCell>
          </TableRow>
        )}
      />
    </div>
  )
}
