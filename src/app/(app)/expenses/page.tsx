import { redirect } from "next/navigation";
import { requireRolePage, asPageError } from "@/server/auth/page-guard";
import { resolveWorkSession } from "@/server/services/work-session";
import { expenseShops } from "@/server/auth/context";
import { listCategories, listExpenses } from "@/server/services/expenses";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/money";
import { ExpenseScreen } from "./expense-screen";
import { ExpenseFilters } from "./expense-filters";

export const metadata = { title: "Expenses · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Expenses (§8.8) — MANAGER and OWNER. STAFF has no expense capability at all
 * (§3.4), which `requireRolePage` enforces before any markup is produced.
 *
 * The shop selector lists every shop the actor may reach, **including HQ**
 * (§4.12) — HQ is the whole reason an owner can record a cost that belongs to
 * no branch. `expenseShops` returns HQ; `selectableShops` deliberately does not
 * (D-54).
 *
 * Filters live in the URL so the list, the running total and the paging cursor
 * all come from ONE `listExpenses` call with one set of parameters. Holding
 * them in client state would have meant the total could drift from the list.
 */
export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string;
    to?: string;
    categoryId?: string;
    shopId?: string;
    cursor?: string;
  }>;
}) {
  const actor = await requireRolePage("OWNER", "MANAGER");

  const { session } = await resolveWorkSession(actor);
  if (!session) redirect("/select-shop");

  const sp = await searchParams;

  // A date arrives from the URL bar and can be anything. The service's Zod
  // schema rejects a malformed one, and on a PAGE that throw is a 500 rather
  // than a usable screen — the same trap D-68 fixed on the report screens.
  // An unparseable value is dropped rather than passed on.
  const from = isIsoDate(sp.from) ? sp.from : undefined;
  const to = isIsoDate(sp.to) ? sp.to : undefined;
  // A half-finished edit, not an error worth refusing.
  const [rangeFrom, rangeTo] =
    from && to && from > to ? [to, from] : [from, to];

  // Shop resolution, in plain terms:
  //   an explicit ?shopId=      → that shop
  //   any OTHER filter present  → all the actor's shops (they are exploring)
  //   no filters at all         → the work-session shop (the default view)
  //
  // The middle case matters: someone who filters by "Rent" across the business
  // expects every branch's rent, not just the branch they happen to be sitting
  // in. `listExpenses` still scopes a manager to their assignments in SQL.
  const explicitShop = sp.shopId;
  const exploring = Boolean(sp.from || sp.to || sp.categoryId);
  const shopId = explicitShop ?? (exploring ? undefined : session.shopId);

  const [categories, listing, shops] = await Promise.all([
    listCategories(actor),
    listExpenses(actor, {
      ...(shopId ? { shopId } : {}),
      ...(sp.categoryId ? { categoryId: sp.categoryId } : {}),
      ...(rangeFrom ? { from: rangeFrom } : {}),
      ...(rangeTo ? { to: rangeTo } : {}),
      ...(sp.cursor ? { cursor: sp.cursor } : {}),
    }).catch(asPageError),
    expenseShops(actor),
  ]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Expenses</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {shopId
            ? (shops.find((s) => s.id === shopId)?.name ?? session.shop.name)
            : "All your shops"}
        </p>
      </div>

      <ExpenseFilters
        from={rangeFrom}
        to={rangeTo}
        categoryId={sp.categoryId}
        shopId={sp.shopId}
        categories={categories.map((c) => ({ id: c.id, name: c.name }))}
        shops={shops.map((s) => ({ id: s.id, name: s.name }))}
        businessDate={actor.businessDate.toISOString().slice(0, 10)}
      />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Total shown
          </CardTitle>
        </CardHeader>
        <CardContent>
          {/* The total covers the whole filtered range, not just this page —
              the service computes it from the same WHERE clause. */}
          <p className="text-3xl font-bold tabular-nums">
            {formatMoney(listing.total)}
          </p>
        </CardContent>
      </Card>

      <ExpenseScreen
        currentShopId={session.shopId}
        shops={shops.map((s) => ({ id: s.id, name: s.name }))}
        categories={categories}
        initialExpenses={listing.expenses}
        canManageCategories={actor.role === "OWNER"}
        nextCursor={listing.nextCursor}
      />
    </div>
  );
}

/** `YYYY-MM-DD`, and a real calendar date — `2026-02-31` is neither. */
function isIsoDate(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
