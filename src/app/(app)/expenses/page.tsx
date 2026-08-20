import { redirect } from "next/navigation";
import { requireManagerOrOwnerPage, asPageError } from "@/server/auth/page-guard";
import { resolveWorkSession } from "@/server/services/work-session";
import { expenseShops } from "@/server/auth/context";
import { listCategories, listExpenses } from "@/server/services/expenses";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/money";
import { ExpenseScreen } from "./expense-screen";
import { ExpenseFilters } from "./expense-filters";
import { AddExpense } from "./add-expense";
import { ManageCategoriesDialog } from "./manage-categories-dialog";

export const metadata = { title: "Expenses · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Expenses (§8.8) — MANAGER and OWNER. STAFF has no expense capability at all
 * (§3.4), which `requireManagerOrOwnerPage` enforces before any markup is produced.
 *
 * The shop selector lists every shop the actor may reach, **including HQ**
 * (§4.12) — HQ is the whole reason an owner can record a cost that belongs to
 * no branch. `expenseShops` returns HQ; `selectableShops` deliberately does not
 * (D-54).
 *
 * Filters live in the URL so the list, the running total and the paging cursor
 * all come from ONE `listExpenses` call with one set of parameters. Holding
 * them in client state would have meant the total could drift from the list.
 *
 * With no filters in the URL at all, the screen defaults to the current
 * business month, the work-session shop, and every category — the view a
 * manager checking their own branch's month-to-date wants on first load.
 * Recording an expense and managing categories are both modals now
 * (`AddExpense`, `ManageCategoriesDialog`); this page's job is the history.
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
  const actor = await requireManagerOrOwnerPage();

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
  const [explicitFrom, explicitTo] =
    from && to && from > to ? [to, from] : [from, to];

  // No filters at all in the URL → default to the current business month,
  // rather than an unbounded "everything ever recorded" list. Any explicit
  // date filter (including a preset click, which always sets both) overrides
  // this outright.
  const businessDate = actor.businessDate.toISOString().slice(0, 10);
  const hasDateFilter = Boolean(explicitFrom || explicitTo);
  const [rangeFrom, rangeTo] = hasDateFilter
    ? [explicitFrom, explicitTo]
    : [monthStart(businessDate), businessDate];

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

  // Nothing at all in the URL — the page is showing its own defaults rather
  // than anything the user picked, so "Clear" has nothing to do yet.
  const isDefaultView = !hasDateFilter && !sp.categoryId && !sp.shopId;

  // Two different lists on purpose: the add form and the filter chips must
  // only offer LIVE categories, but the owner's manage-categories modal is the
  // one place archived categories still need to appear (to be restored).
  const [categories, allCategories, listing, shops] = await Promise.all([
    listCategories(actor),
    actor.isOwner
      ? listCategories(actor, { includeArchived: true })
      : Promise.resolve(undefined),
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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Expenses</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {shopId
              ? (shops.find((s) => s.id === shopId)?.name ?? session.shop.name)
              : "All your shops"}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {actor.isOwner && (
            <ManageCategoriesDialog initialCategories={allCategories ?? []} />
          )}
          <AddExpense
            currentShopId={session.shopId}
            shops={shops.map((s) => ({ id: s.id, name: s.name }))}
            categories={categories}
            businessDate={businessDate}
          />
        </div>
      </div>

      <ExpenseFilters
        from={rangeFrom}
        to={rangeTo}
        categoryId={sp.categoryId}
        shopId={shopId}
        categories={categories.map((c) => ({ id: c.id, name: c.name }))}
        shops={shops.map((s) => ({ id: s.id, name: s.name }))}
        businessDate={businessDate}
        isDefaultView={isDefaultView}
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
        categories={categories}
        initialExpenses={listing.expenses}
        nextCursor={listing.nextCursor}
        canEdit={actor.isOwner}
      />
    </div>
  );
}

/** First day of the month containing `businessDate`, as `YYYY-MM-DD`. */
function monthStart(businessDate: string): string {
  const d = new Date(`${businessDate}T00:00:00.000Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
}

/** `YYYY-MM-DD`, and a real calendar date — `2026-02-31` is neither. */
function isIsoDate(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
