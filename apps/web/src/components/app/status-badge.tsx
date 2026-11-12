import { CircleX, Clock, Loader2, PauseCircle, TriangleAlert } from "lucide-react"
import { cn } from "@/lib/utils"
import type { InstanceStatus } from "@/lib/api/types"
import { presentStatus } from "@/lib/api/status"

/**
 * Status is always carried by its text label; each tone also has its own icon shape, so color is
 * never the only signal (DESIGN.md Do's and Don'ts).
 */
export function StatusBadge({ status, className }: { status: InstanceStatus; className?: string }) {
  const p = presentStatus(status)
  return (
    <span
      data-tone={p.tone}
      className={cn(
        "type-label inline-flex w-fit shrink-0 items-center gap-2 rounded-sm border border-border bg-elevated px-2 py-1 text-foreground",
        p.tone === "ok" && "border-secondary bg-secondary",
        p.tone === "neutral" && "text-muted-foreground",
        p.tone === "danger" && "border-destructive",
        className
      )}
    >
      <StatusIcon status={status} />
      {p.label}
    </span>
  )
}

function StatusIcon({ status }: { status: InstanceStatus }) {
  const p = presentStatus(status)
  const cls = "size-3 shrink-0"
  if (status === "PENDING") return <Clock className={cls} aria-hidden="true" />
  if (status === "SUSPENDED") return <PauseCircle className={cls} aria-hidden="true" />
  switch (p.tone) {
    case "ok":
      return <span aria-hidden="true" className="size-2 shrink-0 bg-current" />
    case "warn":
      return <TriangleAlert className={cls} aria-hidden="true" />
    case "danger":
      return <CircleX className={cn(cls, "text-destructive")} aria-hidden="true" />
    case "busy":
      return <Loader2 className={cn(cls, "animate-spin")} aria-hidden="true" />
    default:
      return <span aria-hidden="true" className="size-2 shrink-0 border border-current" />
  }
}
