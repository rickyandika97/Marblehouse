"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, PackagePlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { PrizeDTO, PrizeCostDTO } from "@/server/dto/prize";

type Tab = "on-hand" | "receive" | "low-stock";

/**
 * Stock tabs (§8.7): On hand · Receive · Low stock.
 *
 * Transfers and Opname are Phase 5 and are deliberately absent rather than
 * rendered as empty tabs.
 *
 * `showCost` is decided on the SERVER and passed in. It is not a permission —
 * the payload for a plain manager physically has no valuation on it (§7.5) —
 * it only decides whether to render columns for data that is present.
 */
export function StockTabs({
  shopId,
  prizes,
  showCost,
  canReceive,
}: {
  shopId: string;
  prizes: PrizeDTO[];
  showCost: boolean;
  canReceive: boolean;
}) {
  const [tab, setTab] = useState<Tab>("on-hand");

  const stocked = prizes.filter((p) => p.shopConfig?.isActive);
  const lowStock = stocked.filter((p) => p.isLowStock);

  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: "on-hand", label: "On hand", count: stocked.length },
    ...(canReceive ? [{ id: "receive" as const, label: "Receive" }] : []),
    { id: "low-stock", label: "Low stock", count: lowStock.length },
  ];

  return (
    <div className="space-y-4">
      <div className="flex gap-1 overflow-x-auto border-b">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            aria-current={tab === t.id ? "page" : undefined}
            className={cn(
              "min-h-12 shrink-0 border-b-2 px-4 text-sm font-medium",
              tab === t.id
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
            {t.count !== undefined && (
              <span className="ml-1.5 tabular-nums opacity-70">{t.count}</span>
            )}
          </button>
        ))}
      </div>

      {tab === "on-hand" && <OnHandTable rows={stocked} showCost={showCost} />}
      {tab === "receive" && (
        <ReceiveForm shopId={shopId} prizes={prizes} showCost={showCost} />
      )}
      {tab === "low-stock" && (
        <>
          {lowStock.length === 0 ? (
            <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
              Nothing is running low. Items appear here when on-hand falls to or
              below the threshold set for this shop.
            </p>
          ) : (
            <OnHandTable rows={lowStock} showCost={showCost} />
          )}
        </>
      )}
    </div>
  );
}

