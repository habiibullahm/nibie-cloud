"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { KeyRound, LogOut } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { KeyValue } from "@/components/app/key-value"
import { PageHeader } from "@/components/app/page-header"
import { PreferenceToggles } from "@/components/app/preference-toggles"
import { PreviewNote } from "@/components/app/preview-note"
import { QueryFallback } from "@/components/app/query-fallback"
import { keys, useApiMode, useDisplayName, useMe, useSubscriptions } from "@/hooks/use-hermes"
import { authConfigured, getSupabase } from "@/lib/auth/supabase"
import { billingStatusLabel, paymentText } from "@/lib/billing"
import type { BillingSubscription } from "@/lib/api/types"
import { useT } from "@/lib/i18n"
import { useLang } from "@/lib/prefs"

/** Sign-in providers of the Supabase user ("google", "email"). Only asked when auth is configured. */
function useSignInMethods() {
  return useQuery({
    queryKey: ["auth-user-providers"],
    queryFn: async () => {
      const user = (await getSupabase()?.auth.getUser())?.data.user
      const p = user?.app_metadata?.providers
      return Array.isArray(p) ? (p as string[]) : []
    },
    enabled: authConfigured(),
  })
}

const MAX_NAME = 80

/** Display name, kept in the Supabase user's metadata (no backend column); the navigation rail shows it above the email. */
function NameCard() {
  const t = useT()
  const qc = useQueryClient()
  const name = useDisplayName()
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const value = draft ?? name.data ?? ""
  const dirty = draft !== null && draft.trim() !== (name.data ?? "")

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    // Enter with nothing changed (the form submits implicitly without a visible button).
    if (!dirty || saving) return
    setSaving(true)
    const { error } = await getSupabase()!.auth.updateUser({ data: { full_name: value.trim() } })
    setSaving(false)
    if (error) return void toast.error(t("Could not save"))
    toast.success(t("Name saved"))
    setDraft(null)
    await qc.invalidateQueries({ queryKey: keys.displayName })
  }

  return (
    <Card>
      <form onSubmit={save}>
        <CardHeader>
          <CardTitle>{t("Name")}</CardTitle>
          <CardDescription>{t("How you appear in the dashboard.")}</CardDescription>
        </CardHeader>
        <CardContent>
          {name.data === undefined ? (
            <QueryFallback what="name" queries={[name]} className="h-10 bg-elevated" />
          ) : (
            <>
              {/* The card title already says "Name"; the label stays for screen readers. */}
              <Label htmlFor="display-name" className="sr-only">
                {t("Name")}
              </Label>
              <Input
                id="display-name"
                value={value}
                maxLength={MAX_NAME}
                autoComplete="name"
                onChange={(e) => setDraft(e.target.value)}
              />
            </>
          )}
        </CardContent>
        {/* Shown only once there is something to save, instead of a faint disabled button. */}
        {dirty || saving ? (
          <CardFooter className="border-t">
            <Button type="submit" disabled={saving}>
              {saving ? t("Saving…") : t("Save")}
            </Button>
          </CardFooter>
        ) : null}
      </form>
    </Card>
  )
}

export default function AccountPage() {
  const t = useT()
  const me = useMe()
  const router = useRouter()
  const customer = useApiMode() === "customer"
  const methods = useSignInMethods()
  const [signingOut, setSigningOut] = useState(false)

  // Same sign-out as the navigation rail (app-shell.tsx): end the Supabase session, then leave.
  const signOut = async () => {
    setSigningOut(true)
    await getSupabase()?.auth.signOut()
    router.push("/sign-in")
  }

  const methodText = !authConfigured()
    ? t("Not available in preview mode")
    : methods.error
      ? t("Could not load")
      : !methods.data
        ? t("Loading")
        : methods.data.map((m) => (m === "google" ? "Google" : m === "email" ? t("Email and password") : m)).join(", ") ||
          t("Unknown")

  return (
    <div className="grid gap-8">
      <PageHeader title={t("Account")} description={t("Your sign-in, orders and preferences.")} />

      <div className="grid max-w-3xl gap-6">
        <Card>
          <CardHeader>
            <CardTitle>{t("Sign-in")}</CardTitle>
            <CardDescription>{t("Your email is your account. It cannot be changed here yet.")}</CardDescription>
            {customer ? null : (
              <CardAction>
                <PreviewNote what="Account" />
              </CardAction>
            )}
          </CardHeader>
          <CardContent>
            <KeyValue
              items={[
                { k: t("Email"), v: me.data?.email ?? (me.error ? t("Could not load") : t("Loading")) },
                { k: t("Sign-in method"), v: methodText },
              ]}
            />
          </CardContent>
          <CardFooter className="flex-wrap gap-3 border-t">
            {authConfigured() ? (
              <Button asChild variant="outline">
                <Link href="/set-password?from=account">
                  <KeyRound aria-hidden="true" />
                  {methods.data?.includes("email") ? t("Change password") : t("Set a password")}
                </Link>
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={signOut} disabled={signingOut}>
              <LogOut aria-hidden="true" />
              {signingOut ? t("Signing out…") : t("Sign out")}
            </Button>
          </CardFooter>
        </Card>

        {authConfigured() ? <NameCard /> : null}

        <OrdersCard />

        <Card>
          <CardHeader>
            <CardTitle>{t("Preferences")}</CardTitle>
            <CardDescription>{t("Saved in this browser only.")}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-muted-foreground">{t("Language and theme")}</span>
            <PreferenceToggles />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("Delete account")}</CardTitle>
            <CardDescription>
              {t("Deleting your account removes your instances and their data. It cannot be done from the dashboard yet.")}
            </CardDescription>
          </CardHeader>
          <CardFooter className="border-t">
            <Button asChild variant="outline">
              <Link href="/support">{t("Ask support to delete it")}</Link>
            </Button>
          </CardFooter>
        </Card>
      </div>
    </div>
  )
}

function OrdersCard() {
  const t = useT()
  const subs = useSubscriptions()
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Orders and payments")}</CardTitle>
        <CardDescription>{t("Paid plans only. Free beta instances have no orders.")}</CardDescription>
      </CardHeader>
      <CardContent>
        {!subs.data ? (
          <QueryFallback what="orders" queries={[subs]} className="h-24 bg-elevated" />
        ) : subs.data.length === 0 ? (
          <p className="text-muted-foreground">{t("No orders yet.")}</p>
        ) : (
          <ul className="grid">
            {[...subs.data]
              .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
              .map((s) => (
                <OrderRow key={s.id} sub={s} />
              ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function OrderRow({ sub }: { sub: BillingSubscription }) {
  const t = useT()
  const lang = useLang()
  const payment = sub.latestPayment ? paymentText(sub.latestPayment, t, lang) : null
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 border-t py-3 first:border-t-0 first:pt-0">
      <div className="grid min-w-0 gap-1">
        <span className="break-words text-foreground">{sub.name}</span>
        <span className="type-mono text-muted-foreground">
          {sub.planName} · {t(billingStatusLabel(sub.status, sub.cancelAtPeriodEnd))}
        </span>
        {payment ? <span className="text-muted-foreground">{payment}</span> : null}
      </div>
      {/* An ended order may still point at its deleted instance. */}
      {sub.instanceId && sub.status !== "ENDED" ? (
        <Button asChild size="sm" variant="outline">
          <Link href={`/instances/${sub.instanceId}/billing`}>
            {t("Billing")}
            <span className="sr-only">: {sub.name}</span>
          </Link>
        </Button>
      ) : null}
    </li>
  )
}
