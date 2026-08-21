"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, PackagePlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ReasonDialog } from "@/components/reason-dialog";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { PrizeDTO, PrizeCostDTO } from "@/server/dto/prize";
import { AdjustStockButton } from "./adjust-stock";
import { InventoryTable } from "./inventory-table";
import {
  TransferCart,
  type Destination,
  type TransferSourceShop,
} from "./transfer-cart";

type Tab = "inventory" | "transfers" | "opname" | "low-stock";

export interface TransferRow {
  id: string;
  status: "IN_TRANSIT" | "RECEIVED" | "CANCELLED";
  note: string | null;
  dispatchedAt: string;
  fromShop: { id: string; name: string; code: string };
  toShop: { id: string; name: string; code: string };
  lines: Array<{ id: string; qty: number; prizeItem: { id: string; name: string } }>;
}

/**
 * The inventory screen (§8.7, D-156).
 *
 * **Inventory** is one table over the whole catalog — it replaced the old
 * On hand and Catalog tabs, which were two views of the same `listPrizes`
 * call. Per-item detail (batches, where a lot's units went, the branch's
 * stocking policy, the catalog row) lives in the row's drawer rather than in
 * tabs of its own. See `inventory-table.tsx` and `item-drawer.tsx`.
 *
 * The tabs that remain are workflows, not views of stock: moving a box between
 * branches and running a physical count. Receiving is scoped to an inventory
 * row, where the item is already known. Opname in particular is a whole-shop
 * session, so it has no sensible per-item home.
 *
 * Low stock stays its own tab because it answers "what do I need to order?"
 * — a different question from "what do we have?", and the one a manager opens
 * the screen for on a restock day.
 *
 * `showCost` is decided on the SERVER and passed in. It is not a permission —
 * the payload for a plain manager physically has no valuation on it (§7.5) —
 * it only decides whether to render columns for data that is present.
 */
