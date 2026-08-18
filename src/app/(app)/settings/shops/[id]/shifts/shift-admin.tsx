"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Clock, Loader2, Moon, Plus, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface ShiftRow {
  id: string;
  shopId: string;
  name: string;
  startTime: string;
  endTime: string;
  daysOfWeek: number[];
  isActive: boolean;
  crossesMidnight: boolean;
}

/** 0 = Sunday, matching `Shift.daysOfWeek` in the schema. */
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

/** The seed's two shifts (§4.14), offered as a starting point on an empty branch. */
const DEFAULT_SHIFTS = [
  { name: "Morning", startTime: "10:00", endTime: "18:00" },
  { name: "Evening", startTime: "18:00", endTime: "23:00" },
];

function describeDays(days: number[]): string {
  if (days.length === 7) return "Every day";
  if (days.length === 0) return "No days — never runs";
  // Weekdays / weekends read better than five chips.
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.join() === "1,2,3,4,5") return "Weekdays";
  if (sorted.join() === "0,6") return "Weekends";
  return sorted.map((d) => DAYS[d]).join(", ");
}

/**
 * The shift manager (§4.14, §7.7).
 *
 * Two things this screen has to communicate that the data alone does not:
 *
 *  1. **A branch with no shift cannot be late.** `clockIn` only computes
 *     lateness when a shift is matched, so with none configured every arrival
 *     records as punctual. That is not obvious and it silently disables a
 *     control the owner thinks is on.
 *  2. **Editing a shift never rewrites past lateness.** Attendance snapshots
 *     the start time at clock-in (§4.14), so a correction is safe — the
 *     screen says so, because the fear of retroactively marking staff late is
 *     exactly what stops someone fixing a typo.
 */
