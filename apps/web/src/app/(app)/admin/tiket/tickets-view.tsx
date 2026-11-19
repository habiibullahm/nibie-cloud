"use client"

import Link from "next/link"
import { useState } from "react"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { PageHeader } from "@/components/app/page-header"
import { AdminTable, TableCell, TableHead, TableRow } from "@/components/app/admin-table"
import { TicketStatusChip } from "@/components/app/ticket-thread"
import { useAdminTickets } from "@/hooks/use-admin"
import { formatDateTimeId } from "@/lib/admin-format"
import type { TicketStatus } from "@/lib/api/tickets"
import { ADMIN_CATEGORY, ADMIN_STATUS } from "@/lib/ticket-labels"

const ALL = "semua"

export function AdminTicketsView() {
  // Open first: those are the ones waiting for the team.
  const [status, setStatus] = useState<string>("OPEN")
  const tickets = useAdminTickets(status === ALL ? undefined : (status as TicketStatus))

  return (
    <div className="grid gap-6">
      <PageHeader title="Tiket" description="Pertanyaan pelanggan dari halaman Bantuan. Balasan juga dikirim ke email pelanggan." />

      <div className="grid max-w-xs gap-2">
        <Label htmlFor="admin-ticket-status">Status</Label>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger id="admin-ticket-status" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(["OPEN", "ANSWERED", "CLOSED"] as const).map((s) => (
              <SelectItem key={s} value={s}>
                {ADMIN_STATUS[s]}
              </SelectItem>
            ))}
            <SelectItem value={ALL}>Semua</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <AdminTable
        what="tiket"
        rows={tickets.data ?? []}
        queries={[tickets]}
        empty={status === "OPEN" ? "Tidak ada tiket yang perlu dibalas." : "Tidak ada tiket dengan status itu."}
        caption="Daftar tiket, aktivitas terbaru dulu"
        head={
          <>
            <TableHead scope="col">Status</TableHead>
            <TableHead scope="col">Subjek</TableHead>
            <TableHead scope="col">Pelanggan</TableHead>
            <TableHead scope="col">Kategori</TableHead>
            <TableHead scope="col">Aktivitas terakhir</TableHead>
          </>
        }
        row={(k) => (
          <TableRow key={k.id}>
            <TableCell>
              <TicketStatusChip closed={k.status === "CLOSED"}>{ADMIN_STATUS[k.status]}</TicketStatusChip>
            </TableCell>
            <TableCell>
              <Link href={`/admin/tiket/${k.id}`} className="underline decoration-input underline-offset-4 hover:decoration-foreground">
                {k.subject}
              </Link>
            </TableCell>
            <TableCell className="text-muted-foreground">{k.createdByEmail}</TableCell>
            <TableCell>{ADMIN_CATEGORY[k.category]}</TableCell>
            <TableCell className="type-mono text-muted-foreground">{formatDateTimeId(k.lastMessageAt)}</TableCell>
          </TableRow>
        )}
      />
    </div>
  )
}
