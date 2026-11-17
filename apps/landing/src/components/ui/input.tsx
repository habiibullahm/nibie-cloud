import * as React from "react"
import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-10 w-full min-w-0 rounded-sm pointer-coarse:h-11 border border-input bg-elevated px-3 py-2.5 text-sm text-foreground transition-[color,box-shadow,border-color] outline-none enabled:hover:border-muted-foreground selection:bg-secondary selection:text-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:text-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        className
      )}
      {...props}
    />
  )
}

export { Input }
