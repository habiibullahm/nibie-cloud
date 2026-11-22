"use client"

import { useState } from "react"
import { CircleX, Wallet as WalletIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { PayButton } from "@/components/app/pay-button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useTopup, useWallet } from "@/hooks/use-hermes"
import type { Wallet } from "@/lib/api/types"
import { formatDate, formatPriceIdr } from "@/lib/format"
import { useT } from "@/lib/i18n"
import { startPayment } from "@/lib/pay"
import { useLang } from "@/lib/prefs"
import { entryLabel, isPayable, parseTopupAmount, TOPUP_PRESETS } from "@/lib/wallet"

/** The Nibie Cloud balance (saldo) and its history. Renders nothing when the backend has the wallet switched off. */
export function WalletCard() {
  const t = useT()
  const lang = useLang()
  const wallet = useWallet().data
  const [dialog, setDialog] = useState(false)
  if (!wallet) return null

  const pending = wallet.topups.filter((x) => isPayable(x))
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <WalletIcon className="size-4" aria-hidden="true" />
          {t("Balance")}
        </CardTitle>
        <CardDescription>{t("Your Nibie Cloud balance. It is not cash and cannot be refunded or withdrawn.")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="type-h1 tabular-nums" aria-live="polite">
            {formatPriceIdr(wallet.balanceIdr, lang)}
          </p>
          <Button onClick={() => setDialog(true)}>{t("Top up")}</Button>
        </div>

        {pending.map((x) => (
          <div key={x.id} className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-border p-3">
            <span>{t("Top-up of {amount} is waiting for payment.", { amount: formatPriceIdr(x.amountIdr, lang) })}</span>
            <PayButton payment={x} label={t("Pay")} purpose={t("Top up balance")} qrisOnly />
          </div>
        ))}

        {wallet.entries.length > 0 ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Date")}</TableHead>
                  <TableHead>{t("Description")}</TableHead>
                  <TableHead className="text-right">{t("Amount")}</TableHead>
                  <TableHead className="text-right">{t("Balance")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {wallet.entries.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell>{formatDate(e.createdAt, lang)}</TableCell>
                    <TableCell>{t(entryLabel(e.kind))}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {e.amountIdr > 0 ? "+" : "−"}
                      {formatPriceIdr(Math.abs(e.amountIdr), lang)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatPriceIdr(e.balanceAfterIdr, lang)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="text-muted-foreground">{t("No balance activity yet.")}</p>
        )}
      </CardContent>
      {dialog ? <TopupDialog onClose={() => setDialog(false)} limits={wallet.limits} /> : null}
    </Card>
  )
}

function TopupDialog({ onClose, limits }: { onClose: () => void; limits: Wallet["limits"] }) {
  const t = useT()
  const lang = useLang()
  const topup = useTopup()
  const [amount, setAmount] = useState("")
  const [error, setError] = useState<string | null>(null)
  // One key per dialog opening: a double click replays the same top-up instead of creating two.
  const [key] = useState(() => crypto.randomUUID())
  const min = formatPriceIdr(limits.topupMinIdr, lang)
  const max = formatPriceIdr(limits.topupMaxIdr, lang)
  const parsed = parseTopupAmount(amount, limits)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (topup.isPending) return
    if (!parsed.ok) {
      setError(t("Enter a whole amount from {min} to {max}.", { min, max }))
      return
    }
    setError(null)
    topup.mutate(
      { amountIdr: parsed.value, idempotencyKey: key },
      {
        onSuccess: (x) => {
          onClose()
          startPayment(x.paymentUrl)
        },
      }
    )
  }

  return (
    <Dialog open onOpenChange={(open) => (!open && !topup.isPending ? onClose() : undefined)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto" showCloseButton={false}>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t("Top up balance")}</DialogTitle>
            <DialogDescription>{t("Pay by QRIS. The balance updates once the payment is confirmed.")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap gap-2" role="group" aria-label={t("Suggested amounts")}>
            {TOPUP_PRESETS.map((p) => (
              <Button
                key={p}
                type="button"
                size="sm"
                variant="outline"
                aria-pressed={amount === String(p)}
                onClick={() => {
                  setAmount(String(p))
                  setError(null)
                }}
              >
                {formatPriceIdr(p, lang)}
              </Button>
            ))}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="topup-amount">{t("Amount (Rp)")}</Label>
            <Input
              id="topup-amount"
              inputMode="numeric"
              autoComplete="off"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-invalid={error !== null}
              aria-describedby="topup-hint"
            />
            {error ? (
              <p id="topup-hint" role="alert" className="flex items-start gap-2">
                <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
                {error}
              </p>
            ) : (
              <p id="topup-hint" className="text-muted-foreground">
                {t("From {min} to {max}.", { min, max })}
              </p>
            )}
          </div>
          <p className="text-muted-foreground">
            {t("Nibie Cloud balance is not cash and cannot be refunded or withdrawn.")}
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={topup.isPending} onClick={onClose}>
              {t("Cancel")}
            </Button>
            <Button type="submit" disabled={topup.isPending}>
              {topup.isPending ? t("Opening payment…") : parsed.ok ? t("Continue to QRIS for {amount}", { amount: formatPriceIdr(parsed.value, lang) }) : t("Continue to QRIS")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
