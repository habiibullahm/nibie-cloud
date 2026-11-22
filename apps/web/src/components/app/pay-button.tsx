"use client"

import { useRef, useState } from "react"
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
  /** Creates (or returns) the invoice after confirmation. */
  create: () => Promise<Payable>
  purpose?: string
  warning?: string
  qrisOnly?: boolean
  onPaid?: (r: CheckoutResult) => void
}

/** Confirms the amount and method before creating, paying or opening an invoice. */
export function usePay() {
  const t = useT()
  const lang = useLang()
  const wallet = useWallet().data
  const walletPay = useWalletPay()
  const [request, setRequest] = useState<(PayRequest & { fromBalance: boolean; amountUpdated?: boolean }) | null>(null)
  const [creating, setCreating] = useState(false)
  const submitting = useRef(false)
  const returnFocus = useRef<HTMLElement | null>(null)
  const siteKey = turnstileSiteKey()
  const [token, setToken] = useState<string | null>(null)
  const [problem, setProblem] = useState<TurnstileProblem>(null)
  // A token works once: a fresh widget for every attempt.
  const [round, setRound] = useState(0)

  const covers = (amountIdr: number | null | undefined) => wallet != null && amountIdr != null && wallet.balanceIdr >= amountIdr

  function pay(r: PayRequest) {
    if (request || submitting.current) return
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setToken(null)
    setProblem(null)
    setRequest({ ...r, fromBalance: !r.qrisOnly && covers(r.amountIdr) })
  }

  const needsCaptcha = request?.fromBalance && siteKey !== null
  const canPay = !request?.fromBalance || (covers(request.amountIdr) && (!needsCaptcha || token !== null))

  async function confirmPayment() {
    if (!request || !canPay || submitting.current) return
    submitting.current = true
    const captchaToken = token ?? undefined
    setToken(null)
    setCreating(true)
    try {
      const payment = await request.create()
      if (payment.amountIdr !== request.amountIdr) {
        setRequest({
          ...request,
          amountIdr: payment.amountIdr,
          fromBalance: request.fromBalance && covers(payment.amountIdr),
          create: async () => payment,
          amountUpdated: true,
        })
        return
      }
      if (request.fromBalance) {
        const result = await walletPay.mutateAsync({ paymentId: payment.id, captchaToken })
        setRequest(null)
        request.onPaid?.(result)
      } else {
        startPayment(payment.paymentUrl)
        setRequest(null)
      }
    } catch {
      // The mutation already shows its error.
    } finally {
      submitting.current = false
      setCreating(false)
      setProblem(null)
      setRound((n) => n + 1)
    }
  }

  const amount = request?.amountIdr
  const confirm =
    request ? (
      <Dialog open onOpenChange={(open) => (!open && !submitting.current ? setRequest(null) : undefined)}>
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
          showCloseButton={false}
          onCloseAutoFocus={(event) => {
            const element = returnFocus.current
            if (element?.isConnected) {
              event.preventDefault()
              element.focus()
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{request.fromBalance ? t("Pay from your balance?") : t("Continue with QRIS?")}</DialogTitle>
            <DialogDescription>
              {request.fromBalance
                ? t("The amount is taken from your Nibie Cloud balance right away.")
                : t("You’ll complete the QRIS payment on SumoPod.")}
            </DialogDescription>
          </DialogHeader>
          <KeyValue
            items={[
              ...(request.purpose ? [{ k: t("Description"), v: request.purpose }] : []),
              { k: t("Amount"), v: <span className="tabular-nums">{amount == null ? t("Shown after invoice is prepared") : formatPriceIdr(amount, lang)}</span> },
              ...(request.fromBalance && wallet && amount != null ? [
                { k: t("Balance now"), v: <span className="tabular-nums">{formatPriceIdr(wallet.balanceIdr, lang)}</span> },
                ...(covers(amount) ? [{ k: t("Balance after"), v: <span className="tabular-nums">{formatPriceIdr(wallet.balanceIdr - amount, lang)}</span> }] : []),
              ] : []),
            ]}
          />
          {request.warning ? <p className="text-muted-foreground">{request.warning}</p> : null}
          {request.amountUpdated ? <p role="status">{t("Review the invoice amount before confirming again.")}</p> : null}
          {request.fromBalance && !covers(amount) ? <p role="status">{t("Not enough balance. Top up your Nibie Cloud balance first.")}</p> : null}
          {request.fromBalance && siteKey ? (
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
            <Button type="button" variant="outline" disabled={creating} onClick={() => setRequest(null)}>
              {t("Cancel")}
            </Button>
            <Button type="button" disabled={creating || !canPay} onClick={() => void confirmPayment()}>
              {creating ? t("Preparing payment…") : request.fromBalance ? t("Confirm payment") : amount == null ? t("Prepare invoice") : t("Continue to QRIS")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    ) : null

  return { pay, covers, paying: creating, confirm }
}

/** Opens confirmation for an existing invoice. */
export function PayButton({
  payment,
  label,
  walletLabel,
  onPaid,
  purpose,
  qrisOnly,
  variant = "outline",
}: {
  payment: Payable
  label: string
  walletLabel?: string
  onPaid?: (r: CheckoutResult) => void
  purpose?: string
  qrisOnly?: boolean
  variant?: "outline" | "default"
}) {
  const t = useT()
  const { pay, covers, paying, confirm } = usePay()
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant={variant}
        disabled={paying}
        onClick={() => pay({ amountIdr: payment.amountIdr, create: async () => payment, purpose, qrisOnly, onPaid })}
      >
        {paying ? t("Paying…") : !qrisOnly && covers(payment.amountIdr) ? (walletLabel ?? t("Pay from balance")) : label}
      </Button>
      {confirm}
    </>
  )
}
