import Link from "next/link";
import type { DetailSaleRow } from "@/server/services/reports";
import {
  EditSaleDialog,
  type SaleEditOptions,
} from "@/components/edit-sale-dialog";
import { ReportTable, formatAmount, formatMoney } from "./report-shell";

/**
 * The list of individual sales behind one row of a §9 sales report.
 *
 * Shared by the three sales drill-downs (by staff, by shop, by payment method)
 * because they show the same rows sliced differently — the only variation is
 * which column would repeat the thing you drilled into, and that is what `omit`
 * removes. Keeping one table means the three screens cannot drift into showing
 * different facts about the same sale.
 */
export function SalesDetailTable({
  rows,
  transactions,
  truncated,
  omit = [],
  empty,
  editOptions,
}: {
  rows: DetailSaleRow[];
  transactions: number;
  truncated: boolean;
  /** Columns the parent screen has already fixed — e.g. Shop on a shop page. */
  omit?: ("staff" | "shop" | "paid")[];
  empty: string;
  /**
   * Owner only (D-181). Null — for a manager, who may read these reports but
   * not edit a sale — drops the column entirely rather than rendering a
   * disabled button, so a manager is never shown a door that 403s.
   *
   * The column is a convenience, not the permission: `updateSale` re-checks
   * `isOwner` on every request (§3.4).
   */
  editOptions?: SaleEditOptions | null;
}) {
  const columns = [
    {
      header: "When",
      cell: (r: DetailSaleRow) => (
        <span className="whitespace-nowrap">
          <span className="block tabular-nums">{r.businessDate}</span>
          <span className="block text-xs text-muted-foreground tabular-nums">
            {new Date(r.occurredAt).toLocaleTimeString("en-GB", {
              hour: "2-digit",
              minute: "2-digit",
              timeZone: "Asia/Jakarta",
            })}
          </span>
        </span>
      ),
    },
    {
      header: "Customer",
      cell: (r: DetailSaleRow) =>
        r.customer ? (
          <Link
            href={`/customers/${r.customer.id}`}
            className="font-medium hover:underline"
          >
            {r.customer.name}
          </Link>
        ) : (
          <span className="text-muted-foreground">Walk-in</span>
        ),
    },
    ...(omit.includes("staff")
      ? []
      : [
          {
            header: "Staff",
            cell: (r: DetailSaleRow) => (
              <span className="text-muted-foreground">{r.staffName}</span>
            ),
          },
        ]),
    ...(omit.includes("shop")
      ? []
      : [
          {
            header: "Shop",
            cell: (r: DetailSaleRow) => (
              <span className="text-muted-foreground">{r.shopName}</span>
            ),
          },
        ]),
    {
      // Not the preset label: a preset is labelled with its own amount
      // ("Rp 50.000"), so showing it would repeat the Amount column on every
      // ordinary row. What is worth flagging is the exception — a keyed-in
      // amount, which §4.3 also writes to the audit log.
      header: "Entry",
      cell: (r: DetailSaleRow) => (
        <span className="text-muted-foreground">
          {r.isCustomAmount ? "Custom" : "Preset"}
        </span>
      ),
    },
    ...(omit.includes("paid")
      ? []
      : [
          {
            header: "Paid",
            cell: (r: DetailSaleRow) =>
              r.paymentMethod === "CASH" ? "Cash" : "Card",
          },
        ]),
    {
      header: "Amount",
      cell: (r: DetailSaleRow) => formatMoney(r.amount),
      numeric: true,
    },
    ...(editOptions
      ? [
          {
            header: "",
            cell: (r: DetailSaleRow) => (
              <EditSaleDialog
                sale={{
                  id: r.id,
                  amount: r.amount,
                  paymentMethod: r.paymentMethod === "CASH" ? "CASH" : "EDC",
                  status: r.status,
                  isCustomAmount: r.isCustomAmount,
                  note: r.note,
                  shopId: r.shopId,
                  occurredAt: r.occurredAt,
                  preset: r.presetId
                    ? { id: r.presetId, label: r.presetLabel ?? "" }
                    : null,
                  customer: r.customer,
                  recordedBy: { id: r.staffId, displayName: r.staffName },
                }}
                options={editOptions}
              />
            ),
          },
        ]
      : []),
  ];

  return (
    <>
      <ReportTable rows={rows} getKey={(r) => r.id} empty={empty} columns={columns} />
      {truncated && (
        <p className="text-sm text-muted-foreground">
          Showing the most recent 500 sales of {formatAmount(transactions)}.
          Narrow the date range to see the rest.
        </p>
      )}
    </>
  );
}
