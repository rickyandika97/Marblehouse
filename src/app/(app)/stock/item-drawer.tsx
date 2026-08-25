"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, ChevronRight, ImageIcon, Loader2, Pencil } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatMoney } from "@/lib/money";
import { AdjustStockButton } from "./adjust-stock";
import {
  TransferCart,
  type Destination,
  type TransferSourceShop,
} from "./transfer-cart";
import { cn } from "@/lib/utils";
import type { PrizeDTO } from "@/server/dto/prize";

/**
 * The per-item drill-down (D-156) — the BisMan `openBH` equivalent.
 *
 * THIS IS WHY THE TWO SCREENS MERGED. Before it, `/stock` showed a single
 * on-hand number per item and `/settings/prizes` showed the catalog row, and
 * NOTHING in the UI ever called `listBatches` — so the lots that number is made
 * of, and the FIFO cost basis underneath them, were invisible to everyone
 * including the owner. An arcade with a shrinkage problem could see the total
 * fall and had no way to ask where it went.
 *
 * Three sections, in the order the questions actually get asked:
 *
 *   Batches      — what is here, oldest first, next-to-draw marked
 *   ↳ Consumption — where a drained lot's units went (lazy, on expand)
 *   This branch  — carried here? warn at what level?
 *   Catalog      — the global row: name, ticket cost, retire
 *
 * `showCost` is decided on the SERVER and passed down. It is not a permission:
 * the payload for a plain manager physically has no cost keys on it (§7.5).
 * It only decides whether to render columns for data that is present.
 */

/** Mirrors `BatchDTO`; cost keys are absent, not null, without the gate. */
interface BatchRow {
  id: string;
  batchCode: string | null;
  qtyReceived: number;
  qtyRemaining: number;
  supplier: string | null;
  note: string | null;
  isAdjustment: boolean;
  receivedAt: string;
  unitCogs?: string;
  remainingValue?: string;
  needsCosting?: boolean;
}

interface ConsumptionRow {
  id: string;
  qty: number;
  businessDate: string;
  occurredAt: string;
  ref: { type: string; label: string | null };
  staffName: string | null;
  reason: string | null;
  unitCogs?: string;
  lineValue?: string;
}

