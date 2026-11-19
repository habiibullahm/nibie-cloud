"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useState } from "react"
import {
  Boxes,
  ChevronDown,
  ChevronRight,
  CreditCard,
  LifeBuoy,
  ListChecks,
  LogOut,
  Menu,
  Rocket,
  ShieldCheck,
  UserRound,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { getSupabase } from "@/lib/auth/supabase"
import { useT } from "@/lib/i18n"
import { cn } from "@/lib/utils"
import { useApiMode, useDisplayName, useMe } from "@/hooks/use-hermes"
import { useAdminMe } from "@/hooks/use-admin"
import { Brand } from "./brand"
import { PreferenceToggles } from "./preference-toggles"

const GROUPS = [
  {
    label: "Overview",
    items: [
      { href: "/quickstart", label: "Quickstart", icon: ListChecks, match: (p: string) => p.startsWith("/quickstart") },
      { href: "/instances", label: "Instances", icon: Boxes, match: (p: string) => p.startsWith("/instances") },
      { href: "/deploy", label: "Deploy", icon: Rocket, match: (p: string) => p.startsWith("/deploy") },
    ],
  },
  {
    label: "Account",
    items: [
      { href: "/billing", label: "Billing", icon: CreditCard, match: (p: string) => p.startsWith("/billing") },
      { href: "/account", label: "Account settings", icon: UserRound, match: (p: string) => p.startsWith("/account") },
      { href: "/support", label: "Support", icon: LifeBuoy, match: (p: string) => p.startsWith("/support") },
    ],
  },
]

const LINK =
  "flex items-center gap-3 rounded-sm border-l-2 border-transparent px-3 py-2 text-muted-foreground pointer-coarse:py-3 no-underline transition-colors outline-none hover:bg-card hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"

/** Group and page names for the top bar; null on a page outside the navigation. */
function crumbs(pathname: string): [string, string] | null {
  if (pathname.startsWith("/admin")) return ["Admin", "Admin"]
  for (const g of GROUPS) for (const i of g.items) if (i.match(pathname)) return [g.label, i.label]
  return null
}

/**
 * Admin link, shown only when the backend says this account is an admin, including an admin who still has to
 * give the second factor (the backend sends `mfa_required` only to accounts on the allowlist, and the page behind
 * the link is where the authenticator is set up). Hiding it is convenience, not protection: every
 * `/api/v1/admin/*` call is refused server-side for anyone else.
 */
function AdminLink({ onNavigate }: { onNavigate?: () => void }) {
  // Ask the admin API only for an account the customer `/me` marks as admin, so customers never call it.
  const me = useMe()
  const admin = useAdminMe(me.data?.admin === true)
  const pathname = usePathname()
  if (!admin.data?.admin && !admin.data?.mfaRequired) return null
  const active = pathname.startsWith("/admin")
  return (
    <Link
      href="/admin"
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(LINK, active && "border-l-foreground bg-card text-foreground")}
    >
      <ShieldCheck className="size-4 shrink-0" aria-hidden="true" />
      Admin
    </Link>
  )
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname()
  const t = useT()
  return (
    <nav aria-label={t("Main")} className="flex flex-col gap-6">
      {GROUPS.map((g) => (
        <div key={g.label} className="flex flex-col gap-1">
          <p className="type-label px-3 pb-1 text-muted-foreground">{t(g.label)}</p>
          {g.items.map(({ href, label, icon: Icon, match }) => {
            const active = match(pathname)
            return (
              <Link
                key={href}
                href={href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(LINK, active && "border-l-foreground bg-card text-foreground")}
              >
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                {t(label)}
              </Link>
            )
          })}
        </div>
      ))}
      <AdminLink onNavigate={onNavigate} />
    </nav>
  )
}

