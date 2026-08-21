"use client";

import { useState } from "react";
import { Check, ChevronDown, Loader2, Store } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface ShopSwitcherOption {
  id: string;
  code: string;
  name: string;
}

/**
 * The persistent shop switcher. A successful change refreshes the current
 * route, so inventory, sales, and other scoped pages remain open while their
 * server data is reloaded for the newly selected shop.
 */
export function ShopSwitcher({
  shops,
  currentShopId,
  currentShopName,
}: {
  shops: ShopSwitcherOption[];
  currentShopId: string | null;
  currentShopName: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [selectedShopId, setSelectedShopId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [reasonRequired, setReasonRequired] = useState(false);
  const [recordCount, setRecordCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedShop = shops.find((shop) => shop.id === selectedShopId) ?? null;

  function reset() {
    setSelectedShopId(null);
    setReason("");
    setReasonRequired(false);
    setRecordCount(null);
    setError(null);
  }

  async function switchShop(shopId: string, switchReason?: string) {
    if (shopId === currentShopId || pending) return;

    setPending(true);
    setError(null);

    try {
      const res = await fetch("/api/work-session", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopId,
          ...(switchReason?.trim() ? { reason: switchReason.trim() } : {}),
        }),
      });
      const body = await res.json();

      if (!res.ok) {
        const count = body?.error?.details?.recordsAtOldShop;
        setSelectedShopId(shopId);
        setReasonRequired(typeof count === "number");
        setRecordCount(typeof count === "number" ? count : null);
        setError(body?.error?.message ?? "Could not change your shop.");
        return;
      }

      setOpen(false);
      reset();
      router.refresh();
    } catch {
      setError("Cannot reach the server. Check the shop's internet connection.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen && !pending) reset();
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            className="flex min-h-11 min-w-0 items-center gap-2 rounded-full border border-border bg-background px-3 text-left shadow-sm transition-colors hover:border-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title="Change today's shop"
          />
        }
      >
        <Store className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate font-semibold">
          {currentShopName ?? "No shop selected"}
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </PopoverTrigger>

      <PopoverContent className="w-[min(22rem,calc(100vw-2rem))] p-2" align="start">
        <p className="px-2 pt-1 pb-2 text-sm font-medium">Switch shop</p>
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {shops.map((shop) => {
            const isCurrent = shop.id === currentShopId;
            const isSelected = shop.id === selectedShopId;

            return (
              <button
                key={shop.id}
                type="button"
                disabled={isCurrent || pending}
                onClick={() => {
                  setSelectedShopId(shop.id);
                  setReasonRequired(false);
                  setRecordCount(null);
                  setReason("");
                  switchShop(shop.id);
                }}
                className={cn(
                  "flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors",
                  isCurrent
                    ? "cursor-default bg-muted"
                    : "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isSelected && !isCurrent && "bg-accent"
                )}
              >
                <Store className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{shop.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {shop.code}{isCurrent && " · current shop"}
                  </span>
                </span>
                {isCurrent && <Check className="size-4 shrink-0 text-primary" aria-label="Current shop" />}
                {pending && isSelected && <Loader2 className="size-4 shrink-0 animate-spin" aria-label="Switching shop" />}
              </button>
            );
          })}
        </div>

        {reasonRequired && selectedShop && (
          <div className="mt-2 space-y-2 border-t px-2 pt-3">
            <p className="text-sm text-muted-foreground">
              You have already recorded {recordCount} {recordCount === 1 ? "item" : "items"} today. Those records stay at the current shop.
            </p>
            <Input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why are you moving shops?"
              autoFocus
            />
            <Button
              size="sm"
              className="w-full"
              disabled={pending || !reason.trim()}
              onClick={() => switchShop(selectedShop.id, reason)}
            >
              {pending && <Loader2 className="animate-spin" />}
              Switch to {selectedShop.name}
            </Button>
          </div>
        )}

        {error && !reasonRequired && (
          <p role="alert" className="mt-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
