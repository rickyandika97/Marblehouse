import { redirect } from "next/navigation";
import { requireRolePage } from "@/server/auth/page-guard";
import { resolveWorkSession } from "@/server/services/work-session";
import { expenseShops } from "@/server/auth/context";
import { listCategories, listExpenses } from "@/server/services/expenses";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/money";
import { ExpenseScreen } from "./expense-screen";

export const metadata = { title: "Expenses · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Expenses (§8.8) — MANAGER and OWNER. STAFF has no expense capability at all
 * (§3.4), which `requireRolePage` enforces before any markup is produced.
 *
 * The shop selector lists every shop the actor may reach, **including HQ**
 * (§4.12) — HQ is the whole reason an owner can record a cost that belongs to
 * no branch. `selectableShops` already returns HQ for an owner.
 */
export default async function ExpensesPage() {
  const actor = await requireRolePage("OWNER", "MANAGER");

  const { session } = await resolveWorkSession(actor);
  if (!session) redirect("/select-shop");

  const [categories, initial, shops] = await Promise.all([
    listCategories(actor),
    listExpenses(actor, { shopId: session.shopId }),
    expenseShops(actor),
  ]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Expenses</h1>
        <p className="mt-1 text-sm text-muted-foreground">{session.shop.name}</p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Total shown
          </CardTitle>
        </CardHeader>
        <CardContent>
          {/* The total covers the whole filtered range, not just the page. */}
          <p className="text-3xl font-bold tabular-nums">
            {formatMoney(initial.total)}
          </p>
        </CardContent>
      </Card>

      <ExpenseScreen
        currentShopId={session.shopId}
        shops={shops.map((s) => ({ id: s.id, name: s.name }))}
        categories={categories}
        initialExpenses={initial.expenses}
        canManageCategories={actor.role === "OWNER"}
      />
    </div>
  );
}
