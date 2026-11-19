import { Brand } from "@/components/app/brand"

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex justify-center px-4 pt-12">
        <Brand href="/sign-in" />
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-8 px-4 py-8">
        <main className="w-full max-w-sm">{children}</main>
        {/* Positioning line from PRD §1. */}
        <p className="max-w-sm text-center text-muted-foreground">
          Your own AI agent in the cloud. No server to set up or maintain.
        </p>
      </div>
    </div>
  )
}
