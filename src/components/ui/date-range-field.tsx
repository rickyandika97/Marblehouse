"use client"

import * as React from "react"

import { DateRangePicker } from "@/components/ui/date-range-picker"

/**
 * Adapts `DateRangePicker` for a plain, uncontrolled `<form>` that submits
 * natively (e.g. a server-rendered report page with no client-side state) —
 * mirrors two hidden inputs so `fromName`/`toName` still land in the
 * `FormData` the browser posts, exactly as the native date inputs it replaces
 * did via `name`/`defaultValue`.
 */
function DateRangeField({
  fromName,
  toName,
  defaultFrom,
  defaultTo,
  max,
}: {
  fromName: string
  toName: string
  defaultFrom?: string
  defaultTo?: string
  max?: string
}) {
  const [from, setFrom] = React.useState(defaultFrom ?? "")
  const [to, setTo] = React.useState(defaultTo ?? "")

  return (
    <>
      <input type="hidden" name={fromName} value={from} />
      <input type="hidden" name={toName} value={to} />
      <DateRangePicker
        from={from || undefined}
        to={to || undefined}
        max={max}
        onChange={(nextFrom, nextTo) => {
          setFrom(nextFrom);
          setTo(nextTo);
        }}
      />
    </>
  )
}

export { DateRangeField }
