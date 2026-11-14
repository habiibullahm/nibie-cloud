import { cn } from "@/lib/utils"

export function Section({
  id,
  label,
  title,
  intro,
  children,
  className,
}: {
  id?: string
  label: string
  title: string
  intro?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <section id={id} className={cn("scroll-mt-4 border-t border-border py-16", className)}>
      <div className="mx-auto max-w-[1120px] px-4 sm:px-6">
        <header className="mb-10 grid max-w-[62ch] gap-3">
          <span className="type-label text-muted-foreground">{label}</span>
          <h2 className="type-h2">{title}</h2>
          {intro ? <p className="text-muted-foreground">{intro}</p> : null}
        </header>
        {children}
      </div>
    </section>
  )
}
