"use client"

import * as React from "react"
import { CalendarIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Calendar, fromIso } from "@/components/ui/calendar"

function formatDisplay(iso: string): string {
  return fromIso(iso).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}

/**
 * Single-date field — the custom calendar popup used in place of a native
 * `<input type="date">`, matching the BisMan dashboard's Sales Performance
 * picker. `max` disables every day after it, same contract as the native
 * input it replaces.
 */
function DatePicker({
  value,
  onChange,
  max,
  className,
  id,
}: {
  value: string
  onChange: (iso: string) => void
  max?: string
  className?: string
  id?: string
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            id={id}
            type="button"
            variant="outline"
            className={cn("justify-start font-normal", className)}
          />
        }
      >
        <CalendarIcon className="size-4 text-muted-foreground" />
        {value ? formatDisplay(value) : "Pick a date"}
      </PopoverTrigger>
      <PopoverContent className="p-3">
        <Calendar
          value={value}
          maxIso={max}
          onChange={(iso) => {
            onChange(iso)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

export { DatePicker }
