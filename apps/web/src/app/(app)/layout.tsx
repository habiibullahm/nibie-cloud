import { AppShell } from "@/components/app/app-shell"
import { ActionConfirmation } from "@/components/app/action-confirmation"
import { AuthGate } from "@/components/app/auth-gate"

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGate>
      <ActionConfirmation>
        <AppShell>{children}</AppShell>
      </ActionConfirmation>
    </AuthGate>
  )
}
