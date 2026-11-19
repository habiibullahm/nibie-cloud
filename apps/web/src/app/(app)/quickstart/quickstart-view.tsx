"use client"

import Link from "next/link"
import { Circle, CircleCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { PageHeader } from "@/components/app/page-header"
import { PreviewNote } from "@/components/app/preview-note"
import { QueryFallback } from "@/components/app/query-fallback"
import { useApiMode, useDisplayName, useInstances, useProvider, useTelegram } from "@/hooks/use-hermes"
import type { Instance, ProviderConfig, TelegramConfig } from "@/lib/api/types"
import { useT } from "@/lib/i18n"
import { quickstartDone, quickstartInstance } from "@/lib/quickstart"

export function QuickstartView() {
  const t = useT()
  const name = useDisplayName()
  const instances = useInstances()
  return (
    <div className="mx-auto grid w-full max-w-[720px] gap-6">
      <PageHeader
        title={name.data ? t("Welcome, {name}", { name: name.data }) : t("Welcome")}
        description={t("Get your Hermes agent answering on Telegram in a few minutes.")}
      />
      <InstanceChecklist instances={instances} />
    </div>
  )
}

function InstanceChecklist({ instances }: { instances: ReturnType<typeof useInstances> }) {
  if (!instances.data) return <QueryFallback what="your instances" queries={[instances]} className="h-64" />
  const instance = quickstartInstance(instances.data)
  // Provider and Telegram are per instance, so their queries run only once there is one.
  return instance ? <WithIntegrations instance={instance} /> : <Checklist instance={null} />
}

function WithIntegrations({ instance }: { instance: Instance }) {
  const provider = useProvider(instance.id)
  const telegram = useTelegram(instance.id)
  // Unknown is not "not done": wait (or offer a retry) rather than ask for a setup that may already be finished.
  if (!provider.data || !telegram.data) return <QueryFallback what="setup status" queries={[provider, telegram]} className="h-64" />
  return <Checklist instance={instance} provider={provider.data} telegram={telegram.data} />
}

function Checklist({ instance, provider, telegram }: { instance: Instance | null; provider?: ProviderConfig; telegram?: TelegramConfig }) {
  const t = useT()
  // Provider and Telegram are real in customer mode; the mock and the dev bridge serve sample status.
  const sample = useApiMode() !== "customer"
  const done = quickstartDone(instance, provider, telegram)
  const config = instance ? `/instances/${instance.id}/configuration` : null
  // The one primary (terracotta) button belongs to the first step still open.
  const next = (["deploy", "provider", "telegram"] as const).find((k) => !done[k])

  const steps = [
    {
      id: "deploy",
      done: done.deploy,
      title: t("Deploy your first instance"),
      body: instance
        ? t("{name} is deployed. It runs in its own container with its own storage.", { name: instance.name })
        : t("Pick a plan and a name. Hermes is ready a few minutes after you pay."),
      action: instance ? { href: `/instances/${instance.id}`, label: t("Open instance") } : { href: "/deploy", label: t("Deploy") },
    },
    {
      id: "provider",
      done: done.provider,
      title: t("Connect an AI provider"),
      body: done.provider
        ? provider?.kind === "nibierouter"
          ? t("NibieRouter is connected. Paid plans include credit.")
          : t("Your own API key is connected.")
        : t("Hermes needs a model to answer. Paid plans connect NibieRouter for you; you can also use your own API key."),
      action: config ? { href: `${config}?tab=provider`, label: t("AI provider settings") } : null,
    },
    {
      id: "telegram",
      done: done.telegram,
      title: t("Connect Telegram"),
      body: done.telegram
        ? t("@{bot} is connected. Send it a message to talk to your agent.", { bot: telegram?.botUsername ?? "" })
        : t("Create a bot with @BotFather, paste its token, and send a test message."),
      action: config
        ? { href: `${config}?tab=telegram`, label: telegram?.configured ? t("Telegram settings") : t("Connect Telegram") }
        : null,
    },
  ]
  const count = steps.filter((s) => s.done).length

  return (
    <>
      <Card>
        <CardContent className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-medium">
              {count === steps.length ? t("You're all set") : t("{done} of {total} steps done", { done: count, total: steps.length })}
            </p>
            {sample && instance ? <PreviewNote what="Provider and Telegram status" /> : null}
          </div>
          <Progress value={(count / steps.length) * 100} aria-label={t("Setup progress")} />
        </CardContent>
      </Card>

      <ol className="grid">
        {steps.map((s, i) => (
          <li key={s.id} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 border-t py-5 first:border-t-0 first:pt-0">
            <span className="pt-0.5">
              {s.done ? <CircleCheck className="size-5" aria-hidden="true" /> : <Circle className="size-5 text-muted-foreground" aria-hidden="true" />}
              <span className="sr-only">{s.done ? t("Done") : t("Not done yet")}</span>
            </span>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="grid min-w-0 gap-1">
                <h2 className="font-medium text-foreground">
                  {i + 1}. {s.title}
                </h2>
                <p className="text-muted-foreground">{s.body}</p>
              </div>
              {s.action ? (
                <Button asChild size="sm" variant={next === s.id ? "default" : "outline"} className="shrink-0 self-start">
                  <Link href={s.action.href}>{s.action.label}</Link>
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </>
  )
}
