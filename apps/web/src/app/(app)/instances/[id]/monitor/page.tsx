"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { LineChart } from "@/components/app/line-chart"
import { SectionTitle } from "@/components/app/page-header"
import { PreviewNote } from "@/components/app/preview-note"
import { useInstanceMeta, usePlans, useUsage } from "@/hooks/use-hermes"
import { formatDuration, formatMb } from "@/lib/format"
import { useInstanceId } from "../instance-frame"

type Range = "1h" | "24h" | "7d"

export default function MonitorPage() {
  const id = useInstanceId()
  const [range, setRange] = useState<Range>("24h")
  const usage = useUsage(id, range)
  const meta = useInstanceMeta(id)
  const plans = usePlans()
  const plan = plans.data?.find((p) => p.id === meta.data?.planId)
  const pts = usage.data?.points ?? []
  const last = pts.at(-1)

  return (
    <div className="grid gap-6">
      <SectionTitle aside={<PreviewNote what="Resource usage" />}>Resource usage</SectionTitle>

      <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Uptime" value={usage.data ? formatDuration(usage.data.uptimeSeconds) : "—"} />
        <Stat label="CPU" value={last ? `${last.cpuPct.toFixed(1)}%` : "—"} sub={plan ? `of ${plan.cpuMillis / 1000} vCPU` : undefined} />
        <Stat label="Memory" value={last ? formatMb(last.memoryMb) : "—"} sub={plan ? `of ${formatMb(plan.memoryMb)}` : undefined} />
        <Stat label="Disk" value={last ? formatMb(last.diskMb) : "—"} sub={plan ? `of ${formatMb(plan.storageMb)}` : undefined} />
      </dl>

      <Tabs value={range} onValueChange={(v) => setRange(v as Range)}>
        <TabsList aria-label="Time range">
          <TabsTrigger value="1h">Last hour</TabsTrigger>
          <TabsTrigger value="24h">24 hours</TabsTrigger>
          <TabsTrigger value="7d">7 days</TabsTrigger>
        </TabsList>
      </Tabs>

      {usage.isLoading || !plan ? (
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-48 bg-card" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <ChartCard title="CPU">
            <LineChart label="CPU" values={pts.map((p) => p.cpuPct)} max={100} format={(v) => `${v.toFixed(1)}%`} />
          </ChartCard>
          <ChartCard title="Memory">
            <LineChart label="Memory" values={pts.map((p) => p.memoryMb)} max={plan.memoryMb} format={formatMb} />
          </ChartCard>
          <ChartCard title="Disk">
            <LineChart label="Disk" values={pts.map((p) => p.diskMb)} max={plan.storageMb} format={formatMb} />
          </ChartCard>
          <ChartCard title="Network in">
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

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}
