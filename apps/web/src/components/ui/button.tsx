import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  "hit-area relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-sm border border-transparent text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:border-transparent disabled:bg-disabled disabled:text-disabled-foreground aria-disabled:pointer-events-none aria-disabled:bg-disabled aria-disabled:text-disabled-foreground aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive-hover",
        outline: "border-border bg-background text-foreground hover:border-muted-foreground hover:bg-card",
        secondary: "bg-secondary text-secondary-foreground hover:bg-surface-hover",
        ghost: "bg-transparent text-foreground hover:bg-secondary",
        link: "h-auto border-0 px-0 text-foreground underline decoration-input underline-offset-4 hover:decoration-foreground",
      },
      size: {
        default: "h-10 px-4 py-2.5",
        xs: "h-8 gap-1 px-2 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-9 px-3 py-2",
        lg: "h-12 px-6",
        icon: "size-10",
        "icon-xs": "size-8 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-9",
        "icon-lg": "size-12",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
