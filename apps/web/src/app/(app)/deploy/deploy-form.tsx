"use client"

import { useRouter, useSearchParams } from "next/navigation"
import { useMemo, useState } from "react"
import { Info, Rocket, TriangleAlert } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { QueryFallback } from "@/components/app/query-fallback"
import { KeyValue } from "@/components/app/key-value"
import { PageHeader, SectionTitle } from "@/components/app/page-header"
import { PreviewNote } from "@/components/app/preview-note"
import { PayButton, usePay } from "@/components/app/pay-button"
import { errorMessage, useApiMode, useCheckout, useCreateInstance, usePlans, useRegions, useSubscriptions } from "@/hooks/use-hermes"
import { isPendingPurchase, payableUrl } from "@/lib/billing"
import { cn } from "@/lib/utils"
import { formatCpu, formatMb, formatPriceIdr } from "@/lib/format"
import { useT } from "@/lib/i18n"
import { useLang } from "@/lib/prefs"
import { validateInstanceName } from "./validate-name"

export function DeployForm() {
  const t = useT()
  const lang = useLang()
  const router = useRouter()
  const plans = usePlans()
  const regions = useRegions()
  const create = useCreateInstance()
  const checkout = useCheckout()
  // One key per form session: a double submit or retry cannot provision twice (PRD §15.8).
  const [idempotencyKey] = useState(() => crypto.randomUUID())

  // "Deploy again" on an expired order links here with its name and plan (lib/billing deployAgainHref).
  const search = useSearchParams()
  const [name, setName] = useState(() => search.get("name") ?? "")
  const [touched, setTouched] = useState(false)
  const [regionId, setRegionId] = useState<string>("")
  const [planId, setPlanId] = useState<string>(() => search.get("plan") ?? "")
  // A new checkout expires every other unpaid invoice (backend BillingService.checkout), so say so before it happens.
  const subs = useSubscriptions()
  const openOrder = subs.data?.find((s) => isPendingPurchase(s) && payableUrl(s.latestPayment) !== null)
  const openOrderUrl = openOrder ? payableUrl(openOrder.latestPayment) : null

  // Regions are sample data and the create call never sends one, so customers do not see the choice.
  const showRegion = useApiMode() !== "customer"
  // PRD §4.2: only advertise regions the scheduler can place an instance in.
  const placeable = useMemo(() => regions.data?.filter((r) => r.hasCapacity) ?? [], [regions.data])
  const region = placeable.find((r) => r.id === (regionId || placeable[0]?.id))
  const regionReady = !showRegion || region !== undefined
  const step = (n: number) => (showRegion || n < 2 ? n : n - 1)
  // Every plan is listed; the ones this account cannot take now are shown out of stock and cannot be chosen.
  const openPlans = plans.data?.filter((p) => p.available) ?? []
  // Default to the smallest open plan: no tier is promoted.
  const plan = openPlans.find((p) => p.id === (planId || openPlans[0]?.id))
  const nameError = validateInstanceName(name)
  const priced = plan !== undefined && plan.monthlyPriceIdr !== null
  // No choice to make: the balance pays when it covers the price, otherwise QRIS (owner decision 2026-11-20).
  const { pay, covers, paying } = usePay()
  const fromBalance = priced && covers(plan?.monthlyPriceIdr)
  const busy = create.isPending || checkout.isPending || paying
  const failure = create.error ?? checkout.error

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setTouched(true)
    if (nameError || !plan || !regionReady) return
    if (priced) {
      // A paid plan: the backend creates the instance only after the first payment (QRIS confirmed, or the balance).
      checkout.mutate(
        { input: { name: name.trim(), planId: plan.id }, idempotencyKey },
        { onSuccess: (r) => pay(r.payment, () => router.push("/instances")) }
      )
      return
    }
    create.mutate(
      { input: { name: name.trim(), planId: plan.id }, idempotencyKey },
      // The overview shows provisioning live; its Health card then points to the next step, connecting Telegram.
      { onSuccess: (instance) => router.push(`/instances/${instance.id}`) }
    )
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-8">
      <PageHeader
        actions={showRegion ? <PreviewNote what="Plans, regions and pricing" /> : null}
        title={t("Deploy a Hermes instance")}
        description={t("Your instance runs in its own container with dedicated persistent storage.")}
      />

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="grid gap-8">
          <section className="grid gap-3" aria-labelledby="sec-name">
            <SectionTitle>
              <span id="sec-name">
                {step(1)} · {t("Name")}
              </span>
            </SectionTitle>
            <div className="grid max-w-md gap-2">
              <Label htmlFor="instance-name">{t("Instance name")}</Label>
              <Input
                id="instance-name"
                value={name}
                placeholder={t("e.g. my-assistant")}
                autoComplete="off"
                spellCheck={false}
                maxLength={63}
                aria-invalid={touched && nameError ? true : undefined}
                aria-describedby="instance-name-hint"
                onChange={(e) => setName(e.target.value)}
                onBlur={() => setTouched(true)}
              />
              <p id="instance-name-hint" className={cn("text-muted-foreground", touched && nameError && "text-foreground")}>
                {touched && nameError ? t(nameError) : t("Up to 63 characters. Lowercase letters, numbers and dashes read best in URLs.")}
              </p>
            </div>
          </section>

          {showRegion ? (
          <section className="grid gap-3" aria-labelledby="sec-region">
            <SectionTitle>
              <span id="sec-region">
                {step(2)} · {t("Region")}
              </span>
            </SectionTitle>
            {!regions.data ? (
              <QueryFallback what="regions" queries={[regions]} className="h-16 max-w-md" />
            ) : placeable.length === 0 ? (
              <Alert>
                <Info aria-hidden="true" />
                <AlertTitle>{t("No capacity right now")}</AlertTitle>
                <AlertDescription>{t("All regions are full right now. Try again later.")}</AlertDescription>
              </Alert>
            ) : (
              <RadioGroup
                value={region?.id}
                onValueChange={setRegionId}
                aria-label={t("Region")}
                className="grid gap-3 sm:grid-cols-2"
              >
                {placeable.map((r) => (
                  <OptionCard key={r.id} id={`region-${r.id}`} value={r.id} selected={region?.id === r.id}>
                    <span className="text-foreground">{r.name}</span>
                    <span className="type-mono text-muted-foreground">{r.code}</span>
                  </OptionCard>
                ))}
              </RadioGroup>
            )}
          </section>
          ) : null}

          <section className="grid gap-3" aria-labelledby="sec-plan">
            <SectionTitle>
              <span id="sec-plan">
                {step(3)} · {t("Plan")}
              </span>
            </SectionTitle>
            {!plans.data ? (
              <QueryFallback what="plans" queries={[plans]} className="h-40" />
            ) : (
              <>
              {openPlans.length === 0 ? (
                <Alert>
                  <Info aria-hidden="true" />
                  <AlertTitle>{t("No plan is open for your account")}</AlertTitle>
                  <AlertDescription>
                    {t("Every plan is out of stock for your account right now. Ask for beta access on")}{" "}
                    <a href="https://cloud.nibie.app" className="text-foreground underline underline-offset-4">
                      cloud.nibie.app
                    </a>{" "}
                    {t("and we will email you when a plan opens for you.")}
                  </AlertDescription>
                </Alert>
              ) : null}
              <RadioGroup value={plan?.id ?? ""} onValueChange={setPlanId} aria-label={t("Plan")} className="grid gap-3 md:grid-cols-3">
                {plans.data.map((p) => (
                  <OptionCard key={p.id} id={`plan-${p.id}`} value={p.id} selected={plan?.id === p.id} disabled={!p.available}>
                    <span className="flex items-start justify-between gap-2">
                      <span className="type-label text-foreground">{p.name}</span>
                      {p.available ? null : <Badge variant="outline">{t("Out of stock")}</Badge>}
                    </span>
                    {/* What sets the plans apart comes first: price and included credit. */}
                    <span className="text-foreground">
                      {formatPriceIdr(p.monthlyPriceIdr, lang)}
                      {p.monthlyPriceIdr !== null ? <span className="text-muted-foreground"> {t("per month")}</span> : null}
                    </span>
                    {p.includedCreditUsd !== null ? (
                      <span className="text-muted-foreground">
                        {t("Includes US${amount} AI credit, one-time, in NibieRouter", { amount: p.includedCreditUsd })}
                      </span>
                    ) : null}
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t pt-2">
                      <dt className="text-muted-foreground">CPU</dt>
                      <dd className="type-mono">{formatCpu(p.cpuMillis)}</dd>
                      <dt className="text-muted-foreground">{t("Memory")}</dt>
                      <dd className="type-mono">{formatMb(p.memoryMb)}</dd>
                      <dt className="text-muted-foreground">{t("Storage")}</dt>
                      <dd className="type-mono">{formatMb(p.storageMb)}</dd>
                      <dt className="text-muted-foreground">{t("Processes")}</dt>
                      <dd className="type-mono">{p.pids}</dd>
                      {/* Unset plan fields (null) are left out rather than shown as "not set yet". */}
                      {p.backupRetentionDays !== null ? (
                        <>
                          <dt className="text-muted-foreground">{t("Backups")}</dt>
                          <dd className="type-mono">{t("{days} days", { days: p.backupRetentionDays })}</dd>
                        </>
                      ) : null}
                    </dl>
                    {p.customDomain === true ? <span className="text-muted-foreground">{t("Custom domain included")}</span> : null}
                  </OptionCard>
                ))}
              </RadioGroup>
              </>
            )}
          </section>

          {/* Monthly is the only cycle, so it is stated rather than offered as a choice. A free plan has no cycle. */}
          {priced ? (
            <section className="grid gap-3" aria-labelledby="sec-billing">
              <SectionTitle>
                <span id="sec-billing">
                  {step(4)} · {t("Billing cycle")}
                </span>
              </SectionTitle>
              <div className="grid max-w-md gap-1">
                <p className="text-foreground">{t("Monthly")}</p>
                <p className="text-muted-foreground">
                  {t("Hosting is billed monthly. AI usage is billed separately by NibieRouter or by your own provider.")}
                </p>
              </div>
            </section>
          ) : null}
        </div>

        <aside className="grid gap-4 rounded-md border bg-card p-4 lg:sticky lg:top-10" aria-labelledby="sum-title">
          <h2 id="sum-title" className="type-label">
            {t("Summary")}
          </h2>
          <KeyValue
            className="sm:grid-cols-[max-content_1fr]"
            items={[
              {
                k: t("Name"),
                v: name.trim() ? <span className="type-mono">{name.trim()}</span> : <span className="text-muted-foreground">{t("Not set")}</span>,
              },
              ...(showRegion ? [{ k: t("Region"), v: region ? region.name : <Unset loading={regions.isLoading} /> }] : []),
              { k: t("Plan"), v: plan ? plan.name : <Unset loading={plans.isLoading} /> },
              ...(plan
                ? [
                    {
                      k: t("Resources"),
                      v: (
                        <span className="type-mono">
                          {formatCpu(plan.cpuMillis)} · {formatMb(plan.memoryMb)} · {formatMb(plan.storageMb)}
                        </span>
                      ),
                    },
                  ]
                : []),
              ...(priced ? [{ k: t("Billing"), v: t("Monthly") }] : []),
              ...(plan ? [{ k: t("Price"), v: formatPriceIdr(plan.monthlyPriceIdr, lang) }] : []),
              ...(plan && plan.includedCreditUsd !== null
                ? [{ k: t("AI credit"), v: t("US${amount}, one-time, with the first payment", { amount: plan.includedCreditUsd }) }]
                : []),
            ]}
          />
          {plan ? (
            <Alert>
              <Info aria-hidden="true" />
              <AlertTitle>{!priced ? t("Free during the beta") : fromBalance ? t("Pay from your balance") : t("Pay with QRIS")}</AlertTitle>
              <AlertDescription>
                {!priced
                  ? t("There is nothing to pay. Deploying starts provisioning right away.")
                  : fromBalance
                    ? t("The price is taken from your Nibie Cloud balance and your instance is created right away.")
                    : t("You pay by QRIS on the SumoPod payment page. Your instance is created after the payment is confirmed, usually within a minute.")}
              </AlertDescription>
            </Alert>
          ) : null}
          {priced && openOrder && openOrderUrl ? (
            <Alert>
              <TriangleAlert aria-hidden="true" />
              <AlertTitle>{t("You have an unpaid order for {name}", { name: openOrder.name })}</AlertTitle>
              <AlertDescription>
                <p>{t("Starting a new payment cancels its payment link.")}</p>
                {openOrder.latestPayment ? (
                  <PayButton
                    payment={openOrder.latestPayment}
                    label={t("Pay for {name} instead", { name: openOrder.name })}
                    walletLabel={t("Pay for {name} from balance", { name: openOrder.name })}
                    onPaid={() => router.push("/instances")}
                  />
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}
          {failure ? (
            <Alert variant="destructive" role="alert">
              <AlertTitle>{priced ? t("Could not start the payment") : t("Deployment failed")}</AlertTitle>
              <AlertDescription>{errorMessage(failure)}</AlertDescription>
            </Alert>
          ) : null}
          <Button type="submit" disabled={busy || !plan || !regionReady} className="w-full">
            <Rocket aria-hidden="true" />
            {busy
              ? priced
                ? fromBalance
                  ? t("Paying…")
                  : t("Preparing payment…")
                : t("Deploying…")
              : priced
                ? t("Pay {amount} and deploy", { amount: formatPriceIdr(plan?.monthlyPriceIdr ?? null, lang) })
                : t("Deploy instance")}
          </Button>
        </aside>
      </div>
    </form>
  )
}

function Unset({ loading }: { loading: boolean }) {
  const t = useT()
  return <span className="text-muted-foreground">{loading ? t("Loading") : t("Not available")}</span>
}

function OptionCard({
  id,
  value,
  selected,
  disabled = false,
  children,
}: {
  id: string
  value: string
  selected: boolean
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <Label
      htmlFor={id}
      className={cn(
        "flex items-start gap-3 rounded-md border bg-card p-4 transition-colors",
        disabled ? "cursor-not-allowed" : "cursor-pointer hover:border-muted-foreground",
        selected && "border-foreground bg-elevated"
      )}
    >
      <RadioGroupItem id={id} value={value} disabled={disabled} className="mt-1" />
      <span className="flex min-w-0 flex-1 flex-col gap-1">{children}</span>
    </Label>
  )
}
