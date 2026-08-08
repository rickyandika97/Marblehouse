"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MapPinOff, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ReasonDialog } from "@/components/reason-dialog";
import { cn } from "@/lib/utils";

interface Row {
  id: string;
  businessDate: string;
  clockInAt: string;
  clockOutAt: string | null;
  isLate: boolean;
  lateMinutes: number;
  status: string;
  locationDenied: boolean;
  photoUrl: string | null;
  photoPurged: boolean;
  note: string | null;
  user: { id: string; displayName: string };
  shop: { id: string; name: string; code: string };
  shift: { id: string; name: string } | null;
}

/**
 * Attendance history (§8.9).
 *
 * Late days are highlighted, and a record whose location was denied is marked
 * so the owner can see it at a glance — §4.13 asks for exactly that.
 */
export function AttendanceList({
  rows,
  canSeeTeam,
  canExcuse,
  selfUserId,
}: {
  rows: Row[];
  canSeeTeam: boolean;
  canExcuse: boolean;
  selfUserId: string;
}) {
  const router = useRouter();
  const [scope, setScope] = useState<"mine" | "team">("mine");
  const [open, setOpen] = useState<Row | null>(null);
  // Separate from `open`: the detail panel stays visible behind the dialog, so
  // the owner can still see the photo they are judging while typing the reason.
  const [excusing, setExcusing] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);

  const visible = rows.filter((r) =>
    scope === "mine" ? r.user.id === selfUserId : true
  );

  async function excuse(row: Row, note: string) {
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
                    {new Date(r.clockInAt).toLocaleTimeString("id-ID", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    {r.shift ? ` · ${r.shift.name}` : ""} · {r.shop.code}
                  </p>
                </div>

                {r.locationDenied && (
                  <MapPinOff
                    className="size-4 shrink-0 text-amber-600"
                    aria-label="Location unavailable"
                  />
                )}

                <span
                  className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
                    r.status === "EXCUSED" && "bg-muted text-muted-foreground",
                    r.status === "LATE" && "bg-red-100 text-red-900",
                    r.status === "PRESENT" && "bg-emerald-100 text-emerald-900"
                  )}
                >
                  {r.status === "LATE" ? `${r.lateMinutes} min late` : r.status}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {open && (
        <div className="space-y-3 rounded-xl border p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-semibold">{open.user.displayName}</p>
              <p className="text-sm text-muted-foreground">
                {open.businessDate} · {open.shop.name}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setOpen(null)}>
              Close
            </Button>
          </div>

          {open.photoPurged ? (
            <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
              The photo for this day passed its 61-day retention and was
              deleted. The attendance record itself is kept.
            </p>
          ) : open.photoUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={open.photoUrl}
              alt={`Clock-in photo for ${open.businessDate}`}
              className="w-full rounded-lg border"
            />
          ) : null}

          {open.note && <p className="text-sm">{open.note}</p>}

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
