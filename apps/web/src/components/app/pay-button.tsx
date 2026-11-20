"use client"

import { useState } from "react"
import { Turnstile, turnstileSiteKey, type TurnstileProblem } from "@/components/auth/turnstile"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { KeyValue } from "@/components/app/key-value"
import { useWallet, useWalletPay } from "@/hooks/use-hermes"
import type { BillingPayment, CheckoutResult } from "@/lib/api"
import { formatPriceIdr } from "@/lib/format"
import { useT } from "@/lib/i18n"
import { startPayment } from "@/lib/pay"
import { useLang } from "@/lib/prefs"

type Payable = Pick<BillingPayment, "id" | "amountIdr" | "paymentUrl">

interface PayRequest {
  /** What will be charged; decides between the balance and QRIS. */
  amountIdr: number | null | undefined
  /** Creates (or returns) the invoice. Called only once the customer confirmed a balance payment, or right away for QRIS. */
  create: () => Promise<Payable>
  onPaid?: (r: CheckoutResult) => void
}

/**
 * One way to pay a hosting invoice (owner decision 2026-11-20): from the Nibie Cloud balance when it covers the amount,
 * otherwise by QRIS on the SumoPod page. A balance payment is confirmed first in a dialog with a Turnstile check (the
 * backend requires the token when it has a Turnstile secret). Render `confirm` once in the calling component.
 */
export function usePay() {
  const t = useT()
  const lang = useLang()
  const wallet = useWallet().data
  const walletPay = useWalletPay()
  const [request, setRequest] = useState<PayRequest | null>(null)
  const [creating, setCreating] = useState(false)
  const siteKey = turnstileSiteKey()
  const [token, setToken] = useState<string | null>(null)
  const [problem, setProblem] = useState<TurnstileProblem>(null)
  // A token works once: a fresh widget for every attempt.
  const [round, setRound] = useState(0)

  const covers = (amountIdr: number | null | undefined) => wallet != null && amountIdr != null && wallet.balanceIdr >= amountIdr

  async function pay(r: PayRequest) {
    if (covers(r.amountIdr)) {
      setToken(null)
      setProblem(null)
      setRound((n) => n + 1)
      setRequest(r)
      return
    }
    try {
      startPayment((await r.create()).paymentUrl)
    } catch {
      // The mutation behind `create` already shows its error.
    }
  }

  async function confirmPayment() {
    if (!request) return
    const captchaToken = token ?? undefined
    setToken(null)
    setCreating(true)
    try {
      const payment = await request.create()
      walletPay.mutate(
        { paymentId: payment.id, captchaToken },
        {
          onSuccess: (result) => {
            setRequest(null)
            request.onPaid?.(result)
          },
          onSettled: () => setRound((n) => n + 1),
        }
      )
    } catch {
      setRound((n) => n + 1)
    } finally {
      setCreating(false)
    }
  }

  const busy = creating || walletPay.isPending
  const amount = request?.amountIdr ?? 0
  const confirm =
    request && wallet ? (
      <Dialog open onOpenChange={(open) => (!open && !busy ? setRequest(null) : undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Pay from your balance?")}</DialogTitle>
            <DialogDescription>{t("The amount is taken from your Nibie Cloud balance right away.")}</DialogDescription>
          </DialogHeader>
          <KeyValue
            items={[
              { k: t("Amount"), v: <span className="tabular-nums">{formatPriceIdr(amount, lang)}</span> },
              { k: t("Balance now"), v: <span className="tabular-nums">{formatPriceIdr(wallet.balanceIdr, lang)}</span> },
              { k: t("Balance after"), v: <span className="tabular-nums">{formatPriceIdr(wallet.balanceIdr - amount, lang)}</span> },
            ]}
          />
          {siteKey ? (
            <div className="grid gap-2">
              <Turnstile key={round} siteKey={siteKey} onToken={setToken} onProblem={setProblem} />
              {problem ? (
                <p className="text-muted-foreground" role="status">
                  {problem === "expired" ? t("The check expired. Solve it again.") : t("The check could not load. Reload the page and try again.")}
                </p>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setRequest(null)}>
              {t("Cancel")}
            </Button>
            <Button type="button" disabled={busy || (siteKey !== null && token === null)} onClick={() => void confirmPayment()}>
              {busy ? t("Paying…") : t("Confirm payment")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    ) : null

  return { pay, covers, paying: busy, confirm }
}

/** Pays an open invoice: from the balance when it covers the amount (`walletLabel`, after a confirmation), else by QRIS (`label`). */
export function PayButton({
  payment,
  label,
  walletLabel,
  onPaid,
}: {
  payment: Payable
  label: string
  walletLabel?: string
  onPaid?: (r: CheckoutResult) => void
}) {
  const t = useT()
  const { pay, covers, paying, confirm } = usePay()
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={paying}
        onClick={() => void pay({ amountIdr: payment.amountIdr, create: async () => payment, ...(onPaid ? { onPaid } : {}) })}
      >
        {paying ? t("Paying…") : covers(payment.amountIdr) ? (walletLabel ?? t("Pay from balance")) : label}
      </Button>
      {confirm}
    </>
  )
}
