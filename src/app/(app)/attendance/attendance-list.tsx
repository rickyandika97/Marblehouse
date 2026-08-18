"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MapPinOff, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ReasonDialog } from "@/components/reason-dialog";
import { ClockOutCard } from "./clock-out-card";
import {
  AttendanceRecordCard,
  StatusPill,
  clockRange,
  type AttendanceRecord,
} from "./attendance-record-card";
import { cn } from "@/lib/utils";

/**
 * Attendance history (§8.9).
 *
 * Late days are highlighted, and a record whose location was denied is marked
 * so the owner can see it at a glance — §4.13 asks for exactly that.
 *
 * The row shape, the clock range and the detail card live in
 * `attendance-record-card.tsx`, shared with the Attendance & Lateness report's
 * drill-in so the two renderings of a record cannot drift.
 */
export function AttendanceList({
  rows,
  canSeeTeam,
  canExcuse,
  selfUserId,
}: {
  rows: AttendanceRecord[];
  canSeeTeam: boolean;
  canExcuse: boolean;
  selfUserId: string;
}) {
  const router = useRouter();
  const [scope, setScope] = useState<"mine" | "team">("mine");
  const [open, setOpen] = useState<AttendanceRecord | null>(null);
  // Separate from `open`: the detail panel stays visible behind the dialog, so
  // the owner can still see the photo they are judging while typing the reason.
  const [excusing, setExcusing] = useState<AttendanceRecord | null>(null);
  const [busy, setBusy] = useState(false);

  const visible = rows.filter((r) =>
    scope === "mine" ? r.user.id === selfUserId : true
  );

  async function excuse(row: AttendanceRecord, note: string) {
    setBusy(true);
    try {
      const response = await fetch(`/api/attendance/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "EXCUSED", note }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        toast.error(body?.error?.message ?? "Could not excuse that record.");
        return;
      }
      toast.success("Excused — lateness cleared for that day.");
      setExcusing(null);
      setOpen(null);
      router.refresh();
    } catch {
      toast.error("No connection. Check the wifi and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">Attendance</h1>

      {/* Renders nothing unless the viewer is clocked in and not yet out. */}
      <ClockOutCard />

      {canSeeTeam && (
        <div className="flex gap-1 border-b">
          {(["mine", "team"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              aria-current={scope === s ? "page" : undefined}
              className={cn(
                "min-h-12 shrink-0 border-b-2 px-4 text-sm font-medium",
                scope === s
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {s === "mine" ? "My attendance" : "Team"}
            </button>
          ))}
        </div>
      )}

      {visible.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          No attendance recorded yet.
        </p>
      ) : (
        <ul className="divide-y rounded-xl border">
          {visible.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => setOpen(r)}
                className="flex w-full items-center gap-3 p-3 text-left hover:bg-muted"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {scope === "team" ? r.user.displayName : r.businessDate}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {scope === "team" ? `${r.businessDate} · ` : ""}
                    {/* Showing the range rather than the clock-in alone: a
                        shift with no clock-out is what the debt entry called
                        "looks unfinished", and it should be visible as such
                        rather than indistinguishable from a completed one. */}
                    {clockRange(r.clockInAt, r.clockOutAt)}
                    {r.shift ? ` · ${r.shift.name}` : ""} · {r.shop.code}
                  </p>
                </div>

                {r.locationDenied && (
                  <MapPinOff
                    className="size-4 shrink-0 text-amber-600"
                    aria-label="Location unavailable"
                  />
                )}

                <StatusPill record={r} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {open && (
        <div className="rounded-xl border p-4">
          <AttendanceRecordCard
            record={open}
            actions={
              <div className="space-y-3">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => setOpen(null)}
                >
                  Close
                </Button>

                {canExcuse && open.status !== "EXCUSED" && (
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => setExcusing(open)}
                    disabled={busy}
                  >
                    {busy && <Loader2 className="size-4 animate-spin" />}
                    Excuse this record
                  </Button>
                )}
              </div>
            }
          />
        </div>
      )}

      {/* The server accepts an excuse with no note (`editAttendanceSchema` makes
          it optional), so the 3-character minimum here is a UI rule rather than
          a mirrored one — an excuse with a blank reason tells the owner nothing
          when they read it back. See the note in ReasonDialog. */}
      <ReasonDialog
        open={excusing !== null}
        onOpenChange={(next) => {
          if (!next) setExcusing(null);
        }}
        title="Excuse this record?"
        description={
          excusing
            ? `${excusing.user.displayName} · ${excusing.businessDate}${
                excusing.isLate ? ` · ${excusing.lateMinutes} min late` : ""
              }`
            : undefined
        }
        consequence="The record is kept and the lateness is cleared for that day, so it stops counting towards the late rate. The original clock-in time and photo are unchanged."
        label="Why is it being excused?"
        placeholder="Approved late start — hospital appointment"
        helpText="At least 3 characters. This is recorded on the attendance record."
        confirmLabel="Excuse record"
        confirmVariant="default"
        submitting={busy}
        onConfirm={(note) => {
          if (excusing) return excuse(excusing, note);
        }}
      />
    </div>
  );
}
