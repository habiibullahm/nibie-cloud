"use client"

import { useState } from "react"
import { CircleX, Sparkles } from "lucide-react"
import { KeyValue } from "@/components/app/key-value"
import { Turnstile, turnstileSiteKey, type TurnstileProblem } from "@/components/auth/turnstile"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
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
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { LineChart } from "@/components/app/line-chart"
import { useAiAccount, useBuyAiCredit, useSetAiAlert, useWallet } from "@/hooks/use-hermes"
import type { AiAccount, Wallet } from "@/lib/api/types"
import { AI_ALERT_MAX_IDR, AI_ALERT_MIN_IDR, AI_BUY_PRESETS, aiCreditUsd, formatAiAmount, parseAiThreshold } from "@/lib/ai-credit"
import { parseTopupAmount } from "@/lib/wallet"
import { formatPriceIdr } from "@/lib/format"
import { useT } from "@/lib/i18n"
import { useLang } from "@/lib/prefs"

/**
 * The NibieRouter (AI) balance in Rupiah, 30-day usage and the low-balance reminder. Renders nothing when the backend has
 * no NibieRouter (GET /ai answers 404) or the request failed: the rest of the Billing page does not depend on it.
 */
export function AiCreditCard() {
  const t = useT()
  const lang = useLang()
  const ai = useAiAccount().data
  const wallet = useWallet().data
  const [buying, setBuying] = useState(false)
  if (!ai) return null

  const rate = ai.rate.idrPerUsd
  const maxCost = Math.max(0, ...ai.daily.map((d) => d.costIdr ?? d.costUsd))
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="size-4" aria-hidden="true" />
          {t("AI balance")}
        </CardTitle>
        <CardDescription>
          {t("Your NibieRouter balance for paid AI models. Free models do not use it.")}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-1">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="type-h1 tabular-nums" aria-live="polite">
              {formatAiAmount(ai.balanceIdr, ai.balanceUsd, lang)}
            </p>
            {/* Bought from the Nibie Cloud balance, so only with the wallet on, a router account and a known rate. */}
            {ai.buy && ai.hasAccount && rate && wallet ? (
              <Button onClick={() => setBuying(true)}>{t("Top up AI balance")}</Button>
            ) : null}
          </div>
          {rate ? (
            <p className="text-muted-foreground">
              {t("Rate: {rate} per US$1", { rate: formatPriceIdr(rate, lang) })} ·{" "}
              {ai.rate.source === "admin" ? t("set by Nibie Cloud") : t("NibieRouter rate")}
            </p>
          ) : null}
        </div>

        {!ai.hasAccount ? (
          <p className="text-muted-foreground">{t("Your AI balance shows here once an instance uses NibieRouter.")}</p>
        ) : (
          <>
            <p>
              {t("Used in the last 30 days: {amount}", { amount: formatAiAmount(ai.spend30dIdr, ai.spend30dUsd, lang) })}
            </p>
            {ai.daily.length > 1 ? (
              <LineChart
                values={ai.daily.map((d) => d.costIdr ?? d.costUsd)}
                max={maxCost}
                label={t("AI cost per day")}
                format={(v) => (rate ? formatPriceIdr(Math.round(v), lang) : `US$${v.toFixed(2)}`)}
              />
            ) : null}
            {ai.models.length > 0 ? (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("Model")}</TableHead>
                      <TableHead className="text-right">{t("Requests")}</TableHead>
                      <TableHead className="text-right">{t("Cost")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ai.models.map((m) => (
                      <TableRow key={m.model}>
                        <TableCell className="type-mono">{m.model}</TableCell>
                        <TableCell className="text-right tabular-nums">{m.requests}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatAiAmount(m.costIdr, m.costUsd, lang)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
      <ReminderForm alert={ai.alert} key={`${ai.alert.enabled}-${ai.alert.thresholdIdr}`} />
      {buying && ai.buy && rate && wallet ? (
        <BuyDialog onClose={() => setBuying(false)} ai={ai} buy={ai.buy} rate={rate} wallet={wallet} />
      ) : null}
    </Card>
  )
}

/**
 * Rupiah from the Nibie Cloud balance to the AI balance, at the rate shown. Mounted per opening, so each opening has its
 * own Idempotency-Key: a double click buys once. A Turnstile check comes first when the site has one.
 */
function BuyDialog({
  onClose,
  ai,
  buy,
  rate,
  wallet,
}: {
  onClose: () => void
  ai: AiAccount
  buy: NonNullable<AiAccount["buy"]>
  rate: number
  wallet: Wallet
}) {
  const t = useT()
  const lang = useLang()
  const purchase = useBuyAiCredit()
  const [key] = useState(() => crypto.randomUUID())
  const [amount, setAmount] = useState("")
  const [error, setError] = useState<string | null>(null)
  const siteKey = turnstileSiteKey()
  const [token, setToken] = useState<string | null>(null)
  const [problem, setProblem] = useState<TurnstileProblem>(null)
  // A token works once: a fresh widget after every attempt.
  const [round, setRound] = useState(0)
  const min = formatPriceIdr(buy.minIdr, lang)
  const max = formatPriceIdr(buy.maxIdr, lang)
  const parsed = parseTopupAmount(amount, { topupMinIdr: buy.minIdr, topupMaxIdr: buy.maxIdr })
  const value = parsed.ok ? parsed.value : null
  const short = value !== null && value > wallet.balanceIdr

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (value === null) {
      setError(t("Enter a whole amount from {min} to {max}.", { min, max }))
      return
    }
    if (short) return
    setError(null)
    const captchaToken = token ?? undefined
    setToken(null)
    purchase.mutate(
      { amountIdr: value, idempotencyKey: key, ...(captchaToken ? { captchaToken } : {}) },
      { onSuccess: onClose, onSettled: () => setRound((n) => n + 1) }
    )
  }

  const busy = purchase.isPending
  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : undefined)}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t("Top up AI balance")}</DialogTitle>
            <DialogDescription>
              {t("Paid from your Nibie Cloud balance at {rate} per US$1.", { rate: formatPriceIdr(rate, lang) })}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap gap-2" role="group" aria-label={t("Suggested amounts")}>
            {AI_BUY_PRESETS.map((p) => (
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
            <Label htmlFor="ai-buy-amount">{t("Amount (Rp)")}</Label>
            <Input
              id="ai-buy-amount"
              inputMode="numeric"
              autoComplete="off"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-invalid={error !== null || short}
              aria-describedby="ai-buy-hint"
            />
            {error || short ? (
              <p id="ai-buy-hint" role="alert" className="flex items-start gap-2">
                <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
                {error ?? t("Not enough balance. Top up your Nibie Cloud balance first.")}
              </p>
            ) : (
              <p id="ai-buy-hint" className="text-muted-foreground">
                {t("From {min} to {max}.", { min, max })}
              </p>
            )}
          </div>
          <KeyValue
            items={[
              { k: t("Balance now"), v: <span className="tabular-nums">{formatPriceIdr(wallet.balanceIdr, lang)}</span> },
              {
                k: t("Balance after"),
                v: <span className="tabular-nums">{value !== null && !short ? formatPriceIdr(wallet.balanceIdr - value, lang) : "–"}</span>,
              },
              {
                k: t("AI credit"),
                v: <span className="tabular-nums">{value !== null ? `US$${aiCreditUsd(value, rate).toFixed(2)}` : "–"}</span>,
              },
              {
                k: t("AI balance after"),
                v: (
                  <span className="tabular-nums">
                    {value !== null && !short && ai.balanceIdr !== null ? formatPriceIdr(ai.balanceIdr + value, lang) : "–"}
                  </span>
                ),
              },
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
          <p className="text-muted-foreground">
            {t("AI credit cannot be turned back into balance, refunded or withdrawn.")}
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              {t("Cancel")}
            </Button>
            <Button type="submit" disabled={busy || short || (siteKey !== null && token === null)}>
              {busy ? t("Paying…") : t("Buy AI credit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ReminderForm({ alert }: { alert: AiAccount["alert"] }) {
  const t = useT()
  const lang = useLang()
  const save = useSetAiAlert()
  const [enabled, setEnabled] = useState(alert.enabled)
  const [amount, setAmount] = useState(String(alert.thresholdIdr))
  const threshold = parseAiThreshold(amount)
  const changed = enabled !== alert.enabled || threshold !== alert.thresholdIdr

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (threshold === null) return
    save.mutate({ enabled, thresholdIdr: threshold })
  }

  return (
    <CardContent className="border-t pt-4">
      <form onSubmit={submit} className="grid gap-4">
        <div className="flex items-start justify-between gap-4">
          <div className="grid gap-1">
            <Label htmlFor="ai-alert">{t("Email me when the AI balance is low")}</Label>
            <p className="text-muted-foreground">{t("One email each time the balance drops below the amount below.")}</p>
          </div>
          <Switch id="ai-alert" checked={enabled} onCheckedChange={setEnabled} />
        </div>
        <div className="grid gap-2 sm:max-w-xs">
          <Label htmlFor="ai-alert-amount">{t("Remind me below")}</Label>
          <Input
            id="ai-alert-amount"
            inputMode="numeric"
            autoComplete="off"
            value={amount}
            disabled={!enabled}
            onChange={(e) => setAmount(e.target.value)}
            aria-invalid={threshold === null}
            aria-describedby="ai-alert-amount-hint"
          />
          <p id="ai-alert-amount-hint" className={threshold === null ? "text-destructive" : "text-muted-foreground"} role={threshold === null ? "alert" : undefined}>
            {t("Between {min} and {max}.", { min: formatPriceIdr(AI_ALERT_MIN_IDR, lang), max: formatPriceIdr(AI_ALERT_MAX_IDR, lang) })}
          </p>
        </div>
        <div>
          <Button type="submit" variant="outline" disabled={!changed || threshold === null || save.isPending}>
            {save.isPending ? t("Saving…") : t("Save reminder")}
          </Button>
        </div>
      </form>
    </CardContent>
  )
}