export function StockTabs({
  shopId,
  shopName,
  prizes,
  showCost,
  canReceive,
  transfers,
  destinations,
  sourceShops,
}: {
  shopId: string;
  shopName: string;
  prizes: PrizeDTO[];
  showCost: boolean;
  canReceive: boolean;
  transfers: TransferRow[];
  destinations: Destination[];
  sourceShops: TransferSourceShop[];
}) {
  const searchParams = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const transferRequest = searchParams.get("transfer");
  const [tab, setTab] = useState<Tab>(
    requestedTab === "transfers" ? "transfers" : "inventory"
  );

  useEffect(() => {
    if (requestedTab === "transfers") setTab("transfers");
  }, [requestedTab, transferRequest]);

  const stocked = prizes.filter((p) => p.shopConfig?.isActive);
  const lowStock = stocked.filter((p) => p.isLowStock);
  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: "inventory", label: "Inventory", count: stocked.length },
    {
      id: "transfers",
      label: "Transfers",
      count: transfers.filter(
        (t) =>
          t.status === "IN_TRANSIT" &&
          (t.fromShop.id === shopId || t.toShop.id === shopId)
      ).length,
    },
    { id: "opname", label: "Opname" },
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

      {tab === "inventory" && (
        <InventoryTable
          prizes={prizes}
          shopId={shopId}
          shopName={shopName}
          showCost={showCost}
          canReceive={canReceive}
          destinations={destinations}
          sourceShops={sourceShops}
        />
      )}
      {tab === "transfers" && (
        <TransfersPanel
          shopId={shopId}
          transfers={transfers}
          destinations={destinations}
          sourceShops={sourceShops}
          initialFromShopId={searchParams.get("fromShopId") ?? shopId}
          initialPrizeItemId={searchParams.get("prizeItemId") ?? undefined}
          transferRequest={transferRequest}
        />
      )}
      {tab === "opname" && <OpnamePanel shopId={shopId} />}
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
  shopId,
}: {
  rows: PrizeDTO[];
  showCost: boolean;
  /** Omitted on the Low stock tab, which is a read-only view of the same rows. */
  shopId?: string;
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
        This shop carries no prizes yet. Use + Batch on an inventory item to bring stock in.
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
            {shopId && <th className="py-2 text-right font-medium">Adjust</th>}
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
              {shopId && (
                <td className="py-3 text-right">
                  <AdjustStockButton shopId={shopId} prize={p} />
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
 * Transfers tab (§8.7): two lists plus a dispatch form.
 *
 * Inbound rows carry a Receive button showing what is expected; outbound rows
 * that are still IN_TRANSIT can be cancelled, which requires a reason (D-38).
 */
function TransfersPanel({
  shopId,
  transfers,
  destinations,
  sourceShops,
  initialFromShopId,
  initialPrizeItemId,
  transferRequest,
}: {
  shopId: string;
  transfers: TransferRow[];
  destinations: Destination[];
  sourceShops: TransferSourceShop[];
  initialFromShopId: string;
  initialPrizeItemId?: string;
  transferRequest: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  // The transfer the cancel dialog is open for, so it can name the destination
  // and contents rather than asking about "this transfer" in the abstract.
  const [cancelTarget, setCancelTarget] = useState<TransferRow | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const outbound = transfers.filter((t) => t.fromShop.id === shopId);
  const inbound = transfers.filter((t) => t.toShop.id === shopId);
  const inboundElsewhere = transfers.filter(
    (t) => t.toShop.id !== shopId && t.status === "IN_TRANSIT"
  );

  async function post(url: string, body?: unknown) {
    setBusy(true);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Stock movement must never double-apply on a double-tap.
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify(body ?? {}),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(result?.error?.message ?? "That did not work.");
        return false;
      }
      router.refresh();
      return true;
    } catch {
      toast.error("No connection. Check the wifi and try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  // §4.10 + D-38: the reason is mandatory and audit-logged, because a cancel
  // after the box has physically left is indistinguishable in the data from a
  // mis-keyed dispatch. The reason is what separates them later.
  async function cancel(id: string, reason: string) {
    setCancelling(true);
    try {
      if (await post(`/api/transfers/${id}/cancel`, { reason })) {
        toast.success("Cancelled — the stock is back at this branch.");
        setCancelTarget(null);
      }
    } finally {
      setCancelling(false);
    }
  }

  async function receive(transfer: TransferRow) {
    if (await post(`/api/transfers/${transfer.id}/receive`)) {
      toast.success(`Received at ${transfer.toShop.name}`, {
        description: "The stock is now counted at that branch.",
      });
    }
  }

  return (
    <div className="space-y-5">
      <TransferCart
        key={transferRequest ?? "transfer-form"}
        initialFromShopId={initialFromShopId}
        initialPrizeItemId={initialPrizeItemId}
        sourceShops={sourceShops}
        destinations={destinations}
      />

      <TransferList
        title="Coming in"
        rows={inbound}
        empty="Nothing is on its way here."
        action={(t) =>
          t.status === "IN_TRANSIT" ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => receive(t)}
            >
              Receive
            </Button>
          ) : null
        }
      />

      {inboundElsewhere.length > 0 && (
        <TransferList
          title="Coming in at other shops"
          rows={inboundElsewhere}
          empty=""
          action={(t) => (
            <Button size="sm" disabled={busy} onClick={() => receive(t)}>
              Receive at {t.toShop.code}
            </Button>
          )}
        />
      )}

      <TransferList
        title="Going out"
        rows={outbound}
        empty="Nothing has been sent from here."
        action={(t) =>
          t.status === "IN_TRANSIT" ? (
            <div className="flex shrink-0 gap-2">
              <Button size="sm" disabled={busy} onClick={() => receive(t)}>
                Accept at {t.toShop.code}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setCancelTarget(t)}
              >
                Cancel
              </Button>
            </div>
          ) : null
        }
      />

      <ReasonDialog
        open={cancelTarget !== null}
        onOpenChange={(next) => {
          if (!next) setCancelTarget(null);
        }}
        title="Cancel this transfer?"
        description={
          cancelTarget
            ? `To ${cancelTarget.toShop.name} · ${cancelTarget.lines
                .map((l) => `${l.qty} × ${l.prizeItem.name}`)
                .join(", ")}`
            : undefined
        }
        consequence="The stock returns to this branch at its original cost and FIFO position. If the box is genuinely lost, cancel it here and then write it off through opname — a real loss should show as shrinkage, not disappear inside a cancelled transfer."
        label="Why is it being cancelled?"
        placeholder="Sent to the wrong branch"
        confirmLabel="Cancel transfer"
        submitting={cancelling}
        onConfirm={(reason) => {
          if (cancelTarget) return cancel(cancelTarget.id, reason);
        }}
      />
    </div>
  );
}

function TransferList({
  title,
  rows,
  empty,
  action,
}: {
  title: string;
  rows: TransferRow[];
  empty: string;
  action: (t: TransferRow) => React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{title}</p>
      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">
          {empty}
        </p>
      ) : (
        <ul className="divide-y rounded-xl border">
          {rows.map((t) => (
            <li key={t.id} className="flex items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {t.lines
                    .map((l) => `${l.qty} × ${l.prizeItem.name}`)
                    .join(", ")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t.fromShop.code} → {t.toShop.code} ·{" "}
                  {new Date(t.dispatchedAt).toLocaleDateString("id-ID")}
                </p>
              </div>
              <StatusPill status={t.status} />
              {action(t)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: TransferRow["status"] }) {
  const label =
    status === "IN_TRANSIT"
      ? "In transit"
      : status === "RECEIVED"
        ? "Received"
        : "Cancelled";
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
        status === "IN_TRANSIT" && "bg-amber-100 text-amber-900",
        status === "RECEIVED" && "bg-emerald-100 text-emerald-900",
        status === "CANCELLED" && "bg-muted text-muted-foreground"
      )}
    >
      {label}
    </span>
  );
}

/**
 * Opname tab (§8.7, §4.11).
 *
 * The count is entered BEFORE the system quantity is shown. That ordering is
 * the control, not a UI preference: a counter who can see the expected number
 * will find that number. The server enforces it too — `POST /api/opname`
 * returns no quantities at all — so this screen cannot leak what it never
 * received.
 */
function OpnamePanel({ shopId }: { shopId: string }) {
  const router = useRouter();
  const [session, setSession] = useState<{
    id: string;
    items: Array<{ id: string; name: string }>;
  } | null>(null);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [reviewed, setReviewed] = useState<Array<{
    id: string;
    prizeItem: { id: string; name: string };
    systemQty: number;
    countedQty: number;
    variance: number;
    varianceValue?: string;
  }> | null>(null);
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    try {
      const response = await fetch("/api/opname", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopId }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(result?.error?.message ?? "Could not start a stock count.");
        return;
      }
      setSession(result);
      setCounts({});
      setReviewed(null);
    } catch {
      toast.error("No connection. Check the wifi and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function review() {
    if (!session) return;
    const lines = Object.entries(counts)
      .filter(([, v]) => v.trim() !== "" && Number.isInteger(Number(v)))
      .map(([prizeItemId, v]) => ({ prizeItemId, countedQty: Number(v) }));

    if (lines.length === 0) {
      toast.error("Enter at least one counted quantity.");
      return;
    }

    setBusy(true);
    try {
      const response = await fetch(`/api/opname/${session.id}/lines`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(result?.error?.message ?? "Could not save the count.");
        return;
      }
      setReviewed(result.lines);
    } catch {
      toast.error("No connection. Check the wifi and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!session) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/opname/${session.id}/commit`, {
        method: "POST",
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(result?.error?.message ?? "Could not apply the count.");
        return;
      }
      toast.success("Stock count applied", {
        description: "On-hand quantities now match what was counted.",
      });
      setSession(null);
      setReviewed(null);
      router.refresh();
    } catch {
      toast.error("No connection. Check the wifi and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!session) {
    return (
      <div className="space-y-4 rounded-xl border p-4">
        <p className="font-medium">Count the stock on the shelf</p>
        <p className="text-sm text-muted-foreground">
          You will enter what you physically count first. The system total is
          revealed only afterwards, so the count stays honest.
        </p>
        <Button size="lg" className="w-full" onClick={start} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <PackagePlus className="size-4" />}
          Start a stock count
        </Button>
      </div>
    );
  }

  if (reviewed) {
    const changed = reviewed.filter((l) => l.variance !== 0);
    return (
      <div className="space-y-4">
        <div className="rounded-xl border p-4">
          <p className="font-medium">Check the differences</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {changed.length === 0
              ? "Everything matched. There is nothing to apply."
              : "Applying this will move stock to match what you counted."}
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Prize</th>
                <th className="py-2 pr-3 text-right font-medium">System</th>
                <th className="py-2 pr-3 text-right font-medium">Counted</th>
                <th className="py-2 text-right font-medium">Difference</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {reviewed.map((l) => (
                <tr key={l.id}>
                  <td className="py-3 pr-3">{l.prizeItem.name}</td>
                  <td className="py-3 pr-3 text-right tabular-nums">{l.systemQty}</td>
                  <td className="py-3 pr-3 text-right tabular-nums">{l.countedQty}</td>
                  <td
                    className={cn(
                      "py-3 text-right font-semibold tabular-nums",
                      l.variance < 0 && "text-destructive",
                      l.variance > 0 && "text-emerald-700"
                    )}
                  >
                    {l.variance > 0 ? `+${l.variance}` : l.variance}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={() => setReviewed(null)}>
            Back
          </Button>
          <Button className="flex-1" size="lg" onClick={commit} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Apply
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border p-4">
        <p className="font-medium">Enter what you counted</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Count the shelf, then type the number. Leave an item blank to skip it.
        </p>
      </div>

      <ul className="divide-y rounded-xl border">
        {session.items.map((item) => (
          <li key={item.id} className="flex items-center gap-3 p-3">
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {item.name}
            </span>
            <Input
              className="w-24"
              inputMode="numeric"
              placeholder="—"
              value={counts[item.id] ?? ""}
              onChange={(e) =>
                setCounts((c) => ({ ...c, [item.id]: e.target.value }))
              }
            />
          </li>
        ))}
      </ul>

      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" onClick={() => setSession(null)}>
          Cancel
        </Button>
        <Button className="flex-1" size="lg" onClick={review} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          See differences
        </Button>
      </div>
    </div>
  );
}

/**
 * Catalog tab (§7.4, D-117) — what THIS branch carries.
 *
 * Sets `ShopPrizeConfig` via `PUT /api/shops/:id/prizes/:prizeId/config`. That
 * endpoint shipped in Phase 5 with a service, tests (D-116) and no caller at
 * all, which quietly disabled two things: a received delivery never appeared on
 * On hand, because that tab filters by `shopConfig?.isActive` and
 * `receiveBatch` does not create a config row; and the low-stock alert could
 * never fire, because `runLowStockScan` reads the same table.
 *
 * The two fields here are the ONLY per-branch settings on a prize. Ticket cost
 * is global and lives on the catalog item (§4.8, a closed decision) — it is
 * deliberately absent, and the server's schema is `.strict()` so a request that
 * smuggles one is rejected rather than silently stripped.
 *
 * Threshold 0 means "never warn" (§4.8), which is not the same as an empty
 * field, so the input says so rather than leaving the reader to guess.
 */
