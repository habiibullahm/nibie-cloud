import { Check, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import type { InstanceStatus } from "@/lib/api/types"
import { PROVISION_STEPS, provisionStepIndex } from "@/lib/api/status"

/** Deployment progress (PRD §4.1 step 7). Each step carries a text state, not just an icon. */
export function ProvisionProgress({ status }: { status: InstanceStatus }) {
  const current = provisionStepIndex(status)
  const done = status === "ACTIVE" || status === "DEGRADED"
  return (
    <ol className="grid gap-3" aria-label="Deployment progress">
      {PROVISION_STEPS.map((step, i) => {
        const state = done || i < current ? "done" : i === current ? "current" : "todo"
        return (
          <li key={step.label} className="flex items-center gap-3" aria-current={state === "current" ? "step" : undefined}>
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-sm border",
                state === "done" && "border-secondary bg-secondary",
                state === "current" && "border-foreground",
                state === "todo" && "border-border text-muted-foreground"
              )}
              aria-hidden="true"
            >
              {state === "done" ? <Check className="size-3" /> : state === "current" ? <Loader2 className="size-3 animate-spin" /> : null}
            </span>
            <span className={cn(state === "todo" ? "text-muted-foreground" : "text-foreground")}>{step.label}</span>
            <span className="sr-only">
              {state === "done" ? "(done)" : state === "current" ? "(in progress)" : "(not started)"}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
