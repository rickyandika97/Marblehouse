import Link from "next/link";
import { Download } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { formatAmount, formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import { selectableShops, type Actor } from "@/server/auth/context";
import { ReportFilters, type ShopOption } from "./report-filters";

/**
 * Shared furniture for the §9 report screens.
 *
 * Every report is a title, a date range, filters, an optional export button and
 * a table. Keeping that in one place is what makes the individual report pages
 * thin readers over `services/reports.ts` rather than seven copies of a layout
 * — and it means the filter control was added to all seven screens at once.
 *
 * The export link is only rendered when the caller passes `exportName`, and
 * the endpoint behind it re-checks the role server-side — a rendered button is
 * never a permission (§3.4).
 */
export function ReportShell({
  title,
  description,
  from,
  to,
  exportName,
  shopId,
  shops,
  canSeeAllShops,
  businessDate,
  children,
}: {
  title: string;
  description?: string;
  from: string;
  to: string;
  exportName?: string;
  shopId?: string;
  /** Shops this actor may filter to. Omit to hide the picker entirely. */
  shops?: ShopOption[];
  /** OWNER only — a manager gets one shop at a time (§3.4). */
  canSeeAllShops?: boolean;
  businessDate?: string;
  children: React.ReactNode;
}) {
  const params = new URLSearchParams({ from, to });
  if (shopId) params.set("shopId", shopId);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {description ? `${description} · ` : ""}
            {from} to {to}
          </p>
        </div>
        {exportName && (
          // Carries the CURRENT filters, so the CSV matches what is on screen.
          // An export that silently ignored the filter would be worse than no
          // export — you would not notice until the numbers were in a
          // spreadsheet.
          <Link
            href={`/api/reports/${exportName}/export?${params.toString()}`}
            prefetch={false}
            className="inline-flex min-h-11 items-center gap-2 rounded-md border px-4 text-sm font-medium hover:bg-muted"
          >
            <Download className="size-4" />
            Export CSV
          </Link>
        )}
      </div>

      {businessDate && (
        <ReportFilters
          from={from}
          to={to}
          shopId={shopId}
          shops={shops ?? []}
          canSeeAllShops={canSeeAllShops ?? false}
          businessDate={businessDate}
        />
      )}

      {children}
    </div>
  );
}

/** A simple table. Report data is tabular; this keeps every screen consistent. */
export function ReportTable<Row>({
  rows,
  columns,
  empty = "Nothing in this period.",
  getKey,
}: {
  rows: Row[];
  columns: {
    header: string;
    cell: (row: Row) => React.ReactNode;
    numeric?: boolean;
  }[];
  empty?: string;
  getKey: (row: Row, index: number) => string;
}) {
  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          {empty}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      {/* Wide tables scroll inside their own container rather than pushing the
          page sideways on a tablet (§8.11). */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase text-muted-foreground">
              {columns.map((c) => (
                <th
                  key={c.header}
                  className={`px-4 py-3 font-medium ${c.numeric ? "text-right" : ""}`}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={getKey(row, i)} className="border-b last:border-0">
                {columns.map((c) => (
                  <td
                    key={c.header}
                    className={`px-4 py-3 ${c.numeric ? "text-right tabular-nums" : ""}`}
                  >
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** A row of headline figures above a table. */
export function ReportTotals({
  items,
  contentClassName,
}: {
  items: { label: string; value: string; hint?: string }[];
  /** Lets a dense dashboard-style report opt out of the extra top inset. */
  contentClassName?: string;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {items.map((it) => (
        <Card key={it.label}>
          <CardContent className={cn("pt-6", contentClassName)}>
            <p className="text-xs font-medium text-muted-foreground">{it.label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{it.value}</p>
            {it.hint && <p className="mt-0.5 text-xs text-muted-foreground">{it.hint}</p>}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export { formatMoney, formatAmount };

/**
 * Resolve the date range for a report page from its search params.
 *
 * Defaults to the last 30 days ending on the actor's business date — never
 * `new Date()`, which would drift across the 04:00 cutoff and disagree with
 * every stored `businessDate` (§4.2, D-18).
 */
export function rangeFrom(
  searchParams: { from?: string; to?: string },
  businessDate: Date
): { from: string; to: string } {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const fallbackTo = iso(businessDate);
  const fallbackFrom = iso(new Date(businessDate.getTime() - 29 * 86_400_000));

  // A date arrives here from the URL bar, so it can be anything. The service
  // throws VALIDATION_FAILED for a malformed or inverted range — correct for an
  // API, but on a PAGE an uncaught throw is a 500, and a mistyped date is
  // ordinary user input rather than an error worth a crash screen.
  //
  // So a bad value falls back to the default window instead. The filter bar
  // then renders showing the range actually in use, which tells the user what
  // happened without a stack trace.
  let to = isIsoDate(searchParams.to) ? searchParams.to! : fallbackTo;
  let from = isIsoDate(searchParams.from) ? searchParams.from! : fallbackFrom;

  // An inverted range is almost always a half-finished edit — the user changed
  // "from" and has not yet changed "to". Swapping is friendlier than refusing,
  // and cannot produce a wrong number: the range it yields is the one they
  // described, just the right way round.
  if (from > to) [from, to] = [to, from];

  return { from, to };
}

/** `YYYY-MM-DD`, and a real calendar date — `2026-02-31` is neither. */
function isIsoDate(value: string | undefined): boolean {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Everything `ReportShell` needs for its filter bar, resolved for one actor.
 *
 * A single helper so all seven report pages populate the picker identically —
 * `selectableShops` already scopes to assignments for a manager and excludes
 * the HQ pseudo-shop, which records no sales and so has no place in a reports
 * picker (§4.12, D-54).
 */
export async function filterPropsFor(
  actor: Actor
): Promise<{
  shops: ShopOption[];
  canSeeAllShops: boolean;
  businessDate: string;
}> {
  const shops = await selectableShops(actor);
  return {
    shops: shops.map((s) => ({ id: s.id, name: s.name })),
    canSeeAllShops: actor.isOwner,
    businessDate: actor.businessDate.toISOString().slice(0, 10),
  };
}
