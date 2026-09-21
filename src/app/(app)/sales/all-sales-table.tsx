"use client";

/**
 * The All Sales register (D-181) — the owner's list of individual transactions,
 * with Edit and Void on every row.
 *
 * Client-side because the filters are interactive and each row carries a dialog.
 * The rows themselves are still fetched on the server; this component never
 * queries, it only re-navigates with new search params and lets the page
 * re-render.
 *
 * **Voided rows are shown, struck through, not hidden.** An owner on this
 * screen is usually looking for a mistake, and the most common mistake worth
 * finding is a void that should not have happened — which a filtered-out row
 * makes unreachable.
 */

import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ReasonDialog } from "@/components/reason-dialog";
import {
  EditSaleDialog,
  type EditableSale,
  type SaleEditOptions,
} from "@/components/edit-sale-dialog";
import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/money";

export interface SaleRow extends EditableSale {
  businessDate: string;
  voidedAt: string | null;
  voidReason: string | null;
}

export function AllSalesTable({
  sales,
  options,
  staff,
  hasMore,
  selected,
}: {
  sales: SaleRow[];
  options: SaleEditOptions;
  staff: { id: string; displayName: string }[];
  hasMore: boolean;
  selected: {
    userId?: string;
    paymentMethod?: "CASH" | "EDC";
    status?: "COMPLETED" | "VOIDED";
  };
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [voidTarget, setVoidTarget] = useState<SaleRow | null>(null);
  const [voiding, setVoiding] = useState(false);

  /**
   * Set or clear one filter, keeping the date range and shop the filter bar
   * above already owns. Written as a full replace rather than a merge so that
   * clearing a filter actually removes the param instead of leaving an empty
   * one the server then parses.
   */
  function setFilter(key: string, value: string | undefined) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    router.push(`/sales?${params.toString()}`);
  }

  async function voidSale(sale: SaleRow, reason: string) {
    setVoiding(true);
    try {
      const res = await fetch(`/api/sales/${sale.id}/void`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        toast.error(body?.error?.message ?? "Could not void that sale.");
        return;
      }

      toast.success("Sale voided");
      setVoidTarget(null);
      router.refresh();
    } catch {
      toast.error("No connection. Check the wifi and try again.");
    } finally {
      setVoiding(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-4">
        <FilterGroup label="Staff">
          <FilterChip
            selected={!selected.userId}
            onClick={() => setFilter("userId", undefined)}
          >
            Everyone
          </FilterChip>
          {staff.map((s) => (
            <FilterChip
              key={s.id}
              selected={selected.userId === s.id}
              onClick={() => setFilter("userId", s.id)}
            >
              {s.displayName}
            </FilterChip>
          ))}
        </FilterGroup>

        <FilterGroup label="Payment">
          <FilterChip
            selected={!selected.paymentMethod}
            onClick={() => setFilter("paymentMethod", undefined)}
          >
            Any
          </FilterChip>
          <FilterChip
            selected={selected.paymentMethod === "CASH"}
            onClick={() => setFilter("paymentMethod", "CASH")}
          >
            Cash
          </FilterChip>
          <FilterChip
            selected={selected.paymentMethod === "EDC"}
            onClick={() => setFilter("paymentMethod", "EDC")}
          >
            Card / QRIS
          </FilterChip>
        </FilterGroup>

        <FilterGroup label="Status">
          <FilterChip
            selected={!selected.status}
            onClick={() => setFilter("status", undefined)}
          >
            All
          </FilterChip>
          <FilterChip
            selected={selected.status === "COMPLETED"}
            onClick={() => setFilter("status", "COMPLETED")}
          >
            Completed
          </FilterChip>
          <FilterChip
            selected={selected.status === "VOIDED"}
            onClick={() => setFilter("status", "VOIDED")}
          >
            Voided
          </FilterChip>
        </FilterGroup>
      </div>

      {sales.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          No sales match these filters.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left">
              <tr>
                <Th>When</Th>
                <Th>Branch</Th>
                <Th>Customer</Th>
                <Th>Staff</Th>
                <Th>Paid</Th>
                <Th numeric>Amount</Th>
                <Th>{/* actions */}</Th>
              </tr>
            </thead>
            <tbody>
              {sales.map((sale) => {
                const voided = sale.status === "VOIDED";
                return (
                  <tr
                    key={sale.id}
                    className={cn("border-b last:border-0", voided && "bg-muted/20")}
                  >
                    <Td>
                      <span className="block tabular-nums">{sale.businessDate}</span>
                      <span className="block text-xs text-muted-foreground tabular-nums">
                        {new Date(sale.occurredAt).toLocaleTimeString("en-GB", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </Td>
                    <Td className="text-muted-foreground">
                      {options.shops.find((s) => s.id === sale.shopId)?.name ??
                        "—"}
                    </Td>
                    <Td>
                      {sale.customer ? (
                        <Link
                          href={`/customers/${sale.customer.id}`}
                          className="font-medium hover:underline"
                        >
                          {sale.customer.name}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">Walk-in</span>
                      )}
                    </Td>
                    <Td className="text-muted-foreground">
                      {sale.recordedBy.displayName}
                    </Td>
                    <Td>{sale.paymentMethod === "CASH" ? "Cash" : "Card"}</Td>
                    <Td numeric>
                      <span
                        className={cn(
                          "tabular-nums font-medium",
                          voided && "text-muted-foreground line-through"
                        )}
                      >
                        {formatMoney(sale.amount)}
                      </span>
                      {voided && (
                        <span
                          className="block text-xs uppercase text-muted-foreground"
                          title={sale.voidReason ?? undefined}
                        >
                          Voided
                        </span>
                      )}
                    </Td>
                    <Td>
                      <div className="flex justify-end gap-1">
                        <EditSaleDialog sale={sale} options={options} />
                        {!voided && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive"
                            onClick={() => setVoidTarget(sale)}
                          >
                            Void
                          </Button>
                        )}
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {hasMore && (
        <p className="text-sm text-muted-foreground">
          Showing the most recent 50 sales in this range. Narrow the dates or the
          filters to see the rest.
        </p>
      )}

      <ReasonDialog
        open={voidTarget !== null}
        onOpenChange={(next) => {
          if (!next) setVoidTarget(null);
        }}
        title="Void this sale?"
        description={
          voidTarget
            ? `${formatMoney(voidTarget.amount)} · ${
                voidTarget.customer?.name ?? "Walk-in"
              }`
            : undefined
        }
        consequence="The sale is kept and marked voided, so the audit trail stays intact. It stops counting towards revenue."
        label="Why is it being voided?"
        placeholder="Rung up twice by mistake"
        confirmLabel="Void sale"
        submitting={voiding}
        onConfirm={(reason) => {
          if (voidTarget) return voidSale(voidTarget, reason);
        }}
      />
    </div>
  );
}

function FilterGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function FilterChip({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "min-h-9 rounded-full border px-3 text-xs font-medium transition-colors",
        selected
          ? "border-primary bg-primary text-primary-foreground"
          : "hover:bg-muted"
      )}
    >
      {children}
    </button>
  );
}

function Th({
  children,
  numeric,
}: {
  children?: React.ReactNode;
  numeric?: boolean;
}) {
  return (
    <th
      className={cn(
        "px-3 py-2 text-xs font-medium text-muted-foreground",
        numeric && "text-right"
      )}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  numeric,
  className,
}: {
  children: React.ReactNode;
  numeric?: boolean;
  className?: string;
}) {
  return (
    <td className={cn("px-3 py-2", numeric && "text-right", className)}>
      {children}
    </td>
  );
}
