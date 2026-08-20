"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Check, Loader2, Store } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export interface ShopOption {
  id: string;
  code: string;
  name: string;
}

/**
 * Settings → Shops, current-shop picker section (§4.7). Every role gets this;
 * only OWNER also gets the branch-administration section below it.
 *
 * Changing the shop does NOT move records already created today. When the
 * server reports that records exist under the old shop, it demands a reason —
 * we surface that inline rather than as a generic error, because the reason is
 * a real requirement, not a validation nuisance.
 */
export function ChangeShopForm({
  shops,
  currentShopId,
}: {
  shops: ShopOption[];
  currentShopId: string | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [selected, setSelected] = useState(currentShopId);
  const [reason, setReason] = useState("");
  const [reasonRequired, setReasonRequired] = useState(false);
  const [recordCount, setRecordCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const changed = selected !== currentShopId;

  async function submit() {
    if (!selected || !changed || pending) return;

    setPending(true);
    setError(null);

    try {
      const res = await fetch("/api/work-session", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopId: selected,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        }),
      });

      const body = await res.json();

      if (!res.ok) {
        const count = body?.error?.details?.recordsAtOldShop;
        if (typeof count === "number") {
          setReasonRequired(true);
          setRecordCount(count);
        }
        setError(body?.error?.message ?? "Could not change your shop.");
        setPending(false);
        return;
      }

      const next = searchParams.get("next");
      router.replace(next && next.startsWith("/") ? next : "/settings");
      router.refresh();
    } catch {
      setError("Cannot reach the server. Check the shop's internet connection.");
      setPending(false);
    }
  }

  return (
    <div className="space-y-6">
      <ul className="grid gap-3">
        {shops.map((shop) => {
          const isSelected = shop.id === selected;
          const isCurrent = shop.id === currentShopId;

          return (
            <li key={shop.id}>
              <button
                type="button"
                onClick={() => setSelected(shop.id)}
                aria-pressed={isSelected}
                className={cn(
                  "flex min-h-16 w-full items-center gap-4 rounded-xl border-2 p-4 text-left transition-colors",
                  isSelected
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-muted"
                )}
              >
                <span
                  className={cn(
                    "flex size-11 shrink-0 items-center justify-center rounded-lg",
                    isSelected
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground"
                  )}
                >
                  {isSelected ? (
                    <Check className="size-5" />
                  ) : (
                    <Store className="size-5" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">
                    {shop.name}
                  </span>
                  <span className="block text-sm text-muted-foreground">
                    {shop.code}
                    {isCurrent && " · where you are now"}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {reasonRequired && (
        <div className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/40">
          <Label htmlFor="reason">Why are you moving?</Label>
          {recordCount !== null && (
            <p className="text-sm text-amber-900 dark:text-amber-200">
              You have already recorded {recordCount}{" "}
              {recordCount === 1 ? "item" : "items"} today. Those stay with the
              shop they were recorded at — only new records move.
            </p>
          )}
          <Input
            id="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. covering the evening shift at Branch 2"
            autoFocus
          />
        </div>
      )}

      {error && !reasonRequired && (
        <p
          role="alert"
          className="rounded-lg bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive"
        >
          {error}
        </p>
      )}

      <Button
        size="xl"
        className="w-full"
        onClick={submit}
        disabled={!changed || pending || (reasonRequired && !reason.trim())}
      >
        {pending && <Loader2 className="animate-spin" />}
        {changed ? "Change my shop" : "This is your current shop"}
      </Button>
    </div>
  );
}
