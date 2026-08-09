import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { requireManagerOrOwnerPage } from "@/server/auth/page-guard";
import { canSeeCost } from "@/server/auth/context";

export const metadata = { title: "Reports · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Reports index (§9).
 *
 * Each entry links to a screen that enforces its OWN role server-side, so this
 * list is about reachability, not permission. Owner-only reports are hidden
 * from a manager here purely so they are not offered a door that will 403 —
 * hiding the link is never what stops them (§3.4).
 */
const REPORTS: {
  href: string;
  title: string;
  description: string;
  ownerOnly?: boolean;
  /**
   * Visible to anyone who may see cost — the OWNER, and a **Purchasing**
   * manager for their own shops (§7.5). Distinct from `ownerOnly`: using that
   * here would hide a screen a Purchasing manager is entitled to, which is the
   * D-34 bug in its "hidden" form rather than its "403" form.
   */
  costOnly?: boolean;
}[] = [
  {
    href: "/reports/sales",
    title: "Daily Sales Summary",
    description: "Revenue, transactions and customers by day, shop and staff.",
  },
  {
    href: "/reports/sales-by-staff",
    title: "Sales by Staff",
    description: "Revenue and average sale per staff member.",
  },
  {
    href: "/reports/sales-by-shop",
    title: "Sales by Shop",
    description: "Branch-by-branch revenue and share of the total.",
  },
  {
    href: "/reports/payment-methods",
    title: "Payment Method Breakdown",
    description: "Cash against card and QRIS — what should be in the drawer.",
  },
  {
    href: "/reports/prize-redemption",
    title: "Prize Redemption",
    description: "What customers took home, and the tickets they spent.",
  },
  {
    href: "/reports/attendance",
    title: "Attendance & Lateness",
    description: "Late counts and late rate per staff member.",
  },
  {
    href: "/reports/expenses",
    title: "Expense Report",
    description: "Operating expenses by category.",
  },
  {
    href: "/reports/low-stock",
    title: "Low Stock",
    description: "Items at or below their branch threshold.",
  },
  {
    href: "/reports/prize-expense",
    title: "Prize Expense (FIFO)",
    description: "True cost of prizes handed out, and shrinkage, separately.",
    ownerOnly: true,
  },
  {
    href: "/reports/stock-valuation",
    title: "Stock Valuation",
    description: "Value of stock on hand, per branch.",
    ownerOnly: true,
  },
  {
    href: "/reports/shrinkage",
    title: "Shrinkage",
    description: "Stock lost at a count or written off as damaged.",
    // Cost-bearing, so a PURCHASING manager may see it for their own shops —
    // `costOnly`, not `ownerOnly`. Marking it owner-only would repeat D-34
    // exactly: hiding a screen the person is entitled to.
    costOnly: true,
  },
  {
    href: "/reports/customers",
    title: "Customer Spend Leaderboard",
    description: "Lifetime value, visits and balances per customer.",
    ownerOnly: true,
  },
  {
    href: "/reports/profit",
    title: "Profit & Loss per Shop",
    description: "Revenue less prize expense, shrinkage and operating costs.",
    ownerOnly: true,
  },
  {
    href: "/reports/liability",
    title: "Liability",
    description: "Outstanding marbles and tickets, and what they are worth.",
    ownerOnly: true,
  },
  {
    href: "/reports/tickets-awarded",
    title: "Tickets Awarded by Staff",
    description: "The §4.6 fraud control — tickets per rupiah of sales.",
    ownerOnly: true,
  },
];

export default async function ReportsIndexPage() {
  const actor = await requireManagerOrOwnerPage();
  const visible = REPORTS.filter((r) => {
    if (r.ownerOnly) return actor.role === "OWNER";
    // canSeeCost is the same predicate the services use, so the list cannot
    // drift from what the screens actually allow.
    if (r.costOnly) return canSeeCost(actor);
    return true;
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Reports</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {actor.role === "OWNER"
            ? "All shops, or one at a time."
            : "Your shop. Cost and profit figures are owner-only."}
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {visible.map((r) => (
          <Link key={r.href} href={r.href} className="block">
            <Card className="transition-colors hover:bg-muted/50">
              <CardContent className="flex min-h-11 items-center gap-3 py-4">
                <div className="flex-1">
                  <p className="font-medium">{r.title}</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {r.description}
                  </p>
                </div>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
