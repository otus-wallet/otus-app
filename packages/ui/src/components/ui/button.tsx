// shadcn/ui (button, new-york-v4), MIT: as it comes, but for its imports, which point into this repo, and its variants,
// in Otus's OLED look: uppercase and bold, outlined in ink, the main action filled with it; "risky" in red.
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../../lib/cn.ts"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md text-[13px] font-bold uppercase whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border border-primary bg-primary text-primary-foreground hover:bg-[#c9d6e6]",
        outline: "border border-ink bg-transparent text-ink hover:bg-hover",
        risky: "border border-danger bg-transparent text-danger hover:bg-danger-bg",
        warn: "border border-warn bg-transparent text-warn hover:bg-warn-bg",
        ghost: "text-ink-2 hover:bg-hover hover:text-ink",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-11 px-4",
        sm: "h-[30px] gap-1.5 px-2.5 text-[11px]",
        xs: "h-[22px] gap-1 px-2 text-[10px]",
        icon: "size-8 rounded-md",
      },
    },
    defaultVariants: {
      variant: "outline",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "outline",
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
