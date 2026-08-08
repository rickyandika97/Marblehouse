import Link from "next/link";
import { Download } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { formatAmount, formatMoney } from "@/lib/money";

/**
 * Shared furniture for the §9 report screens.
 *
 * Every report is a title, a date range, an optional export button and a
 * table. Keeping that in one place is what makes the individual report pages
 * thin readers over `services/reports.ts` rather than six copies of a layout.
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
  children,
}: {
  title: string;
  description?: string;
  from: string;
  to: string;
  exportName?: string;
  shopId?: string;
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
}: {
  items: { label: string; value: string; hint?: string }[];
}) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {items.map((it) => (
        <Card key={it.label}>
          <CardContent className="pt-6">
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
  const to = searchParams.to ?? iso(businessDate);
  const from =
    searchParams.from ?? iso(new Date(businessDate.getTime() - 29 * 86_400_000));
  return { from, to };
}
