"use client"

import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Check, CircleX, PlugZap, Send, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { KeyValue } from "@/components/app/key-value"
import { PreviewNote } from "@/components/app/preview-note"
import { errorMessage, keys, useInstanceMeta, usePlans, useProvider, useTelegram } from "@/hooks/use-hermes"
import { getApi, type ProviderConfig, type ProviderKind, type TelegramConfig } from "@/lib/api"
import { formatCpu, formatMb, formatRelative } from "@/lib/format"
import { cn } from "@/lib/utils"
import { useInstanceId } from "../instance-frame"

export default function ConfigurationPage() {
  const id = useInstanceId()
  return (
    <Tabs defaultValue="provider">
      <TabsList aria-label="Configuration">
        <TabsTrigger value="provider">AI provider</TabsTrigger>
        <TabsTrigger value="telegram">Telegram</TabsTrigger>
        <TabsTrigger value="runtime">Runtime</TabsTrigger>
      </TabsList>
      <TabsContent value="provider">
        <ProviderSection id={id} />
      </TabsContent>
      <TabsContent value="telegram">
        <TelegramSection id={id} />
      </TabsContent>
      <TabsContent value="runtime">
        <RuntimeSection id={id} />
      </TabsContent>
    </Tabs>
  )
}

// ── Provider (PRD §8) ────────────────────────────────────────────────────────

const BYOK_PROVIDERS = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "custom", label: "OpenAI-compatible (custom URL)" },
]

function ConnectionStatus({ config }: { config: ProviderConfig }) {
  const Icon = config.status === "connected" ? Check : config.status === "error" ? CircleX : TriangleAlert
  const text =
    config.status === "connected" ? "Connected" : config.status === "error" ? "Connection error" : "Not tested yet"
  return (
    <span className="inline-flex items-center gap-2">
      <Icon className={cn("size-4", config.status === "error" && "text-destructive")} aria-hidden="true" />
      {text}
      {config.statusMessage ? <span className="text-muted-foreground">· {config.statusMessage}</span> : null}
    </span>
  )
}

function ProviderSection({ id }: { id: string }) {
  const provider = useProvider(id)
  if (!provider.data) return <Skeleton className="h-64 bg-card" />
  return <ProviderForm key={provider.data.id} id={id} cfg={provider.data} />
}

