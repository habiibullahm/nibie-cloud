import { AdminGate } from "@/components/app/admin-gate"

/**
 * Every `/admin/*` page sits behind the gate. It is a client component because the check is a fetch
 * to `/admin/me`; the real guard is server-side (`ADMIN_EMAILS`), so nothing here is trusted.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <AdminGate>{children}</AdminGate>
}
