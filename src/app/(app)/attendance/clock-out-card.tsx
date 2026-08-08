"use client";

import { useEffect, useState } from "react";
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
 * looked unfinished on the team screen. This is the caller.
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
 * The note is **optional** — `clockOutSchema` makes it optional and this must
 * not invent a requirement the server does not have. That is the opposite of
 * the reason dialogs in `components/reason-dialog.tsx`, where a void or a
 * cancel genuinely requires one, which is why this does not reuse that
 * component: its whole shape is "you may not confirm until the reason is long
 * enough", and here you always may.
 */
interface ClockOutState {
  clockedIn: boolean;
  record: {
    clockInAt: string;
    clockOutAt: string | null;
    shopName: string;
    shift: { id: string; name: string; endTime: string } | null;
  } | null;
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

export function ClockOutCard() {
  const router = useRouter();
  const [state, setState] = useState<ClockOutState | null>(null);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Ticks the elapsed label. Held in state rather than read at render time so
  // the number does not sit frozen at whatever it was when the page loaded.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    fetch("/api/attendance/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data) {
          setState({ clockedIn: data.clockedIn, record: data.record });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  async function clockOut() {
    setSubmitting(true);
    try {
      const response = await fetch("/api/attendance/clock-out", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Omitted entirely when blank — the schema treats the note as optional,
        // and sending "" would store an empty string rather than nothing.
        body: JSON.stringify(note.trim() === "" ? {} : { note: note.trim() }),
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
      setOpen(false);
      setNote("");
      setState((s) =>
        s?.record ? { ...s, record: { ...s.record, clockOutAt: body.clockOutAt } } : s
      );
      router.refresh();
    } catch {
      toast.error("No connection. Check the wifi and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // Nothing to offer until the server has answered, to someone who never
  // clocked in, or to someone already finished for the day.
  if (!state?.clockedIn || !state.record || state.record.clockOutAt) return null;

  const { record } = state;

  return (
    <>
      <section className="flex flex-wrap items-center gap-3 rounded-xl border bg-muted/30 p-4">
        <div className="min-w-0 flex-1">
          <p className="font-semibold">
            Clocked in {timeLabel(record.clockInAt)} · {record.shopName}
          </p>
          <p className="text-sm text-muted-foreground">
            On shift for {elapsedLabel(record.clockInAt, now)}
            {record.shift && ` · ${record.shift.name} ends ${record.shift.endTime}`}
          </p>
        </div>
        <Button size="lg" variant="outline" onClick={() => setOpen(true)}>
          <LogOut className="size-4" />
          Clock out
        </Button>
      </section>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setNote("");
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clock out?</DialogTitle>
            <DialogDescription>
              {timeLabel(record.clockInAt)} → now · on shift for{" "}
              {elapsedLabel(record.clockInAt, now)}
              {record.shift && ` · scheduled to ${record.shift.endTime}`}
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
              Leave it blank if there is nothing to say. Your clock-out time is
              recorded either way.
            </p>
          </div>

          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button onClick={clockOut} disabled={submitting}>
              {submitting && <Loader2 className="size-4 animate-spin" />}
              Clock out
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
