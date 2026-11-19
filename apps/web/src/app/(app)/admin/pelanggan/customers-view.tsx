"use client"

import Link from "next/link"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PageHeader } from "@/components/app/page-header"
import { AdminTable, TableCell, TableHead, TableRow } from "@/components/app/admin-table"
import { useAdminCustomers } from "@/hooks/use-admin"
import { formatDateTimeId } from "@/lib/admin-format"

export function AdminCustomersView() {
  // Searched on submit, not per keystroke: every admin request writes an audit row and counts against the rate limit.
  const [input, setInput] = useState("")
  const [q, setQ] = useState("")
  const customers = useAdminCustomers(q)

  return (
    <div className="grid gap-6">
      <PageHeader title="Pelanggan" description="Tenant dan akun yang memilikinya." />

      <form
        role="search"
        className="grid max-w-md gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          setQ(input.trim())
        }}
      >
        <Label htmlFor="admin-customer-search">Cari email</Label>
        <div className="flex gap-2">
          <Input
            id="admin-customer-search"
            type="search"
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              // Clearing the box (or its x button) shows everyone again without another click.
              if (e.target.value === "" && q !== "") setQ("")
            }}
            placeholder="nama@contoh.com"
            autoComplete="off"
          />
          <Button type="submit" variant="outline">
            Cari
          </Button>
        </div>
      </form>

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
              <Link href={`/admin/pelanggan/${c.tenantId}`} className="underline decoration-input underline-offset-4 hover:decoration-foreground">
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
