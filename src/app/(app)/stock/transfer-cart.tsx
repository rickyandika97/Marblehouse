"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { PrizeDTO } from "@/server/dto/prize";

/**
 * Building and sending a branch transfer (D-156).
 *
 * Two changes from the single-item form this replaces:
 *
 * 1. **A cart.** `dispatchTransferSchema` has always accepted up to 100 lines;
 *    only the UI was one-item-at-a-time, so a box carrying five prize types
 *    became five transfer records the receiving branch confirmed separately.
 *    One physical box should be one record.
 *
 * FIFO allocation remains server-owned: dispatch selects the oldest lots
 * inside its transaction, so a sender cannot cherry-pick a cheaper cost basis.
 */

interface CartLine {
  prizeItemId: string;
  qty: number;
}

export interface Destination {
  id: string;
  name: string;
  code: string;
}

export interface TransferSourceShop extends Destination {
  prizes: PrizeDTO[];
}

export function TransferCart({
  initialFromShopId,
  initialPrizeItemId,
  sourceShops,
  destinations,
  onSent,
}: {
  initialFromShopId: string;
  initialPrizeItemId?: string;
  sourceShops: TransferSourceShop[];
  destinations: Destination[];
  onSent?: () => void;
}) {
  const router = useRouter();
  const [fromShopId, setFromShopId] = useState(initialFromShopId);
  const [toShopId, setToShopId] = useState("");
  const [lines, setLines] = useState<CartLine[]>([]);
  const [prizeItemId, setPrizeItemId] = useState(initialPrizeItemId ?? "");
  const [qty, setQty] = useState("");
  const [busy, setBusy] = useState(false);

  const sourceShop =
    sourceShops.find((shop) => shop.id === fromShopId) ?? sourceShops[0];
  const sourcePrizes = sourceShop?.prizes.filter((prize) => prize.onHand > 0) ?? [];
  const byId = new Map(sourcePrizes.map((p) => [p.id, p]));
  const availableDestinations = destinations.filter((shop) => shop.id !== sourceShop?.id);
  const parsedQty = Number(qty);
  const canAdd =
    prizeItemId !== "" && Number.isInteger(parsedQty) && parsedQty > 0;

  function addLine() {
    if (!canAdd) return;
    // The service rejects a duplicated prize outright, so combine here rather
    // than letting the user build a cart that cannot be sent.
    setLines((prev) => {
      const existing = prev.find((l) => l.prizeItemId === prizeItemId);
      return existing
        ? prev.map((l) =>
            l.prizeItemId === prizeItemId ? { ...l, qty: l.qty + parsedQty } : l
          )
        : [...prev, { prizeItemId, qty: parsedQty }];
    });
    setPrizeItemId("");
    setQty("");
  }

  function removeLine(id: string) {
    setLines((prev) => prev.filter((l) => l.prizeItemId !== id));
  }

  function changeSource(nextFromShopId: string) {
    setFromShopId(nextFromShopId);
    // A cart is always one physical box from one branch; line stock must not
    // survive changing the branch underneath it.
    setLines([]);
    setPrizeItemId("");
    setQty("");
    setToShopId((current) => (current === nextFromShopId ? "" : current));
  }

  async function send() {
    if (!sourceShop || !toShopId || lines.length === 0) return;
    setBusy(true);
    try {
      const response = await fetch("/api/transfers", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Stock movement must never double-apply on a double-tap.
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          fromShopId: sourceShop.id,
          toShopId,
          lines,
        }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(result?.error?.message ?? "That did not work.");
        return;
      }
      toast.success("Sent", {
        description:
          "The stock is in transit and is in neither branch's count until it is received.",
      });
      setLines([]);
      onSent?.();
      router.refresh();
    } catch {
      toast.error("No connection. Check the wifi and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3.5 rounded-[14px] border bg-card p-[18px]">
      <p className="text-sm font-semibold">Send stock to another branch</p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-[13px] font-semibold text-foreground">
          From
          <select
            className="mt-[5px] h-11 w-full rounded-[10px] border bg-background px-3 text-sm text-foreground"
            value={sourceShop?.id ?? ""}
            onChange={(event) => changeSource(event.target.value)}
          >
            {sourceShops.map((shop) => (
              <option key={shop.id} value={shop.id}>
                {shop.name} ({shop.code})
              </option>
            ))}
          </select>
        </label>

        <label className="text-[13px] font-semibold text-foreground">
          To
          <select
            className="mt-[5px] h-11 w-full rounded-[10px] border bg-background px-3 text-sm"
            value={toShopId}
            onChange={(e) => setToShopId(e.target.value)}
          >
            <option value="">Choose a branch…</option>
            {availableDestinations.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.code})
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex flex-wrap items-end gap-2.5">
        <label className="min-w-48 flex-1 text-[13px] font-semibold text-foreground">
          Prize
          <select
            className="mt-[5px] h-11 w-full rounded-[10px] border bg-background px-3 text-sm"
            value={prizeItemId}
            onChange={(e) => setPrizeItemId(e.target.value)}
          >
            <option value="">Choose an item…</option>
            {sourcePrizes.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — {p.onHand} on hand
              </option>
            ))}
          </select>
        </label>

        <label className="w-[100px] text-[13px] font-semibold text-foreground">
          Qty
          <Input
            className="mt-[5px] h-11 rounded-[10px] px-3 text-sm tabular-nums"
            inputMode="numeric"
            value={qty}
            onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))}
            placeholder="0"
          />
        </label>

        <Button
          variant="outline"
          className="h-11 min-h-0 rounded-[10px] px-[18px] text-sm font-semibold"
          onClick={addLine}
          disabled={!canAdd}
        >
          <Plus className="size-4" />
          Add
        </Button>
      </div>

      {lines.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {lines.map((l) => (
            <li
              key={l.prizeItemId}
              className="flex items-center gap-3 px-3 py-2 text-sm"
            >
              <span className="flex-1">
                {byId.get(l.prizeItemId)?.name ?? "Unknown item"}
              </span>
              <span className="font-medium tabular-nums">{l.qty}</span>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove ${byId.get(l.prizeItemId)?.name ?? "item"}`}
                onClick={() => removeLine(l.prizeItemId)}
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {lines.length === 0 && (
        <p className="text-[13px] text-muted-foreground">No items added yet.</p>
      )}

      <Button
        className="h-[52px] min-h-0 w-full rounded-[10px] text-[15px] font-semibold"
        onClick={send}
        disabled={busy || lines.length === 0 || !toShopId}
      >
        {busy && <Loader2 className="size-4 animate-spin" />}
        Send {lines.length > 0 && `${lines.length} ${lines.length === 1 ? "item" : "items"}`}
      </Button>
    </div>
  );
}
