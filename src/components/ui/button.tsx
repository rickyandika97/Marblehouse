import { isValidElement } from "react"
import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        link: "text-primary underline-offset-4 hover:underline",
      },
      // Tablet-first touch scale (PRD NF-3, §8.11). 44px is the FLOOR, not the
      // default — staff use this one-handed on a 10" tablet on shop wifi.
      // Do not reintroduce shadcn's desktop sizes (h-6/h-7/h-8) here.
      size: {
        // Dense contexts only — table row actions, inline affordances.
        sm: "h-11 gap-1.5 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        default:
          "h-12 gap-2 px-4 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        // Primary action on a screen.
        lg: "h-14 gap-2 px-5 text-base has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4",
        // The one dominant action: Record sale, Confirm redemption, Clock in.
        xl: "h-16 gap-2.5 px-6 text-lg font-semibold has-data-[icon=inline-end]:pr-5 has-data-[icon=inline-start]:pl-5 [&_svg:not([class*='size-'])]:size-5",
        // Square — height alone is not a touch target.
        icon: "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

/**
 * `nativeButton` tells Base UI whether the element it actually renders is a
 * real `<button>`. It defaults to TRUE, so `render={<Link/>}` or `render={<a/>}`
 * — the D-6 navigation pattern used across the app — makes the primitive apply
 * button semantics to an anchor and log an error.
 *
 * Derived here rather than passed at each call site: there were eight such
 * sites across five phases and every one of them had it wrong, which is the
 * failure mode of a prop you have to remember. An explicit `nativeButton` still
 * wins, for the case where a caller renders something we cannot infer.
 */
function Button({
  className,
  variant = "default",
  size = "default",
  render,
  nativeButton,
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  const rendersNativeButton =
    nativeButton ??
    (render === undefined ||
      (isValidElement(render) && render.type === "button"))

  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      render={render}
      nativeButton={rendersNativeButton}
      {...props}
    />
  )
}

export { Button, buttonVariants }
