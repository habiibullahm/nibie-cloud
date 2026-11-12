"use client"

import Link from "next/link"
import { Check, CircleX, Copy, Minus, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { PreviewNote } from "@/components/app/preview-note"
import { ProvisionProgress } from "@/components/app/provision-progress"
import { useEvents, useInstance, useProvider, useTelegram } from "@/hooks/use-hermes"
import { isTransitional, presentStatus, provisionStepIndex } from "@/lib/api/status"
import type { Instance } from "@/lib/api/types"
import { formatDateTime, formatRelative } from "@/lib/format"
import { useInstanceId } from "./instance-frame"

export default function OverviewPage() {
  const id = useInstanceId()
  const { data: instance } = useInstance(id)
  if (!instance) return <Skeleton className="h-64 bg-card" />

  const provisioning = provisionStepIndex(instance.status) >= 0 && instance.status !== "ACTIVE" && instance.status !== "DEGRADED"

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      {provisioning ? (
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Deploying</CardTitle>
            <CardDescription>This usually takes under a minute. You can leave this page; we keep going.</CardDescription>
          </CardHeader>
          <CardContent>
            <ProvisionProgress status={instance.status} />
          </CardContent>
        </Card>
      ) : null}
      <StatusCard instance={instance} />
      <HealthCard instance={instance} />
      <EventsCard instance={instance} />
    </div>
  )
}

function StatusCard({ instance }: { instance: Instance }) {
  const p = presentStatus(instance.status)
  const reason = instance.statusReason ?? p.defaultReason
  return (
    <Card>
      <CardHeader>
        <CardTitle>Hermes status</CardTitle>
        <CardDescription>{p.label}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {reason ? <p>{reason}</p> : <p>Hermes is running and passing health checks.</p>}
        {p.nextAction ? (
          <div className="grid gap-1 border-t pt-4">
            <span className="type-label text-muted-foreground">Next step</span>
            <p>{p.nextAction}</p>
          </div>
        ) : null}
        <div className="grid gap-2 border-t pt-4">
          <span className="type-label text-muted-foreground">Instance URL</span>
          {instance.accessUrl ? (
            <div className="flex min-w-0 items-center gap-2">
              <a href={instance.accessUrl} target="_blank" rel="noreferrer" className="type-mono min-w-0 truncate text-foreground">
                {instance.accessUrl}
              </a>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Copy instance URL"
                onClick={() => {
                  void navigator.clipboard?.writeText(instance.accessUrl!)
                  toast.success("URL copied")
                }}
              >
                <Copy aria-hidden="true" />
              </Button>
            </div>
          ) : (
            <p className="text-muted-foreground">Available once the instance is active.</p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

type Health = "ok" | "warn" | "fail" | "none"

function HealthRow({ label, state, text }: { label: string; state: Health; text: string }) {
  const Icon = state === "ok" ? Check : state === "warn" ? TriangleAlert : state === "fail" ? CircleX : Minus
  return (
    <li className="flex items-center justify-between gap-3 border-t py-2 first:border-t-0 first:pt-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="inline-flex items-center gap-2 text-right">
        <Icon className={state === "fail" ? "size-4 text-destructive" : "size-4"} aria-hidden="true" />
        {text}
      </span>
    </li>
  )
}

function HealthCard({ instance }: { instance: Instance }) {
  const provider = useProvider(instance.id)
  const telegram = useTelegram(instance.id)
  const s = instance.status
  const running = s === "ACTIVE" || s === "DEGRADED"
  const runtime: [Health, string] = running
    ? ["ok", "Running"]
    : s === "FAILED"
      ? ["fail", "Not running"]
      : isTransitional(s)
        ? ["none", presentStatus(s).label]
        : ["none", "Stopped"]
  const gateway: [Health, string] =
    s === "ACTIVE"
      ? ["ok", "Ready"]
      : s === "DEGRADED"
        ? ["warn", "Failing checks"]
        : isTransitional(s)
          ? ["none", "Waiting for runtime"]
          : ["none", "Offline"]
  const prov: [Health, string] = !provider.data
    ? ["none", "Loading"]
    : provider.data.status === "connected"
      ? ["ok", provider.data.kind === "nibierouter" ? "NibieRouter connected" : "Own key connected"]
      : provider.data.status === "error"
        ? ["fail", "Connection error"]
        : ["warn", "Not tested"]
  const tg: [Health, string] = !telegram.data
    ? ["none", "Loading"]
    : !telegram.data.configured
      ? ["none", "Not set up"]
      : telegram.data.verified
        ? ["ok", `@${telegram.data.botUsername}`]
        : ["warn", "Not verified"]

  return (
    <Card>
      <CardHeader>
        <CardTitle>Health</CardTitle>
        <CardDescription>Each layer is checked separately.</CardDescription>
        <CardAction>
          <PreviewNote what="Provider and Telegram health" />
        </CardAction>
      </CardHeader>
      <CardContent>
        <ul className="grid">
          <HealthRow label="Runtime" state={runtime[0]} text={runtime[1]} />
          <HealthRow label="Hermes gateway" state={gateway[0]} text={gateway[1]} />
          <HealthRow label="AI provider" state={prov[0]} text={prov[1]} />
          <HealthRow label="Telegram" state={tg[0]} text={tg[1]} />
        </ul>
        <div className="flex flex-wrap gap-2 pt-4">
          <Button asChild variant="outline" size="sm">
            <Link href={`/instances/${instance.id}/configuration`}>Configure provider and Telegram</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function EventsCard({ instance }: { instance: Instance }) {
  const events = useEvents(instance.id, isTransitional(instance.status))
  const list = [...(events.data ?? [])].reverse()
  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>Recent activity</CardTitle>
        <CardDescription>Deployment and health events for this instance.</CardDescription>
      </CardHeader>
      <CardContent>
        {events.isLoading ? (
          <Skeleton className="h-24 bg-elevated" />
        ) : list.length === 0 ? (
          <p className="text-muted-foreground">No events yet.</p>
        ) : (
          <ol className="grid">
            {list.slice(0, 12).map((e, i) => (
              <li
                key={`${e.createdAt}-${i}`}
                className="grid gap-1 border-t py-2 first:border-t-0 first:pt-0 sm:grid-cols-[160px_minmax(0,1fr)] sm:gap-4"
              >
                <time dateTime={e.createdAt} className="type-mono text-muted-foreground" title={formatDateTime(e.createdAt)}>
                  {formatRelative(e.createdAt)}
                </time>
                <span className="min-w-0 break-words">{e.message}</span>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}
