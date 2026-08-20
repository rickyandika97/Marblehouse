"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ArrowRight, Loader2, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Handoff = {
  shopId: string;
  shopName: string;
  shiftName: string;
  startTime: string;
};

/**
 * Same-day branch handoff for split-shift staff.
 *
 * The target is server-resolved from the timetable, never supplied by the
 * browser. Tapping it changes the active work-session shop; it is explicitly
 * not an attendance clock-in.
 */
export function ShopHandoffBanner() {
  const pathname = usePathname();
  const router = useRouter();
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [reason, setReason] = useState("");
  const [reasonRequired, setReasonRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/work-session/handoff");
        const data = response.ok ? await response.json() : null;
        if (!cancelled) setHandoff(data?.handoff ?? null);
      } catch {
        // A missing handoff must never stop ordinary work.
      }
    };

    void load();
    const timer = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pathname]);

  async function switchShop() {
    if (!handoff || pending || (reasonRequired && !reason.trim())) return;
    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/work-session", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopId: handoff.shopId,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        }),
      });
      const body = await response.json();

      if (!response.ok) {
        const count = body?.error?.details?.recordsAtOldShop;
        if (typeof count === "number") setReasonRequired(true);
        setError(body?.error?.message ?? "Could not switch your shop.");
        setPending(false);
        return;
      }

      setHandoff(null);
      // Sale may already be the current route, so pathname alone will not make
      // the attendance banner refetch. Notify it as soon as the server has
      // committed the new work session.
      window.dispatchEvent(new Event("work-session-changed"));
      // The handoff has put the person at their next operational branch. Land
      // on Sale so they immediately see the destination's work surface and,
      // when still unclocked, the attendance prompt below this handoff.
      router.replace("/sale");
      router.refresh();
    } catch {
      setError("Cannot reach the server. Check the shop's internet connection.");
      setPending(false);
    }
  }

  if (!handoff) return null;

  return (
    <section className="sticky top-14 z-30 border-b-4 border-amber-700 bg-amber-400 px-4 py-4 text-amber-950 shadow-sm">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <MapPin className="mt-1 size-6 shrink-0" aria-hidden />
          <div>
            <p className="text-sm font-bold uppercase tracking-wide">Your next shift is at</p>
            <p className="text-3xl font-black leading-tight sm:text-4xl">{handoff.shopName}</p>
            <p className="mt-1 text-sm font-medium">
              {handoff.shiftName} · starts {handoff.startTime}
            </p>
          </div>
        </div>
        <Button size="xl" onClick={switchShop} disabled={pending || (reasonRequired && !reason.trim())}>
          {pending ? <Loader2 className="animate-spin" /> : <ArrowRight />}
          Switch to {handoff.shopName}
        </Button>
      </div>

      {reasonRequired && (
        <div className="mx-auto mt-3 w-full max-w-5xl rounded-lg border border-amber-800/40 bg-amber-100 p-3">
          <Label htmlFor="handoff-reason">Why are you moving branches?</Label>
          <Input
            id="handoff-reason"
            className="mt-2 bg-background"
            autoFocus
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. evening shift at the other branch"
          />
        </div>
      )}

      {error && <p role="alert" className="mx-auto mt-3 max-w-5xl text-sm font-semibold">{error}</p>}
    </section>
  );
}
