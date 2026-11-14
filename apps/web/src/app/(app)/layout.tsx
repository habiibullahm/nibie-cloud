import { AppShell } from "@/components/app/app-shell"
import { AuthGate } from "@/components/app/auth-gate"

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGate>
      <AppShell>{children}</AppShell>
    </AuthGate>
  )
}
