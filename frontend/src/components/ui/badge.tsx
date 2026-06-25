import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-[0.68rem] font-semibold uppercase tracking-wider transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background",
  {
    variants: {
      variant: {
        default:
          "border-[var(--amber-line)] bg-[var(--amber-soft)] text-[var(--amber-bright)]",
        secondary:
          "border-border bg-secondary text-secondary-foreground",
        destructive:
          "border-[var(--red-line)] bg-[var(--red-soft)] text-[#ffb0ab]",
        success:
          "border-[var(--green-line)] bg-[var(--green-soft)] text-[#9bf0c4]",
        outline: "border-border text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
