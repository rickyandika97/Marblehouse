import Link from "next/link";
import { redirect } from "next/navigation";
import { requireRolePage } from "@/server/auth/page-guard";
import { resolveWorkSession } from "@/server/services/work-session";
import { listPrizes } from "@/server/services/prizes";
import { countUncostedBatches } from "@/server/services/stock";
import { canSeeCostForShop, selectableShops } from "@/server/auth/context";
import { listTransfers } from "@/server/services/transfers";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/money";
import type { PrizeCostDTO } from "@/server/dto/prize";
import { StockTabs } from "./stock-tabs";

export const metadata = { title: "Stock · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Stock management (§8.7) — MANAGER and OWNER.
 *
 * §8.7's five tabs are all present as of Phase 5: On hand · Receive ·
 * Transfers · Opname · Low stock. (Transfers and Opname were deliberately
 * absent in Phase 4 rather than stubbed — see BUILD-LOG D-35.)
 *
 * Cost columns are decided HERE, server-side, and the client component is only
 * ever handed what the role may see (§7.5). `listPrizes` already returns the
 * restricted shape for a plain manager, so there is no cost figure in the page
 * payload to leak into the HTML.
 */
export default async function StockPage() {
  const actor = await requireRolePage("OWNER", "MANAGER");

  const { session } = await resolveWorkSession(actor);
  if (!session) redirect("/select-shop");

  const [prizes, uncostedCount, transfers, shops] = await Promise.all([
    listPrizes(actor, { shopId: session.shopId, includeUnstocked: true }),
    countUncostedBatches(actor),
    listTransfers(actor, { shopId: session.shopId }),
    selectableShops(actor),
  ]);

  const showCost = canSeeCostForShop(actor, session.shopId);

  // Only read valuation off the DTO when the gate says it is there. The cast is
  // safe precisely because `showCost` mirrors what the service branched on.
  const totalValuation = showCost
    ? (prizes as PrizeCostDTO[]).reduce(
        (sum, p) => sum + Number(p.stockValuation ?? 0),
        0
      )
    : null;

  const stocked = prizes.filter((p) => p.shopConfig?.isActive);
  const lowStock = stocked.filter((p) => p.isLowStock);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Stock</h1>
        <p className="mt-1 text-sm text-muted-foreground">{session.shop.name}</p>
      </div>

      {/*
        §7.5: while any batch is uncosted, prize expense is understated. The
        owner needs telling, and a Purchasing manager can act on it.
      */}
      {showCost && uncostedCount > 0 && (
        <Link
          href="/stock/uncosted"
          className="block rounded-xl border-2 border-amber-400 bg-amber-50 p-4 text-sm text-amber-950 hover:bg-amber-100"
        >
          <p className="font-semibold">
            {uncostedCount} {uncostedCount === 1 ? "batch is" : "batches are"} waiting
            for a cost.
          </p>
          <p className="mt-1">
            Prize expense is understated until every delivery has a unit cost.
            Tap to price them.
          </p>
        </Link>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Items stocked
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold tabular-nums">{stocked.length}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {showCost ? "Stock value" : "Low stock"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold tabular-nums">
              {showCost && totalValuation !== null
                ? formatMoney(totalValuation)
                : lowStock.length}
            </p>
          </CardContent>
        </Card>
      </div>

      <StockTabs
        shopId={session.shopId}
        prizes={prizes}
        showCost={showCost}
        canReceive
        transfers={transfers}
        // Never offer the current shop as its own destination (§4.10).
        destinations={shops
          .filter((s) => s.id !== session.shopId)
          .map((s) => ({ id: s.id, name: s.name, code: s.code }))}
      />
    </div>
  );
}
