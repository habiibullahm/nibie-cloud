"use client"

import Link from "next/link"
import { Boxes, Plus, RefreshCw } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/app/empty-state"
import { PageHeader } from "@/components/app/page-header"
import { PreviewNote } from "@/components/app/preview-note"
import { StatusBadge } from "@/components/app/status-badge"
import { errorMessage, useApiMode, useInstanceMeta, useInstances, usePlans } from "@/hooks/use-hermes"
import type { Instance } from "@/lib/api/types"
import { presentStatus } from "@/lib/api/status"
import { formatRelative, shortId } from "@/lib/format"

export function InstancesView() {
  const { data, isLoading, error, refetch, isFetching } = useInstances()
  const mock = useApiMode() === "mock"

  return (
    <div className="grid gap-8">
      <PageHeader
        title="Instances"
        description="Each instance is a dedicated Hermes runtime with its own persistent storage."
        actions={
          <>
            {mock ? <PreviewNote what="These instances" reason="mock" /> : null}
            <Button asChild>
              <Link href="/deploy">
                <Plus aria-hidden="true" />
                Deploy instance
              </Link>
            </Button>
          </>
        }
      />

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load instances</AlertTitle>
          <AlertDescription>
            <p>{errorMessage(error)}</p>
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw aria-hidden="true" />
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : isLoading ? (
        <div className="grid gap-4 md:grid-cols-2" role="status" aria-label="Loading instances">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-40 rounded-md bg-card" />
          ))}
        </div>
      ) : data && data.length === 0 ? (
        <EmptyState
          icon={<Boxes />}
          title="No instances yet"
          description="Deploy your first Hermes agent. Choose a plan and region, name it, and we handle the runtime, storage and recovery."
          action={
            <Button asChild variant="outline">
              <Link href="/deploy">Start a deployment</Link>
            </Button>
          }
        />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2" aria-label="Your instances">
          {data?.map((i) => (
            <li key={i.id}>
              <InstanceCard instance={i} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function InstanceCard({ instance }: { instance: Instance }) {
  const meta = useInstanceMeta(instance.id)
  const plans = usePlans()
  const plan = plans.data?.find((p) => p.id === meta.data?.planId)
  const p = presentStatus(instance.status)
  const reason = instance.statusReason ?? (p.tone === "ok" ? null : p.defaultReason)

  return (
    <article className="relative flex h-full flex-col gap-3 rounded-md border bg-card p-4 transition-colors focus-within:border-muted-foreground hover:border-muted-foreground">
      <div className="flex items-center justify-between gap-3">
        <span className="type-label text-muted-foreground">Instance</span>
        <StatusBadge status={instance.status} />
      </div>
      <h2 className="min-w-0 break-words text-foreground">
        <Link
          href={`/instances/${instance.id}`}
          className="rounded-sm text-foreground no-underline outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-offset-2 focus-visible:after:ring-offset-background"
        >
          {instance.name}
        </Link>
      </h2>
      <p className="type-mono text-muted-foreground">
        {shortId(instance.id)}
        {plan ? ` · ${plan.name.toLowerCase()}` : ""}
        {meta.data ? ` · ${meta.data.regionId}` : ""}
        {meta.data ? ` · ${meta.data.runtime}` : ""}
      </p>
      {reason ? <p className="text-muted-foreground">{reason}</p> : null}
      <div className="mt-auto flex items-center justify-between gap-3 border-t pt-3 text-muted-foreground">
        <span>Created {formatRelative(instance.createdAt)}</span>
        <span className="text-foreground underline decoration-input underline-offset-4" aria-hidden="true">
          Manage
        </span>
      </div>
    </article>
  )
}
