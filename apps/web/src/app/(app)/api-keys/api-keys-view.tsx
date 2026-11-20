"use client"

import Link from "next/link"
import { useState } from "react"
import { toast } from "sonner"
import { Copy, KeyRound } from "lucide-react"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { EmptyState } from "@/components/app/empty-state"
import { PageHeader } from "@/components/app/page-header"
import { PreviewNote } from "@/components/app/preview-note"
import { QueryFallback } from "@/components/app/query-fallback"
import { errorMessage, useAiKeys, useApiMode, useCreateAiKey, useRevokeAiKey } from "@/hooks/use-hermes"
import { ApiError } from "@/lib/api"
import type { AiKey } from "@/lib/api/types"
import { copyWithToast } from "@/lib/copy"
import { formatDate } from "@/lib/format"
import { useT, type T } from "@/lib/i18n"
import { useLang } from "@/lib/prefs"

/** Same rule as the backend (ai-account.ts `keyBody`). */
const KEY_NAME = /^[A-Za-z0-9 _.-]{1,40}$/
const MAX_KEYS = 5

function keyError(e: unknown, t: T): string {
  if (e instanceof ApiError) {
    if (e.code === "key_limit") return t("You already have {max} active keys. Revoke one first.", { max: MAX_KEYS })
    if (e.code === "ai_account_missing") return t("Create an instance first: keys are billed from the AI balance it opens.")
    if (e.code === "validation_error") return t("Use 1 to 40 letters, digits, spaces, dots, dashes or underscores.")
    if (e.code === "router_unavailable") return t("NibieRouter is not reachable right now. Try again in a minute.")
  }
  return errorMessage(e)
}

/**
 * The customer's own NibieRouter keys, for calling AI models from their own apps. Usage is paid from the same AI balance
 * as their agents. The secret is shown once, in the dialog after creating; it is never listed or stored here.
 */
