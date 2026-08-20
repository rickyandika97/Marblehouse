"use client"

import * as React from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"

/** Local `YYYY-MM-DD` — never UTC, so the grid matches the viewer's calendar. */
function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`
}

function fromIso(iso: string): Date {
  const parts = iso.split("-")
  const y = Number(parts[0])
  const m = Number(parts[1])
  const d = Number(parts[2])
  return new Date(y, m - 1, d)
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

function addMonths(d: Date, delta: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + delta, 1)
}

const DOW_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]

/**
 * One month's grid of day cells. Shared by the single-date and range pickers
 * — range mode passes `rangeStart`/`rangeEnd` (and a `hoverIso` preview while
 * the second endpoint is still pending) so both months in a range popup can
 * highlight the same in-progress selection.
 */
function CalendarMonth({
  month,
  todayIso,
  selected,
  rangeStart,
  rangeEnd,
  disabled,
  onSelect,
  onHover,
}: {
  month: Date
  todayIso: string
  selected?: string
  rangeStart?: string | null
  rangeEnd?: string | null
  disabled?: (iso: string) => boolean
  onSelect: (iso: string) => void
  onHover?: (iso: string) => void
}) {
  const year = month.getFullYear()
  const m = month.getMonth()
  const daysInMonth = new Date(year, m + 1, 0).getDate()
  // Monday-first, matching the rest of the app's date conventions.
  const firstDow = (new Date(year, m, 1).getDay() + 6) % 7

  const cells: React.ReactNode[] = []
  for (let i = 0; i < firstDow; i++) {
    cells.push(<div key={`pad-${i}`} className="aspect-square" />)
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const iso = toIso(new Date(year, m, day))
    const isFuture = iso > todayIso
    const isDisabled = isFuture || (disabled ? disabled(iso) : false)
    const isToday = iso === todayIso
    const isSelected = iso === selected
    const isRangeStart = iso === rangeStart
    const isRangeEnd = iso === rangeEnd
    const isInRange = Boolean(
      rangeStart &&
        rangeEnd &&
        iso > rangeStart &&
        iso < rangeEnd &&
        rangeStart !== rangeEnd
    )
    const isEndpoint = isRangeStart || isRangeEnd

    cells.push(
      <div
        key={iso}
        className={cn(
          "flex aspect-square items-center justify-center",
          isRangeStart && rangeEnd && rangeStart !== rangeEnd
            ? "bg-gradient-to-r from-transparent from-50% to-accent to-50%"
            : isRangeEnd && rangeStart && rangeStart !== rangeEnd
              ? "bg-gradient-to-r from-accent from-50% to-transparent to-50%"
              : isInRange
                ? "bg-accent"
                : undefined
        )}
      >
        <button
          type="button"
          disabled={isDisabled}
          onClick={() => onSelect(iso)}
          onPointerEnter={() => {
            if (onHover && !isDisabled) onHover(iso)
          }}
          className={cn(
            "relative flex size-9 shrink-0 items-center justify-center rounded-full text-sm transition-colors",
            isDisabled && "pointer-events-none text-muted-foreground/40",
            !isDisabled &&
              !isSelected &&
              !isEndpoint &&
              "hover:bg-muted",
            isToday && !isSelected && !isEndpoint && "font-semibold text-primary",
            (isSelected || isEndpoint) &&
              "bg-primary font-medium text-primary-foreground"
          )}
        >
          {day}
          {isToday && !isSelected && !isEndpoint && (
            <span className="absolute bottom-1 size-1 rounded-full bg-primary" />
          )}
        </button>
      </div>
    )
  }

  return (
    <div className="w-64">
      <div className="mb-1 grid grid-cols-7">
        {DOW_LABELS.map((label) => (
          <div
            key={label}
            className="py-1 text-center text-xs font-medium text-muted-foreground"
          >
            {label}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-y-0.5">{cells}</div>
    </div>
  )
}

function MonthHeader({
  month,
  onPrev,
  onNext,
  canNext = true,
  showNav = true,
}: {
  month: Date
  onPrev?: () => void
  onNext?: () => void
  canNext?: boolean
  showNav?: boolean
}) {
  return (
    <div className="mb-2 flex items-center justify-between px-1">
      {showNav && onPrev ? (
        <button
          type="button"
          onClick={onPrev}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
        </button>
      ) : (
        <span className="size-8" />
      )}
      <span className="text-sm font-semibold">
        {month.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
      </span>
      {showNav && onNext ? (
        <button
          type="button"
          onClick={onNext}
          disabled={!canNext}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        >
          <ChevronRight className="size-4" />
        </button>
      ) : (
        <span className="size-8" />
      )}
    </div>
  )
}

/** Single-date calendar — one month, with prev/next navigation. */
function Calendar({
  value,
  onChange,
  maxIso,
}: {
  value?: string
  onChange: (iso: string) => void
  /** Latest selectable date, `YYYY-MM-DD` — days after it are disabled. */
  maxIso?: string
}) {
  const todayIso = maxIso ?? toIso(new Date())
  const [month, setMonth] = React.useState(() =>
    startOfMonth(value ? fromIso(value) : fromIso(todayIso))
  )

  return (
    <div className="w-64">
      <MonthHeader
        month={month}
        onPrev={() => setMonth((m) => addMonths(m, -1))}
        onNext={() => setMonth((m) => addMonths(m, 1))}
        canNext={toIso(startOfMonth(addMonths(month, 1))) <= todayIso}
      />
      <CalendarMonth
        month={month}
        todayIso={todayIso}
        selected={value}
        disabled={maxIso ? (iso) => iso > maxIso : undefined}
        onSelect={onChange}
      />
    </div>
  )
}

/**
 * Two-month range calendar — click a start date, then an end date (hovering
 * previews the range before the second click commits it). Both months share
 * one `left` anchor; the right month always follows one month after it.
 */
function RangeCalendar({
  start,
  end,
  onChange,
  maxIso,
}: {
  start: string | null
  end: string | null
  onChange: (start: string, end: string) => void
  maxIso?: string
}) {
  const todayIso = maxIso ?? toIso(new Date())
  const [left, setLeft] = React.useState(() =>
    addMonths(startOfMonth(end ? fromIso(end) : fromIso(todayIso)), -1)
  )
  const [pending, setPending] = React.useState<string | null>(null)
  const [hover, setHover] = React.useState<string | null>(null)

  const right = addMonths(left, 1)
  const canNavRight = toIso(right) < todayIso

  function handleSelect(iso: string) {
    if (!pending) {
      setPending(iso)
      setHover(iso)
      return
    }
    let a = pending
    let b = iso
    if (a > b) [a, b] = [b, a]
    setPending(null)
    setHover(null)
    onChange(a, b)
  }

  let rangeStart = pending ?? start ?? undefined
  let rangeEnd = pending ? (hover ?? undefined) : (end ?? undefined)
  if (rangeStart && rangeEnd && rangeStart > rangeEnd) {
    ;[rangeStart, rangeEnd] = [rangeEnd, rangeStart]
  }

  return (
    <div>
      <div className="flex gap-6">
        <div>
          <MonthHeader month={left} onPrev={() => setLeft((m) => addMonths(m, -1))} />
          <CalendarMonth
            month={left}
            todayIso={todayIso}
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            disabled={maxIso ? (iso) => iso > maxIso : undefined}
            onSelect={handleSelect}
            onHover={(iso) => pending && setHover(iso)}
          />
        </div>
        <div>
          <MonthHeader
            month={right}
            onNext={() => setLeft((m) => addMonths(m, 1))}
            canNext={canNavRight}
          />
          <CalendarMonth
            month={right}
            todayIso={todayIso}
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            disabled={maxIso ? (iso) => iso > maxIso : undefined}
            onSelect={handleSelect}
            onHover={(iso) => pending && setHover(iso)}
          />
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between border-t pt-3 text-xs text-muted-foreground">
        <span>{pending ? "Select end date" : "Select start date"}</span>
        {(start || pending) && (
          <button
            type="button"
            onClick={() => {
              setPending(null)
              setHover(null)
              onChange("", "")
            }}
            className="font-medium text-foreground hover:underline"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  )
}

export { Calendar, RangeCalendar, toIso, fromIso }
