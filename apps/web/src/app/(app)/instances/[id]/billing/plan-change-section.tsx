"use client"

import { useState } from "react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { useActionConfirmation } from "@/components/app/action-confirmation"
import { PayButton } from "@/components/app/pay-button"
import { useChangePlan } from "@/hooks/use-hermes"
import type { BillingPayment, BillingSubscription, Plan } from "@/lib/api"
import { canSwitchToPlan, payableUrl } from "@/lib/billing"
import { formatCpu, formatMb, formatPriceIdr } from "@/lib/format"
import { useT } from "@/lib/i18n"
import { useLang } from "@/lib/prefs"
import { cn } from "@/lib/utils"

/** Paid-to-paid plan switching for an active subscription. Period end stays unchanged; downgrades stay disabled. */
export function PlanChangeSection({
  sub,
  current,
  plans,
}: {
  sub: BillingSubscription
  current: Plan | undefined
  plans: Plan[]
}) {
  const t = useT()
  const lang = useLang()
  const changePlan = useChangePlan()
  const confirmAction = useActionConfirmation()
  const [visit] = useState(() => crypto.randomUUID())
  const [createdPayment, setCreatedPayment] = useState<BillingPayment | null>(null)

  const subOpenPayment =
    sub.latestPayment?.purpose === "PLAN_CHANGE" && payableUrl(sub.latestPayment) ? sub.latestPayment : null
  const openPayment =
    subOpenPayment ??
    (createdPayment && sub.latestPayment?.id !== createdPayment.id && payableUrl(createdPayment) ? createdPayment : null)

  return (
    <section className="grid gap-3" aria-labelledby="change-plan-title">
      <h2 id="change-plan-title" className="type-label">
        {t("Change plan")}
      </h2>

      {openPayment ? (
        <Alert>
          <AlertTitle>{t("Plan change is waiting for payment")}</AlertTitle>
          <AlertDescription>
            <p>{t("Finish the payment to apply the new plan. This page updates by itself once it is paid.")}</p>
            <div className="mt-2">
              <PayButton
                payment={openPayment}
                label={t("Continue payment")}
                purpose={t("Plan change for {name}", { name: sub.name })}
                onPaid={() => setCreatedPayment(null)}
              />
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      <ul className="grid gap-4 md:grid-cols-3">
        {plans.map((p) => {
          const isCurrent = p.id === current?.id
          const eligible = canSwitchToPlan(current, p)
          return (
            <li key={p.id} className={cn("grid gap-3 rounded-md border bg-card p-4", isCurrent && "border-foreground")}>
              <div className="flex items-center justify-between gap-2">
                <span className="type-label">{p.name}</span>
                {isCurrent ? <span className="type-label rounded-sm border px-2 py-1 text-muted-foreground">{t("Current")}</span> : null}
              </div>
              <p className="type-mono text-muted-foreground">
                {formatCpu(p.cpuMillis)} · {formatMb(p.memoryMb)} · {formatMb(p.storageMb)}
              </p>
              <p className="text-muted-foreground">{t("Price {price}", { price: formatPriceIdr(p.monthlyPriceIdr, lang) })}</p>
              {isCurrent ? (
                <Button variant="outline" disabled className="mt-auto">
                  {t("Current plan")}
                </Button>
              ) : !eligible ? (
                <Button variant="outline" disabled className="mt-auto">
                  {t("Not available as a switch")}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  className="mt-auto"
                  disabled={!p.available || sub.status !== "ACTIVE" || changePlan.isPending}
                  onClick={() =>
                    confirmAction({
                      title: t("Switch to {plan}?", { plan: p.name }),
                      description: t("The difference for the remaining days is charged now."),
                      label: t("Switch to {plan}", { plan: p.name }),
                      run: () => {
                        void changePlan
                          .mutateAsync({ subscriptionId: sub.id, planId: p.id, idempotencyKey: `${visit}:${p.id}` })
                          .then((res) => {
                            setCreatedPayment(res.payment)
                          })
                          .catch(() => undefined)
                      },
                    })
                  }
                >
                  {!p.available
                    ? t("Not available yet")
                    : changePlan.isPending && changePlan.variables?.planId === p.id
                      ? t("Preparing payment…")
                      : t("Switch to {plan}", { plan: p.name })}
                </Button>
              )}
            </li>
          )
        })}
      </ul>
      <p className="text-muted-foreground">
        {t("You pay the price difference for the days left in this period. The period end stays the same. Moving to a smaller plan is not possible yet.")}
      </p>
    </section>
  )
}
