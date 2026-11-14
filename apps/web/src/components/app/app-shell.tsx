"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useState } from "react"
import { Boxes, LifeBuoy, LogOut, Menu, Rocket, UserRound } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { getSupabase } from "@/lib/auth/supabase"
import { cn } from "@/lib/utils"
import { useApiMode, useMe } from "@/hooks/use-hermes"
import { Brand } from "./brand"

const NAV = [
  { href: "/instances", label: "Instances", icon: Boxes, match: (p: string) => p.startsWith("/instances") },
  { href: "/deploy", label: "Deploy", icon: Rocket, match: (p: string) => p.startsWith("/deploy") },
  { href: "/account", label: "Account", icon: UserRound, match: (p: string) => p.startsWith("/account") },
]

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname()
  return (
    <nav aria-label="Main" className="flex flex-col gap-1">
      {NAV.map(({ href, label, icon: Icon, match }) => {
        const active = match(pathname)
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-sm border-l-2 border-transparent px-3 py-2 text-muted-foreground pointer-coarse:py-3 no-underline transition-colors outline-none hover:bg-card hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              active && "border-l-foreground bg-card text-foreground"
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            {label}
          </Link>
        )
      })}
    </nav>
  )
}

function RailFooter() {
  const router = useRouter()
  const mode = useApiMode()
  const me = useMe()
  return (
    <div className="mt-auto flex flex-col gap-3 border-t pt-4 text-muted-foreground">
      <div className="flex items-center gap-2">
        <span className="type-label">Data</span>
        <span className="type-mono rounded-sm border px-2 py-1">{mode === "mock" ? "mock" : "live api"}</span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-foreground">{me.data?.name ?? " "}</p>
          <p className="type-mono truncate">{me.data?.email ?? " "}</p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Sign out"
          onClick={async () => {
            await getSupabase()?.auth.signOut()
            router.push("/sign-in")
          }}
        >
          <LogOut aria-hidden="true" />
        </Button>
      </div>
    </div>
  )
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
      <a
        href="#main"
        className="fixed top-2 left-2 z-[100] -translate-y-[200%] rounded-sm bg-foreground px-4 py-2 text-background focus:translate-y-0 pointer-coarse:py-3"
      >
        Skip to content
      </a>

      <header className="sticky top-0 hidden h-dvh flex-col gap-6 overflow-y-auto border-r px-4 py-6 lg:flex">
        <Brand />
        <NavLinks />
        <RailFooter />
      </header>

      <header className="sticky top-0 z-40 flex items-center justify-between gap-3 border-b bg-background px-4 py-3 lg:hidden">
        <Brand />
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Open navigation">
              <Menu aria-hidden="true" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="flex w-72 flex-col gap-6 border-r bg-background px-4 py-6">
            <SheetHeader className="p-0">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <SheetDescription className="sr-only">Main navigation</SheetDescription>
              <Brand />
            </SheetHeader>
            <NavLinks onNavigate={() => setOpen(false)} />
            <RailFooter />
          </SheetContent>
        </Sheet>
      </header>

      <div className="flex min-h-dvh min-w-0 flex-col">
        <main id="main" tabIndex={-1} className="flex-1 px-4 pt-6 pb-12 outline-none sm:px-6 lg:px-8 lg:pt-10">
          <div className="mx-auto w-full max-w-[1080px]">{children}</div>
        </main>
        <SiteFooter className="px-4 sm:px-6 lg:px-8" />
      </div>
    </div>
  )
}

/** Page footer, shared with the auth screens. */
export function SiteFooter({ className }: { className?: string }) {
  return (
    <footer className={cn("border-t py-4 text-muted-foreground", className)}>
      <div className="mx-auto flex w-full max-w-[1080px] items-center gap-2">
        <LifeBuoy className="size-4 shrink-0" aria-hidden="true" />
        {/* TODO(support): link the Telegram support handle once it exists (PRD §3, "Initial support: Telegram"). */}
        <p>Support on Telegram, coming soon.</p>
      </div>
    </footer>
  )
}
