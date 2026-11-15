"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { ShieldAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/app/empty-state"
import { QueryFallback } from "@/components/app/query-fallback"
import { apiMode } from "@/lib/api"
import { decideAdminGate } from "@/lib/admin-gate-rules"
import { useAdminMe } from "@/hooks/use-admin"
import { cn } from "@/lib/utils"

const ADMIN_NAV = [
  { href: "/admin", label: "Ringkasan", exact: true },
  { href: "/admin/pelanggan", label: "Pelanggan" },
  { href: "/admin/instance", label: "Instance" },
  { href: "/admin/langganan", label: "Langganan" },
  { href: "/admin/plan", label: "Plan" },
  { href: "/admin/node", label: "Node" },
  { href: "/admin/job", label: "Job gagal" },
  { href: "/admin/audit", label: "Audit" },
]

function AdminNav() {
  const pathname = usePathname()
  return (
    <nav aria-label="Navigasi admin" className="flex flex-wrap gap-2 border-b pb-4">
      {ADMIN_NAV.map(({ href, label, exact }) => {
        const active = exact ? pathname === href : pathname.startsWith(href)
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "type-label hit-area rounded-sm border px-3 py-1.5 no-underline transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              active ? "border-foreground bg-card text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {label}
          </Link>
        )
      })}
    </nav>
  )
}

/**
 * Admin shell. The allowlist lives on the server, so this only decides what to draw: nothing at all
 * until `/admin/me` answers, an "unauthorized" page for a signed-in non-admin (with no hint about who
 * is one), and the panel otherwise.
 */
export function AdminGate({ children }: { children: React.ReactNode }) {
  const me = useAdminMe()
  const decision = decideAdminGate({
    mode: apiMode(),
    pending: me.isPending,
    error: me.error !== null && me.error !== undefined,
    admin: me.data?.admin ?? null,
  })

  if (decision === "needs-backend") {
    return (
      <EmptyState
        icon={<ShieldAlert aria-hidden="true" />}
        title="Panel admin butuh backend"
        description="Panel ini hanya jalan dengan NEXT_PUBLIC_HERMES_API_MODE=customer dan alamat API yang disetel. Tidak ada data contoh di sini."
        action={
          <Button asChild variant="outline">
            <Link href="/instances">Kembali ke instance</Link>
          </Button>
        }
      />
    )
  }

  if (decision === "loading") return <QueryFallback what="akses admin" queries={[me]} />
  if (decision === "unauthorized") {
    return (
      <EmptyState
        icon={<ShieldAlert aria-hidden="true" />}
        title="Tidak berwenang"
        description="Akun ini tidak punya akses ke panel admin."
        action={
          <Button asChild variant="outline">
            <Link href="/instances">Kembali ke instance</Link>
          </Button>
        }
      />
    )
  }

  // `decision === "panel"` implies `me.data.admin` exists; the guard above is what proves it.
  const admin = me.data!.admin!
  return (
    <div className="grid gap-6">
      <div className="flex flex-col gap-1">
        <p className="type-label text-muted-foreground">Panel admin</p>
        <p className="type-mono text-muted-foreground">
          {admin.email}
          {admin.aal === "aal2" ? " · 2FA aktif" : " · 2FA belum aktif"}
        </p>
      </div>
      <AdminNav />
      {children}
    </div>
  )
}
