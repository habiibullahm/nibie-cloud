"use client"

import { useState } from "react"
import { toast } from "sonner"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PageHeader } from "@/components/app/page-header"
import { AdminTable, TableCell, TableHead, TableRow } from "@/components/app/admin-table"
import { useAdminPlans, useSetPlanStock } from "@/hooks/use-admin"
import { MIN_REASON } from "@/lib/admin-beta"
import { formatIdr, formatUsd } from "@/lib/admin-format"
import { MAX_STOCK, parseStock, stockErrorMessage, stockLabel } from "@/lib/admin-plans"
import type { AdminPlan } from "@/lib/api/admin-types"
import { formatCpu, formatMb } from "@/lib/format"

export function AdminPlansView() {
  const plans = useAdminPlans()
  const save = useSetPlanStock()

  const [target, setTarget] = useState<AdminPlan | null>(null)
  const [stock, setStock] = useState("")
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)

  function open(p: AdminPlan) {
    setTarget(p)
    setStock(p.stockLimit === null ? "" : String(p.stockLimit))
    setReason("")
    setError(null)
  }

  function close() {
    setTarget(null)
    setError(null)
  }

  function submit() {
    if (!target) return
    const parsed = parseStock(stock)
    if (!parsed.ok) {
      setError(`Isi angka bulat 0 sampai ${MAX_STOCK}, atau kosongkan untuk tanpa batas.`)
      return
    }
    if (reason.trim().length < MIN_REASON) {
      setError(`Alasan minimal ${MIN_REASON} karakter.`)
      return
    }
    save.mutate(
      { id: target.id, stockLimit: parsed.value, reason: reason.trim() },
      {
        onSuccess: (p) => {
          toast.success(p.stockLimit === null ? `Stok ${p.slug} sekarang tanpa batas.` : `Stok ${p.slug} sekarang ${p.stockLimit}.`)
          close()
        },
        onError: (err) => setError(stockErrorMessage(err)),
      }
    )
  }

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Plan"
        description="Semua plan, termasuk yang tidak aktif atau belum dijual. Stok plan berbayar bisa diubah di sini; perubahan berlaku untuk checkout berikutnya dan tercatat di Audit bersama alasannya."
      />

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
            <TableHead scope="col">Stok</TableHead>
            <TableHead scope="col">
              <span className="sr-only">Aksi</span>
            </TableHead>
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
            <TableCell className="type-label">{stockLabel(p)}</TableCell>
            <TableCell>
              {p.monthlyPriceIdr === null ? null : (
                <Button type="button" variant="outline" size="xs" onClick={() => open(p)}>
                  Ubah stok
                  <span className="sr-only"> plan {p.slug}</span>
                </Button>
              )}
            </TableCell>
          </TableRow>
        )}
      />

      <Card>
        <CardHeader>
          <CardTitle>Harga dan spesifikasi belum bisa diubah di sini</CardTitle>
          <CardDescription>
            Harga dan spesifikasi plan masih diubah lewat SQL oleh operator. Slot plan gratis diatur oleh FREE_BETA_SLOTS di server.
          </CardDescription>
        </CardHeader>
      </Card>

      <AlertDialog open={target !== null} onOpenChange={(o) => !o && close()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Ubah stok {target?.slug}</AlertDialogTitle>
            <AlertDialogDescription>
              Stok menghitung instance, langganan yang sudah dibayar tapi belum punya instance, dan invoice yang masih menunggu
              bayar. Saat ini terpakai {target?.stockUsed ?? 0}. Menurunkan stok tidak menghentikan instance yang sudah ada;
              hanya pembelian baru yang ditolak.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="stock-limit">Stok (kosongkan untuk tanpa batas)</Label>
              <Input
                id="stock-limit"
                inputMode="numeric"
                autoComplete="off"
                value={stock}
                onChange={(e) => setStock(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="stock-reason">Alasan</Label>
              <Input id="stock-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            {error ? (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <Button type="button" disabled={save.isPending} onClick={submit}>
              {save.isPending ? "Menyimpan…" : "Simpan stok"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
