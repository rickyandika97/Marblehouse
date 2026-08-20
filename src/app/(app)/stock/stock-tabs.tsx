"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ImageIcon, Loader2, PackagePlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ReasonDialog } from "@/components/reason-dialog";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { PrizeDTO, PrizeCostDTO } from "@/server/dto/prize";

type Tab = "on-hand" | "catalog" | "receive" | "transfers" | "opname" | "low-stock";

export interface TransferRow {
  id: string;
  status: "IN_TRANSIT" | "RECEIVED" | "CANCELLED";
  note: string | null;
  dispatchedAt: string;
  fromShop: { id: string; name: string; code: string };
  toShop: { id: string; name: string; code: string };
  lines: Array<{ id: string; qty: number; prizeItem: { id: string; name: string } }>;
}

export interface Destination {
  id: string;
  name: string;
  code: string;
}

/**
 * Stock tabs (§8.7): On hand · Catalog · Receive · Transfers · Opname ·
 * Low stock.
 *
 * Transfers and Opname landed in Phase 5; they were deliberately absent in
 * Phase 4 rather than stubbed (D-35).
 *
 * **Catalog** is D-117 and is not in §8.7's list. It sets `ShopPrizeConfig` —
 * whether this branch carries an item, and its low-stock threshold. Before it,
 * `setShopPrizeConfig` was the ONLY writer of that table outside the demo seed
 * and had no caller, which had two silent consequences: received stock stayed
 * invisible on On hand (that tab filters by `shopConfig?.isActive`, and
 * `receiveBatch` never creates a config row), and the low-stock alert could
 * never fire for it because `runLowStockScan` reads the same table.
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
  transfers,
  destinations,
}: {
  shopId: string;
  prizes: PrizeDTO[];
  showCost: boolean;
  canReceive: boolean;
  transfers: TransferRow[];
  destinations: Destination[];
}) {
  const [tab, setTab] = useState<Tab>("on-hand");

  const stocked = prizes.filter((p) => p.shopConfig?.isActive);
  const lowStock = stocked.filter((p) => p.isLowStock);
  // An archived catalog item cannot be stocked anywhere (`receiveBatch`
  // refuses it), so offering a "carry it" switch for one would be a control
  // that leads to a dead end. Retiring an item does NOT hide stock already
  // here — that still shows on On hand.
  const carriable = prizes.filter((p) => p.isActive);

  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: "on-hand", label: "On hand", count: stocked.length },
    { id: "catalog", label: "Catalog", count: carriable.length },
    ...(canReceive ? [{ id: "receive" as const, label: "Receive" }] : []),
    {
      id: "transfers",
      label: "Transfers",
      count: transfers.filter((t) => t.status === "IN_TRANSIT").length,
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

      {tab === "on-hand" && (
        <OnHandTable rows={stocked} showCost={showCost} shopId={shopId} />
      )}
      {tab === "catalog" && <CatalogPanel shopId={shopId} rows={carriable} />}
      {tab === "receive" && (
        <ReceiveForm shopId={shopId} prizes={prizes} showCost={showCost} />
      )}
      {tab === "transfers" && (
        <TransfersPanel
          shopId={shopId}
          transfers={transfers}
          destinations={destinations}
          prizes={stocked}
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
                {p.shopConfig?.isActive ? "" : " (not carried here — see Catalog)"}
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
  prizes,
}: {
  shopId: string;
  transfers: TransferRow[];
  destinations: Destination[];
  prizes: PrizeDTO[];
}) {
  const router = useRouter();
  const [toShopId, setToShopId] = useState("");
  const [prizeItemId, setPrizeItemId] = useState("");
  const [qty, setQty] = useState("");
  const [busy, setBusy] = useState(false);
  // The transfer the cancel dialog is open for, so it can name the destination
  // and contents rather than asking about "this transfer" in the abstract.
  const [cancelTarget, setCancelTarget] = useState<TransferRow | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const parsedQty = Number(qty);
  const canSubmit =
    !busy &&
    toShopId !== "" &&
    prizeItemId !== "" &&
    Number.isInteger(parsedQty) &&
    parsedQty > 0;

  const outbound = transfers.filter((t) => t.fromShop.id === shopId);
  const inbound = transfers.filter((t) => t.toShop.id === shopId);

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

  async function dispatch() {
    if (!canSubmit) return;
    const ok = await post("/api/transfers", {
      fromShopId: shopId,
      toShopId,
      lines: [{ prizeItemId, qty: parsedQty }],
    });
    if (ok) {
      toast.success("Sent", {
        description: "The stock is in transit and is in neither branch's count.",
      });
      setQty("");
      setPrizeItemId("");
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

  return (
    <div className="space-y-5">
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

        <label className="block text-sm font-medium">
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

        <label className="block text-sm font-medium">
          Quantity
          <Input
            inputMode="numeric"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            placeholder="0"
          />
        </label>

        <Button size="lg" className="w-full" onClick={dispatch} disabled={!canSubmit}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          Send
        </Button>
        <p className="text-xs text-muted-foreground">
          The stock leaves this branch immediately and arrives when the other
          branch confirms it.
        </p>
      </div>

      <TransferList
        title="Coming in"
        rows={inbound}
        empty="Nothing is on its way here."
        action={(t) =>
          t.status === "IN_TRANSIT" ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={async () => {
                if (await post(`/api/transfers/${t.id}/receive`)) {
                  toast.success("Received — the stock is now counted here.");
                }
              }}
            >
              Receive
            </Button>
          ) : null
        }
      />

      <TransferList
        title="Going out"
        rows={outbound}
        empty="Nothing has been sent from here."
        action={(t) =>
          t.status === "IN_TRANSIT" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setCancelTarget(t)}
            >
              Cancel
            </Button>
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
function CatalogPanel({
  shopId,
  rows,
}: {
  shopId: string;
  rows: PrizeDTO[];
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
        The prize catalog is empty. An owner or manager adds items in
        Settings → Prizes, then this branch chooses which of them to carry.
      </p>
    );
  }

  const carried = rows.filter((r) => r.shopConfig?.isActive);
  const notCarried = rows.filter((r) => !r.shopConfig?.isActive);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Choose which catalog items this branch carries, and when to warn that
        one is running low. Ticket prices are the same at every branch and are
        set in Settings → Prizes.
      </p>

      {carried.length > 0 && (
        <div className="rounded-xl border">
          <p className="border-b px-4 py-3 text-sm font-medium">
            Carried here ({carried.length})
          </p>
          <ul className="divide-y">
            {carried.map((r) => (
              <CatalogRow key={r.id} shopId={shopId} prize={r} />
            ))}
          </ul>
        </div>
      )}

      {notCarried.length > 0 && (
        <div className="rounded-xl border">
          <p className="border-b px-4 py-3 text-sm font-medium">
            Not carried here ({notCarried.length})
          </p>
          <ul className="divide-y">
            {notCarried.map((r) => (
              <CatalogRow key={r.id} shopId={shopId} prize={r} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CatalogRow({ shopId, prize }: { shopId: string; prize: PrizeDTO }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [threshold, setThreshold] = useState(
    String(prize.shopConfig?.lowStockThreshold ?? 0)
  );

  const carried = prize.shopConfig?.isActive ?? false;

  // One writer for both fields: the endpoint is a PUT of the whole config, so
  // sending only the field that changed would reset the other to a default.
  async function save(next: { isActive: boolean; lowStockThreshold: number }) {
    setBusy(true);
    try {
      const response = await fetch(
        `/api/shops/${shopId}/prizes/${prize.id}/config`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(next),
        }
      );
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(result?.error?.message ?? "Could not save that setting.");
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

  async function toggleCarried() {
    const next = !carried;
    // Stopping carrying an item does NOT remove its stock — the batches stay,
    // and On hand keeps showing them until they are transferred or adjusted
    // away. Say so, because "not carried" sounding like "written off" is the
    // dangerous reading for anyone counting stock.
    const ok = await save({
      isActive: next,
      lowStockThreshold: Number(threshold) || 0,
    });
    if (!ok) return;
    toast.success(
      next
        ? `${prize.name} is now carried here`
        : prize.onHand > 0
          ? `${prize.name} is no longer offered — its ${prize.onHand} in stock stay on the shelf`
          : `${prize.name} is no longer carried here`
    );
  }

  async function saveThreshold() {
    const parsed = Number(threshold);
    if (!Number.isInteger(parsed) || parsed < 0) {
      toast.error("Use a whole number, 0 or more.");
      return;
    }
    const ok = await save({ isActive: carried, lowStockThreshold: parsed });
    if (!ok) return;
    setEditing(false);
    toast.success(
      parsed === 0
        ? `No low-stock warning for ${prize.name}`
        : `Warn when ${prize.name} falls to ${parsed}`
    );
  }

  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-4">
      {/* Same fixed box with or without a photo, so rows stay aligned. */}
      {prize.imagePath ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/prizes/${prize.id}/image`}
          alt=""
          aria-hidden
          width={40}
          height={40}
          className="size-10 shrink-0 rounded-lg border object-cover"
        />
      ) : (
        <span
          aria-hidden
          className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-dashed text-muted-foreground"
        >
          <ImageIcon className="size-4" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{prize.name}</span>
        <span className="block truncate text-sm text-muted-foreground">
          {prize.sku}
          {prize.category && ` · ${prize.category}`}
          {" · "}
          <span className="tabular-nums">{prize.onHand}</span> in stock
          {prize.isLowStock && (
            <span className="ml-1 font-medium text-amber-700">· low</span>
          )}
        </span>

        {carried && (
          <span className="mt-1 block text-xs text-muted-foreground">
            {editing ? null : prize.shopConfig?.lowStockThreshold ? (
              <>Warn at {prize.shopConfig.lowStockThreshold} or fewer</>
            ) : (
              <>No low-stock warning</>
            )}
          </span>
        )}
      </span>

      {carried && editing ? (
        <span className="flex items-center gap-2">
          <Input
            value={threshold}
            inputMode="numeric"
            aria-label={`Low-stock threshold for ${prize.name}`}
            className="w-24"
            onChange={(e) => setThreshold(e.target.value.replace(/[^0-9]/g, ""))}
            disabled={busy}
          />
          <Button size="sm" onClick={saveThreshold} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setThreshold(String(prize.shopConfig?.lowStockThreshold ?? 0));
              setEditing(false);
            }}
          >
            Cancel
          </Button>
        </span>
      ) : (
        <span className="flex shrink-0 gap-2">
          {carried && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setEditing(true)}
            >
              Low-stock
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={toggleCarried}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {carried ? "Stop carrying" : "Carry here"}
          </Button>
        </span>
      )}
    </li>
  );
}

/**
 * Manual stock adjustment (§7.4, §4.16; BUILD-LOG D-119).
 *
 * `POST /api/stock/adjust` shipped in Phase 4 and had no caller until now, so
 * the only way stock could move outside a sale, a transfer or a delivery was a
 * full opname. An opname is a whole-shop physical count — the wrong instrument
 * for "a customer dropped one teddy bear", which is the case §4.16 is written
 * for.
 *
 * **Two steps, deliberately.** The first picks a direction and a quantity; the
 * second is the shared `ReasonDialog`, which is where the change is actually
 * confirmed. Rolling both into one form would put the reason field next to a
 * +/- control and make it look optional — and §4.16's whole value is that an
 * owner reading the movement back months later can tell breakage from theft
 * from a counting error.
 *
 * The reason's `minLength` is 3 because `adjustStockSchema` says
 * `min(3)` — mirrored from the server, not invented here (see
 * `reason-dialog.tsx` on why that distinction matters).
 *
 * **The direction is a choice, not a sign.** Typing "-3" is easy to get wrong
 * on a tablet and impossible to notice afterwards; two labelled buttons carry
 * the meaning that the number alone does not. The negative is sent as
 * `-quantity`, which is what the service expects.
 */
function AdjustStockButton({
  shopId,
  prize,
}: {
  shopId: string;
  prize: PrizeDTO;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState<"remove" | "add">("remove");
  const [qty, setQty] = useState("");
  const [reasonOpen, setReasonOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const parsedQty = Number(qty);
  const qtyValid = Number.isInteger(parsedQty) && parsedQty > 0;
  // Stock may never go negative. The server checks this inside the transaction
  // at commit time and is the real control — this only avoids offering a
  // button whose only outcome is a 422.
  const exceedsStock = direction === "remove" && parsedQty > prize.onHand;
  const canContinue = qtyValid && !exceedsStock;

  const delta = direction === "remove" ? -parsedQty : parsedQty;

  function reset() {
    setQty("");
    setDirection("remove");
    setOpen(false);
    setReasonOpen(false);
  }

  async function submit(reason: string) {
    setSubmitting(true);
    try {
      const response = await fetch("/api/stock/adjust", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Staff double-tap on slow shop wifi. Without this a retry books the
          // adjustment twice and the count is wrong in the other direction.
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ shopId, prizeItemId: prize.id, delta, reason }),
      });
      const result = await response.json().catch(() => null);

      if (!response.ok) {
        toast.error(result?.error?.message ?? "Could not adjust that stock.");
        return;
      }

      toast.success(
        direction === "remove"
          ? `Removed ${parsedQty} · ${prize.name} now ${result.onHand}`
          : `Added ${parsedQty} · ${prize.name} now ${result.onHand}`,
        {
          description:
            direction === "add"
              ? "Found stock has no cost yet — price it in the uncosted queue."
              : undefined,
        }
      );
      reset();
      router.refresh();
    } catch {
      toast.error("No connection. Check the wifi and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Adjust
      </Button>
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <div className="flex overflow-hidden rounded-lg border">
          <button
            type="button"
            onClick={() => setDirection("remove")}
            aria-pressed={direction === "remove"}
            className={cn(
              "min-h-11 px-3 text-sm font-medium",
              direction === "remove"
                ? "bg-destructive text-white"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Remove
          </button>
          <button
            type="button"
            onClick={() => setDirection("add")}
            aria-pressed={direction === "add"}
            className={cn(
              "min-h-11 border-l px-3 text-sm font-medium",
              direction === "add"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Add
          </button>
        </div>

        <Input
          value={qty}
          inputMode="numeric"
          placeholder="Qty"
          aria-label={`Quantity to adjust for ${prize.name}`}
          className="w-20"
          onChange={(e) => setQty(e.target.value.replace(/[^0-9]/g, ""))}
        />

        <Button
          size="sm"
          disabled={!canContinue}
          onClick={() => setReasonOpen(true)}
        >
          Continue
        </Button>
        <Button size="sm" variant="ghost" onClick={reset}>
          Cancel
        </Button>
      </div>

      {exceedsStock && (
        <p className="mt-1 text-right text-xs font-medium text-destructive">
          Only {prize.onHand} in stock.
        </p>
      )}

      <ReasonDialog
        open={reasonOpen}
        onOpenChange={setReasonOpen}
        title={direction === "remove" ? "Remove stock?" : "Add stock?"}
        description={`${prize.name} · ${prize.onHand} on hand now`}
        consequence={
          direction === "remove"
            ? `${parsedQty} will be taken from the oldest batches first, so the loss is valued at what those units actually cost. On hand becomes ${prize.onHand - parsedQty}.`
            : `${parsedQty} will be added as found stock with no cost yet — price it in the uncosted queue, or prize expense stays understated. On hand becomes ${prize.onHand + parsedQty}.`
        }
        label="Why is this being adjusted?"
        placeholder={
          direction === "remove" ? "Damaged by a customer" : "Found in the store room"
        }
        helpText="Recorded against the movement and the audit log. Be specific — breakage, theft and a miscount read very differently to an owner months later."
        confirmLabel={direction === "remove" ? "Remove stock" : "Add stock"}
        confirmVariant={direction === "remove" ? "destructive" : "default"}
        // Mirrors `adjustStockSchema`'s `min(3)`.
        minLength={3}
        submitting={submitting}
        onConfirm={submit}
      />
    </>
  );
}
