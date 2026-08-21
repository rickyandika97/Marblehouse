"use client";

import { useMemo, useState } from "react";
import { ImageIcon, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { PrizeDTO, PrizeCostDTO } from "@/server/dto/prize";
import { AddPrizeButton } from "./add-prize";
import { ItemDrawer } from "./item-drawer";
import { ReceiveBatchButton } from "./receive-batch";
import type { Destination, TransferSourceShop } from "./transfer-cart";

/**
 * The unified inventory table (D-156) — one row per catalog item, following
 * the flow of BisMan's desktop Inventory page.
 *
 * Replaces the old On hand / Catalog split. Those were two views of the same
 * `listPrizes` call: one filtered to `shopConfig.isActive` and showed a
 * quantity, the other showed the catalog row and a carry toggle. Keeping them
 * apart meant an item this branch had not switched on was invisible on the
 * screen called "Stock" — including any stock of it already sitting on the
 * shelf, because `receiveBatch` never creates a config row.
 *
 * One table, a filter for the same distinction, and everything else in the
 * row's drawer.
 *
 * Sorting and filtering are client-side over an already-loaded array: this is
 * one shop's catalog, in the low hundreds. Nothing here paginates, and it
 * should not start without a real row count to justify it.
 */

type SortKey = "name" | "category" | "onHand" | "value" | "status";
type InventoryScope = "this" | "all" | "not-carried";

interface NetworkInventoryRow {
  prize: PrizeDTO;
  byShop: Map<string, PrizeDTO>;
  totalOnHand: number;
}

function statusRank(p: PrizeDTO): number {
  if (!p.shopConfig?.isActive) return 3; // not carried — sorts last
  if (p.onHand === 0) return 0; // out of stock — most urgent
  if (p.isLowStock) return 1;
  return 2;
}

function StatusBadge({ prize }: { prize: PrizeDTO }) {
  if (!prize.shopConfig?.isActive) {
    return (
      <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
        Not carried
      </span>
    );
  }
  if (prize.onHand === 0) {
    return (
      <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
        Out of stock
      </span>
    );
  }
  if (prize.isLowStock) {
    return (
      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
        Low
      </span>
    );
  }
  return (
    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-900">
      In stock
    </span>
  );
}

function networkStatus(rows: Iterable<PrizeDTO>) {
  const carried = [...rows].filter((prize) => prize.shopConfig?.isActive);
  if (carried.length === 0) {
    return { label: "Not carried", className: "bg-muted text-muted-foreground", rank: 3 };
  }
  if (carried.every((prize) => prize.onHand === 0)) {
    return { label: "Out everywhere", className: "bg-destructive/10 text-destructive", rank: 0 };
  }
  if (carried.some((prize) => prize.isLowStock)) {
    return { label: "Low somewhere", className: "bg-amber-100 text-amber-900", rank: 1 };
  }
  return { label: "Healthy", className: "bg-emerald-100 text-emerald-900", rank: 2 };
}

export function InventoryTable({
  prizes,
  shopId,
  shopName,
  showCost,
  canReceive,
  destinations,
  sourceShops,
}: {
  prizes: PrizeDTO[];
  shopId: string;
  shopName: string;
  showCost: boolean;
  canReceive: boolean;
  destinations: Destination[];
  sourceShops: TransferSourceShop[];
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [inventoryScope, setInventoryScope] = useState<InventoryScope>("this");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "name",
    dir: "asc",
  });
  const [openId, setOpenId] = useState<string | null>(null);

  const categories = useMemo(
    () =>
      [...new Set(prizes.map((p) => p.category).filter((c): c is string => !!c))].sort(),
    [prizes]
  );

  const rows = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);

    const filtered = prizes.filter((p) => {
      if (inventoryScope === "this" && !p.shopConfig?.isActive) return false;
      if (inventoryScope === "not-carried" && p.shopConfig?.isActive) return false;
      if (category && p.category !== category) return false;
      if (words.length === 0) return true;
      const haystack = `${p.name} ${p.sku} ${p.category ?? ""}`.toLowerCase();
      return words.every((w) => haystack.includes(w));
    });

    // Key computed once per row rather than inside the comparator, which would
    // recompute it O(n log n) times.
    const keyed = filtered.map((p) => {
      let k: string | number;
      switch (sort.key) {
        case "category":
          k = (p.category ?? "").toLowerCase();
          break;
        case "onHand":
          k = p.onHand;
          break;
        case "value":
          k = Number((p as PrizeCostDTO).stockValuation ?? 0);
          break;
        case "status":
          k = statusRank(p);
          break;
        default:
          k = p.name.toLowerCase();
      }
      return { p, k };
    });

    keyed.sort((a, b) => {
      const cmp = a.k < b.k ? -1 : a.k > b.k ? 1 : 0;
      return sort.dir === "asc" ? cmp : -cmp;
    });

    return keyed.map((x) => x.p);
  }, [prizes, query, category, inventoryScope, sort]);

  const networkRows = useMemo(() => {
    const byPrize = new Map<
      string,
      { prize: PrizeDTO; byShop: Map<string, PrizeDTO> }
    >();

    for (const shop of sourceShops) {
      for (const prize of shop.prizes) {
        const entry = byPrize.get(prize.id) ?? {
          // Prefer the current-shop DTO so opening a network row stays in the
          // same item detail context as the rest of this screen.
          prize: prizes.find((current) => current.id === prize.id) ?? prize,
          byShop: new Map<string, PrizeDTO>(),
        };
        entry.byShop.set(shop.id, prize);
        byPrize.set(prize.id, entry);
      }
    }

    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const filtered: NetworkInventoryRow[] = [];
    for (const { prize, byShop } of byPrize.values()) {
      if (category && prize.category !== category) continue;
      const haystack = `${prize.name} ${prize.sku} ${prize.category ?? ""}`.toLowerCase();
      if (!words.every((word) => haystack.includes(word))) continue;
      filtered.push({
        prize,
        byShop,
        totalOnHand: [...byShop.values()].reduce((sum, shopPrize) => sum + shopPrize.onHand, 0),
      });
    }

    filtered.sort((a, b) => {
      let aKey: string | number;
      let bKey: string | number;
      switch (sort.key) {
        case "category":
          aKey = (a.prize.category ?? "").toLowerCase();
          bKey = (b.prize.category ?? "").toLowerCase();
          break;
        case "onHand":
          aKey = a.totalOnHand;
          bKey = b.totalOnHand;
          break;
        case "status":
          aKey = networkStatus(a.byShop.values()).rank;
          bKey = networkStatus(b.byShop.values()).rank;
          break;
        default:
          aKey = a.prize.name.toLowerCase();
          bKey = b.prize.name.toLowerCase();
      }
      const comparison = aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
      return sort.dir === "asc" ? comparison : -comparison;
    });

    return filtered;
  }, [category, prizes, query, sort, sourceShops]);

  const totalValue = useMemo(() => {
    if (!showCost) return null;
    return rows.reduce(
      (sum, p) => sum + Number((p as PrizeCostDTO).stockValuation ?? 0),
      0
    );
  }, [rows, showCost]);

  function toggleSort(key: SortKey) {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : // Quantities and money read most usefully largest-first.
          { key, dir: key === "name" || key === "category" ? "asc" : "desc" }
    );
  }

  const openPrize = prizes.find((p) => p.id === openId) ?? null;

  return (
    <div className="space-y-3">
      <div className="flex w-fit gap-0.5 rounded-[10px] bg-muted p-0.5">
        <button
          type="button"
          className={cn(
            "h-9 rounded-lg px-3.5 text-[13px] font-semibold transition-colors",
            inventoryScope === "this"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
          onClick={() => setInventoryScope("this")}
        >
          This shop
        </button>
        <button
          type="button"
          className={cn(
            "h-9 rounded-lg px-3.5 text-[13px] font-semibold transition-colors",
            inventoryScope === "all"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
          onClick={() => setInventoryScope("all")}
        >
          All shops
        </button>
        <button
          type="button"
          className={cn(
            "h-9 rounded-lg px-3.5 text-[13px] font-semibold transition-colors",
            inventoryScope === "not-carried"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
          onClick={() => setInventoryScope("not-carried")}
        >
          Not carried
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search name, SKU or category…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {categories.length > 0 && (
          <select
            className="min-h-10 rounded-lg border bg-background px-3 text-sm"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            aria-label="Filter by category"
          >
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}

        <AddPrizeButton
          existingSkus={prizes.map((p) => p.sku.toLowerCase())}
        />
      </div>

      {inventoryScope === "all" ? (
        <NetworkInventoryTable
          rows={networkRows}
          sourceShops={sourceShops}
          sort={sort}
          onSort={toggleSort}
          onOpenPrize={(prizeId) => setOpenId(prizeId)}
        />
      ) : (
        <div className="overflow-x-auto rounded-[14px] border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
              <SortHeader label="Prize" k="name" sort={sort} onSort={toggleSort} />
              <SortHeader
                label="Category"
                k="category"
                sort={sort}
                onSort={toggleSort}
                className="hidden sm:table-cell"
              />
              <th className="px-3 py-2 text-right font-medium">Tickets</th>
              <SortHeader
                label="On hand"
                k="onHand"
                sort={sort}
                onSort={toggleSort}
                align="right"
              />
              {showCost && (
                <SortHeader
                  label="Stock value"
                  k="value"
                  sort={sort}
                  onSort={toggleSort}
                  align="right"
                />
              )}
              <SortHeader
                label="Status"
                k="status"
                sort={sort}
                onSort={toggleSort}
              />
              {canReceive && <th className="px-3.5 py-2.5" />}
            </tr>
          </thead>

          <tbody className="divide-y">
            {rows.map((p) => (
              <tr
                key={p.id}
                onClick={() => setOpenId(p.id)}
                className="cursor-pointer hover:bg-muted/40"
              >
                <td className="px-3.5 py-3">
                  <div className="flex items-center gap-3">
                    {p.imagePath ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`/api/prizes/${p.id}/image`}
                        alt=""
                        aria-hidden
                        width={36}
                        height={36}
                        className="size-9 shrink-0 rounded-lg border object-cover"
                      />
                    ) : (
                      <span
                        aria-hidden
                        className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-dashed text-muted-foreground"
                      >
                        <ImageIcon className="size-4" />
                      </span>
                    )}
                    <span className="min-w-0">
                      <span className="block font-medium">{p.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {p.sku}
                        {!p.isActive && " · retired"}
                      </span>
                    </span>
                  </div>
                </td>

                <td className="hidden px-3.5 py-3 text-muted-foreground sm:table-cell">
                  {p.category ?? "—"}
                </td>

                <td className="px-3.5 py-3 text-right tabular-nums">
                  {p.ticketCost.toLocaleString("id-ID")}
                </td>

                <td className="px-3.5 py-3 text-right">
                  <span className="font-semibold tabular-nums">
                    {p.onHand.toLocaleString("id-ID")}
                  </span>
                  {/*
                    The BisMan stock cell: the number, then how the branch is
                    set up underneath it. The threshold is the bit people
                    forget, and it explains why an item is or is not flagged.
                  */}
                  <span className="block text-xs text-muted-foreground">
                    {p.shopConfig?.isActive
                      ? p.shopConfig.lowStockThreshold > 0
                        ? `alert @${p.shopConfig.lowStockThreshold}`
                        : "no alert"
                      : "not carried"}
                  </span>
                </td>

                {showCost && (
                  <td className="px-3.5 py-3 text-right tabular-nums">
                    {formatMoney((p as PrizeCostDTO).stockValuation ?? 0)}
                  </td>
                )}

                <td className="px-3.5 py-3">
                  <StatusBadge prize={p} />
                </td>

                {canReceive && (
                  <td className="px-3.5 py-3 text-right">
                    <ReceiveBatchButton
                      shopId={shopId}
                      prizeItemId={p.id}
                      prizeName={p.name}
                      shopName={shopName}
                      showCost={showCost}
                    />
                  </td>
                )}
              </tr>
            ))}

            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={(showCost ? 6 : 5) + (canReceive ? 1 : 0)}
                  className="px-3 py-10 text-center text-sm text-muted-foreground"
                >
                  {prizes.length === 0
                    ? "The prize catalog is empty. Add an item to get started."
                    : "Nothing matches that search."}
                </td>
              </tr>
            )}
          </tbody>

          {showCost && totalValue !== null && rows.length > 0 && (
            <tfoot>
              <tr className="border-t bg-muted/40 font-medium">
                <td colSpan={4} className="px-3 py-2 text-xs text-muted-foreground">
                  {rows.length} {rows.length === 1 ? "item" : "items"} shown
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatMoney(totalValue)}
                </td>
                <td />
                {canReceive && <td />}
              </tr>
            </tfoot>
          )}
        </table>
        </div>
      )}

      {openPrize && (
        <ItemDrawer
          key={openPrize.id}
          prize={openPrize}
          shopId={shopId}
          shopName={shopName}
          showCost={showCost}
          destinations={destinations}
          sourceShops={sourceShops}
          open
          onOpenChange={(next) => {
            if (!next) setOpenId(null);
          }}
        />
      )}
    </div>
  );
}

function NetworkInventoryTable({
  rows,
  sourceShops,
  sort,
  onSort,
  onOpenPrize,
}: {
  rows: NetworkInventoryRow[];
  sourceShops: TransferSourceShop[];
  sort: { key: SortKey; dir: "asc" | "desc" };
  onSort: (key: SortKey) => void;
  onOpenPrize: (prizeId: string) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-[14px] border bg-card">
      <table className="w-full min-w-[760px] text-sm">
        <thead>
          <tr className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
            <SortHeader label="Prize" k="name" sort={sort} onSort={onSort} />
            <SortHeader
              label="Category"
              k="category"
              sort={sort}
              onSort={onSort}
              className="hidden sm:table-cell"
            />
            <th className="px-3.5 py-2.5 text-right font-medium">Tickets</th>
            {sourceShops.map((shop) => (
              <th key={shop.id} className="px-3.5 py-2.5 text-right font-medium">
                {shop.code}
              </th>
            ))}
            <SortHeader
              label="Total"
              k="onHand"
              sort={sort}
              onSort={onSort}
              align="right"
            />
            <SortHeader label="Network status" k="status" sort={sort} onSort={onSort} />
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => {
            const status = networkStatus(row.byShop.values());
            return (
              <tr
                key={row.prize.id}
                className="cursor-pointer hover:bg-muted/40"
                onClick={() => onOpenPrize(row.prize.id)}
              >
                <td className="px-3.5 py-3">
                  <div className="flex items-center gap-3">
                    {row.prize.imagePath ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`/api/prizes/${row.prize.id}/image`}
                        alt=""
                        aria-hidden
                        width={36}
                        height={36}
                        className="size-9 shrink-0 rounded-lg border object-cover"
                      />
                    ) : (
                      <span
                        aria-hidden
                        className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-dashed text-muted-foreground"
                      >
                        <ImageIcon className="size-4" />
                      </span>
                    )}
                    <span className="min-w-0">
                      <span className="block font-medium">{row.prize.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {row.prize.sku}
                      </span>
                    </span>
                  </div>
                </td>
                <td className="hidden px-3.5 py-3 text-muted-foreground sm:table-cell">
                  {row.prize.category ?? "—"}
                </td>
                <td className="px-3.5 py-3 text-right tabular-nums">
                  {row.prize.ticketCost.toLocaleString("id-ID")}
                </td>
                {sourceShops.map((shop) => (
                  <td key={shop.id} className="px-3.5 py-3 text-right">
                    <NetworkStockCell prize={row.byShop.get(shop.id)} />
                  </td>
                ))}
                <td className="px-3.5 py-3 text-right font-semibold tabular-nums">
                  {row.totalOnHand.toLocaleString("id-ID")}
                </td>
                <td className="px-3.5 py-3">
                  <span
                    className={cn(
                      "whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
                      status.className
                    )}
                  >
                    {status.label}
                  </span>
                </td>
              </tr>
            );
          })}

          {rows.length === 0 && (
            <tr>
              <td
                colSpan={sourceShops.length + 5}
                className="px-3 py-10 text-center text-sm text-muted-foreground"
              >
                Nothing matches that search across your shops.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function NetworkStockCell({ prize }: { prize: PrizeDTO | undefined }) {
  if (!prize?.shopConfig?.isActive) {
    return <span className="text-muted-foreground">—</span>;
  }

  return (
    <span
      className={cn(
        "font-semibold tabular-nums",
        prize.onHand === 0
          ? "text-destructive"
          : prize.isLowStock
            ? "text-amber-900"
            : "text-foreground"
      )}
    >
      {prize.onHand.toLocaleString("id-ID")}
    </span>
  );
}

function SortHeader({
  label,
  k,
  sort,
  onSort,
  align = "left",
  className,
}: {
  label: string;
  k: SortKey;
  sort: { key: SortKey; dir: "asc" | "desc" };
  onSort: (k: SortKey) => void;
  align?: "left" | "right";
  className?: string;
}) {
  const active = sort.key === k;
  return (
    <th
      className={cn(
        "px-3.5 py-2.5 font-medium",
        align === "right" && "text-right",
        className
      )}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(k)}
        className={cn(
          "inline-flex items-center gap-1 text-[11px] tracking-[0.04em] uppercase hover:text-foreground",
          active && "text-foreground"
        )}
      >
        {label}
        <span aria-hidden className={cn("text-[10px]", !active && "opacity-0")}>
          {sort.dir === "asc" ? "▲" : "▼"}
        </span>
      </button>
    </th>
  );
}