export function ApiKeysView() {
  const t = useT()
  const lang = useLang()
  const mock = useApiMode() === "mock"
  const query = useAiKeys()
  const create = useCreateAiKey()
  const revoke = useRevokeAiKey()

  const [name, setName] = useState("")
  const [formError, setFormError] = useState<string | null>(null)
  // Held only until the dialog closes.
  const [created, setCreated] = useState<string | null>(null)
  const [target, setTarget] = useState<AiKey | null>(null)

  const data = query.data
  const active = (data?.keys ?? []).filter((k) => !k.revoked)

  function submitCreate(e: React.FormEvent) {
    e.preventDefault()
    const clean = name.trim()
    if (!KEY_NAME.test(clean)) {
      setFormError(t("Use 1 to 40 letters, digits, spaces, dots, dashes or underscores."))
      return
    }
    setFormError(null)
    create.mutate(clean, {
      onSuccess: (r) => {
        setCreated(r.secret)
        setName("")
      },
      onError: (err) => setFormError(keyError(err, t)),
    })
  }

  // The mutation result holds the secret too, so it is dropped with the dialog.
  function closeCreated() {
    setCreated(null)
    create.reset()
  }

  function submitRevoke() {
    if (!target) return
    revoke.mutate(target.id, {
      onSuccess: () => {
        toast.success(t("Key {name} revoked.", { name: target.name }))
        setTarget(null)
      },
      onError: (err) => toast.error(keyError(err, t)),
    })
  }

  return (
    <div className="grid gap-6">
      <PageHeader
        title={t("API keys")}
        description={t("Call NibieRouter AI models from your own apps and scripts. Usage is paid from your AI balance, like your agents.")}
        actions={mock ? <PreviewNote what="API keys" reason="mock" /> : null}
      />

      {data === undefined ? (
        <QueryFallback what="your API keys" queries={[query]} className="h-48" />
      ) : data === null ? (
        <EmptyState
          icon={<KeyRound aria-hidden="true" />}
          title={t("API keys are not available")}
          description={t("NibieRouter is not set up on this server.")}
        />
      ) : !data.hasAccount ? (
        <EmptyState
          icon={<KeyRound aria-hidden="true" />}
          title={t("No AI account yet")}
          description={t("Create an instance first: keys are billed from the AI balance it opens.")}
          action={
            <Button asChild>
              <Link href="/deploy">{t("Deploy")}</Link>
            </Button>
          }
        />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t("Create a key")}</CardTitle>
              <CardDescription>
                {t("OpenAI-compatible: use this base URL and the key as a bearer token. At most {max} active keys, 20 requests per minute each.", { max: MAX_KEYS })}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="ai-base-url">{t("Base URL")}</Label>
                <div className="flex gap-2">
                  <Input id="ai-base-url" readOnly value={data.baseUrl} className="type-mono" />
                  <Button type="button" variant="outline" onClick={() => copyWithToast(data.baseUrl, "Base URL")}>
                    <Copy aria-hidden="true" />
                    <span className="sr-only">{t("Copy base URL")}</span>
                  </Button>
                </div>
                <p className="text-muted-foreground">
                  <Link href="/ai-models" className="text-foreground underline underline-offset-4">
                    {t("See the list of models")}
                  </Link>
                </p>
              </div>
              <form onSubmit={submitCreate} className="grid gap-4 border-t pt-4 sm:max-w-xl" noValidate>
                <div className="grid gap-2">
                  <Label htmlFor="ai-key-name">{t("Key name")}</Label>
                  <Input
                    id="ai-key-name"
                    maxLength={40}
                    autoComplete="off"
                    placeholder="my-script"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    aria-invalid={formError ? true : undefined}
                    aria-describedby={formError ? "ai-key-error" : undefined}
                  />
                </div>
                {formError ? (
                  <Alert variant="destructive" role="alert" id="ai-key-error">
                    <AlertDescription>{formError}</AlertDescription>
                  </Alert>
                ) : null}
                <div>
                  <Button type="submit" disabled={create.isPending || active.length >= MAX_KEYS}>
                    {create.isPending ? t("Creating…") : t("Create key")}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          {data.keys.length === 0 ? (
            <EmptyState icon={<KeyRound aria-hidden="true" />} title={t("No keys yet")} description={t("Keys you create show up here.")} />
          ) : (
            <Table>
              <caption className="sr-only">{t("Your API keys")}</caption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{t("Name")}</TableHead>
                  <TableHead scope="col">{t("Created")}</TableHead>
                  <TableHead scope="col">{t("Status")}</TableHead>
                  <TableHead scope="col">
                    <span className="sr-only">{t("Actions")}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.keys.map((k) => (
                  <TableRow key={k.id}>
                    <TableCell>{k.name}</TableCell>
                    <TableCell className="type-mono">{k.createdAt ? formatDate(k.createdAt, lang) : "—"}</TableCell>
                    <TableCell className="type-label">{k.revoked ? t("Revoked") : t("Active")}</TableCell>
                    <TableCell>
                      {k.revoked ? null : (
                        <Button type="button" variant="outline" size="xs" onClick={() => setTarget(k)}>
                          {t("Revoke")}
                          <span className="sr-only"> {t("key {name}", { name: k.name })}</span>
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}

      <Dialog open={created !== null} onOpenChange={(o) => !o && closeCreated()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Your new API key")}</DialogTitle>
            <DialogDescription>{t("Copy it now. It is not shown again; if you lose it, revoke it and create a new one.")}</DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Label htmlFor="ai-new-key" className="sr-only">
              {t("API key")}
            </Label>
            <Input id="ai-new-key" readOnly value={created ?? ""} className="type-mono" onFocus={(e) => e.currentTarget.select()} />
            <Button type="button" variant="outline" onClick={() => created && copyWithToast(created, "API key")}>
              <Copy aria-hidden="true" />
              <span className="sr-only">{t("Copy key")}</span>
            </Button>
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={closeCreated}>
              {t("I have saved it")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={target !== null} onOpenChange={(o) => !o && setTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Revoke key?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("{name} stops working at once. Apps using it will be refused. This cannot be undone.", { name: target?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
            <Button type="button" variant="destructive" disabled={revoke.isPending} onClick={submitRevoke}>
              {revoke.isPending ? t("Revoking…") : t("Revoke key")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
