"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ReasonDialog } from "@/components/reason-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * The roster portion of the combined Shifts & roster screen (§4.14.1).
 *
 * The calendar stays first, then the recurring pattern is grouped by shift:
 *
 *   - **This week** — the RESOLVED grid. Read-only, because nothing stores a
 *     week: it is the pattern plus its overrides, computed on the server. Any
 *     control that let you edit a cell here would have to guess whether you
 *     meant "this Tuesday" or "every Tuesday", and guessing wrong rewrites a
 *     roster people have planned around.
 *   - **Shift coverage** — select an operating shift, then explicitly set its
 *     recurring staff pattern. This keeps the UI shift-focused without merging
 *     the two data models.
 *
 * Per-date exceptions are added from the grid, where the date is unambiguous,
 * and they always carry a reason.
 */
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** The business week is shown Monday-first; indexes still match the schema. */
const DAY_PICKER = [1, 2, 3, 4, 5, 6, 0];

function formatDays(days: number[]): string {
  return DAY_PICKER.filter((day) => days.includes(day))
    .map((day) => DAY_SHORT[day])
    .join(", ");
}

interface Shift {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  daysOfWeek: number[];
}

interface Staff {
  userId: string;
  name: string;
  username: string;
  role: string;
}

interface Assignment {
  id: string;
  userId: string;
  shiftId: string;
  employeeName: string;
  shiftName: string;
  startTime: string;
  endTime: string;
  daysOfWeek: number[];
  effectiveFrom: string;
  isRemoved: boolean;
}

interface Leave {
  id: string;
  userId: string;
  employeeName: string;
  startDate: string;
  endDate: string;
  reason: string;
  isActiveToday: boolean;
}

interface Slot {
  userId: string;
  employeeName: string;
  shiftId: string;
  shiftName: string;
  startTime: string;
  endTime: string;
  via: "PATTERN" | "OVERRIDE";
  reason: string | null;
}

interface Day {
  businessDate: string;
  weekday: number;
  slots: Slot[];
}

