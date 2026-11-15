"use client"

import Link from "next/link"
import { useState } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PageHeader } from "@/components/app/page-header"
import { AdminTable, TableCell, TableHead, TableRow } from "@/components/app/admin-table"
import { useAdminCustomers } from "@/hooks/use-admin"
import { formatDateTimeId } from "@/lib/admin-format"

export function AdminCustomersView() {
  const [q, setQ] = useState("")
  const customers = useAdminCustomers(q)

  return (
    <div className="grid gap-6">
      <PageHeader title="Pelanggan" description="Tenant dan akun yang memilikinya." />

      <div className="grid max-w-md gap-2">
        <Label htmlFor="admin-customer-search">Cari email</Label>
        <Input
          id="admin-customer-search"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="nama@contoh.com"
          autoComplete="off"
        />
      </div>

      <AdminTable
        what="pelanggan"
        rows={customers.data?.items ?? []}
        queries={[customers]}
        empty={q ? "Tidak ada pelanggan yang cocok dengan pencarian itu." : "Belum ada pelanggan."}
        caption="Daftar pelanggan"
        head={
          <>
            <TableHead scope="col">Email</TableHead>
            <TableHead scope="col">Tenant</TableHead>
            <TableHead scope="col">Instance</TableHead>
            <TableHead scope="col">Terdaftar</TableHead>
          </>
        }
        row={(c) => (
          <TableRow key={c.tenantId}>
            <TableCell>
              <Link href={`/admin/pelanggan/${c.tenantId}`} className="no-underline hover:underline">
                {c.email ?? "Tanpa akun"}
              </Link>
            </TableCell>
            <TableCell className="type-mono text-muted-foreground">{c.tenantId}</TableCell>
            <TableCell className="type-mono">{c.instanceCount}</TableCell>
            <TableCell className="type-mono text-muted-foreground">{formatDateTimeId(c.createdAt)}</TableCell>
          </TableRow>
        )}
      />
    </div>
  )
}