function Breadcrumb() {
  const pathname = usePathname()
  const t = useT()
  const c = crumbs(pathname)
  if (!c) return null
  const [group, page] = c
  return (
    <nav aria-label={t("Breadcrumb")} className="hidden min-w-0 sm:block">
      <ol className="flex items-center gap-2">
        {group !== page ? (
          <>
            <li className="text-muted-foreground">{t(group)}</li>
            <li aria-hidden="true" className="text-muted-foreground">
              <ChevronRight className="size-4" />
            </li>
          </>
        ) : null}
        <li aria-current="page" className="truncate font-medium text-foreground">
          {t(page)}
        </li>
      </ol>
    </nav>
  )
}

/** Name or email, Account, Support and Sign out, like the account menu in NibieRouter. */
function UserMenu() {
  const router = useRouter()
  const me = useMe()
  const name = useDisplayName()
  const t = useT()
  const email = me.data?.email ?? ""
  const shown = name.data || email
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="max-w-64 gap-2 px-2" aria-label={t("Account menu")}>
          <span
            aria-hidden="true"
            className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-secondary type-label text-foreground"
          >
            {(shown[0] ?? "?").toUpperCase()}
          </span>
          <span className="hidden truncate md:inline">{shown}</span>
          <ChevronDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="grid min-w-0 font-normal">
          {name.data ? <span className="truncate text-foreground">{name.data}</span> : null}
          <span className="truncate text-muted-foreground" title={email}>
            {email}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/account">
            <UserRound aria-hidden="true" />
            {t("Account settings")}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/support">
            <LifeBuoy aria-hidden="true" />
            {t("Support")}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={async () => {
            await getSupabase()?.auth.signOut()
            router.push("/sign-in")
          }}
        >
          <LogOut aria-hidden="true" />
          {t("Sign out")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A developer hint: customers only ever see their real data, so they do not get the chip. */
function DataModeChip() {
  const mode = useApiMode()
  if (mode === "customer") return null
  return <span className="type-mono hidden rounded-sm border px-2 py-1 text-muted-foreground sm:inline">{mode === "mock" ? "mock" : "live api"}</span>
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const t = useT()
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
      <a
        href="#main"
        className="fixed top-2 left-2 z-[100] -translate-y-[200%] rounded-sm bg-foreground px-4 py-2 text-background focus:translate-y-0 pointer-coarse:py-3"
      >
        {t("Skip to content")}
      </a>

      <aside className="sticky top-0 hidden h-dvh flex-col border-r lg:flex">
        <div className="flex h-14 shrink-0 items-center border-b px-4">
          <Brand />
        </div>
        <div className="overflow-y-auto px-3 py-4">
          <NavLinks />
        </div>
      </aside>

      <div className="flex min-h-dvh min-w-0 flex-col">
        <header className="sticky top-0 z-40 flex h-14 items-center justify-between gap-3 border-b bg-background px-4 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <Sheet open={open} onOpenChange={setOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={t("Open navigation")} className="lg:hidden">
                  <Menu aria-hidden="true" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="flex w-72 flex-col gap-6 border-r bg-background px-4 py-6">
                <SheetHeader className="p-0">
                  <SheetTitle className="sr-only">{t("Navigation")}</SheetTitle>
                  <SheetDescription className="sr-only">{t("Main navigation")}</SheetDescription>
                  <Brand />
                </SheetHeader>
                <NavLinks onNavigate={() => setOpen(false)} />
                <PreferenceToggles className="mt-auto border-t pt-4" />
              </SheetContent>
            </Sheet>
            <div className="lg:hidden">
              <Brand />
            </div>
            <Breadcrumb />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <DataModeChip />
            <PreferenceToggles className="hidden sm:flex" />
            <UserMenu />
          </div>
        </header>
        <main id="main" tabIndex={-1} className="flex-1 px-4 pt-6 pb-12 outline-none sm:px-6 lg:px-8 lg:pt-10">
          <div className="mx-auto w-full max-w-[1080px]">{children}</div>
        </main>
      </div>
    </div>
  )
}