export function RosterAdmin({
  shopId,
  startDate,
  shifts,
  staff,
  initialAssignments,
  initialGrid,
  initialLeave,
}: {
  shopId: string;
  startDate: string;
  shifts: Shift[];
  staff: Staff[];
  initialAssignments: Assignment[];
  initialGrid: Day[];
  initialLeave: Leave[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  /** The shift whose recurring coverage is being set. */
  const [selectedShiftId, setSelectedShiftId] = useState(shifts[0]?.id ?? "");
  /** A staff picker belongs to one shift at a time, never a detached roster. */
  const [addingFor, setAddingFor] = useState<string | null>(null);
  /**
   * The slot being taken off a date. D-79 removed `window.prompt` from this
   * codebase; this reuses the shared dialog rather than reintroducing it — it
   * enforces the minimum before the round trip and meets §8.11's 44px floor.
   */
  const [removing, setRemoving] = useState<{ day: string; slot: Slot } | null>(
    null
  );
  /** Which recurring row is open for editing. Only one at a time. */
  const [editing, setEditing] = useState<string | null>(null);
  /**
   * The row awaiting a Remove confirmation.
   *
   * Remove means "this person no longer works this shift" — a soft delete that
   * hides the row but keeps it as the record behind any past attendance
   * (D-140). It is NOT for a holiday: that is Leave, which ends by itself. The
   * confirmation says so, because the owner's first instinct was to reach for
   * the destructive button to record a temporary absence.
   */
  const [removingRow, setRemovingRow] = useState<Assignment | null>(null);
  /** Whether the Leave form is open, and for whom. */
  const [leaveFor, setLeaveFor] = useState<Staff | null>(null);
  /** Removed schedules are collapsed — visible only when asked for. */
  const [showRemoved, setShowRemoved] = useState(false);

  function shiftWeek(byDays: number) {
    const next = new Date(`${startDate}T00:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + byDays);
    router.push(
      `/settings/shops/${shopId}/shifts?week=${next.toISOString().slice(0, 10)}`
    );
  }

  async function post(url: string, body: unknown, ok: string) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      toast.error(data?.error?.message ?? "That did not work.");
      return false;
    }
    toast.success(ok);
    startTransition(() => router.refresh());
    return true;
  }

  async function patch(url: string, body: unknown, ok: string) {
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      toast.error(data?.error?.message ?? "That did not work.");
      return false;
    }
    toast.success(ok);
    startTransition(() => router.refresh());
    return true;
  }

  const live = initialAssignments.filter((a) => !a.isRemoved);
  const removed = initialAssignments.filter((a) => a.isRemoved);
  const selectedShift = shifts.find((shift) => shift.id === selectedShiftId) ?? shifts[0];
  const selectedAssignments = selectedShift
    ? live.filter((assignment) => assignment.shiftId === selectedShift.id)
    : [];

  if (shifts.length === 0) {
    return (
      <div className="rounded-xl border-2 border-amber-400 bg-amber-50 p-4 text-sm text-amber-950">
        <p className="font-semibold">This branch has no shifts yet.</p>
        <p className="mt-1">
          A roster places people onto shifts, so the shifts have to exist first.
          Add the first shift below, then assign the people who cover it here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* ─────────────────────────── the week grid ─────────────────────────── */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Week of {startDate}</h2>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => shiftWeek(-7)}>
              Previous
            </Button>
            <Button variant="outline" size="sm" onClick={() => shiftWeek(7)}>
              Next
            </Button>
          </div>
        </div>

        {/* Wide content scrolls inside its own container so the page body never
            scrolls sideways on a phone. */}
        <div className="overflow-x-auto">
          <div className="grid min-w-[45rem] grid-cols-7 gap-2">
            {initialGrid.map((day) => (
              <div
                key={day.businessDate}
                className="min-h-32 rounded-xl border p-2"
              >
                <p className="text-xs font-semibold text-muted-foreground">
                  {DAY_SHORT[day.weekday]} {day.businessDate.slice(8)}
                </p>

                {day.slots.length === 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Nobody rostered
                  </p>
                ) : (
                  <ul className="mt-2 space-y-1.5">
                    {day.slots.map((slot) => (
                      <li
                        key={`${slot.userId}:${slot.shiftId}`}
                        className={cn(
                          "group rounded-lg px-2 py-1.5 text-xs",
                          slot.via === "OVERRIDE"
                            ? "bg-amber-100 text-amber-950"
                            : "bg-muted"
                        )}
                      >
                        <div className="flex items-start gap-1">
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium">
                              {slot.employeeName}
                            </p>
                            <p className="truncate text-muted-foreground">
                              {slot.shiftName} · {slot.startTime}
                            </p>
                            {slot.reason && (
                              <p className="truncate italic">{slot.reason}</p>
                            )}
                          </div>
                          <button
                            type="button"
                            title="Take them off this shift on this date"
                            className="shrink-0 rounded p-0.5 opacity-0 hover:bg-black/10 focus:opacity-100 group-hover:opacity-100"
                            onClick={() =>
                              setRemoving({ day: day.businessDate, slot })
                            }
                          >
                            <X className="size-3" />
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                <AddForDay
                  shopId={shopId}
                  date={day.businessDate}
                  shifts={shifts}
                  staff={staff}
                  post={post}
                />
              </div>
            ))}
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          Amber entries are one-off changes for that date. Everything else comes
          from the recurring pattern below — changing a single day never changes
          the pattern.
        </p>
      </section>

      {/* ───────────────────────── shift coverage ───────────────────────── */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold">Shift coverage</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Choose a shift, then pick the staff who regularly cover it.
            </p>
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {shifts.map((shift) => {
            const assigned = live.filter((assignment) => assignment.shiftId === shift.id);
            const selected = selectedShift?.id === shift.id;
            return (
              <button
                key={shift.id}
                type="button"
                onClick={() => {
                  setSelectedShiftId(shift.id);
                  setAddingFor(null);
                }}
                className={cn(
                  "min-h-24 rounded-xl border p-3 text-left transition-colors hover:bg-muted",
                  selected && "border-primary bg-primary/5 ring-1 ring-primary"
                )}
              >
                <p className="font-medium">{shift.name}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {shift.startTime}–{shift.endTime}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {assigned.length === 0
                    ? "No regular staff assigned"
                    : `${assigned.length} regular ${assigned.length === 1 ? "staff member" : "staff members"}`}
                </p>
              </button>
            );
          })}
        </div>

        {selectedShift && (
          <div className="space-y-3 rounded-xl border bg-muted/20 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="font-semibold">{selectedShift.name}</h3>
                <p className="text-sm text-muted-foreground">
                  {selectedShift.startTime}–{selectedShift.endTime} ·{" "}
                  {formatDays(selectedShift.daysOfWeek)}
                </p>
              </div>
              <Button
                size="sm"
                onClick={() => setAddingFor(addingFor === selectedShift.id ? null : selectedShift.id)}
              >
                <Plus className="size-4" />
                Assign staff
              </Button>
            </div>

            {addingFor === selectedShift.id && (
              <AssignmentForm
                shopId={shopId}
                shifts={shifts}
                staff={staff}
                fixedShift={selectedShift}
                onDone={() => setAddingFor(null)}
                post={post}
              />
            )}

            {selectedAssignments.length === 0 ? (
              <p className="rounded-xl border border-dashed bg-background p-3 text-sm text-muted-foreground">
                No recurring coverage yet. Assign someone above; one-off cover
                can still be added directly from the calendar.
              </p>
            ) : (
              <ul className="space-y-2">
                {selectedAssignments.map((assignment) => (
                  <li
                    key={assignment.id}
                    className="flex flex-wrap items-center gap-3 rounded-xl border bg-background p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{assignment.employeeName}</p>
                      <p className="text-sm text-muted-foreground">
                        {formatDays(assignment.daysOfWeek)}
                      </p>
                    </div>

                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditing(editing === assignment.id ? null : assignment.id)}
                    >
                      {editing === assignment.id ? "Close" : "Edit days"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() => setRemovingRow(assignment)}
                    >
                      {pending && <Loader2 className="size-4 animate-spin" />}
                      Remove
                    </Button>

                    {editing === assignment.id && (
                      <EditAssignment
                        assignment={assignment}
                        shift={selectedShift}
                        onDone={() => setEditing(null)}
                        patch={patch}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Removed schedules live behind a toggle. They exist so a mis-tap is
            recoverable — putting them in the main list would defeat the point
            of Remove, which is that the roster stops showing people who have
            left. */}
        {removed.length > 0 && (
          <div className="pt-1">
            <button
              type="button"
              onClick={() => setShowRemoved((v) => !v)}
              className="min-h-11 text-sm text-muted-foreground underline underline-offset-4"
            >
              {showRemoved ? "Hide" : "Show"} {removed.length} removed{" "}
              {removed.length === 1 ? "schedule" : "schedules"}
            </button>

            {showRemoved && (
              <ul className="mt-2 space-y-2">
                {removed.map((a) => (
                  <li
                    key={a.id}
                    className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed bg-muted/40 p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{a.employeeName}</p>
                      <p className="text-sm text-muted-foreground">
                        {a.shiftName} · {a.startTime}–{a.endTime} ·{" "}
                        {formatDays(a.daysOfWeek)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Removed · past attendance records are unaffected
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={async () => {
                        const res = await fetch(
                          `/api/schedule/assignments/${a.id}/restore`,
                          { method: "POST" }
                        );
                        const data = await res.json().catch(() => null);
                        if (!res.ok) {
                          toast.error(
                            data?.error?.message ?? "That did not work."
                          );
                          return;
                        }
                        toast.success("Back on the roster.");
                        startTransition(() => router.refresh());
                      }}
                    >
                      {pending && <Loader2 className="size-4 animate-spin" />}
                      Restore
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {/* ─────────────────────────── leave ─────────────────────────── */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Leave</h2>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setLeaveFor(leaveFor ? null : (staff[0] ?? null))}
          >
            <Plus className="size-4" />
            Record leave
          </Button>
        </div>

        {leaveFor && (
          <LeaveForm
            staff={staff}
            onDone={() => setLeaveFor(null)}
            post={post}
          />
        )}

        {initialLeave.length === 0 ? (
          <p className="rounded-xl border p-4 text-sm text-muted-foreground">
            Nobody is on leave. Recording leave stops the clock-in prompt for
            those dates and keeps them off the roster, without touching their
            recurring schedule.
          </p>
        ) : (
          <ul className="space-y-2">
            {initialLeave.map((l) => (
              <li
                key={l.id}
                className={cn(
                  "flex flex-wrap items-center gap-3 rounded-xl border p-3",
                  l.isActiveToday && "border-amber-400 bg-amber-50"
                )}
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {l.employeeName}
                    {l.isActiveToday && (
                      <span className="ml-2 text-sm font-normal text-amber-800">
                        on leave now
                      </span>
                    )}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {l.startDate === l.endDate
                      ? l.startDate
                      : `${l.startDate} → ${l.endDate}`}{" "}
                    · {l.reason}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={async () => {
                    const res = await fetch(`/api/schedule/leave/${l.id}`, {
                      method: "DELETE",
                    });
                    const data = await res.json().catch(() => null);
                    if (!res.ok) {
                      toast.error(data?.error?.message ?? "That did not work.");
                      return;
                    }
                    toast.success("Leave cancelled. Their schedule resumes.");
                    startTransition(() => router.refresh());
                  }}
                >
                  {pending && <Loader2 className="size-4 animate-spin" />}
                  Cancel
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/*
        Remove confirmation. Deliberately NOT a ReasonDialog: removing a
        schedule is a structural change, not an exception that needs explaining
        in a report — and the thing worth showing is what it does to the record
        plus the better tool for a temporary absence.
      */}
      <Dialog
        open={removingRow !== null}
        onOpenChange={(open) => !open && setRemovingRow(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove this schedule?</DialogTitle>
            {removingRow && (
              <DialogDescription>
                {removingRow.employeeName} · {removingRow.shiftName} ·{" "}
                {formatDays(removingRow.daysOfWeek)}
              </DialogDescription>
            )}
          </DialogHeader>

          <div className="space-y-3 text-sm">
            <div className="rounded-xl border-2 border-amber-400 bg-amber-50 p-3 text-amber-950">
              <p className="font-semibold">Is this a holiday or time off?</p>
              <p className="mt-1">
                Then close this and use <strong>Record leave</strong> instead.
                Leave ends by itself and the schedule comes back — removing it
                does not.
              </p>
            </div>

            <p className="text-muted-foreground">
              Use Remove when{" "}
              {removingRow?.employeeName ?? "this person"} no longer works this
              shift. It disappears from the roster, but{" "}
              <strong>every past attendance record stays exactly as it is</strong>
              , including any late marks. You can restore it if you change your
              mind.
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setRemovingRow(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={async () => {
                if (!removingRow) return;
                const res = await fetch(
                  `/api/schedule/assignments/${removingRow.id}`,
                  { method: "DELETE" }
                );
                const data = await res.json().catch(() => null);
                if (!res.ok) {
                  toast.error(data?.error?.message ?? "That did not work.");
                  return;
                }
                toast.success("Removed from the roster.");
                setRemovingRow(null);
                startTransition(() => router.refresh());
              }}
            >
              {pending && <Loader2 className="size-4 animate-spin" />}
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ReasonDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="Take them off this shift?"
        description={
          removing
            ? `${removing.slot.employeeName} · ${removing.slot.shiftName} · ${removing.day}`
            : undefined
        }
        consequence="This changes only that one date. Their recurring schedule stays exactly as it is."
        label="Why?"
        placeholder="e.g. Annual leave"
        confirmLabel="Take off"
        minLength={3}
        maxLength={200}
        onConfirm={async (reason) => {
          if (!removing) return;
          const ok = await post(
            `/api/shops/${shopId}/schedule/overrides`,
            {
              userId: removing.slot.userId,
              shiftId: removing.slot.shiftId,
              businessDate: removing.day,
              kind: "REMOVED",
              reason,
            },
            `${removing.slot.employeeName} taken off ${removing.day}.`
          );
          if (ok) setRemoving(null);
        }}
      />
    </div>
  );
}

/**
 * Edit a saved recurring schedule (§4.14.1).
 *
 * **Days only.** Dates were removed in D-140: the owner never wanted to type a
 * from/until, and having them meant two different ways to express "this
 * schedule has stopped" — an end date and a removal — which could disagree.
 * A start date is still stored (defaulted to the day the row was created), so
 * "was this person scheduled last Monday?" stays answerable; nothing edits it.
 *
 * The employee and the shift are also fixed. Changing either would turn one
 * person's history into another's — every past date the pattern governed would
 * start resolving to a different name. Remove and re-add instead.
 */
function EditAssignment({
  assignment,
  shift,
  onDone,
  patch,
}: {
  assignment: Assignment;
  shift: Shift | undefined;
  onDone: () => void;
  patch: (url: string, body: unknown, ok: string) => Promise<boolean>;
}) {
  const [days, setDays] = useState<number[]>(assignment.daysOfWeek);
  const [saving, setSaving] = useState(false);

  // Same rule as the create form: only days this shift actually runs. If the
  // shift has since been retired it is not in the list, so fall back to what
  // the assignment already holds rather than blanking every button.
  const selectableDays = shift?.daysOfWeek ?? assignment.daysOfWeek;

  return (
    <div className="mt-3 w-full space-y-3 rounded-xl border bg-muted/40 p-3">
      <div className="space-y-1">
        <span className="text-sm font-medium">Days</span>
        <div className="flex flex-wrap gap-1.5">
          {DAY_PICKER.map((day) => {
            const label = DAY_SHORT[day];
            const available = selectableDays.includes(day);
            const on = days.includes(day);
            return (
              <button
                key={label}
                type="button"
                disabled={!available}
                title={
                  available
                    ? undefined
                    : `${assignment.shiftName} does not run on ${label}`
                }
                onClick={() =>
                  setDays((d) =>
                    d.includes(day)
                      ? d.filter((value) => value !== day)
                      : [...d, day]
                  )
                }
                className={cn(
                  "min-h-11 min-w-11 rounded-xl border px-3 text-sm",
                  on && "border-primary bg-primary text-primary-foreground",
                  !available && "cursor-not-allowed opacity-40"
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={saving || days.length === 0}
          onClick={async () => {
            setSaving(true);
            const ok = await patch(
              `/api/schedule/assignments/${assignment.id}`,
              { daysOfWeek: days },
              "Schedule updated."
            );
            setSaving(false);
            if (ok) onDone();
          }}
        >
          {saving && <Loader2 className="size-4 animate-spin" />}
          Save changes
        </Button>
        <Button variant="outline" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        To move {assignment.employeeName} to a different shift, remove this
        entry and add a new one — that keeps past dates resolving correctly.
      </p>
    </div>
  );
}

/**
 * Record a period of leave (§4.14.2).
 *
 * **Business-wide by default** — no shop picker. Somebody on holiday is away
 * from every branch they work at, not just the one whose roster you happen to
 * be looking at, and the per-branch case is rare enough that asking about it
 * every time would be noise. The service accepts a `shopId` for when it is
 * genuinely needed.
 */
function LeaveForm({
  staff,
  onDone,
  post,
}: {
  staff: Staff[];
  onDone: () => void;
  post: (url: string, body: unknown, ok: string) => Promise<boolean>;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [userId, setUserId] = useState(staff[0]?.userId ?? "");
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const badRange = endDate < startDate;

  return (
    <div className="space-y-3 rounded-xl border p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1">
          <span className="text-sm font-medium">Employee</span>
          <select
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            className="min-h-11 w-full rounded-xl border px-3"
          >
            {staff.map((s) => (
              <option key={s.userId} value={s.userId}>
                {s.name}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1">
          <span className="text-sm font-medium">From</span>
          <input
            type="date"
            value={startDate}
            onChange={(e) => {
              setStartDate(e.target.value);
              // Keep the range valid as you type rather than waiting to
              // reject it: a single day off is the same date twice.
              if (endDate < e.target.value) setEndDate(e.target.value);
            }}
            className="min-h-11 w-full rounded-xl border px-3"
          />
        </label>

        <label className="space-y-1">
          <span className="text-sm font-medium">Until</span>
          <input
            type="date"
            value={endDate}
            min={startDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="min-h-11 w-full rounded-xl border px-3"
          />
        </label>
      </div>

      <label className="block space-y-1">
        <span className="text-sm font-medium">Reason</span>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Annual leave"
          maxLength={200}
          className="min-h-11 w-full rounded-xl border px-3"
        />
      </label>

      {badRange && (
        <p className="text-sm text-destructive">
          The end date cannot be before the start date.
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        Applies at every branch this person works at. They will not be prompted
        to clock in on these dates and will not be marked late — but they can
        still clock in if they come in to cover.
      </p>

      <div className="flex gap-2">
        <Button
          disabled={
            saving || !userId || reason.trim().length < 3 || badRange
          }
          onClick={async () => {
            setSaving(true);
            const ok = await post(
              "/api/schedule/leave",
              { userId, startDate, endDate, reason: reason.trim() },
              "Leave recorded."
            );
            setSaving(false);
            if (ok) onDone();
          }}
        >
          {saving && <Loader2 className="size-4 animate-spin" />}
          Save
        </Button>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Add someone to one specific date — an `ADDED` override, always with a reason. */
function AddForDay({
  shopId,
  date,
  shifts,
  staff,
  post,
}: {
  shopId: string;
  date: string;
  shifts: Shift[];
  staff: Staff[];
  post: (url: string, body: unknown, ok: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState("");
  const [shiftId, setShiftId] = useState("");
  const [reason, setReason] = useState("");

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 w-full rounded-lg border border-dashed py-1 text-xs text-muted-foreground hover:bg-muted"
      >
        + Add
      </button>
    );
  }

  return (
    <div className="mt-2 space-y-1.5">
      <select
        value={userId}
        onChange={(e) => setUserId(e.target.value)}
        className="w-full rounded-lg border px-1.5 py-1 text-xs"
      >
        <option value="">Who…</option>
        {staff.map((s) => (
          <option key={s.userId} value={s.userId}>
            {s.name}
          </option>
        ))}
      </select>
      <select
        value={shiftId}
        onChange={(e) => setShiftId(e.target.value)}
        className="w-full rounded-lg border px-1.5 py-1 text-xs"
      >
        <option value="">Shift…</option>
        {shifts.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name} {s.startTime}
          </option>
        ))}
      </select>
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason"
        maxLength={200}
        className="w-full rounded-lg border px-1.5 py-1 text-xs"
      />
      <div className="flex gap-1">
        <button
          type="button"
          disabled={!userId || !shiftId || reason.trim().length < 3}
          onClick={async () => {
            const ok = await post(
              `/api/shops/${shopId}/schedule/overrides`,
              {
                userId,
                shiftId,
                businessDate: date,
                kind: "ADDED",
                reason: reason.trim(),
              },
              `Added for ${date}.`
            );
            if (ok) {
              setOpen(false);
              setUserId("");
              setShiftId("");
              setReason("");
            }
          }}
          className="flex-1 rounded-lg bg-primary px-1.5 py-1 text-xs text-primary-foreground disabled:opacity-50"
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-lg border px-1.5 py-1 text-xs"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The recurring-pattern form. */
function AssignmentForm({
  shopId,
  shifts,
  staff,
  fixedShift,
  onDone,
  post,
}: {
  shopId: string;
  shifts: Shift[];
  staff: Staff[];
  fixedShift?: Shift;
  onDone: () => void;
  post: (url: string, body: unknown, ok: string) => Promise<boolean>;
}) {
  const [userId, setUserId] = useState("");
  const [shiftId, setShiftId] = useState(fixedShift?.id ?? "");
  const [days, setDays] = useState<number[]>([]);

  const shift = fixedShift ?? shifts.find((s) => s.id === shiftId);
  // The assignment selects from WITHIN the shift's operating days, so a day the
  // branch does not run this shift is not offered at all. The server enforces
  // the same rule — this only turns a rejection into an absence.
  const selectableDays = shift?.daysOfWeek ?? [];

  return (
    <div className="space-y-3 rounded-xl border p-4">
      <div className={cn("grid gap-3", fixedShift ? "sm:grid-cols-1" : "sm:grid-cols-2")}>
        <label className="space-y-1">
          <span className="text-sm font-medium">Employee</span>
          <select
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            className="min-h-11 w-full rounded-xl border px-3"
          >
            <option value="">Choose…</option>
            {staff.map((s) => (
              <option key={s.userId} value={s.userId}>
                {s.name} ({s.role.toLowerCase()})
              </option>
            ))}
          </select>
        </label>

        {!fixedShift && (
          <label className="space-y-1">
            <span className="text-sm font-medium">Shift</span>
            <select
              value={shiftId}
              onChange={(e) => {
                setShiftId(e.target.value);
                // Days that the previous shift ran but this one does not would
                // silently fail on save, so the selection resets with the shift.
                setDays([]);
              }}
              className="min-h-11 w-full rounded-xl border px-3"
            >
              <option value="">Choose…</option>
              {shifts.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.startTime}–{s.endTime}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="space-y-1">
        <span className="text-sm font-medium">Days</span>
        {!shift ? (
          <p className="text-sm text-muted-foreground">
            Choose a shift first — a person can only be rostered on days that
            shift actually runs.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {DAY_PICKER.map((day) => {
              const label = DAY_SHORT[day];
              const available = selectableDays.includes(day);
              const on = days.includes(day);
              return (
                <button
                  key={label}
                  type="button"
                  disabled={!available}
                  title={
                    available
                      ? undefined
                      : `${shift.name} does not run on ${label}`
                  }
                  onClick={() =>
                    setDays((d) =>
                    d.includes(day)
                      ? d.filter((value) => value !== day)
                      : [...d, day]
                    )
                  }
                  className={cn(
                    "min-h-11 min-w-11 rounded-xl border px-3 text-sm",
                    on && "border-primary bg-primary text-primary-foreground",
                    !available && "cursor-not-allowed opacity-40"
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <Button
          disabled={!userId || !shiftId || days.length === 0}
          onClick={async () => {
            const ok = await post(
              `/api/shops/${shopId}/schedule`,
              // No dates: the service starts it today (D-140). The owner
              // never wanted to type a from/until, and a schedule that begins
              // when you create it is what "add to the roster" already means.
              { userId, shiftId, daysOfWeek: days },
              `Added to ${shift?.name ?? "the"} roster.`
            );
            if (ok) onDone();
          }}
        >
          Save
        </Button>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
