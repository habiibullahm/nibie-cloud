"use client"

import { Suspense, useState } from "react"
import { useSearchParams } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { Check, CircleX, PlugZap, RotateCw, Send, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { KeyValue } from "@/components/app/key-value"
import { PreviewNote } from "@/components/app/preview-note"
import { QueryFallback } from "@/components/app/query-fallback"
import {
  errorMessage,
  keys,
  useApiMode,
  useInstance,
  useInstanceAction,
  usePlans,
  useProvider,
  useRouterModels,
  useSubscriptions,
  useTelegram,
} from "@/hooks/use-hermes"
import { subscriptionOfInstance } from "@/lib/billing"
import { getApi, type ProviderConfig, type ProviderKind, type TelegramConfig } from "@/lib/api"
import { BYOK_PROVIDERS, MAX_TELEGRAM_USERS, type ByokProviderName } from "@/lib/api/providers"
import { allowedActions, isTransitional } from "@/lib/api/status"
import { formatCpu, formatMb, formatRelative } from "@/lib/format"
import { cn } from "@/lib/utils"
import { useInstanceId } from "../instance-frame"

export default function ConfigurationPage() {
  return (
    <Suspense fallback={null}>
      <ConfigurationTabs />
    </Suspense>
  )
}

/** Telegram comes first: NibieRouter is attached by Nibie Cloud, so the bot token is the one thing a new customer must add. */
function ConfigurationTabs() {
  const id = useInstanceId()
  const tab = useSearchParams().get("tab")
  return (
    <Tabs defaultValue={tab === "provider" || tab === "runtime" ? tab : "telegram"}>
      <TabsList aria-label="Configuration">
        <TabsTrigger value="telegram">Telegram</TabsTrigger>
        <TabsTrigger value="provider">AI provider</TabsTrigger>
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

// ── Restart notice ───────────────────────────────────────────────────────────

/**
 * Saved provider and Telegram settings only reach Hermes when the container is recreated, which the next
 * start or restart does (backend `restartRequired`). Offers that action right where the change was made.
 */
function RestartNotice({ id }: { id: string }) {
  const qc = useQueryClient()
  const instance = useInstance(id)
  const action = useInstanceAction(id)
  const status = instance.data?.status
  const allowed = status ? allowedActions(status) : null
  const verb = allowed?.has("restart") ? "restart" : allowed?.has("start") ? "start" : null

  const apply = () => {
    if (!verb) return
    action.mutate(verb, {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: keys.provider(id) })
        void qc.invalidateQueries({ queryKey: keys.telegram(id) })
      },
    })
  }

  return (
    <Alert>
      <RotateCw aria-hidden="true" />
      <AlertTitle>Restart to apply your changes</AlertTitle>
      <AlertDescription>
        <p>Your changes are saved, but Hermes keeps running with the old settings until the instance restarts.</p>
        {verb ? (
          <Button type="button" size="sm" variant="outline" className="mt-2" onClick={apply} disabled={action.isPending}>
            {action.isPending ? "Requesting…" : verb === "restart" ? "Restart instance" : "Start instance"}
          </Button>
        ) : status && isTransitional(status) ? (
          <p>The instance is changing state. This notice disappears once the new settings are running.</p>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}

// ── Provider (PRD §8) ────────────────────────────────────────────────────────

function labelFor(name: string | null) {
  return BYOK_PROVIDERS.find((p) => p.value === name)?.label ?? name ?? "Provider"
}

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
  if (!provider.data) return <QueryFallback what="the AI provider settings" queries={[provider]} className="h-64" />
  return (
    <div className="grid gap-6">
      <ProviderForm key={provider.data.id} id={id} cfg={provider.data} />
      {provider.data.configured && provider.data.kind === "nibierouter" ? (
        <RouterModelCard key={provider.data.id} id={id} cfg={provider.data} />
      ) : null}
    </div>
  )
}

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 })