/** The movement types a lot can be drawn down by, in plain language. */
const MOVEMENT_LABEL: Record<string, string> = {
  REDEEM: "Redeemed",
  TRANSFER_OUT: "Sent out",
  OPNAME_LOSS: "Stock count",
  DAMAGE: "Damaged",
  MANUAL_ADJUST: "Adjusted",
  VOID_RESTORE: "Put back",
};

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function ItemDrawer({
  prize,
  shopId,
  shopName,
  showCost,
  destinations,
  sourceShops,
  open,
  onOpenChange,
}: {
  prize: PrizeDTO;
  shopId: string;
  shopName: string;
  showCost: boolean;
  destinations: Destination[];
  sourceShops: TransferSourceShop[];
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const [view, setView] = useState<"item" | "catalog">("item");
  const [stockScope, setStockScope] = useState<"this" | "across">("this");
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferSourceShopId, setTransferSourceShopId] = useState(shopId);

  function startTransfer(fromShopId = shopId) {
    setTransferSourceShopId(fromShopId);
    setTransferOpen(true);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[786px]">
        <DialogHeader>
          <DialogTitle className="text-xl font-bold">{prize.name}</DialogTitle>
          <p className="text-sm text-muted-foreground">
            {prize.sku}
            {prize.category && ` · ${prize.category}`} ·{" "}
            <span className="tabular-nums">
              {prize.ticketCost.toLocaleString("id-ID")}
            </span>{" "}
            tickets
          </p>
        </DialogHeader>

        {view === "item" ? (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex w-fit gap-0.5 rounded-[10px] bg-muted p-0.5">
                <button
                  type="button"
                  className={cn(
                    "h-9 rounded-lg px-3.5 text-[13px] font-semibold transition-colors",
                    stockScope === "this"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  onClick={() => setStockScope("this")}
                >
                  This shop
                </button>
                <button
                  type="button"
                  className={cn(
                    "h-9 rounded-lg px-3.5 text-[13px] font-semibold transition-colors",
                    stockScope === "across"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  onClick={() => setStockScope("across")}
                >
                  Across shops
                </button>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  className="h-10 min-h-0 rounded-[10px] px-3.5 text-[13px] font-semibold"
                  onClick={() => setView("catalog")}
                >
                  <Pencil className="size-4" />
                  Edit
                </Button>
                <Button
                  variant="outline"
                  className="h-10 min-h-0 rounded-[10px] px-3.5 text-[13px] font-semibold"
                  onClick={() => startTransfer()}
                >
                  <ArrowRight className="size-4" />
                  Send to another shop
                </Button>
              </div>
            </div>

            {stockScope === "this" ? (
              <BatchSection
                prize={prize}
                shopId={shopId}
                shopName={shopName}
                showCost={showCost}
                open={open}
                onStartTransfer={startTransfer}
              />
            ) : (
              <AcrossShopsSection
                prizeId={prize.id}
                sourceShops={sourceShops}
                showCost={showCost}
                open={open}
                onStartTransfer={startTransfer}
              />
            )}
            <BranchSummary prize={prize} shopName={shopName} />
          </div>
        ) : (
          <div className="space-y-4">
            <CatalogSection prize={prize} />
            <BranchSection prize={prize} shopId={shopId} shopName={shopName} />
          </div>
        )}

        <Dialog open={transferOpen} onOpenChange={setTransferOpen} modal={false}>
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>Send {prize.name}</DialogTitle>
            </DialogHeader>
            <TransferCart
              key={transferSourceShopId}
              initialFromShopId={transferSourceShopId}
              initialPrizeItemId={prize.id}
              sourceShops={sourceShops}
              destinations={destinations}
              onSent={() => setTransferOpen(false)}
            />
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}

/* ────────────────────────────── BATCHES ────────────────────────────── */

function BatchSection({
  prize,
  shopId,
  shopName,
  showCost,
  open,
  onStartTransfer,
}: {
  prize: PrizeDTO;
  shopId: string;
  shopName: string;
  showCost: boolean;
  open: boolean;
  onStartTransfer: () => void;
}) {
  const [rows, setRows] = useState<BatchRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setRows(null);
    setError(null);

    fetch(
      `/api/stock/batches/by-item?shopId=${encodeURIComponent(shopId)}&prizeId=${encodeURIComponent(prize.id)}`
    )
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok) throw new Error(body?.error?.message ?? "Could not load batches.");
        return body as BatchRow[];
      })
      .then((data) => {
        if (!cancelled) setRows(data);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });

    return () => {
      cancelled = true;
    };
  }, [open, shopId, prize.id]);

  // The first lot with stock left is the one the next redemption draws from.
  const nextLotId = rows?.find((b) => b.qtyRemaining > 0)?.id ?? null;

  return (
    <section>
      <h3 className="text-sm font-semibold">Batches at {shopName}</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Oldest first — the order stock is drawn in.
      </p>

      {error && (
        <p className="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
          {error}
        </p>
      )}

      {!rows && !error && (
        <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading batches…
        </p>
      )}

      {rows && rows.length === 0 && (
        <p className="mt-3 rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">
          No stock of this item has ever been received at this branch.
        </p>
      )}

      {rows && rows.length > 0 && (
        <ul className="mt-3 divide-y rounded-xl border">
          {rows.map((b) => (
            <BatchRowItem
              key={b.id}
              batch={b}
              ticketCost={prize.ticketCost}
              showCost={showCost}
              isNext={b.id === nextLotId}
              onStartTransfer={onStartTransfer}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function BatchRowItem({
  batch,
  ticketCost,
  showCost,
  isNext,
  onStartTransfer,
}: {
  batch: BatchRow;
  ticketCost: number;
  showCost: boolean;
  isNext: boolean;
  onStartTransfer: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const used = batch.qtyReceived - batch.qtyRemaining;

  return (
    <li>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-3">
        {/*
          `min-w-0` alone is not enough: the batch code is one long unbroken
          token, so without a basis wide enough to hold it the flex item
          collapses and the browser breaks the code mid-word. A basis plus
          `break-words` keeps it on one line at any realistic width.
        */}
        <div className="min-w-0 flex-1 basis-48">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium break-words">
            {batch.batchCode ?? shortDate(batch.receivedAt)}
            {isNext && (
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                Next to draw
              </span>
            )}
            {batch.isAdjustment && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                Adjustment
              </span>
            )}
            {batch.needsCosting && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
                No cost yet
              </span>
            )}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Received {shortDate(batch.receivedAt)}
            {batch.supplier && ` · ${batch.supplier}`}
            {batch.note && ` · ${batch.note}`}
          </p>
          {used > 0 && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {used.toLocaleString("id-ID")} redeemed so far for{" "}
              {(used * ticketCost).toLocaleString("id-ID")} tickets
            </p>
          )}
        </div>

        {showCost && batch.unitCogs !== undefined && (
          <p className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {formatMoney(batch.unitCogs)} each
            {batch.remainingValue !== undefined &&
              ` · ${formatMoney(batch.remainingValue)} left`}
          </p>
        )}

        <div className="shrink-0 text-right">
          <p className="font-semibold tabular-nums">
            {batch.qtyRemaining.toLocaleString("id-ID")}
            <span className="font-normal text-muted-foreground">
              {" "}
              / {batch.qtyReceived.toLocaleString("id-ID")}
            </span>
          </p>
        </div>

        <Button
          size="sm"
          variant="outline"
          className="h-10 min-h-0 rounded-[8px] px-3 text-xs font-semibold"
          onClick={onStartTransfer}
        >
          <ArrowRight className="size-3.5" />
          Send
        </Button>

        {/*
          Only a lot something has come OUT of has a history to show. Offering
          the control on an untouched batch would open an empty drawer.
        */}
        {used > 0 ? (
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1 px-1 text-xs font-semibold text-muted-foreground hover:text-foreground"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            <ChevronRight
              className={cn("size-4 transition-transform", expanded && "rotate-90")}
            />
            {used.toLocaleString("id-ID")} used
          </button>
        ) : (
          <span className="shrink-0 px-3 text-xs text-muted-foreground">
            Untouched
          </span>
        )}
      </div>

      {expanded && <ConsumptionList batchId={batch.id} showCost={showCost} />}
    </li>
  );
}

function BranchSummary({ prize, shopName }: { prize: PrizeDTO; shopName: string }) {
  const threshold = prize.shopConfig?.lowStockThreshold ?? 0;
  const carried = prize.shopConfig?.isActive ?? false;

  return (
    <section className="rounded-xl border p-3.5">
      <h3 className="text-[13px] font-semibold">At {shopName}</h3>
      <p className="mt-1 text-[13px] text-muted-foreground">
        <span className="font-medium text-foreground tabular-nums">
          {prize.onHand.toLocaleString("id-ID")}
        </span>{" "}
        on hand · warns at {threshold} · {carried ? "carried at this shop" : "not carried here"}
      </p>
    </section>
  );
}

/* ─────────────────────────── ACROSS SHOPS ─────────────────────────── */

function AcrossShopsSection({
  prizeId,
  sourceShops,
  showCost,
  open,
  onStartTransfer,
}: {
  prizeId: string;
  sourceShops: TransferSourceShop[];
  showCost: boolean;
  open: boolean;
  onStartTransfer: (shopId: string) => void;
}) {
  const rows = sourceShops.map((shop) => ({
    shop,
    prize: shop.prizes.find((candidate) => candidate.id === prizeId),
  }));
  const carriedCount = rows.filter((row) => row.prize?.shopConfig?.isActive).length;
  const totalOnHand = rows.reduce((total, row) => total + (row.prize?.onHand ?? 0), 0);

  return (
    <section>
      <p className="text-xs text-muted-foreground">
        Carried at {carriedCount} of {rows.length} branches ·{" "}
        {totalOnHand.toLocaleString("id-ID")} units total.
      </p>

      <ul className="mt-3 divide-y rounded-xl border">
        {rows.map(({ shop, prize: shopPrize }) => (
          <NetworkShopRow
            key={shop.id}
            shop={shop}
            prize={shopPrize}
            showCost={showCost}
            open={open}
            onStartTransfer={() => onStartTransfer(shop.id)}
          />
        ))}
      </ul>
    </section>
  );
}

function NetworkShopRow({
  shop,
  prize,
  showCost,
  open,
  onStartTransfer,
}: {
  shop: TransferSourceShop;
  prize: PrizeDTO | undefined;
  showCost: boolean;
  open: boolean;
  onStartTransfer: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const status = networkStatus(prize);
  const onHand = prize?.onHand ?? 0;

  return (
    <li>
      <button
        type="button"
        className="flex w-full items-center gap-3 px-3.5 py-3 text-left hover:bg-muted/40"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
      >
        <ChevronRight
          className={cn("size-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">
            {shop.name} <span className="font-normal text-muted-foreground">({shop.code})</span>
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {prize?.shopConfig?.isActive ? `${onHand.toLocaleString("id-ID")} on hand` : "Not carried here"}
          </span>
        </span>
        <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", status.className)}>
          {status.label}
        </span>
        <span className="min-w-8 text-right text-lg font-semibold tabular-nums">
          {onHand.toLocaleString("id-ID")}
        </span>
      </button>

      {expanded &&
        (prize ? (
          <div className="border-t px-3.5 py-3 pl-10">
            <BatchSection
              prize={prize}
              shopId={shop.id}
              shopName={shop.name}
              showCost={showCost}
              open={open}
              onStartTransfer={onStartTransfer}
            />
          </div>
        ) : (
          <p className="border-t px-3.5 py-3 pl-10 text-sm text-muted-foreground">
            This item is not carried at this branch.
          </p>
        ))}
    </li>
  );
}

function networkStatus(prize: PrizeDTO | undefined) {
  if (!prize?.shopConfig?.isActive) {
    return { label: "Not carried", className: "bg-muted text-muted-foreground" };
  }
  if (prize.onHand === 0) {
    return { label: "Out of stock", className: "bg-destructive/10 text-destructive" };
  }
  if (prize.isLowStock) {
    return { label: "Low", className: "bg-amber-100 text-amber-900" };
  }
  return { label: "In stock", className: "bg-primary/10 text-primary" };
}

/**
 * Where one lot's units went — fetched lazily, on expand.
 *
 * Lazy because a busy branch's item has a dozen lots and each has its own
 * history; loading all of them to render a list nobody has opened would make
 * the drawer slow for the common case of "just checking the count".
 */
function ConsumptionList({
  batchId,
  showCost,
}: {
  batchId: string;
  showCost: boolean;
}) {
  const [rows, setRows] = useState<ConsumptionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/stock/batches/${encodeURIComponent(batchId)}/consumption`)
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok) throw new Error(body?.error?.message ?? "Could not load history.");
        return body as ConsumptionRow[];
      })
      .then((data) => {
        if (!cancelled) setRows(data);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [batchId]);

  if (error) {
    return (
      <p className="border-t bg-muted/30 px-4 py-3 text-sm text-destructive">
        {error}
      </p>
    );
  }

  if (!rows) {
    return (
      <p className="flex items-center gap-2 border-t bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading history…
      </p>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="border-t bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
        Nothing recorded against this batch.
      </p>
    );
  }

  return (
    <div className="border-t bg-muted/30 px-4 py-3">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase text-muted-foreground">
            <th className="pb-1 pr-3 font-medium">Date</th>
            <th className="pb-1 pr-3 font-medium">What</th>
            <th className="pb-1 pr-3 font-medium">Who</th>
            <th className="pb-1 text-right font-medium">Qty</th>
            {showCost && <th className="pb-1 text-right font-medium">Value</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {rows.map((c) => (
            <tr key={c.id}>
              <td className="py-2 pr-3 whitespace-nowrap tabular-nums">
                {shortDate(c.businessDate)}
              </td>
              <td className="py-2 pr-3">
                {MOVEMENT_LABEL[c.ref.type] ?? c.ref.type}
                {c.ref.label && (
                  <span className="text-muted-foreground"> · {c.ref.label}</span>
                )}
                {c.reason && (
                  <span className="block text-xs text-muted-foreground">
                    {c.reason}
                  </span>
                )}
              </td>
              <td className="py-2 pr-3 text-muted-foreground">
                {c.staffName ?? "—"}
              </td>
              <td className="py-2 text-right font-medium tabular-nums">
                {c.qty.toLocaleString("id-ID")}
              </td>
              {showCost && (
                <td className="py-2 text-right tabular-nums">
                  {c.lineValue !== undefined ? formatMoney(c.lineValue) : "—"}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ─────────────────────────── THIS BRANCH ─────────────────────────── */

/**
 * `ShopPrizeConfig` for this branch — carried here, and the low-stock level.
 *
 * Moved from the old Catalog tab (D-117). Note that stopping carrying an item
 * does NOT remove its stock: the batches stay and keep showing on the table,
 * which is why the confirmation says so out loud.
 */
function BranchSection({
  prize,
  shopId,
  shopName,
}: {
  prize: PrizeDTO;
  shopId: string;
  shopName: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [threshold, setThreshold] = useState(
    String(prize.shopConfig?.lowStockThreshold ?? 0)
  );

  const carried = prize.shopConfig?.isActive ?? false;

  const save = useCallback(
    async (next: { isActive: boolean; lowStockThreshold: number }) => {
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
          toast.error(result?.error?.message ?? "Could not save that.");
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
    },
    [router, shopId, prize.id]
  );

  return (
    <section className="rounded-xl border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">At {shopName}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            <span className="font-medium tabular-nums text-foreground">
              {prize.onHand.toLocaleString("id-ID")}
            </span>{" "}
            on hand
          </p>
        </div>
        {/*
          §4.16's instrument for "a customer dropped one teddy bear". It lived
          on the old On hand tab; when that merged into the table this was the
          one control with nowhere to go, and `POST /api/stock/adjust` would
          have become unreachable from the UI a second time (D-119).
        */}
        <AdjustStockButton shopId={shopId} prize={prize} />
      </div>

      <div className="mt-3 flex flex-wrap items-start gap-3">
        <div>
          <label className="flex h-12 items-center gap-4 text-sm font-medium">
            <span>Warn when stock falls to</span>
            <Input
              className="w-16 text-center tabular-nums"
              inputMode="numeric"
              value={threshold}
              disabled={!carried || busy}
              onChange={(e) => setThreshold(e.target.value.replace(/[^0-9]/g, ""))}
            />
          </label>
          <span className="mt-1 block text-xs font-normal text-muted-foreground">
            0 means never warn.
          </span>
        </div>

        <Button
          variant="outline"
          disabled={!carried || busy}
          onClick={async () => {
            const parsed = Number(threshold);
            if (!Number.isInteger(parsed) || parsed < 0) {
              toast.error("Use a whole number, 0 or more.");
              return;
            }
            if (await save({ isActive: carried, lowStockThreshold: parsed })) {
              toast.success(
                parsed === 0
                  ? `No low-stock warning for ${prize.name}`
                  : `Warn when ${prize.name} falls to ${parsed}`
              );
            }
          }}
        >
          {busy && <Loader2 className="size-4 animate-spin" />}
          Save level
        </Button>

        <Button
          variant="outline"
          disabled={busy}
          onClick={async () => {
            const next = !carried;
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
          }}
        >
          {busy && <Loader2 className="size-4 animate-spin" />}
          {carried ? "Stop carrying here" : "Carry here"}
        </Button>
      </div>
    </section>
  );
}

/* ───────────────────────────── CATALOG ───────────────────────────── */

/**
 * The global catalog row, folded in from the old Settings → Prizes screen.
 *
 * **The catalog is global (§4.8).** A reprice lands at every branch, including
 * ones this manager does not run — which is why the ticket-cost field carries
 * the warning and why `updatePrize` raises an owner alert. That warning moved
 * across with the field; losing it in the merge would be the dangerous outcome.
 */
function CatalogSection({ prize }: { prize: PrizeDTO }) {
  const router = useRouter();
  const [name, setName] = useState(prize.name);
  const [category, setCategory] = useState(prize.category ?? "");
  const [ticketCost, setTicketCost] = useState(String(prize.ticketCost));
  const [busy, setBusy] = useState(false);

  const repriced = Number(ticketCost) !== prize.ticketCost;

  async function save() {
    const parsed = Number(ticketCost);
    if (!Number.isInteger(parsed) || parsed < 1) {
      toast.error("Ticket cost must be a whole number above zero.");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/prizes/${prize.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          category: category.trim() || null,
          ticketCost: parsed,
        }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(result?.error?.message ?? "Could not save that.");
        return;
      }
      toast.success("Saved", {
        description: repriced
          ? "The new ticket price applies at every branch."
          : undefined,
      });
      router.refresh();
    } catch {
      toast.error("No connection. Check the wifi and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function setActive(isActive: boolean) {
    setBusy(true);
    try {
      const response = await fetch(`/api/prizes/${prize.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => null);
        toast.error(result?.error?.message ?? "Could not save that.");
        return;
      }
      toast.success(
        isActive
          ? `${prize.name} is back in the catalog`
          : `${prize.name} is retired — existing stock is unaffected`
      );
      router.refresh();
    } catch {
      toast.error("No connection. Check the wifi and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border p-4">
      <h3 className="text-sm font-semibold">Catalog</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Shared by every branch. SKU cannot be changed after creation.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium">
          Name
          <Input
            className="mt-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            disabled={busy}
          />
        </label>
        <label className="text-sm font-medium">
          Category{" "}
          <span className="font-normal text-muted-foreground">(optional)</span>
          <Input
            className="mt-1"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            maxLength={60}
            disabled={busy}
          />
        </label>
      </div>

      <div className="mt-3">
        <label className="flex h-12 items-center gap-4 text-sm font-medium">
          <span>Ticket cost</span>
          <Input
            className="w-[77px] text-center tabular-nums"
            inputMode="numeric"
            value={ticketCost}
            onChange={(e) => setTicketCost(e.target.value.replace(/[^0-9]/g, ""))}
            disabled={busy}
          />
        </label>
        {repriced && (
          <span className="mt-1 block text-xs font-normal text-amber-700">
            This price applies at EVERY branch, including ones you do not
            manage. The owner is notified of the change.
          </span>
        )}
      </div>

      <div className="mt-4">
        <ImageField prize={prize} disabled={busy} />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button onClick={save} disabled={busy}>
          {busy && <Loader2 className="size-4 animate-spin" />}
          Save catalog details
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => setActive(!prize.isActive)}
        >
          {prize.isActive ? "Retire item" : "Restore item"}
        </Button>
      </div>
    </section>
  );
}

/**
 * The prize photo (§8.6) — recovered from `prize-admin.tsx` in the D-156 merge.
 *
 * Saved on choosing a file, separately from the fields above, because an
 * upload is a different request from the PATCH and pretending otherwise would
 * mean a failed photo silently discarding a name change.
 *
 * `<img>` rather than `next/image`: the source is our own authenticated route,
 * not a static asset, and Next's optimiser would need a loader configured for
 * an endpoint that already returns a right-sized 600px JPEG. D-4's rule
 * against Vercel-flavoured infrastructure applies to the image optimiser too.
 */
function ImageField({
  prize,
  disabled,
}: {
  prize: PrizeDTO;
  disabled: boolean;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  // The route's URL never changes when the image does, and it is cached for an
  // hour — so a replaced photo would keep showing the old one. Bumping a
  // cache-buster on success is what makes the change visible immediately.
  const [version, setVersion] = useState(0);

  const src = `/api/prizes/${prize.id}/image${version ? `?v=${version}` : ""}`;

  async function upload(file: File) {
    setBusy(true);
    try {
      const body = new FormData();
      body.append("image", file);
      const res = await fetch(`/api/prizes/${prize.id}/image`, {
        method: "POST",
        body,
      });
      const result = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(result?.error?.message ?? "Could not upload that image.");
        return;
      }
      setVersion((v) => v + 1);
      toast.success("Photo updated");
      router.refresh();
    } catch {
      toast.error("No connection. Check the wifi and try again.");
    } finally {
      setBusy(false);
      // Clear the input, or choosing the SAME file again fires no change event
      // and a failed upload could not be retried.
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function remove() {
    setBusy(true);
    try {
      const res = await fetch(`/api/prizes/${prize.id}/image`, {
        method: "DELETE",
      });
      const result = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(result?.error?.message ?? "Could not remove that image.");
        return;
      }
      setVersion((v) => v + 1);
      toast.success("Photo removed");
      router.refresh();
    } catch {
      toast.error("No connection. Check the wifi and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={`image-${prize.id}`}>Photo</Label>

      <div className="flex items-center gap-3">
        {prize.imagePath ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={`Photo of ${prize.name}`}
            width={64}
            height={64}
            className="size-16 shrink-0 rounded-lg border object-cover"
          />
        ) : (
          <span
            aria-hidden
            className="flex size-16 shrink-0 items-center justify-center rounded-lg border border-dashed text-muted-foreground"
          >
            <ImageIcon className="size-6" />
          </span>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || busy}
            onClick={() => inputRef.current?.click()}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {prize.imagePath ? "Replace photo" : "Add photo"}
          </Button>

          {prize.imagePath && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled || busy}
              onClick={remove}
            >
              Remove
            </Button>
          )}
        </div>
      </div>

      <input
        ref={inputRef}
        id={`image-${prize.id}`}
        type="file"
        accept="image/*"
        className="sr-only"
        disabled={disabled || busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
        }}
      />

      <p className="text-xs text-muted-foreground">
        Shown to staff on the redemption screen. Saved as soon as you choose it,
        separately from the fields above. Square crop, JPEG, up to 12MB.
      </p>
    </div>
  );
}
