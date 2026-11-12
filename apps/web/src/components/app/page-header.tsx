import { cn } from "@/lib/utils"

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  eyebrow?: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <header className={cn("flex flex-col gap-4 border-b pb-6 md:flex-row md:items-end md:justify-between", className)}>
      <div className="flex min-w-0 flex-col gap-3">
        {eyebrow ? <div className="type-label flex flex-wrap items-center gap-2 text-muted-foreground">{eyebrow}</div> : null}
        <h1 className="type-h1 break-words">{title}</h1>
        {description ? <p className="max-w-[66ch] text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  )
}

export function SectionTitle({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="type-label text-foreground">{children}</h2>
      {aside}
    </div>
  )
}
