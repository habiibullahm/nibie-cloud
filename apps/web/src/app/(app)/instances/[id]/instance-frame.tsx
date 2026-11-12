"use client"

import Link from "next/link"
import { useParams, usePathname } from "next/navigation"
import { useEffect } from "react"
import { ArrowLeft } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { InstanceActions } from "@/components/app/instance-actions"
import { PreviewNote } from "@/components/app/preview-note"
import { StatusBadge } from "@/components/app/status-badge"
import { useApiMode, useInstance, useInstanceMeta, usePlans } from "@/hooks/use-hermes"
import { ApiError } from "@/lib/api"
import { cn } from "@/lib/utils"
import { shortId } from "@/lib/format"

const SECTIONS = [
  { slug: "", label: "Overview" },
  { slug: "access", label: "Access" },
  { slug: "monitor", label: "Monitor" },
  { slug: "logs", label: "Logs" },
  { slug: "configuration", label: "Configuration" },
  { slug: "files", label: "File manager" },
  { slug: "console", label: "Console" },
  { slug: "backups", label: "Backups" },
  { slug: "billing", label: "Upgrade & renew" },
  { slug: "domain", label: "Custom domain" },
]

function sectionFor(pathname: string, base: string) {
  const rest = pathname.slice(base.length).split("/")[1] ?? ""
  return SECTIONS.find((s) => s.slug === rest) ?? SECTIONS[0]!
}

/** Instance pages are client-rendered, so the tab title is set here (antislop R-39: unique titles). */
function useDocumentTitle(title: string | null) {
  useEffect(() => {
    if (title) document.title = `${title} · Hermes Cloud`
  }, [title])
}

export function useInstanceId(): string {
  const { id } = useParams<{ id: string }>()
  return id
}

export function InstanceFrame({ children }: { children: React.ReactNode }) {
  const id = useInstanceId()
  const pathname = usePathname()
  const { data: instance, error, isLoading } = useInstance(id)
  const meta = useInstanceMeta(id)
  const plans = usePlans()
  const plan = plans.data?.find((p) => p.id === meta.data?.planId)
  const base = `/instances/${id}`
  const mock = useApiMode() === "mock"
  useDocumentTitle(instance ? `${sectionFor(pathname, base).label} · ${instance.name}` : null)

  if (error) {
    const notFound = error instanceof ApiError && error.status === 404
    return (
      <div className="grid gap-6">
        <BackLink />
        <Alert variant={notFound ? "default" : "destructive"}>
          <AlertTitle>{notFound ? "Instance not found" : "Could not load this instance"}</AlertTitle>
          <AlertDescription>
            <p>{notFound ? "It may have been deleted, or the link is wrong." : error.message}</p>
            <Button asChild variant="outline" size="sm">
              <Link href="/instances">Back to instances</Link>
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  return (
    <div className="grid gap-6">
      <BackLink />
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="flex min-w-0 flex-col gap-3">
          {isLoading || !instance ? (
            <>
              <Skeleton className="h-6 w-24 bg-card" />
              <Skeleton className="h-8 w-64 bg-card" />
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <StatusBadge status={instance.status} />
                <span className="type-mono text-muted-foreground">
                  {shortId(instance.id)}
                  {plan ? ` · ${plan.name.toLowerCase()}` : ""}
                  {meta.data ? ` · ${meta.data.regionId} · ${meta.data.runtime}` : ""}
                </span>
                {mock ? <PreviewNote what="This instance and its events" reason="mock" /> : null}
              </div>
              <h1 className="type-h1 break-words">{instance.name}</h1>
            </>
          )}
        </div>
        {instance ? (
          <div className="flex flex-wrap items-center gap-2">
            <InstanceActions instance={instance} />
          </div>
        ) : null}
      </header>

      <nav aria-label="Instance" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <ul className="flex min-w-max gap-1 border-b">
          {SECTIONS.map(({ slug, label }) => {
            const href = slug ? `${base}/${slug}` : base
            const active = slug ? pathname.startsWith(href) : pathname === base
            return (
              <li key={slug || "overview"}>
                <Link
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "hit-area relative -mb-px inline-flex rounded-t-sm border-b-2 border-transparent px-3 py-2 whitespace-nowrap text-muted-foreground no-underline transition-colors outline-none hover:bg-elevated hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                    active && "border-foreground text-foreground"
                  )}
                >
                  {label}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>

      <div className="min-w-0">{children}</div>
    </div>
  )
}

function BackLink() {
  return (
    <Link
      href="/instances"
      className="hit-area relative inline-flex w-fit items-center gap-2 rounded-sm text-muted-foreground no-underline outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      All instances
    </Link>
  )
}