function ProviderForm({ id, cfg }: { id: string; cfg: ProviderConfig }) {
  const qc = useQueryClient()
  const [kind, setKind] = useState<ProviderKind>(cfg.kind)
  const [providerName, setProviderName] = useState(cfg.providerName ?? "openai")
  const [baseUrl, setBaseUrl] = useState(cfg.baseUrl ?? "")
  const [apiKey, setApiKey] = useState("")
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError(null)
    setSaving(true)
    try {
      const next = await getApi().preview.saveProvider(id, {
        kind,
        providerName: kind === "byok" ? providerName : undefined,
        baseUrl: kind === "byok" && providerName === "custom" ? baseUrl : undefined,
        apiKey: kind === "byok" && apiKey ? apiKey : undefined,
      })
      qc.setQueryData(keys.provider(id), next)
      setApiKey("")
      toast.success("Provider saved. Test the connection to confirm it works.")
    } catch (err) {
      setFormError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    setTesting(true)
    try {
      const next = await getApi().preview.testProvider(id)
      qc.setQueryData(keys.provider(id), next)
      toast.success("Connection test passed")
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setTesting(false)
    }
  }

  return (
    <form onSubmit={save}>
      <Card>
        <CardHeader>
          <CardTitle>AI provider</CardTitle>
          <CardDescription>Hermes Cloud bills hosting only. AI usage is billed by the provider you choose.</CardDescription>
          <CardAction>
            <PreviewNote what="Provider configuration" />
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-6">
          <div className="grid gap-1">
            <span className="type-label text-muted-foreground">Current</span>
            <p>
              {cfg.kind === "nibierouter" ? "NibieRouter (default)" : `Own key · ${labelFor(cfg.providerName)}`}
              {cfg.keyHint ? <span className="type-mono text-muted-foreground"> · key {cfg.keyHint}</span> : null}
            </p>
            <ConnectionStatus config={cfg} />
            <p className="text-muted-foreground">Updated {formatRelative(cfg.updatedAt)}</p>
          </div>

          <RadioGroup value={kind} onValueChange={(v) => setKind(v as ProviderKind)} aria-label="Provider type" className="grid gap-3 md:grid-cols-2">
            <ChoiceCard id="kind-nibie" value="nibierouter" selected={kind === "nibierouter"} title="NibieRouter">
              Works out of the box. Usage is attributed to your account and billed by NibieRouter.
            </ChoiceCard>
            <ChoiceCard id="kind-byok" value="byok" selected={kind === "byok"} title="Bring your own key">
              Use your own provider account. Charges come from that provider, not Hermes Cloud.
            </ChoiceCard>
          </RadioGroup>

          {kind === "byok" ? (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="byok-provider">Provider</Label>
                <Select value={providerName} onValueChange={setProviderName}>
                  <SelectTrigger id="byok-provider" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BYOK_PROVIDERS.map((p) => (
                      <SelectItem key={p.value} value={p.value}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="byok-key">API key</Label>
                <Input
                  id="byok-key"
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={cfg.kind === "byok" && cfg.keyHint ? `Saved (${cfg.keyHint}). Leave empty to keep.` : "sk-…"}
                  aria-describedby="byok-key-hint"
                />
                <p id="byok-key-hint" className="text-muted-foreground">
                  Stored encrypted. We never show it again after you save.
                </p>
              </div>
              {providerName === "custom" ? (
                <div className="grid gap-2 md:col-span-2">
                  <Label htmlFor="byok-url">Base URL</Label>
                  <Input
                    id="byok-url"
                    type="url"
                    inputMode="url"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="https://api.example.com/v1"
                    aria-describedby="byok-url-hint"
                  />
                  <p id="byok-url-hint" className="text-muted-foreground">
                    Must be a public https endpoint. Private and internal addresses are rejected.
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}

          {formError ? (
            <Alert variant="destructive">
              <AlertTitle>Could not save</AlertTitle>
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
        <CardFooter className="flex-wrap border-t">
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save provider"}
          </Button>
          <Button type="button" variant="outline" onClick={test} disabled={testing}>
            <PlugZap aria-hidden="true" />
            {testing ? "Testing…" : "Test connection"}
          </Button>
        </CardFooter>
      </Card>
    </form>
  )
}

function labelFor(name: string | null) {
  return BYOK_PROVIDERS.find((p) => p.value === name)?.label ?? name ?? "Provider"
}

function ChoiceCard({
  id,
  value,
  selected,
  title,
  children,
}: {
  id: string
  value: string
  selected: boolean
  title: string
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
      <span className="grid gap-1">
        <span className="type-label">{title}</span>
        <span className="text-muted-foreground">{children}</span>
      </span>
    </Label>
  )
}

// ── Telegram (PRD §9) ────────────────────────────────────────────────────────

function TelegramSection({ id }: { id: string }) {
  const telegram = useTelegram(id)
  if (!telegram.data) return <Skeleton className="h-64 bg-card" />
  return <TelegramForm id={id} cfg={telegram.data} />
}

function TelegramForm({ id, cfg }: { id: string; cfg: TelegramConfig }) {
  const qc = useQueryClient()
  const [token, setToken] = useState("")
  const [mode, setMode] = useState<"polling" | "webhook">(cfg.mode)
  const [allowlist, setAllowlist] = useState(cfg.allowlist.join("\n"))
  const [busy, setBusy] = useState<null | "save" | "verify" | "remove">(null)
  const [formError, setFormError] = useState<string | null>(null)

  const run = async (kind: "save" | "verify" | "remove", fn: () => Promise<TelegramConfig>, ok: string) => {
    setFormError(null)
    setBusy(kind)
    try {
      qc.setQueryData(keys.telegram(id), await fn())
      if (kind === "save") setToken("")
      toast.success(ok)
    } catch (err) {
      setFormError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const entries = allowlist
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void run(
          "save",
          () => getApi().preview.saveTelegram(id, { token: token || undefined, mode, allowlist: entries }),
          "Telegram settings saved"
        )
      }}
    >
      <Card>
        <CardHeader>
          <CardTitle>Telegram bot</CardTitle>
          <CardDescription>Chat with Hermes from Telegram using a bot you own.</CardDescription>
          <CardAction>
            <PreviewNote what="Telegram configuration" />
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-6">
          <div className="grid gap-1">
            <span className="type-label text-muted-foreground">Status</span>
            <p className="inline-flex items-center gap-2">
              {cfg.configured ? (
                cfg.verified ? (
                  <>
                    <Check className="size-4" aria-hidden="true" /> Verified · @{cfg.botUsername}
                  </>
                ) : (
                  <>
                    <TriangleAlert className="size-4" aria-hidden="true" /> Saved, not verified yet
                  </>
                )
              ) : (
                "Not set up"
              )}
              {cfg.tokenHint ? <span className="type-mono text-muted-foreground">· token {cfg.tokenHint}</span> : null}
            </p>
          </div>

          <ol className="grid list-decimal gap-1 pl-4 text-muted-foreground">
            <li>
              In Telegram, open <span className="type-mono text-foreground">@BotFather</span> and send{" "}
              <span className="type-mono text-foreground">/newbot</span>.
            </li>
            <li>Copy the token it gives you and paste it below.</li>
            <li>Add your own Telegram username to the allowlist so only you can talk to the bot.</li>
          </ol>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="tg-token">Bot token</Label>
              <Input
                id="tg-token"
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={cfg.configured ? `Saved (${cfg.tokenHint}). Leave empty to keep.` : "123456789:AA…"}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="tg-mode">Update mode</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as "polling" | "webhook")}>
                <SelectTrigger id="tg-mode" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="polling">Polling (recommended)</SelectItem>
                  <SelectItem value="webhook">Webhook</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2 md:col-span-2">
              <Label htmlFor="tg-allow">Allowed users</Label>
              <Textarea
                id="tg-allow"
                value={allowlist}
                onChange={(e) => setAllowlist(e.target.value)}
                placeholder={"@your_username\n123456789"}
                rows={3}
                className="type-mono"
                aria-describedby="tg-allow-hint"
              />
              <p id="tg-allow-hint" className="text-muted-foreground">
                One username or numeric user ID per line. Leave empty to require pairing in Hermes.
              </p>
            </div>
          </div>

          {formError ? (
            <Alert variant="destructive">
              <AlertTitle>Could not update Telegram</AlertTitle>
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
        <CardFooter className="flex-wrap border-t">
          <Button type="submit" disabled={busy !== null}>
            {busy === "save" ? "Saving…" : "Save"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy !== null || !cfg.configured}
            onClick={() => void run("verify", () => getApi().preview.verifyTelegram(id), "Test message delivered")}
          >
            <Send aria-hidden="true" />
            {busy === "verify" ? "Sending…" : "Send test message"}
          </Button>
          {cfg.configured ? (
            <Button
              type="button"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => void run("remove", () => getApi().preview.removeTelegram(id), "Telegram bot disconnected")}
            >
              Disconnect bot
            </Button>
          ) : null}
        </CardFooter>
      </Card>
    </form>
  )
}

// ── Runtime ──────────────────────────────────────────────────────────────────

function RuntimeSection({ id }: { id: string }) {
  const meta = useInstanceMeta(id)
  const plans = usePlans()
  const plan = plans.data?.find((p) => p.id === meta.data?.planId)
  const [preBackup, setPreBackup] = useState(true)

  if (!meta.data || !plan) return <Skeleton className="h-48 bg-card" />

  return (
    <Card>
      <CardHeader>
        <CardTitle>Runtime</CardTitle>
        <CardDescription>Managed by Hermes Cloud. Limits come from your plan.</CardDescription>
        <CardAction>
          <PreviewNote what="Runtime details" />
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-6">
        <KeyValue
          items={[
            { k: "Image", v: <span className="type-mono">{meta.data.image}</span> },
            { k: "Isolation", v: <span className="type-mono">{meta.data.runtime}</span> },
            { k: "CPU", v: <span className="type-mono">{formatCpu(plan.cpuMillis)}</span> },
            { k: "Memory", v: <span className="type-mono">{formatMb(plan.memoryMb)}</span> },
            { k: "Storage", v: <span className="type-mono">{formatMb(plan.storageMb)}</span> },
            { k: "Processes", v: <span className="type-mono">{plan.pids}</span> },
          ]}
        />
        <div className="flex items-start gap-3 border-t pt-4">
          <Checkbox id="pre-upgrade-backup" checked={preBackup} onCheckedChange={(v) => setPreBackup(v === true)} className="mt-1" />
          <div className="grid gap-1">
            <Label htmlFor="pre-upgrade-backup">Back up before runtime upgrades</Label>
            <p className="text-muted-foreground">Recommended. We snapshot your volume before applying a new Hermes version.</p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