export function ShiftAdmin({
  shopId,
  shopName,
  lateGraceMin,
  initialShifts,
}: {
  shopId: string;
  shopName: string;
  lateGraceMin: number;
  initialShifts: ShiftRow[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const active = initialShifts.filter((s) => s.isActive);
  const retired = initialShifts.filter((s) => !s.isActive);

  async function addDefaults() {
    setBusy("defaults");
    try {
      // No bulk endpoint — POST each in turn, and stop at the first failure so
      // a partial result is not reported as success.
      for (const shift of DEFAULT_SHIFTS) {
        const res = await fetch(`/api/shops/${shopId}/shifts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...shift, daysOfWeek: EVERY_DAY }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          toast.error(
            body?.error?.message ?? `Could not add the ${shift.name} shift.`,
          );
          router.refresh();
          return;
        }
      }
      toast.success("Added a Morning and an Evening shift.");
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function remove(shift: ShiftRow) {
    setBusy(shift.id);
    try {
      const res = await fetch(`/api/shops/${shopId}/shifts/${shift.id}`, {
        method: "DELETE",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(body?.error?.message ?? "Could not remove that shift.");
        return;
      }
      // The server decides which happened: a shift with attendance against it
      // is deactivated so historical rows keep resolving their name; one with
      // none is deleted outright.
      toast.success(
        body?.deactivated
          ? `${shift.name} retired — past attendance still refers to it.`
          : `Deleted ${shift.name}`,
      );
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function setActive(shift: ShiftRow, isActive: boolean) {
    setBusy(shift.id);
    try {
      const res = await fetch(`/api/shops/${shopId}/shifts/${shift.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(body?.error?.message ?? "Could not update that shift.");
        return;
      }
      toast.success(isActive ? `${shift.name} restored` : `${shift.name} retired`);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      {/*
        The consequence of having no shifts, stated plainly. Without a shift to
        measure from, `clockIn` records every arrival as punctual — the branch
        looks perfectly attended and the grace setting does nothing.
      */}
      {active.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>No shifts yet</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Staff can still clock in at {shopName}, but with no shift to
              measure against <strong>nobody is ever recorded as late</strong> —
              the {lateGraceMin}-minute grace setting has nothing to apply to.
            </p>
            <Button
              onClick={addDefaults}
              disabled={busy === "defaults"}
              size="lg"
              className="w-full"
            >
              {busy === "defaults" ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Sparkles className="size-4" />
              )}
              Use the standard shifts (Morning 10:00–18:00 · Evening 18:00–23:00)
            </Button>
            <p className="text-xs text-muted-foreground">
              You can edit the times, days or names afterwards.
            </p>
          </CardContent>
        </Card>
      )}

      {active.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Shifts staff can choose</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y">
              {active.map((s) => (
                <ShiftItem
                  key={s.id}
                  shift={s}
                  shopId={shopId}
                  lateGraceMin={lateGraceMin}
                  busy={busy === s.id}
                  onDelete={() => remove(s)}
                />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {adding ? (
          <ShiftForm
            shopId={shopId}
            onCancel={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            router.refresh();
          }}
        />
      ) : (
        <Button variant="outline" onClick={() => setAdding(true)}>
          <Plus className="size-4" />
          Add a shift
        </Button>
      )}

      {retired.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Retired</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y">
              {retired.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center gap-3 px-6 py-4 text-muted-foreground"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{s.name}</span>
                    <span className="block text-sm">
                      {s.startTime}–{s.endTime} · {describeDays(s.daysOfWeek)}
                    </span>
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy === s.id}
                    onClick={() => setActive(s, true)}
                  >
                    Restore
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ShiftItem({
  shift,
  shopId,
  lateGraceMin,
  busy,
  onDelete,
}: {
  shift: ShiftRow;
  shopId: string;
  lateGraceMin: number;
  busy: boolean;
  onDelete: () => void;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <li className="px-6 py-4">
        <ShiftForm
          shopId={shopId}
          shift={shift}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            router.refresh();
          }}
        />
      </li>
    );
  }

  return (
    <li className="flex items-center gap-3 px-6 py-4">
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{shift.name}</span>
        <span className="block text-sm text-muted-foreground">
          {shift.startTime}–{shift.endTime} · {describeDays(shift.daysOfWeek)}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          Late after {shift.startTime} plus {lateGraceMin} min
        </span>
        {/*
          A shift ending before it starts is legitimate (§4.14 — a 22:00–06:00
          night shift), so label it rather than letting it read as a data error.
        */}
        {shift.crossesMidnight && (
          <span className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Moon className="size-3" />
            Runs past midnight
          </span>
        )}
      </span>

      <div className="flex shrink-0 gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={onDelete}
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4" />
          )}
          Remove
        </Button>
      </div>
    </li>
  );
}

/** Create when `shift` is absent, edit when present. Same fields either way. */
function ShiftForm({
  shopId,
  shift,
  onSaved,
  onCancel,
}: {
  shopId: string;
  shift?: ShiftRow;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(shift?.name ?? "");
  const [startTime, setStartTime] = useState(shift?.startTime ?? "10:00");
  const [endTime, setEndTime] = useState(shift?.endTime ?? "18:00");
  const [days, setDays] = useState<number[]>(shift?.daysOfWeek ?? EVERY_DAY);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const crossesMidnight = endTime < startTime;
  const sameTime = startTime === endTime && startTime !== "";

  function toggleDay(d: number) {
    setDays((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort(),
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);

    const url = shift
      ? `/api/shops/${shopId}/shifts/${shift.id}`
      : `/api/shops/${shopId}/shifts`;

    try {
      const res = await fetch(url, {
        method: shift ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, startTime, endTime, daysOfWeek: days }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error?.message ?? "Could not save that shift.");
        setPending(false);
        return;
      }
      toast.success(shift ? `Saved ${body.name}` : `Added ${body.name}`);
      onSaved();
    } catch {
      setError("Cannot reach the server. Check the internet connection.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={`name-${shift?.id ?? "new"}`}>Name</Label>
        <Input
          id={`name-${shift?.id ?? "new"}`}
          value={name}
          placeholder="Morning"
          onChange={(e) => setName(e.target.value)}
          required
          disabled={pending}
        />
      </div>

      <div className="flex gap-3">
        <div className="flex-1 space-y-2">
          <Label htmlFor={`start-${shift?.id ?? "new"}`}>Starts</Label>
          <Input
            id={`start-${shift?.id ?? "new"}`}
            type="time"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            required
            disabled={pending}
          />
        </div>
        <div className="flex-1 space-y-2">
          <Label htmlFor={`end-${shift?.id ?? "new"}`}>Ends</Label>
          <Input
            id={`end-${shift?.id ?? "new"}`}
            type="time"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
            required
            disabled={pending}
          />
        </div>
      </div>

      {crossesMidnight && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Moon className="size-3.5 shrink-0" />
          This shift runs past midnight into the next day. That is allowed.
        </p>
      )}
      {sameTime && (
        <p className="text-xs text-destructive">
          A shift cannot start and end at the same time.
        </p>
      )}

      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium">Days</legend>
        <div className="flex flex-wrap gap-2">
          {DAYS.map((label, d) => (
            <button
              key={d}
              type="button"
              onClick={() => toggleDay(d)}
              aria-pressed={days.includes(d)}
              disabled={pending}
              className={cn(
                "min-h-11 min-w-11 rounded-lg border-2 px-3 text-sm font-medium",
                days.includes(d)
                  ? "border-primary bg-primary/5"
                  : "border-border text-muted-foreground hover:bg-muted",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {days.length === 0 && (
          <p className="text-xs text-destructive">Choose at least one day.</p>
        )}
      </fieldset>

      {/*
        §4.14: attendance snapshots the shift start at clock-in, so editing is
        safe. Saying so is the point — otherwise nobody dares fix a wrong time
        in case it retroactively marks staff late.
      */}
      {shift && (
        <p className="flex items-start gap-1.5 rounded-lg bg-muted px-4 py-3 text-sm text-muted-foreground">
          <Clock className="mt-0.5 size-4 shrink-0" />
          Changing these times affects future clock-ins only. Past attendance
          keeps the times it was recorded against.
        </p>
      )}

      {error && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <Button
          type="submit"
          disabled={pending || sameTime || days.length === 0 || !name.trim()}
        >
          {pending && <Loader2 className="animate-spin" />}
          {shift ? "Save" : "Add"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
