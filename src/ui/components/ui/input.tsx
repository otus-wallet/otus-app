// shadcn/ui (input, new-york-v4), MIT: as it comes, but for its imports, which point into this repo, and its colours and size, Otus's.
import * as React from "react"
import { cn } from "../../lib/cn.ts"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-[34px] w-full min-w-0 rounded-md border border-input bg-panel px-2.5 py-1 text-xs transition-[color,box-shadow] outline-none selection:bg-ok-bg selection:text-ok placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
