"use client"

import Link from "next/link"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { PageHeader } from "@/components/app/page-header"
import { AdminTable, TableCell, TableHead, TableRow } from "@/components/app/admin-table"
import { useAdminPayments, useAdminSubscriptions } from "@/hooks/use-admin"
import { formatDateTimeId, formatIdr, paymentPurposeId, paymentStatusId, subscriptionStatusId } from "@/lib/admin-format"

export function AdminBillingView() {
  const subs = useAdminSubscriptions()
  const payments = useAdminPayments()

  return (
    <div className="grid gap-8">
      <PageHeader title="Langganan &amp; pembayaran" description="Langganan hosting dan invoice SumoPod." />

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
              <TableCell className="type-label">{subscriptionStatusId(s.status)}</TableCell>
              <TableCell className="text-muted-foreground">{s.email ?? "Tidak ada"}</TableCell>
              <TableCell>{s.intendedName}</TableCell>
              <TableCell className="type-mono">{s.plan.slug}</TableCell>
              <TableCell className="type-mono">{formatIdr(s.plan.monthlyPriceIdr)}</TableCell>
              <TableCell className="type-mono text-muted-foreground">{formatDateTimeId(s.currentPeriodEnd)}</TableCell>
              <TableCell>
                {s.instanceId ? (
                  <Link
                    href={`/admin/instance/${s.instanceId}`}
                    aria-label={`Lihat instance ${s.intendedName}`}
                    className="underline decoration-input underline-offset-4 hover:decoration-foreground"
                  >
                    Lihat instance
                  </Link>
                ) : (
                  <span className="text-muted-foreground">Belum dibuat</span>
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
              <TableCell className="type-label">{paymentStatusId(p.status)}</TableCell>
              <TableCell className="text-muted-foreground">{p.email ?? "Tidak ada"}</TableCell>
              <TableCell className="type-mono">{formatIdr(p.amountIdr)}</TableCell>
              <TableCell className="text-muted-foreground">{paymentPurposeId(p.purpose)}</TableCell>
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
            Refund dan perubahan langganan belum bisa dilakukan dari panel ini. Untuk sekarang panel hanya membaca.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  )
}
