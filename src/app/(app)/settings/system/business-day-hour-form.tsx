"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * §8.10's business-day start hour.
 *
 * **Two-step, and deliberately so.** Every other setting on this screen saves
 * on one tap. This one asks for confirmation first, because it is the only
 * control here that changes what past and future data *mean* rather than what
 * the app does next: `businessDate` is stamped once and never recalculated
 * (D-18), so changing the hour puts a permanent seam in the reporting history.
 *
 * The confirmation names that consequence in full rather than asking a bare
 * "are you sure?", which trains people to tap through.
 */
const HOURS = Array.from({ length: 24 }, (_, h) => h);

function label(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

export function BusinessDayHourForm({ initial }: { initial: number }) {
  const router = useRouter();
  const [value, setValue] = useState(initial);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const key = useRef(crypto.randomUUID());

  const changed = value !== initial;

  async function save() {
    setSaving(true);
    try {
      const response = await fetch("/api/settings/business-day-start-hour", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": key.current,
        },
        body: JSON.stringify({ hour: value }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(body?.error?.message ?? "Could not save that hour.");
        return;
      }
      key.current = crypto.randomUUID();
      setConfirming(false);
      toast.success(`The business day now starts at ${label(body.hour)}.`);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Business-day start hour</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Which reporting day a record is filed under. A sale at 01:00 belongs
          to the previous day when the cutoff is {label(initial)}. This is one
          global setting for every branch — it is not opening hours, which are
          per-branch and set as shifts.
        </p>

        <div className="flex max-w-md items-center gap-3">
          <select
            className="h-12 min-w-32 rounded-md border bg-background px-3 text-sm"
            value={value}
            onChange={(e) => {
              setValue(Number(e.target.value));
              setConfirming(false);
            }}
          >
            {HOURS.map((h) => (
              <option key={h} value={h}>
                {label(h)}
              </option>
            ))}
          </select>

          {!confirming ? (
            <Button disabled={!changed} onClick={() => setConfirming(true)}>
              Change…
            </Button>
          ) : (
            <>
              <Button disabled={saving} onClick={save}>
                {saving ? "Saving…" : "Yes, change it"}
              </Button>
              <Button
                variant="ghost"
                disabled={saving}
                onClick={() => {
                  setValue(initial);
                  setConfirming(false);
                }}
              >
                Cancel
              </Button>
            </>
          )}
        </div>

        {confirming && (
          <div className="flex gap-3 rounded-md border border-amber-600/50 bg-amber-50 p-3 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <p className="text-sm leading-relaxed">
              Moving the cutoff from {label(initial)} to {label(value)} affects
              only records created from now on.{" "}
              <strong>Existing records are not re-filed.</strong> Reports either
              side of today will be built on different definitions of a day, and
              nothing in the app will mark where that boundary falls.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
