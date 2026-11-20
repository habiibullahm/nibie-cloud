"use client"

import { Button } from "@/components/ui/button"
import { useWallet, useWalletPay } from "@/hooks/use-hermes"
import type { BillingPayment } from "@/lib/api"
import { useT } from "@/lib/i18n"
import { startPayment } from "@/lib/pay"

type Payable = Pick<BillingPayment, "id" | "amountIdr" | "paymentUrl">

/**
 * One way to pay a hosting invoice (owner decision 2026-11-20): from the Nibie Cloud balance when it covers the amount,
 * otherwise by QRIS on the SumoPod page. The customer never has to choose.
 */
export function usePay() {
  const wallet = useWallet().data
  const walletPay = useWalletPay()
  const covers = (amountIdr: number | null | undefined) => wallet != null && amountIdr != null && wallet.balanceIdr >= amountIdr
  const pay = (p: Payable, onPaid?: () => void) =>
    covers(p.amountIdr) ? walletPay.mutate(p.id, { onSuccess: () => onPaid?.() }) : startPayment(p.paymentUrl)
  return { pay, covers, paying: walletPay.isPending }
}

/** Pays an open invoice: from the balance when it covers the amount (`walletLabel`), else by QRIS (`label`). */
export function PayButton({
  payment,
  label,
  walletLabel,
  onPaid,
}: {
  payment: Payable
  label: string
  walletLabel?: string
  onPaid?: () => void
}) {
  const t = useT()
  const { pay, covers, paying } = usePay()
  const fromBalance = covers(payment.amountIdr)
  return (
    <Button type="button" size="sm" variant="outline" disabled={paying} onClick={() => pay(payment, onPaid)}>
      {paying ? t("Paying…") : fromBalance ? (walletLabel ?? t("Pay from balance")) : label}
    </Button>
  )
}
