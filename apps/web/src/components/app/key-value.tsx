import { cn } from "@/lib/utils"

export function KeyValue({ items, className }: { items: { k: string; v: React.ReactNode }[]; className?: string }) {
  return (
    <dl className={cn("grid gap-x-6 gap-y-3 sm:grid-cols-[max-content_1fr]", className)}>
      {items.map(({ k, v }) => (
        <div key={k} className="contents">
          <dt className="type-label pt-1 text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  )
}