/** NibieRouter model choice. The key stays the same; the new model reaches Hermes on the next restart. */
function RouterModelCard({ id, cfg }: { id: string; cfg: ProviderConfig }) {
  const qc = useQueryClient()
  const catalog = useRouterModels(id, true)
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState(cfg.model ?? "")
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  if (!catalog.data) return <QueryFallback what="the NibieRouter models" queries={[catalog]} className="h-64" />

  const q = query.trim().toLowerCase()
  const shown = catalog.data.models.filter((m) => !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
  const chosen = catalog.data.models.find((m) => m.id === selected)

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError(null)
    setSaving(true)
    try {
      const next = await getApi().preview.setRouterModel(id, selected)
      qc.setQueryData(keys.provider(id), next)
      toast.success("Model saved. Restart your instance to apply it.")
    } catch (err) {
      setFormError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={save}>
      <Card>
        <CardHeader>
          <CardTitle>NibieRouter model</CardTitle>
          <CardDescription>The model Hermes uses through NibieRouter. Prices are per 1 million tokens.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {catalog.data.freeOnly ? (
            <p className="text-muted-foreground">Your plan includes the free models. Paid models come with a paid plan.</p>
          ) : null}
          <div className="grid gap-2">
            <Label htmlFor="router-model-search">Search models</Label>
            <Input
              id="router-model-search"
              type="search"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Name or id"
            />
          </div>
          {shown.length === 0 ? (
            <p className="text-muted-foreground">No model matches “{query.trim()}”.</p>
          ) : (
            <RadioGroup
              value={selected}
              onValueChange={setSelected}
              aria-label="NibieRouter model"
              className="grid max-h-80 gap-2 overflow-y-auto rounded-md border p-2"
            >
              {shown.map((m) => (
                <Label
                  key={m.id}
                  htmlFor={`router-model-${m.id}`}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-md border border-transparent p-3 transition-colors hover:border-muted-foreground",
                    selected === m.id && "border-foreground bg-elevated"
                  )}
                >
                  <RadioGroupItem id={`router-model-${m.id}`} value={m.id} className="mt-1" />
                  <span className="grid min-w-0 gap-1">
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <span className="type-label">{m.name}</span>
                      {m.free ? <Badge>Free</Badge> : null}
                      {m.id === cfg.model ? <Badge variant="outline">Current</Badge> : null}
                    </span>
                    <span className="type-mono break-all text-muted-foreground">{m.id}</span>
                    {m.free ? null : (
                      <span className="text-muted-foreground">
                        {usd(m.promptUsdPerM)} input · {usd(m.completionUsdPerM)} output
                      </span>
                    )}
                  </span>
                </Label>
              ))}
            </RadioGroup>
          )}
          {chosen && !chosen.free ? (
            <p className="text-muted-foreground">
              This model is paid from your AI balance. When the balance runs out, Hermes&apos; requests to it fail until you
              choose a free model again.
            </p>
          ) : null}
          {formError ? (
            <Alert variant="destructive">
              <AlertTitle>Could not save the model</AlertTitle>
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
        <CardFooter className="border-t">
          <Button type="submit" disabled={saving || !chosen || selected === cfg.model}>
            {saving ? "Saving…" : "Save model"}
          </Button>
        </CardFooter>
      </Card>
    </form>
  )
}

function ProviderForm({ id, cfg }: { id: string; cfg: ProviderConfig }) {
  const qc = useQueryClient()
  const mode = useApiMode()
  const instance = useInstance(id)
  const plans = usePlans()
  // A free instance gets its NibieRouter key from the backend shortly after it becomes active.
  const routerComing =
    mode === "customer" && !cfg.configured && plans.data?.find((p) => p.id === instance.data?.planId)?.monthlyPriceIdr === null
  // Only the in-browser mock can switch to NibieRouter; on the real API that key is attached by Nibie Cloud.
  const routerLocked = mode !== "mock"
  const [kind, setKind] = useState<ProviderKind>(cfg.configured ? cfg.kind : "byok")
  const [providerName, setProviderName] = useState<ByokProviderName>(
    cfg.kind === "byok" && cfg.providerName ? (cfg.providerName as ByokProviderName) : "openai"
  )
  const [baseUrl, setBaseUrl] = useState(cfg.kind === "byok" && cfg.providerName === "custom" ? (cfg.baseUrl ?? "") : "")
  const [model, setModel] = useState(cfg.kind === "byok" ? (cfg.model ?? "") : "")
  const [apiKey, setApiKey] = useState("")
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const preset = BYOK_PROVIDERS.find((p) => p.value === providerName)

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError(null)
    setSaving(true)
    try {
      const next = await getApi().preview.saveProvider(
        id,
        kind === "byok"
          ? { kind, providerName, baseUrl: preset?.baseUrl ?? baseUrl.trim(), model: model.trim(), apiKey }
          : { kind }
      )
      qc.setQueryData(keys.provider(id), next)
      setApiKey("")
      toast.success("Provider saved. Restart your instance to apply it, then test the connection.")
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
      if (next.status === "connected") toast.success("Connection test passed")
      else toast.error(next.statusMessage ?? "Connection test failed")
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
          <CardDescription>Nibie Cloud bills hosting only. AI usage is billed by the provider you choose.</CardDescription>
          {mode !== "customer" ? (
            <CardAction>
              <PreviewNote what="Provider configuration" />
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent className="grid gap-6">
          {cfg.restartRequired ? <RestartNotice id={id} /> : null}

          <div className="grid gap-1">
            <span className="type-label text-muted-foreground">Current</span>
            {cfg.configured ? (
              <>
                <p>
                  {cfg.kind === "nibierouter" ? "NibieRouter (included)" : `Own key · ${labelFor(cfg.providerName)}`}
                  {cfg.model ? <span className="type-mono text-muted-foreground"> · {cfg.model}</span> : null}
                  {cfg.keyHint ? <span className="type-mono text-muted-foreground"> · key {cfg.keyHint}</span> : null}
                </p>
                <ConnectionStatus config={cfg} />
                {cfg.lastTestedAt ? (
                  <p className="text-muted-foreground">Last tested {formatRelative(cfg.lastTestedAt)}</p>
                ) : null}
              </>
            ) : routerComing ? (
              <p className="text-muted-foreground">
                Nibie Cloud is connecting NibieRouter. This usually takes under a minute and this page updates on its own.
                Meanwhile, add your bot in the Telegram tab. If it is still not connected after a few minutes, add your own key
                below.
              </p>
            ) : (
              <p className="text-muted-foreground">No AI provider yet. Add your own key below so Hermes can answer.</p>
            )}
          </div>

          <RadioGroup value={kind} onValueChange={(v) => setKind(v as ProviderKind)} aria-label="Provider type" className="grid gap-3 md:grid-cols-2">
            <ChoiceCard
              id="kind-nibie"
              value="nibierouter"
              selected={kind === "nibierouter"}
              title="NibieRouter"
              disabled={routerLocked && cfg.kind !== "nibierouter"}
            >
              {routerLocked && cfg.kind !== "nibierouter"
                ? "Added by Nibie Cloud with your plan. To use NibieRouter again, bring your own NibieRouter key."
                : "Works out of the box. Usage is attributed to your account and billed by NibieRouter."}
            </ChoiceCard>
            <ChoiceCard id="kind-byok" value="byok" selected={kind === "byok"} title="Bring your own key">
              Use your own provider account. Charges come from that provider, not Nibie Cloud.
            </ChoiceCard>
          </RadioGroup>

          {kind === "byok" ? (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="byok-provider">Provider</Label>
                <Select value={providerName} onValueChange={(v) => setProviderName(v as ByokProviderName)}>
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
                <Label htmlFor="byok-model">Model</Label>
                <Input
                  id="byok-model"
                  autoComplete="off"
                  spellCheck={false}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={preset?.modelHint ?? "model-name"}
                  aria-describedby="byok-model-hint"
                  className="type-mono"
                />
                <p id="byok-model-hint" className="text-muted-foreground">
                  The model name exactly as your provider lists it.
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
                    Must be a public https endpoint that answers <span className="type-mono">GET /models</span>.
                  </p>
                </div>
              ) : null}
              <div className="grid gap-2 md:col-span-2">
                <Label htmlFor="byok-key">API key</Label>
                <Input
                  id="byok-key"
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={cfg.kind === "byok" && cfg.keyHint ? `Saved (${cfg.keyHint}). Paste it again to save.` : "sk-…"}
                  aria-describedby="byok-key-hint"
                />
                <p id="byok-key-hint" className="text-muted-foreground">
                  Stored encrypted and never shown again, so paste the key each time you save.
                </p>
                {preset?.keyUrl ? (
                  <p className="text-muted-foreground">
                    No key yet? Create one at{" "}
                    <a href={preset.keyUrl} target="_blank" rel="noopener noreferrer" className="text-foreground underline underline-offset-4">
                      router.nibie.app
                    </a>
                    , then paste it here.
                  </p>
                ) : null}
              </div>
              {cfg.kind === "nibierouter" && cfg.configured ? (
                <p className="text-muted-foreground md:col-span-2">
                  Saving your own key replaces the NibieRouter connection that came with your plan.
                </p>
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
          <Button type="submit" disabled={saving || (kind === "nibierouter" && routerLocked)}>
            {saving ? "Saving…" : "Save provider"}
          </Button>
          <Button type="button" variant="outline" onClick={test} disabled={testing || !cfg.configured}>
            <PlugZap aria-hidden="true" />
            {testing ? "Testing…" : "Test connection"}
          </Button>
        </CardFooter>
      </Card>
    </form>
  )
}

function ChoiceCard({
  id,
  value,
  selected,
  title,
  disabled,
  children,
}: {
  id: string
  value: string
  selected: boolean
  title: string
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <Label
      htmlFor={id}
      className={cn(
        "flex items-start gap-3 rounded-md border bg-card p-4 transition-colors",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:border-muted-foreground",
        selected && "border-foreground bg-elevated"
      )}
    >
      <RadioGroupItem id={id} value={value} disabled={disabled} className="mt-1" />
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
  if (!telegram.data) return <QueryFallback what="the Telegram settings" queries={[telegram]} className="h-64" />
  return <TelegramForm id={id} cfg={telegram.data} />
}

function TelegramForm({ id, cfg }: { id: string; cfg: TelegramConfig }) {
  const qc = useQueryClient()
  const mode = useApiMode()
  const [token, setToken] = useState("")
  const [allowlist, setAllowlist] = useState(cfg.allowlist.join("\n"))
  const [busy, setBusy] = useState<null | "save" | "verify" | "remove">(null)
  const [formError, setFormError] = useState<string | null>(null)

  const run = async (
    kind: "save" | "verify" | "remove",
    fn: () => Promise<TelegramConfig>,
    ok: string,
    failure?: (next: TelegramConfig) => string | null
  ) => {
    setFormError(null)
    setBusy(kind)
    try {
      const next = await fn()
      qc.setQueryData(keys.telegram(id), next)
      if (kind === "save") setToken("")
      const problem = failure?.(next)
      if (problem) setFormError(problem)
      else toast.success(ok)
    } catch (err) {
      setFormError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const entries = allowlist
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void run(
          "save",
          () => getApi().preview.saveTelegram(id, { token: token.trim(), allowlist: entries }),
          "Telegram settings saved. Restart your instance to apply them."
        )
      }}
    >
      <Card>
        <CardHeader>
          <CardTitle>Telegram bot</CardTitle>
          <CardDescription>Chat with Hermes from Telegram using a bot you own.</CardDescription>
          {mode !== "customer" ? (
            <CardAction>
              <PreviewNote what="Telegram configuration" />
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent className="grid gap-6">
          {cfg.restartRequired ? <RestartNotice id={id} /> : null}

          <div className="grid gap-1">
            <span className="type-label text-muted-foreground">Status</span>
            <p className="inline-flex flex-wrap items-center gap-2">
              {cfg.configured ? (
                cfg.verified ? (
                  <>
                    <Check className="size-4" aria-hidden="true" /> Verified · @{cfg.botUsername}
                  </>
                ) : (
                  <>
                    <TriangleAlert className="size-4" aria-hidden="true" /> Saved, not verified yet · @{cfg.botUsername}
                  </>
                )
              ) : (
                "Not set up"
              )}
              {cfg.tokenHint ? <span className="type-mono text-muted-foreground">· token {cfg.tokenHint}</span> : null}
            </p>
            {cfg.configured && cfg.statusMessage ? <p className="text-muted-foreground">{cfg.statusMessage}</p> : null}
            {cfg.configured ? (
              <p className="text-muted-foreground">
                {cfg.allowlist.length === 1 ? "1 allowed user" : `${cfg.allowlist.length} allowed users`}
                {cfg.verifiedAt ? ` · test message delivered ${formatRelative(cfg.verifiedAt)}` : ""}
              </p>
            ) : null}
          </div>

          <ol className="grid list-decimal gap-1 pl-4 text-muted-foreground">
            <li>
              In Telegram, open <span className="type-mono text-foreground">@BotFather</span> and send{" "}
              <span className="type-mono text-foreground">/newbot</span>.
            </li>
            <li>Copy the token it gives you and paste it below.</li>
            <li>
              Send any message to <span className="type-mono text-foreground">@userinfobot</span> to get your numeric user ID,
              and add it to the allowed users.
            </li>
            <li>Open your new bot and press Start, save here, then restart the instance to switch the bot on.</li>
          </ol>

          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="tg-token">Bot token</Label>
              <Input
                id="tg-token"
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={cfg.configured ? `Saved (${cfg.tokenHint}). Paste it again to save.` : "123456789:AA…"}
                aria-describedby="tg-token-hint"
              />
              <p id="tg-token-hint" className="text-muted-foreground">
                Stored encrypted and never shown again, so paste the token each time you save.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="tg-allow">Allowed users</Label>
              <Textarea
                id="tg-allow"
                value={allowlist}
                onChange={(e) => setAllowlist(e.target.value)}
                placeholder={"123456789"}
                rows={3}
                inputMode="numeric"
                className="type-mono"
                aria-describedby="tg-allow-hint"
              />
              <p id="tg-allow-hint" className="text-muted-foreground">
                Numeric Telegram user IDs, one per line, up to {MAX_TELEGRAM_USERS}. Only these people can talk to your bot;
                everyone else is ignored. At least one is required. Usernames such as @name do not work.
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
            onClick={() =>
              void run("verify", () => getApi().preview.verifyTelegram(id), "Test message delivered", (next) =>
                next.verified ? null : (next.statusMessage ?? "The test message was not delivered.")
              )
            }
          >
            <Send aria-hidden="true" />
            {busy === "verify" ? "Sending…" : "Send test message"}
          </Button>
          {cfg.configured ? (
            <Button
              type="button"
              variant="ghost"
              disabled={busy !== null}
              onClick={() =>
                void run("remove", () => getApi().preview.removeTelegram(id), "Telegram bot disconnected. Restart your instance to apply it.")
              }
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
  const instance = useInstance(id)
  const plans = usePlans()
  const subs = useSubscriptions()
  // Same rule as the instance header (instance-frame.tsx): the billed plan wins over the instance's own plan.
  const plan = plans.data?.find((p) => p.id === (subscriptionOfInstance(subs.data, id)?.planId ?? instance.data?.planId))

  if (!plan) return <QueryFallback what="the runtime details" queries={[instance, plans]} />

  return (
    <Card>
      <CardHeader>
        <CardTitle>Runtime</CardTitle>
        <CardDescription>Managed by Nibie Cloud. Limits come from your plan.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        <KeyValue
          items={[
            { k: "CPU", v: <span className="type-mono">{formatCpu(plan.cpuMillis)}</span> },
            { k: "Memory", v: <span className="type-mono">{formatMb(plan.memoryMb)}</span> },
            { k: "Storage", v: <span className="type-mono">{formatMb(plan.storageMb)}</span> },
            { k: "Processes", v: <span className="type-mono">{plan.pids}</span> },
          ]}
        />
      </CardContent>
    </Card>
  )
}
