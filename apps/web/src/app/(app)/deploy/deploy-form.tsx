"use client"

import { useRouter } from "next/navigation"
import { useMemo, useState } from "react"
import { Info, Rocket } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { QueryFallback } from "@/components/app/query-fallback"
import { KeyValue } from "@/components/app/key-value"
import { PageHeader, SectionTitle } from "@/components/app/page-header"
import { PreviewNote } from "@/components/app/preview-note"
import { errorMessage, useCreateInstance, usePlans, useRegions } from "@/hooks/use-hermes"
import { cn } from "@/lib/utils"
import { formatCpu, formatMb, formatPriceIdr } from "@/lib/format"
import { validateInstanceName } from "./validate-name"

export function DeployForm() {
  const router = useRouter()
  const plans = usePlans()
  const regions = useRegions()
  const create = useCreateInstance()
  // One key per form session: a double submit or retry cannot provision twice (PRD §15.8).
  const [idempotencyKey] = useState(() => crypto.randomUUID())

  const [name, setName] = useState("")
  const [touched, setTouched] = useState(false)
  const [regionId, setRegionId] = useState<string>("")
  const [planId, setPlanId] = useState<string>("")
  const [cycle, setCycle] = useState("monthly")

  // PRD §4.2: only advertise regions the scheduler can place an instance in.
  const placeable = useMemo(() => regions.data?.filter((r) => r.hasCapacity) ?? [], [regions.data])
  const region = placeable.find((r) => r.id === (regionId || placeable[0]?.id))
  // Default to the smallest plan: no tier is promoted, and upgrading later is always possible.
  const plan = plans.data?.find((p) => p.id === (planId || plans.data?.[0]?.id))
  const nameError = validateInstanceName(name)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setTouched(true)
    if (nameError || !plan || !region) return
    create.mutate(
      { input: { name: name.trim(), planId: plan.id }, idempotencyKey },
      { onSuccess: (instance) => router.push(`/instances/${instance.id}`) }
    )
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-8">
      <PageHeader
        actions={<PreviewNote what="Plans, regions and pricing" />}
        title="Deploy a Hermes instance"
        description="Your instance runs in its own container with dedicated persistent storage. You can change plans later."
      />

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="grid gap-8">
          <section className="grid gap-3" aria-labelledby="sec-name">
            <SectionTitle>
              <span id="sec-name">1 · Name</span>
            </SectionTitle>
            <div className="grid max-w-md gap-2">
              <Label htmlFor="instance-name">Instance name</Label>
              <Input
                id="instance-name"
                value={name}
                placeholder="my-assistant"
                autoComplete="off"
                spellCheck={false}
                maxLength={63}
                aria-invalid={touched && nameError ? true : undefined}
                aria-describedby="instance-name-hint"
                onChange={(e) => setName(e.target.value)}
                onBlur={() => setTouched(true)}
              />
              <p id="instance-name-hint" className={cn("text-muted-foreground", touched && nameError && "text-foreground")}>
                {touched && nameError ? nameError : "Up to 63 characters. Lowercase letters, numbers and dashes read best in URLs."}
              </p>
            </div>
          </section>

          <section className="grid gap-3" aria-labelledby="sec-region">
            <SectionTitle>
              <span id="sec-region">2 · Region</span>
            </SectionTitle>
            {!regions.data ? (
              <QueryFallback what="regions" queries={[regions]} className="h-16 max-w-md" />
            ) : placeable.length === 0 ? (
              <Alert>
                <Info aria-hidden="true" />
                <AlertTitle>No capacity right now</AlertTitle>
                <AlertDescription>All regions are full right now. Try again later.</AlertDescription>
              </Alert>
            ) : (
              <RadioGroup
                value={region?.id}
                onValueChange={setRegionId}
                aria-label="Region"
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

          <section className="grid gap-3" aria-labelledby="sec-plan">
            <SectionTitle>
              <span id="sec-plan">3 · Plan</span>
            </SectionTitle>
            {!plans.data ? (
              <QueryFallback what="plans" queries={[plans]} className="h-40" />
            ) : (
              <RadioGroup value={plan?.id} onValueChange={setPlanId} aria-label="Plan" className="grid gap-3 md:grid-cols-3">
                {plans.data?.map((p) => (
                  <OptionCard key={p.id} id={`plan-${p.id}`} value={p.id} selected={plan?.id === p.id}>
                    <span className="type-label text-foreground">{p.name}</span>
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 pt-2">
                      <dt className="text-muted-foreground">CPU</dt>
                      <dd className="type-mono">{formatCpu(p.cpuMillis)}</dd>
                      <dt className="text-muted-foreground">Memory</dt>
                      <dd className="type-mono">{formatMb(p.memoryMb)}</dd>
                      <dt className="text-muted-foreground">Storage</dt>
                      <dd className="type-mono">{formatMb(p.storageMb)}</dd>
                      <dt className="text-muted-foreground">Processes</dt>
                      <dd className="type-mono">{p.pids}</dd>
                      <dt className="text-muted-foreground">Backups</dt>
                      <dd className="type-mono">{p.backupRetentionDays} days</dd>
                    </dl>
                    <span className="pt-2 text-muted-foreground">
                      {p.customDomain ? "Custom domain included" : "No custom domain"}
                    </span>
                    <span className="border-t pt-2 text-muted-foreground">
                      Price <span className="text-foreground">{formatPriceIdr(p.monthlyPriceIdr)}</span>
                    </span>
                  </OptionCard>
                ))}
              </RadioGroup>
            )}
          </section>

          <section className="grid gap-3" aria-labelledby="sec-billing">
            <SectionTitle>
              <span id="sec-billing">4 · Billing cycle</span>
            </SectionTitle>
            <div className="grid max-w-md gap-2">
              <Label htmlFor="billing-cycle">Cycle</Label>
              <Select value={cycle} onValueChange={setCycle}>
                <SelectTrigger id="billing-cycle" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="monthly">Monthly</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-muted-foreground">
                Hosting is billed monthly. AI usage is billed separately by NibieRouter or by your own provider.
              </p>
            </div>
          </section>
        </div>

        <aside className="grid gap-4 rounded-md border bg-card p-4 lg:sticky lg:top-10" aria-labelledby="sum-title">
          <h2 id="sum-title" className="type-label">
            Summary
          </h2>
          <KeyValue
            className="sm:grid-cols-[max-content_1fr]"
            items={[
              {
                k: "Name",
                v: name.trim() ? <span className="type-mono">{name.trim()}</span> : <span className="text-muted-foreground">Not set</span>,
              },
              { k: "Region", v: region ? region.name : <Unset loading={regions.isLoading} /> },
              { k: "Plan", v: plan ? plan.name : <Unset loading={plans.isLoading} /> },
              ...(plan
                ? [
                    {
                      k: "Resources",
                      v: (
                        <span className="type-mono">
                          {formatCpu(plan.cpuMillis)} · {formatMb(plan.memoryMb)} · {formatMb(plan.storageMb)}
                        </span>
                      ),
                    },
                  ]
                : []),
              { k: "Network", v: "Dedicated container, platform egress policy" },
              { k: "Billing", v: cycle === "monthly" ? "Monthly" : cycle },
              ...(plan ? [{ k: "Price", v: formatPriceIdr(plan.monthlyPriceIdr) }] : []),
            ]}
          />
          <Alert>
            <Info aria-hidden="true" />
            <AlertTitle>Checkout is not available yet</AlertTitle>
            <AlertDescription>
              Pricing is still being set. In this preview, deploying skips payment and starts provisioning directly.
            </AlertDescription>
          </Alert>
          {create.error ? (
            <Alert variant="destructive" role="alert">
              <AlertTitle>Deployment failed</AlertTitle>
              <AlertDescription>{errorMessage(create.error)}</AlertDescription>
            </Alert>
          ) : null}
          <Button type="submit" disabled={create.isPending || !plan || !region} className="w-full">
            <Rocket aria-hidden="true" />
            {create.isPending ? "Deploying…" : "Deploy instance"}
          </Button>
        </aside>
      </div>
    </form>
  )
}

function Unset({ loading }: { loading: boolean }) {
  return <span className="text-muted-foreground">{loading ? "Loading" : "Not available"}</span>
}

function OptionCard({
  id,
  value,
  selected,
  children,
}: {
  id: string
  value: string
  selected: boolean
  children: React.ReactNode
}) {
  return (
    <Label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-md border bg-card p-4 transition-colors hover:border-muted-foreground",
        selected && "border-foreground bg-elevated"
      )}
    >
      <RadioGroupItem id={id} value={value} className="mt-1" />
      <span className="flex min-w-0 flex-1 flex-col gap-1">{children}</span>
    </Label>
  )
}
