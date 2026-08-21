"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatMoney } from "@/lib/money";
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
 * 2. **The FIFO plan is shown before sending.** `POST /api/transfers/preview`
 *    reports which lots dispatch would draw. This is visibility, NOT choice —
 *    the sender cannot pick lots, because cherry-picking cheap ones would
 *    invert the cost basis at both branches. See `previewTransferPlan`.
 *
 * The preview is a forecast, not a reservation: stock can move between
 * previewing and sending, and dispatch re-runs FIFO for real inside a
 * transaction. A line that has gone short in the meantime fails there with
 * INSUFFICIENT_STOCK, which is the authoritative answer.
 */

interface CartLine {
  prizeItemId: string;
  qty: number;
}

interface PreviewLot {
  batchId: string;
  batchCode: string | null;
  qty: number;
  receivedAt: string;
  supplier: string | null;
  unitCogs?: string;
  lineValue?: string;
  needsCosting?: boolean;
}

interface PreviewLine {
  prizeItemId: string;
  prizeName: string;
  qty: number;
  onHand: number;
  short: boolean;
  lots: PreviewLot[];
}

export interface Destination {
  id: string;
  name: string;
  code: string;
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function TransferCart({
  shopId,
  prizes,
  destinations,
  showCost,
}: {
  shopId: string;
  prizes: PrizeDTO[];
  destinations: Destination[];
  showCost: boolean;
}) {
  const router = useRouter();
  const [toShopId, setToShopId] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<CartLine[]>([]);
  const [prizeItemId, setPrizeItemId] = useState("");
  const [qty, setQty] = useState("");
  const [preview, setPreview] = useState<PreviewLine[] | null>(null);
  const [busy, setBusy] = useState(false);

  const byId = new Map(prizes.map((p) => [p.id, p]));
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
    // Any edit invalidates a plan computed for the old cart.
    setPreview(null);
  }

  function removeLine(id: string) {
    setLines((prev) => prev.filter((l) => l.prizeItemId !== id));
    setPreview(null);
  }

  async function loadPreview() {
    if (lines.length === 0) return;
    setBusy(true);
    try {
      const response = await fetch("/api/transfers/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromShopId: shopId, lines }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(result?.error?.message ?? "Could not work out the batches.");
        return;
      }
      setPreview(result as PreviewLine[]);
    } catch {
      toast.error("No connection. Check the wifi and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!toShopId || lines.length === 0) return;
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
          fromShopId: shopId,
          toShopId,
          lines,
          ...(note.trim() ? { note: note.trim() } : {}),
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
      setPreview(null);
      setNote("");
      router.refresh();
    } catch {
      toast.error("No connection. Check the wifi and try again.");
    } finally {
      setBusy(false);
    }
  }

  const anyShort = preview?.some((l) => l.short) ?? false;

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <p className="font-medium">Send stock to another branch</p>

      <label className="block text-sm font-medium">
        Destination
        <select
          className="mt-1 min-h-12 w-full rounded-lg border bg-background px-3 text-base"
          value={toShopId}
          onChange={(e) => setToShopId(e.target.value)}
        >
          <option value="">Choose a branch…</option>
          {destinations.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} ({d.code})
            </option>
          ))}
        </select>
      </label>

      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-48 flex-1 text-sm font-medium">
          Prize
          <select
            className="mt-1 min-h-12 w-full rounded-lg border bg-background px-3 text-base"
            value={prizeItemId}
            onChange={(e) => setPrizeItemId(e.target.value)}
          >
            <option value="">Choose an item…</option>
            {prizes.map((p) => (
              <option key={p.id} value={p.id} disabled={p.onHand < 1}>
                {p.name} — {p.onHand} on hand
              </option>
            ))}
          </select>
        </label>

        <label className="w-28 text-sm font-medium">
          Qty
          <Input
            className="mt-1 tabular-nums"
            inputMode="numeric"
            value={qty}
            onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))}
            placeholder="0"
          />
        </label>

        <Button variant="outline" onClick={addLine} disabled={!canAdd}>
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

      <label className="block text-sm font-medium">
        Note{" "}
        <span className="font-normal text-muted-foreground">(optional)</span>
        <Input
          className="mt-1"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
          placeholder="Which box, who is carrying it"
        />
      </label>

      {preview && (
        <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
          <p className="text-sm font-medium">Batches that will be sent</p>
          <p className="text-xs text-muted-foreground">
            Oldest stock goes first. This is worked out automatically so the
            cost basis stays honest at both branches — it is not a choice.
          </p>

          {preview.map((line) => (
            <div key={line.prizeItemId}>
              <p className="text-sm font-medium">
                {line.prizeName}{" "}
                <span className="font-normal text-muted-foreground">
                  · {line.qty} of {line.onHand} on hand
                </span>
              </p>

              {line.short ? (
                <p className="mt-1 text-sm text-destructive">
                  Only {line.onHand} here — reduce the quantity before sending.
                </p>
              ) : (
                <ul className="mt-1 space-y-0.5">
                  {line.lots.map((lot) => (
                    <li
                      key={lot.batchId}
                      className="flex flex-wrap gap-x-2 text-xs text-muted-foreground"
                    >
                      <span className="font-medium text-foreground tabular-nums">
                        {lot.qty}
                      </span>
                      from {lot.batchCode ?? shortDate(lot.receivedAt)}
                      <span>· received {shortDate(lot.receivedAt)}</span>
                      {showCost && lot.unitCogs !== undefined && (
                        <span>
                          · {formatMoney(lot.unitCogs)} each
                          {lot.needsCosting && " (no cost set)"}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={loadPreview}
          disabled={busy || lines.length === 0}
        >
          {busy && <Loader2 className="size-4 animate-spin" />}
          Check batches
        </Button>

        <Button
          className="flex-1"
          size="lg"
          onClick={send}
          disabled={busy || lines.length === 0 || !toShopId || anyShort}
        >
          {busy && <Loader2 className="size-4 animate-spin" />}
          Send {lines.length > 0 && `${lines.length} ${lines.length === 1 ? "item" : "items"}`}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        The stock leaves this branch immediately and arrives when the other
        branch confirms it.
      </p>
    </div>
  );
}
