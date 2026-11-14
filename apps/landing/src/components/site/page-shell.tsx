import { cn } from "@/lib/utils"

/** Shared frame for the secondary pages (harga, kontak, legal): one h1, readable measure. */
export function PageShell({
  title,
  intro,
  children,
  className,
}: {
  title: string
  intro?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className="mx-auto max-w-[1120px] px-4 pt-10 pb-20 sm:px-6">
      <header className="mb-10 grid max-w-[62ch] gap-3">
        <h1 className="type-h2">{title}</h1>
        {intro ? <p className="type-lead text-muted-foreground">{intro}</p> : null}
      </header>
      <div className={cn("grid gap-8", className)}>{children}</div>
    </div>
  )
}

/** Long-form prose block for the legal pages. */
export function Prose({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid max-w-[70ch] gap-8 text-muted-foreground [&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-4 [&_h2]:font-heading [&_h2]:text-[1.125rem] [&_h2]:font-semibold [&_h2]:text-foreground [&_li]:pl-1 [&_ol]:list-decimal [&_ol]:pl-6 [&_section]:grid [&_section]:gap-3 [&_strong]:font-normal [&_strong]:text-foreground [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:grid [&_ul]:gap-1.5 [&_ol]:grid [&_ol]:gap-1.5">
      {children}
    </div>
  )
}
