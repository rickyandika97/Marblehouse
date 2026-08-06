import Link from "next/link";
import { requireOwnerPage } from "@/server/auth/page-guard";
import {
  listTicketAwardReport,
  ticketAwardReportSchema,
} from "@/server/services/ticket-reports";
import { prisma } from "@/lib/prisma";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatMoney } from "@/lib/money";

export const metadata = { title: "Tickets Awarded by Staff · Marblehouse" };
export const dynamic = "force-dynamic";

export default async function TicketAwardReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireOwnerPage();
  const query = await searchParams;
  const input = ticketAwardReportSchema.parse({
    shopId: one(query.shopId),
    from: one(query.from),
    to: one(query.to),
    cursor: one(query.cursor),
  });
  const [report, shops] = await Promise.all([
    listTicketAwardReport(actor, input),
    prisma.shop.findMany({
      where: { isActive: true, isHqPseudoShop: false },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          Tickets Awarded by Staff
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Review unusual ticket awards against each shop&apos;s sales.
        </p>
      </div>

      <form className="grid gap-3 rounded-xl border p-4 sm:grid-cols-4">
        <label className="text-sm font-medium">
          From
          <Input className="mt-1" type="date" name="from" defaultValue={report.from} />
        </label>
        <label className="text-sm font-medium">
          To
          <Input className="mt-1" type="date" name="to" defaultValue={report.to} />
        </label>
        <label className="text-sm font-medium">
          Shop
          <select
            name="shopId"
            defaultValue={input.shopId ?? ""}
            className="mt-1 h-12 w-full rounded-lg border bg-background px-3 text-base"
          >
            <option value="">All shops</option>
            {shops.map((shop) => (
              <option key={shop.id} value={shop.id}>{shop.name}</option>
            ))}
          </select>
        </label>
        <Button className="self-end" type="submit">Apply</Button>
      </form>

      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-muted/60 text-left">
            <tr>
              <th className="p-3">Date</th>
              <th className="p-3">Shop</th>
              <th className="p-3">Staff</th>
              <th className="p-3 text-right">Tickets</th>
              <th className="p-3 text-right">Shop sales</th>
              <th className="p-3 text-right">Tickets / Rp 1.000</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {report.rows.map((row) => (
              <tr key={`${row.businessDate}:${row.shop.id}:${row.staff.id}`}>
                <td className="p-3 tabular-nums">{row.businessDate}</td>
                <td className="p-3">{row.shop.name}</td>
                <td className="p-3 font-medium">{row.staff.displayName}</td>
                <td className="p-3 text-right font-semibold tabular-nums">
                  {row.ticketsAwarded.toLocaleString("id-ID")}
                </td>
                <td className="p-3 text-right tabular-nums">
                  {formatMoney(row.shopRevenue)}
                </td>
                <td className="p-3 text-right tabular-nums">
                  {row.ticketsPerThousandRupiah ?? "—"}
                </td>
              </tr>
            ))}
            {report.rows.length === 0 && (
              <tr><td className="p-6 text-center text-muted-foreground" colSpan={6}>No ticket awards in this period.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {report.nextCursor !== null && (
        <Button
          variant="outline"
          render={<Link href={nextHref(input, report.nextCursor)} />}
        >
          Next page
        </Button>
      )}
    </div>
  );
}

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function nextHref(
  input: { shopId?: string; from?: string; to?: string },
  cursor: number
): string {
  const params = new URLSearchParams();
  if (input.shopId) params.set("shopId", input.shopId);
  if (input.from) params.set("from", input.from);
  if (input.to) params.set("to", input.to);
  params.set("cursor", String(cursor));
  return `/reports/tickets-awarded?${params}`;
}

