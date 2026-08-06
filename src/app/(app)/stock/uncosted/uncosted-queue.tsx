"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Price the queue (§7.5).
 *
 * Setting a cost is not just a field update: it triggers the backfill that
 * rewrites every `StockConsumption` recorded at zero for that batch, and
 * recalculates the redemptions those consumptions fed. The confirmation says so
 * — a manager who thinks this only affects future stock would be surprised to
 * see last week's prize expense move.
 */
interface QueuedBatch {
  id: string;
  qtyReceived: number;
  qtyRemaining: number;
  receivedAt: string;
  supplier: string | null;
  batchCode: string | null;
  prizeItem: { id: string; name: string; sku: string };
  shop: { id: string; name: string };
}

export function UncostedQueue({ batches }: { batches: QueuedBatch[] }) {
  const router = useRouter();
  const [costs, setCosts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  async function save(batch: QueuedBatch) {
    const raw = costs[batch.id]?.trim() ?? "";
    if (raw === "") return;
    const unitCogs = Number(raw);
    if (!Number.isFinite(unitCogs) || unitCogs < 0) {
      toast.error("Enter a unit cost of zero or more.");
      return;
    }

    setSaving(batch.id);
    try {
      const response = await fetch(`/api/stock/batches/${batch.id}/cost`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unitCogs }),
      });
      const result = await response.json().catch(() => null);

      if (!response.ok) {
        toast.error(result?.error?.message ?? "Could not set that cost.");
        return;
      }

      const corrected = result?.consumptionsUpdated ?? 0;
      toast.success(`${batch.prizeItem.name} priced`, {
        description:
          corrected > 0
            ? `${corrected} past consumption${corrected === 1 ? "" : "s"} corrected, and any redemption that used them.`
            : "No stock from this batch had been used yet.",
      });
      router.refresh();
    } catch {
      toast.error("No connection. Check the wifi and try again.");
    } finally {
      setSaving(null);
    }
  }

  return (
    <ul className="space-y-3">
      {batches.map((batch) => (
        <li key={batch.id} className="rounded-xl border p-4">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-semibold">{batch.prizeItem.name}</span>
            <span className="text-sm text-muted-foreground">
              {batch.shop.name}
            </span>
          </div>

          <p className="mt-1 text-sm text-muted-foreground tabular-nums">
            {batch.qtyReceived.toLocaleString("id-ID")} received
            {batch.qtyRemaining !== batch.qtyReceived &&
              ` · ${batch.qtyRemaining.toLocaleString("id-ID")} left`}
            {" · "}
            {new Date(batch.receivedAt).toLocaleDateString("id-ID")}
            {batch.supplier ? ` · ${batch.supplier}` : ""}
            {batch.batchCode ? ` · ${batch.batchCode}` : ""}
          </p>

          {/* Some of this batch is already gone — the backfill will correct it. */}
          {batch.qtyRemaining < batch.qtyReceived && (
            <p className="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-950">
              {(batch.qtyReceived - batch.qtyRemaining).toLocaleString("id-ID")} units
              have already been redeemed at zero cost. Pricing this batch will
              correct those records.
            </p>
          )}

          <div className="mt-3 flex gap-2">
            <Input
              className="tabular-nums"
              inputMode="numeric"
              placeholder="Cost per unit"
              value={costs[batch.id] ?? ""}
              onChange={(e) =>
                setCosts((c) => ({
                  ...c,
                  [batch.id]: e.target.value.replace(/[^\d.]/g, ""),
                }))
              }
            />
            <Button
              disabled={saving !== null || (costs[batch.id]?.trim() ?? "") === ""}
              onClick={() => save(batch)}
            >
              {saving === batch.id && <Loader2 className="size-4 animate-spin" />}
              Save
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
