"use client"

import Link from "next/link"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { PageHeader } from "@/components/app/page-header"
import { AdminTable, TableCell, TableHead, TableRow } from "@/components/app/admin-table"
import { useAdminPayments, useAdminSubscriptions } from "@/hooks/use-admin"
import { formatDateTimeId, formatIdr } from "@/lib/admin-format"

export function AdminBillingView() {
  const subs = useAdminSubscriptions()
  const payments = useAdminPayments()

  return (
    <div className="grid gap-8">
      <PageHeader title="Langganan &amp; pembayaran" description="Langganan hosting dan invoice Duitku." />

      <section className="grid gap-3">
        <h2 className="type-label text-foreground">Langganan</h2>
        <AdminTable
          what="langganan"
          rows={subs.data?.items ?? []}
          queries={[subs]}
          empty="Belum ada langganan."
          caption="Daftar langganan"
          head={
            <>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col">Pelanggan</TableHead>
              <TableHead scope="col">Nama</TableHead>
              <TableHead scope="col">Plan</TableHead>
              <TableHead scope="col">Harga</TableHead>
              <TableHead scope="col">Periode berakhir</TableHead>
              <TableHead scope="col">Instance</TableHead>
            </>
          }
          row={(s) => (
            <TableRow key={s.id}>
              <TableCell className="type-label">{s.status}</TableCell>
              <TableCell className="text-muted-foreground">{s.email ?? "—"}</TableCell>
              <TableCell>{s.intendedName}</TableCell>
              <TableCell className="type-mono">{s.plan.slug}</TableCell>
              <TableCell className="type-mono">{formatIdr(s.plan.monthlyPriceIdr)}</TableCell>
              <TableCell className="type-mono text-muted-foreground">{formatDateTimeId(s.currentPeriodEnd)}</TableCell>
              <TableCell className="type-mono">
                {s.instanceId ? (
                  <Link href={`/admin/instance/${s.instanceId}`} className="no-underline hover:underline">
                    buka
                  </Link>
                ) : (
                  "—"
                )}
              </TableCell>
            </TableRow>
          )}
        />
      </section>

      <section className="grid gap-3">
        <h2 className="type-label text-foreground">Pembayaran</h2>
        <AdminTable
          what="pembayaran"
          rows={payments.data?.items ?? []}
          queries={[payments]}
          empty="Belum ada pembayaran."
          caption="Daftar pembayaran"
          head={
            <>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col">Pelanggan</TableHead>
              <TableHead scope="col">Jumlah</TableHead>
              <TableHead scope="col">Jenis</TableHead>
              <TableHead scope="col">Order</TableHead>
              <TableHead scope="col">Dibayar</TableHead>
            </>
          }
          row={(p) => (
            <TableRow key={p.id}>
              <TableCell className="type-label">{p.status}</TableCell>
              <TableCell className="text-muted-foreground">{p.email ?? "—"}</TableCell>
              <TableCell className="type-mono">{formatIdr(p.amountIdr)}</TableCell>
              <TableCell className="type-mono text-muted-foreground">{p.purpose}</TableCell>
              <TableCell className="type-mono text-muted-foreground">{p.merchantOrderId}</TableCell>
              <TableCell className="type-mono text-muted-foreground">{formatDateTimeId(p.paidAt)}</TableCell>
            </TableRow>
          )}
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Tindakan uang belum tersedia</CardTitle>
          <CardDescription>
            Refund dan perubahan langganan menunggu keputusan gateway (Duitku atau SumoPod). Panel ini untuk sekarang hanya membaca.
          </CardDescription>
        </CardHeader>
        <CardContent />
      </Card>
    </div>
  )
}
