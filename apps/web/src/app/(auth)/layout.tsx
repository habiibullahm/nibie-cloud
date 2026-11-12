import { Brand } from "@/components/app/brand"

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-8 px-4 py-12">
      <Brand href="/sign-in" />
      <main className="w-full max-w-sm">{children}</main>
      <p className="max-w-sm text-center text-muted-foreground">
        Run your personal AI agent 24/7. No VPS, no setup, no infrastructure maintenance.
      </p>
    </div>
  )
}
