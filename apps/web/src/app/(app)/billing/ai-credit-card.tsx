"use client"

import { useState } from "react"
import { Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { LineChart } from "@/components/app/line-chart"
import { useAiAccount, useSetAiAlert } from "@/hooks/use-hermes"
import type { AiAccount } from "@/lib/api/types"
import { AI_ALERT_MAX_IDR, AI_ALERT_MIN_IDR, formatAiAmount, parseAiThreshold } from "@/lib/ai-credit"
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
          <p className="type-h1 tabular-nums" aria-live="polite">
            {formatAiAmount(ai.balanceIdr, ai.balanceUsd, lang)}
          </p>
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
    </Card>
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
