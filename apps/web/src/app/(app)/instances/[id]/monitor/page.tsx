"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { LineChart } from "@/components/app/line-chart"
import { SectionTitle } from "@/components/app/page-header"
import { PreviewNote } from "@/components/app/preview-note"
import { QueryFallback } from "@/components/app/query-fallback"
import { useInstanceMeta, usePlans, useUsage } from "@/hooks/use-hermes"
import { formatDuration, formatMb } from "@/lib/format"
import { useInstanceId } from "../instance-frame"

type Range = "1h" | "24h" | "7d"

const RANGE_LABEL: Record<Range, string> = { "1h": "last hour", "24h": "last 24 hours", "7d": "last 7 days" }

export default function MonitorPage() {
  const id = useInstanceId()
  const [range, setRange] = useState<Range>("24h")
  const usage = useUsage(id, range)
  const meta = useInstanceMeta(id)
  const plans = usePlans()
  const plan = plans.data?.find((p) => p.id === meta.data?.planId)
  const pts = usage.data?.points ?? []
  const last = pts.at(-1)
  const span = RANGE_LABEL[range]

  return (
    <div className="grid gap-6">
      <SectionTitle aside={<PreviewNote what="Resource usage" />}>Resource usage</SectionTitle>

      {!usage.data || !plan ? (
        <QueryFallback what="resource usage" queries={[usage, meta, plans]} className="h-24" />
      ) : !last ? (
        <p className="text-muted-foreground">No usage samples for this range yet.</p>
      ) : (
        <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label="Uptime" value={formatDuration(usage.data.uptimeSeconds)} />
          <Stat label="CPU now" value={`${last.cpuPct.toFixed(1)}%`} sub={`of ${plan.cpuMillis / 1000} vCPU`} />
          <Stat label="Memory now" value={formatMb(last.memoryMb)} sub={`of ${formatMb(plan.memoryMb)}`} />
          <Stat label="Disk now" value={formatMb(last.diskMb)} sub={`of ${formatMb(plan.storageMb)}`} />
        </dl>
      )}

      <Tabs value={range} onValueChange={(v) => setRange(v as Range)}>
        <TabsList aria-label="Time range">
          <TabsTrigger value="1h">Last hour</TabsTrigger>
          <TabsTrigger value="24h">24 hours</TabsTrigger>
          <TabsTrigger value="7d">7 days</TabsTrigger>
        </TabsList>
      </Tabs>

      {!usage.data || !plan ? (
        // A failure is already reported once above, with its retry; here we only show loading.
        usage.error || meta.error || plans.error ? null : <QueryFallback what="usage charts" queries={[]} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {/* Each title says what the chart answers: how close the instance is to its plan limit. */}
          <ChartCard title={`CPU use, ${span}`} description="Percent of the plan's CPU">
            <LineChart label="CPU" values={pts.map((p) => p.cpuPct)} max={100} format={(v) => `${v.toFixed(1)}%`} />
          </ChartCard>
          <ChartCard title={`Memory use, ${span}`} description={`Against the ${formatMb(plan.memoryMb)} limit`}>
            <LineChart label="Memory" values={pts.map((p) => p.memoryMb)} max={plan.memoryMb} format={formatMb} />
          </ChartCard>
          <ChartCard title={`Disk use, ${span}`} description={`Against the ${formatMb(plan.storageMb)} volume`}>
            <LineChart label="Disk" values={pts.map((p) => p.diskMb)} max={plan.storageMb} format={formatMb} />
          </ChartCard>
          <ChartCard title={`Inbound traffic, ${span}`} description="Kilobits per second">
            <LineChart
              label="Network in"
              values={pts.map((p) => p.netInKbps)}
              max={Math.max(250, ...pts.map((p) => p.netInKbps))}
              format={(v) => `${Math.round(v)} kbps`}
            />
          </ChartCard>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="grid gap-1 rounded-md border bg-card p-4">
      <dt className="type-label text-muted-foreground">{label}</dt>
      <dd className="type-mono text-foreground">
        {value}
        {sub ? <span className="block text-muted-foreground">{sub}</span> : null}
      </dd>
    </div>
  )
}

function ChartCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}
