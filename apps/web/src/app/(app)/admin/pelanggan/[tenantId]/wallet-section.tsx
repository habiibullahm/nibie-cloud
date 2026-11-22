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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useAdjustWallet, useAdminSystem } from "@/hooks/use-admin"
import { MIN_REASON } from "@/lib/admin-beta"
import { formatDateTimeId, formatIdr } from "@/lib/admin-format"
import type { AdminWallet } from "@/lib/api/admin-types"
import { ADJUST_MAX_IDR, parseAdjustAmount } from "@/lib/wallet"

const KIND_ID: Record<string, string> = {
  TOPUP: "Top-up",
  HOSTING: "Bayar hosting",
  AUTO_RENEW: "Perpanjangan otomatis",
  AI_CREDIT: "Kredit AI",
  ADMIN_CREDIT: "Penyesuaian admin (+)",
  ADMIN_DEBIT: "Penyesuaian admin (−)",
}

/** Admin client errors carry `status` and `code` but are not ApiError instances (see adminError in lib/api/admin.ts). */
function adjustErrorMessage(e: unknown): string {
  const err = e as { status?: unknown; code?: unknown } | null
  if (err?.code === "insufficient_balance") return "Saldo tidak cukup untuk dikurangi sebanyak itu."
  if (err?.code === "wallet_limit") return "Saldo akan melewati batas maksimum dompet."
  const status = typeof err?.status === "number" ? err.status : 0
  if (status === 400) return "Data tidak valid. Periksa jumlah dan alasan."
  if (status === 401 || status === 403) return "Tidak diizinkan. Masuk lagi dan pastikan verifikasi 2 langkah aktif."
  if (status === 404) return "Saldo belum aktif di server (WALLET_ENABLED mati), atau pelanggan tidak ditemukan."
  return "Gagal menyimpan. Coba lagi."
}

/** Saldo pelanggan, riwayatnya, dan penyesuaian manual (butuh alasan, tercatat di Audit). */
export function WalletSection({ tenantId, wallet }: { tenantId: string; wallet: AdminWallet }) {
  const system = useAdminSystem()
  const enabled = system.data?.settings.billing.walletEnabled === true
  const adjust = useAdjustWallet(tenantId)
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState("")
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const change = parseAdjustAmount(amount)

  function start() {
    setAmount("")
    setReason("")
    setError(null)
    setOpen(true)
  }

  function submit() {
    if (adjust.isPending) return
    if (change === null) {
      setError(`Isi angka bulat bukan nol, paling banyak ${formatIdr(ADJUST_MAX_IDR)}. Pakai tanda minus untuk mengurangi.`)
      return
    }
    if (reason.trim().length < MIN_REASON) {
      setError(`Alasan minimal ${MIN_REASON} karakter.`)
      return
    }
    adjust.mutate(
      { amountIdr: change, reason: reason.trim() },
      {
        onSuccess: (w) => {
          toast.success(`Saldo sekarang ${formatIdr(w.balanceIdr)}.`)
          setOpen(false)
        },
        onError: (e) => setError(adjustErrorMessage(e)),
      }
    )
  }

  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="type-label text-foreground">Saldo: {formatIdr(wallet.balanceIdr)}</h2>
        {enabled ? (
          <Button size="sm" variant="outline" onClick={start}>
            Sesuaikan saldo
          </Button>
        ) : null}
      </div>
      {wallet.entries.length === 0 ? (
        <p className="text-muted-foreground">Belum ada aktivitas saldo.</p>
      ) : (
        <ul className="grid gap-2">
          {wallet.entries.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-3 rounded-sm border px-4 py-3">
              <span className="flex flex-wrap items-center gap-3">
                <span className="type-label">{KIND_ID[e.kind] ?? e.kind}</span>
                <span className="type-mono">
                  {e.amountIdr > 0 ? "+" : "−"}
                  {formatIdr(Math.abs(e.amountIdr))}
                </span>
                <span className="text-muted-foreground">saldo {formatIdr(e.balanceAfterIdr)}</span>
              </span>
              <span className="type-mono text-muted-foreground">{formatDateTimeId(e.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}

      <AlertDialog open={open} onOpenChange={(o) => !o && !adjust.isPending && setOpen(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sesuaikan saldo</AlertDialogTitle>
            <AlertDialogDescription>
              Angka positif menambah, negatif (pakai tanda minus) mengurangi. Saldo tidak bisa di bawah nol. Pelanggan melihat
              &quot;Penyesuaian admin&quot;; alasannya hanya tercatat di Audit. Tidak bisa dibatalkan, kecuali dengan penyesuaian lain.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="adjust-amount">Jumlah (Rp)</Label>
              <Input id="adjust-amount" inputMode="numeric" autoComplete="off" value={amount} disabled={adjust.isPending} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="adjust-reason">Alasan</Label>
              <Input id="adjust-reason" maxLength={500} value={reason} disabled={adjust.isPending} onChange={(e) => setReason(e.target.value)} />
            </div>
            {change !== null && wallet.balanceIdr + change >= 0 ? (
              <p className="text-muted-foreground">Perkiraan saldo setelah penyesuaian {formatIdr(wallet.balanceIdr + change)}.</p>
            ) : null}
            {error ? (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={adjust.isPending}>Batal</AlertDialogCancel>
            <Button type="button" onClick={submit} disabled={adjust.isPending}>
              {adjust.isPending ? "Menyimpan…" : change === null ? "Konfirmasi penyesuaian" : `${change > 0 ? "Tambah" : "Kurangi"} ${formatIdr(Math.abs(change))}`}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
