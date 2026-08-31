"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, LogOut } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Clock out (§4.13, Phase 10).
 *
 * `POST /api/attendance/clock-out` has existed and been tested since Phase 6
 * with nothing calling it, so a shift could be started but never finished and
 * looked unfinished on the team screen. This is the caller. It deliberately
 * lists every open record, not just today's: a forgotten clock-out must remain
 * actionable after the business date changes.
 *
 * **It lives on /attendance and nowhere else, and there is deliberately no
 * second banner.** §4.13 specifies exactly one banner — the red clock-in one —
 * and a persistent amber "still clocked in" bar would compete with it for the
 * same strip of screen while eating vertical space the sale screen needs (§8.11
 * wants that screen usable without scrolling on a 10" tablet). What replaces the
 * nag is information: the card shows the shift's scheduled end time, so someone
 * can see at a glance whether they are leaving early or late without being
 * chased about it.
 *
 * The note is optional for an ordinary clock-out. Once a record has remained
 * open for twelve hours past its scheduled end, the API requires both a reason
 * and an explicitly confirmed time, because recording "now" would invent a
 * fictitious shift length.
 */
interface ClockOutState {
  openRecords: {
    id: string;
    businessDate: string;
    clockInAt: string;
    shopName: string;
    requiresReasonAndTimeConfirmation: boolean;
    shift: { id: string; name: string; endTime: string } | null;
  }[];
}

/** "7h 14m" — how long they have been on shift, from the server's clock-in. */
function elapsedLabel(fromIso: string, now: number): string {
  const mins = Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dateTimeLabel(iso: string): string {
  return new Date(iso).toLocaleString("id-ID", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function toDateTimeLocal(instant: Date): string {
  const offset = instant.getTimezoneOffset() * 60_000;
  return new Date(instant.getTime() - offset).toISOString().slice(0, 16);
}

export function ClockOutCard() {
  const router = useRouter();
  const [state, setState] = useState<ClockOutState | null>(null);
  const [record, setRecord] = useState<ClockOutState["openRecords"][number] | null>(null);
  const [note, setNote] = useState("");
  const [confirmedClockOutAt, setConfirmedClockOutAt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Ticks the elapsed label. Held in state rather than read at render time so
  // the number does not sit frozen at whatever it was when the page loaded.
  const [now, setNow] = useState(() => Date.now());

  /** Open the confirm dialog for one record and consume the deep-link hash. */
  const openFor = useCallback((row: ClockOutState["openRecords"][number]) => {
    setRecord(row);
    setConfirmedClockOutAt(toDateTimeLocal(new Date()));
    // Consume the fragment so a refresh, or Back into this page, does not
    // reopen a dialog the person deliberately cancelled.
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/attendance/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const openRecords: ClockOutState["openRecords"] = data.openRecords ?? [];
        setState({ openRecords });

        /**
         * Opened from the §4.13 end-of-shift banner (D-172).
         *
         * The banner is a link, not a submitter, so without this the tap only
         * lands on /attendance and the person still has to find the card —
         * which read as "the button does nothing". Resolved here rather than
         * on mount because the fragment names a record we have not fetched
         * yet; an id that no longer matches an open row (already clocked out
         * in another tab) simply opens nothing.
         */
        const match = /^#clock-out=(.+)$/.exec(window.location.hash);
        if (!match) return;
        const wanted = openRecords.find((row) => row.id === match[1]);
        if (!wanted) return;

        openFor(wanted);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [openFor]);

  /**
   * Tapping the banner while ALREADY on /attendance changes only the hash, so
   * the page does not remount and the fetch effect above never re-runs. Without
   * this the second tap is the dead one — the same symptom in a narrower case.
   */
  useEffect(() => {
    const onHashChange = () => {
      const match = /^#clock-out=(.+)$/.exec(window.location.hash);
      if (!match) return;
      const wanted = state?.openRecords.find((row) => row.id === match[1]);
      if (wanted) openFor(wanted);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [state, openFor]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  async function clockOut() {
    if (!record) return;
    setSubmitting(true);
    try {
      const response = await fetch("/api/attendance/clock-out", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Omitted entirely when blank — the schema treats the note as optional,
        // and sending "" would store an empty string rather than nothing.
        body: JSON.stringify({
          attendanceId: record.id,
          ...(note.trim() === "" ? {} : { note: note.trim() }),
          ...(record.requiresReasonAndTimeConfirmation && confirmedClockOutAt
            ? { clockOutAt: new Date(confirmedClockOutAt).toISOString() }
            : {}),
        }),
      });
      const body = await response.json().catch(() => null);

      if (!response.ok) {
        toast.error(body?.error?.message ?? "Could not clock out.");
        return;
      }

      toast.success(
        body?.clockOutAt
          ? `Clocked out at ${timeLabel(body.clockOutAt)}.`
          : "Clocked out."
      );
      // Let the app-wide reminder disappear immediately instead of waiting for
      // its minute refresh interval.
      window.dispatchEvent(new Event("attendance-changed"));
      setRecord(null);
      setNote("");
      setConfirmedClockOutAt("");
      setState((s) =>
        s
          ? { ...s, openRecords: s.openRecords.filter((row) => row.id !== record.id) }
          : s
      );
      router.refresh();
    } catch {
      toast.error("No connection. Check the wifi and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // A split-shift employee can have more than one open attendance record.
  // Each card chooses its exact row, so clocking out at PIK cannot close MKG.
  if (!state?.openRecords.length) return null;

  return (
    <>
      {state.openRecords.map((openRecord, index) => (
        <section
          key={openRecord.id}
          id={index === 0 ? "clock-out" : undefined}
          className="flex flex-wrap items-center gap-3 rounded-xl border bg-muted/30 p-4"
        >
          <div className="min-w-0 flex-1">
            <p className="font-semibold">
              Clocked in {dateTimeLabel(openRecord.clockInAt)} · {openRecord.shopName}
            </p>
            <p className="text-sm text-muted-foreground">
              On shift for {elapsedLabel(openRecord.clockInAt, now)}
              {openRecord.shift && ` · ${openRecord.shift.name} ends ${openRecord.shift.endTime}`}
            </p>
            {openRecord.requiresReasonAndTimeConfirmation && (
              <p className="mt-1 text-sm font-medium text-amber-700">
                Overdue clock-out — reason and actual finish time required.
              </p>
            )}
          </div>
          <Button
            size="lg"
            variant="outline"
            onClick={() => {
              setRecord(openRecord);
              setConfirmedClockOutAt(toDateTimeLocal(new Date()));
            }}
          >
            <LogOut className="size-4" />
            Clock out
          </Button>
        </section>
      ))}

      <Dialog
        open={record !== null}
        onOpenChange={(next) => {
          if (!next) {
            setRecord(null);
            setNote("");
            setConfirmedClockOutAt("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clock out?</DialogTitle>
            <DialogDescription>
              {record && (
                <>
                  {timeLabel(record.clockInAt)} → now · on shift for{" "}
                  {elapsedLabel(record.clockInAt, now)}
                  {record.shift && ` · scheduled to ${record.shift.endTime}`}
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1">
            <label htmlFor="clock-out-note" className="text-sm font-medium">
              Anything to note?{" "}
              <span className="text-muted-foreground">(optional)</span>
            </label>
            <Input
              id="clock-out-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Left early — dentist appointment"
              maxLength={500}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && !submitting) {
                  e.preventDefault();
                  void clockOut();
                }
              }}
            />
            <p className="text-xs text-muted-foreground">
              {record?.requiresReasonAndTimeConfirmation
                ? "Required because this record has been open for more than 12 hours after its scheduled end."
                : "Leave it blank if there is nothing to say. Your clock-out time is recorded either way."}
            </p>
          </div>

          {record?.requiresReasonAndTimeConfirmation && (
            <div className="space-y-1">
              <label htmlFor="confirmed-clock-out-at" className="text-sm font-medium">
                Actual clock-out time
              </label>
              <Input
                id="confirmed-clock-out-at"
                type="datetime-local"
                value={confirmedClockOutAt}
                onChange={(e) => setConfirmedClockOutAt(e.target.value)}
                min={toDateTimeLocal(new Date(record.clockInAt))}
                max={toDateTimeLocal(new Date())}
                required
              />
              <p className="text-xs text-muted-foreground">
                Confirm when you actually finished this shift.
              </p>
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setRecord(null)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              onClick={clockOut}
              disabled={
                submitting ||
                (record?.requiresReasonAndTimeConfirmation === true &&
                  (note.trim().length < 3 || confirmedClockOutAt === ""))
              }
            >
              {submitting && <Loader2 className="size-4 animate-spin" />}
              {record?.requiresReasonAndTimeConfirmation ? "Confirm clock out" : "Clock out"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
