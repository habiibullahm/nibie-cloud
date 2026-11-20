"use client"

import { Wallet as WalletIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useWallet, useWalletPay } from "@/hooks/use-hermes"
import { formatPriceIdr } from "@/lib/format"
import { useT } from "@/lib/i18n"
import { useLang } from "@/lib/prefs"

/** True when the wallet is on and its balance covers `amountIdr`. */
export function useWalletCovers(amountIdr: number | null | undefined): boolean {
  const wallet = useWallet().data
  return wallet != null && amountIdr != null && wallet.balanceIdr >= amountIdr
}

/**
 * "Pay from balance" for an open hosting invoice, next to the QRIS button. Renders nothing when the wallet is off or its
 * balance does not cover the amount.
 */
export function WalletPayButton({ paymentId, amountIdr, onPaid }: { paymentId: string; amountIdr: number; onPaid?: () => void }) {
  const t = useT()
  const lang = useLang()
  const balance = useWallet().data?.balanceIdr
  const pay = useWalletPay()
  if (balance === undefined || balance < amountIdr) return null
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={pay.isPending}
      onClick={() => pay.mutate(paymentId, { onSuccess: () => onPaid?.() })}
    >
      <WalletIcon aria-hidden="true" />
      {pay.isPending ? t("Paying…") : t("Pay from balance ({balance})", { balance: formatPriceIdr(balance, lang) })}
    </Button>
  )
}
