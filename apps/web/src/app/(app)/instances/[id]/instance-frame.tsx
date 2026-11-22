"use client"

import Link from "next/link"
import { useParams, usePathname } from "next/navigation"
import { useEffect } from "react"
import { ArrowLeft } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { BillingNotice } from "@/components/app/billing-notice"
import { InstanceActions } from "@/components/app/instance-actions"
import { PreviewNote } from "@/components/app/preview-note"
import { StatusBadge } from "@/components/app/status-badge"
import { useApiMode, useInstance, useInstanceMeta, usePlans, useSubscriptions } from "@/hooks/use-hermes"
import { ApiError } from "@/lib/api"
import { cn } from "@/lib/utils"
import { formatPriceIdr, shortId } from "@/lib/format"
import { subscriptionOfInstance } from "@/lib/billing"
import { useT, type T } from "@/lib/i18n"
import { useLang } from "@/lib/prefs"

const SECTIONS = [
  { slug: "", label: (t: T) => t("Overview") },
  { slug: "access", label: (t: T) => t("Access") },
  { slug: "monitor", label: (t: T) => t("Monitor") },
  { slug: "logs", label: (t: T) => t("Logs") },
  { slug: "configuration", label: (t: T) => t("Configuration") },
  { slug: "files", label: (t: T) => t("File manager") },
  { slug: "console", label: (t: T) => t("Console") },
  { slug: "backups", label: (t: T) => t("Backups") },
  { slug: "billing", label: (t: T) => t("Upgrade & renew") },
  { slug: "domain", label: (t: T) => t("Custom domain") },
]

/**
 * Sections that have a real backend behind them in customer mode. The rest (monitor, files, console,
 * domain, access) still render sample data, so they are not offered to customers until they are wired.
 * Logs are real since the Configuration wiring (container output with the instance's credentials scrubbed).
 */
const CUSTOMER_SECTIONS = new Set(["", "logs", "configuration", "backups", "billing"])

function sectionFor(pathname: string, base: string) {
  const rest = pathname.slice(base.length).split("/")[1] ?? ""
  return SECTIONS.find((s) => s.slug === rest) ?? SECTIONS[0]!
}

/** Instance pages are client-rendered, so the tab title is set here (antislop R-39: unique titles). */
function useDocumentTitle(title: string | null) {
  useEffect(() => {
    if (title) document.title = `${title} · Nibie Cloud`
  }, [title])
}

export function useInstanceId(): string {
  const { id } = useParams<{ id: string }>()
  return id
}

export function InstanceFrame({ children }: { children: React.ReactNode }) {
  const t = useT()
  const lang = useLang()
  const id = useInstanceId()
  const pathname = usePathname()
  const { data: instance, error, isLoading } = useInstance(id)
  const meta = useInstanceMeta(id)
  const plans = usePlans()
  const subs = useSubscriptions()
  const subscription = subscriptionOfInstance(subs.data, id)
  // Prefer the plan the customer is actually billed for; fall back to the instance's own plan.
  const plan = plans.data?.find((p) => p.id === (subscription?.planId ?? instance?.planId))
  const base = `/instances/${id}`
  const mode = useApiMode()
  const mock = mode === "mock"
  const customer = mode === "customer"
  const sections = customer ? SECTIONS.filter((s) => CUSTOMER_SECTIONS.has(s.slug)) : SECTIONS
  const hiddenSection = customer && !CUSTOMER_SECTIONS.has(sectionFor(pathname, base).slug)
  useDocumentTitle(instance ? `${sectionFor(pathname, base).label(t)} · ${instance.name}` : null)

  if (error) {
    const notFound = error instanceof ApiError && error.status === 404
    return (
      <div className="grid gap-6">
        <BackLink t={t} />
        <Alert variant={notFound ? "default" : "destructive"}>
          <AlertTitle>{notFound ? t("Instance not found") : t("Could not load this instance")}</AlertTitle>
          <AlertDescription>
            <p>{notFound ? t("It may have been deleted, or the link is wrong.") : error.message}</p>
            <Button asChild variant="outline" size="sm">
              <Link href="/instances">{t("Back to instances")}</Link>
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  return (
    <div className="grid gap-6">
      <BackLink t={t} />
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
                  {meta.data && !customer ? ` · ${meta.data.regionId} · ${meta.data.runtime}` : ""}
                </span>
                {mock ? <PreviewNote what="This instance and its events" reason="mock" /> : null}
              </div>
              <h1 className="type-h1 break-words">{instance.name}</h1>
              {subscription && plan ? (
                <p className="text-muted-foreground">
                  {plan.name} · {t("monthly")}{plan.monthlyPriceIdr !== null ? ` · ${formatPriceIdr(plan.monthlyPriceIdr, lang)}` : ""}
                </p>
              ) : null}
            </>
          )}
        </div>
        {instance ? (
          <div className="flex flex-wrap items-center gap-2">
            <InstanceActions instance={instance} suspended={subscription?.status === "SUSPENDED"} />
          </div>
        ) : null}
      </header>

      <BillingNotice instanceId={id} />

      <nav aria-label={t("Instance")} className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <ul className="flex min-w-max gap-1 border-b">
          {sections.map(({ slug, label }) => {
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
                  {label(t)}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>

      <div className="min-w-0">
        {hiddenSection ? (
          <Alert>
            <AlertTitle>{t("Not available in the beta yet")}</AlertTitle>
            <AlertDescription>
              <p>{t("This section is still being built. Overview, Logs, Configuration and Upgrade & renew work today.")}</p>
              <Button asChild variant="outline" size="sm">
                <Link href={base}>{t("Back to overview")}</Link>
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          children
        )}
      </div>
    </div>
  )
}

function BackLink({ t }: { t: T }) {
  return (
    <Link
      href="/instances"
      className="hit-area relative inline-flex w-fit items-center gap-2 rounded-sm text-muted-foreground no-underline outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      {t("All instances")}
    </Link>
  )
}