function OnHandTable({
  rows,
  showCost,
}: {
  rows: PrizeDTO[];
  showCost: boolean;
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
        This shop carries no prizes yet. Use the Receive tab to bring stock in.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs uppercase text-muted-foreground">
            <th className="py-2 pr-3 font-medium">Prize</th>
            <th className="py-2 pr-3 text-right font-medium">Tickets</th>
            <th className="py-2 pr-3 text-right font-medium">On hand</th>
            {/* Owner / Purchasing manager only (§8.7). */}
            {showCost && (
              <th className="py-2 text-right font-medium">Stock value</th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((p) => (
            <tr key={p.id}>
              <td className="py-3 pr-3">
                <span className="font-medium">{p.name}</span>
                {p.isLowStock && (
                  <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
                    Low
                  </span>
                )}
                {p.category && (
                  <span className="block text-xs text-muted-foreground">
                    {p.category}
                  </span>
                )}
              </td>
              <td className="py-3 pr-3 text-right tabular-nums">
                {p.ticketCost.toLocaleString("id-ID")}
              </td>
              <td className="py-3 pr-3 text-right font-semibold tabular-nums">
                {p.onHand.toLocaleString("id-ID")}
              </td>
              {showCost && (
                <td className="py-3 text-right tabular-nums">
                  {formatMoney((p as PrizeCostDTO).stockValuation ?? 0)}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Receive a delivery (§8.7).
 *
 * The cost field renders ONLY when `showCost`. Everyone else sees the §8.7 note
 * — "Cost will be added by the owner." — rather than a disabled input, because
 * a greyed-out box invites someone to go looking for the permission.
 *
 * The server rejects a `unitCogs` from an unauthorised caller with a 403 rather
 * than dropping it, so this is presentation only, not the control.
 */
function ReceiveForm({
  shopId,
  prizes,
  showCost,
}: {
  shopId: string;
  prizes: PrizeDTO[];
  showCost: boolean;
}) {
  const router = useRouter();
  const [prizeItemId, setPrizeItemId] = useState("");
  const [qty, setQty] = useState("");
  const [unitCogs, setUnitCogs] = useState("");
  const [supplier, setSupplier] = useState("");
  const [batchCode, setBatchCode] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const parsedQty = Number(qty);
  const canSubmit =
    !submitting && prizeItemId !== "" && Number.isInteger(parsedQty) && parsedQty > 0;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const response = await fetch("/api/stock/batches", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // A double-tap on shop wifi must not book two deliveries.
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          shopId,
          prizeItemId,
          qtyReceived: parsedQty,
          supplier: supplier.trim() || undefined,
          batchCode: batchCode.trim() || undefined,
          // Omitted entirely when the field was never shown, which is what
          // flags the batch as needing a cost (§7.5).
          ...(showCost && unitCogs.trim() !== ""
            ? { unitCogs: Number(unitCogs) }
            : {}),
        }),
      });
      const result = await response.json().catch(() => null);

      if (!response.ok) {
        toast.error(result?.error?.message ?? "Could not record that delivery.");
        return;
      }

      toast.success("Stock received", {
        description: showCost && unitCogs.trim() !== ""
          ? `${parsedQty} units added.`
          : `${parsedQty} units added — waiting for the owner to set a cost.`,
      });
      setQty("");
      setUnitCogs("");
      setSupplier("");
      setBatchCode("");
      router.refresh();
    } catch {
      toast.error("No connection. Check the wifi and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <label className="block font-medium">
        Prize
        <select
          className="mt-1 min-h-12 w-full rounded-lg border bg-background px-3 text-base"
          value={prizeItemId}
          onChange={(e) => setPrizeItemId(e.target.value)}
        >
          <option value="">Choose an item…</option>
          {prizes
            .filter((p) => p.isActive)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.shopConfig?.isActive ? "" : " (not stocked here yet)"}
              </option>
            ))}
        </select>
      </label>

      <label className="block font-medium">
        Quantity received
        <Input
          className="mt-1 text-xl font-bold tabular-nums"
          inputMode="numeric"
          value={qty}
          onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))}
          placeholder="0"
        />
      </label>

      {showCost ? (
        <label className="block font-medium">
          Unit cost
          <Input
            className="mt-1 tabular-nums"
            inputMode="numeric"
            value={unitCogs}
            onChange={(e) => setUnitCogs(e.target.value.replace(/[^\d.]/g, ""))}
            placeholder="Cost per single unit"
          />
          <span className="mt-1 block text-xs font-normal text-muted-foreground">
            Leave blank to price it later. Prize expense is understated until
            every delivery has a cost.
          </span>
        </label>
      ) : (
        <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
          Cost will be added by the owner.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block font-medium">
          Supplier <span className="font-normal text-muted-foreground">(optional)</span>
          <Input
            className="mt-1"
            value={supplier}
            onChange={(e) => setSupplier(e.target.value)}
            maxLength={120}
          />
        </label>
        <label className="block font-medium">
          Batch code <span className="font-normal text-muted-foreground">(optional)</span>
          <Input
            className="mt-1"
            value={batchCode}
            onChange={(e) => setBatchCode(e.target.value)}
            maxLength={60}
          />
        </label>
      </div>

      <Button size="lg" className="w-full" disabled={!canSubmit} onClick={submit}>
        {submitting ? (
          <Loader2 className="size-5 animate-spin" />
        ) : (
          <PackagePlus className="size-5" />
        )}
        Receive stock
      </Button>
    </div>
  );
}
