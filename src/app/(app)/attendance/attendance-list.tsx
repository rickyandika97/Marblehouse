"use client";

import { useState } from "react";
import Link from "next/link";
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
  myRows,
  teamRows,
  canSeeTeam,
  showMyAttendance,
  canExcuse,
  selfUserId,
  attention,
}: {
  myRows: AttendanceRecord[];
  teamRows: AttendanceRecord[];
  canSeeTeam: boolean;
  showMyAttendance: boolean;
  canExcuse: boolean;
  selfUserId: string;
  attention: {
    issue: "not-clocked-in" | "late";
    rows: AttendanceRecord[] | {
      userId: string;
      displayName: string;
      shop: { id: string; name: string; code: string };
    }[];
  } | null;
}) {
  const router = useRouter();
  const [scope, setScope] = useState<"mine" | "team">(
    showMyAttendance ? "mine" : "team"
  );
  const [open, setOpen] = useState<AttendanceRecord | null>(null);
  // Separate from `open`: the detail panel stays visible behind the dialog, so
  // the owner can still see the photo they are judging while typing the reason.
  const [excusing, setExcusing] = useState<AttendanceRecord | null>(null);
  const [busy, setBusy] = useState(false);

  const visible = scope === "mine" ? myRows : teamRows;

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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">Attendance</h1>
        {canSeeTeam && (
          <Link
            href="/attendance?view=report"
            className="inline-flex min-h-11 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted"
          >
            Attendance & lateness
          </Link>
        )}
      </div>

      {/* Renders nothing unless the viewer is clocked in and not yet out. */}
      <ClockOutCard />

      {attention && (
        <section className="rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/30">
          <h2 className="font-semibold text-amber-950 dark:text-amber-100">
            {attention.issue === "late"
              ? "Arrived late today"
              : "Not clocked in today"}
          </h2>
          <p className="mt-1 text-sm text-amber-900 dark:text-amber-200">
            {attention.issue === "late"
              ? "These clock-ins were recorded after their grace period."
              : "These assigned employees do not yet have a clock-in record."}
          </p>

          {attention.rows.length === 0 ? (
            <p className="mt-3 text-sm text-amber-900 dark:text-amber-200">
              This alert has cleared since the dashboard was loaded.
            </p>
          ) : attention.issue === "late" ? (
            <ul className="mt-3 divide-y divide-amber-200 rounded-lg border border-amber-200 bg-background dark:divide-amber-900 dark:border-amber-900">
              {(attention.rows as AttendanceRecord[]).map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => setOpen(row)}
                    className="flex w-full items-center justify-between gap-3 p-3 text-left hover:bg-muted"
                  >
                    <span>
                      <span className="block text-sm font-medium">{row.user.displayName}</span>
                      <span className="block text-xs text-muted-foreground">
                        {row.shop.name} · {clockRange(row.clockInAt, row.clockOutAt)}
                      </span>
                    </span>
                    <StatusPill record={row} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <ul className="mt-3 divide-y divide-amber-200 rounded-lg border border-amber-200 bg-background dark:divide-amber-900 dark:border-amber-900">
              {(attention.rows as {
                userId: string;
                displayName: string;
                shop: { id: string; name: string; code: string };
              }[]).map((row) => (
                <li key={`${row.shop.id}:${row.userId}`} className="p-3">
                  <p className="text-sm font-medium">{row.displayName}</p>
                  <p className="text-xs text-muted-foreground">
                    {row.shop.name} · {row.shop.code}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {(showMyAttendance || canSeeTeam) && (
        <div className="flex gap-1 border-b">
          {(
            [
              ...(showMyAttendance ? (["mine"] as const) : []),
              ...(canSeeTeam ? (["team"] as const) : []),
            ] as const
          ).map((s) => (
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
