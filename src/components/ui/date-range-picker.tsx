"use client"

import * as React from "react"
import { CalendarIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { RangeCalendar, fromIso } from "@/components/ui/calendar"

function formatShort(iso: string): string {
  return fromIso(iso).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
  })
}

/**
 * Date-range field — the dual-month calendar popup used in place of two
 * native `<input type="date">` fields, matching the BisMan dashboard's Sales
 * Performance range picker. Selection is click start, then click end (hover
 * previews the range); `onChange` fires once, on the second click, with both
 * bounds — there is no separate "Apply" step inside the popup.
 */
function DateRangePicker({
  from,
  to,
  onChange,
  max,
  className,
}: {
  from?: string
  to?: string
  onChange: (from: string, to: string) => void
  max?: string
  className?: string
}) {
  const [open, setOpen] = React.useState(false)

  const label =
    from && to
      ? from === to
        ? formatShort(from)
        : `${formatShort(from)} – ${formatShort(to)}`
      : "Pick a date range"

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            className={cn("justify-start font-normal", className)}
          />
        }
      >
        <CalendarIcon className="size-4 text-muted-foreground" />
        {label}
      </PopoverTrigger>
      <PopoverContent className="p-4">
        <RangeCalendar
          start={from ?? null}
          end={to ?? null}
          maxIso={max}
          onChange={(nextFrom, nextTo) => {
            onChange(nextFrom, nextTo)
            if (nextFrom && nextTo) setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

export { DateRangePicker }
