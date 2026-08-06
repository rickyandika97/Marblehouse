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

type Tab = "on-hand" | "receive" | "transfers" | "opname" | "low-stock";

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
 * Stock tabs (§8.7): On hand · Receive · Transfers · Opname · Low stock.
 *
 * Transfers and Opname landed in Phase 5; they were deliberately absent in
 * Phase 4 rather than stubbed (D-35).
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

  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: "on-hand", label: "On hand", count: stocked.length },
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

      {tab === "on-hand" && <OnHandTable rows={stocked} showCost={showCost} />}
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

  async function cancel(id: string) {
    // §4.10 + D-38. window.prompt is ugly on a tablet and is already logged as
    // a debt for the void flow; Phase 10's polish pass replaces both.
    const reason = window.prompt("Why is this transfer being cancelled?")?.trim();
    if (!reason) return;
    if (reason.length < 3) {
      toast.error("Give a slightly longer reason.");
      return;
    }
    if (await post(`/api/transfers/${id}/cancel`, { reason })) {
      toast.success("Cancelled — the stock is back at this branch.");
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
              onClick={() => cancel(t.id)}
            >
              Cancel
            </Button>
          ) : null
        }
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
