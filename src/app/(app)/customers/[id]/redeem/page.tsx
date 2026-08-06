import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireActorPage } from "@/server/auth/page-guard";
import { resolveWorkSession } from "@/server/services/work-session";
import { getCustomerForActor } from "@/server/services/customers";
import { listPrizes } from "@/server/services/prizes";
import { Button } from "@/components/ui/button";
import { AppError } from "@/server/errors";
import { RedeemCart, type RedeemablePrize } from "./redeem-cart";

export const metadata = { title: "Redeem · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Redeem prizes for a customer (§8.6).
 *
 * The prize list is fetched server-side so the grid is populated on first
 * paint — staff open this with a customer standing at the counter.
 *
 * Only prizes this shop actually carries are listed: `listPrizes` filters to
 * active `ShopPrizeConfig` rows by default, which matches §4.9's rule that
 * staff see only what is configured at their current shop. The server re-checks
 * that on redemption too, so this is convenience rather than a permission.
 */
export default async function RedeemPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requireActorPage();
  const { id } = await params;

  // Resolve the session here rather than trusting the cached actor — the D-19
  // reason: for a single-shop user the layout auto-selects after `getActor`
  // has already been cached with `workSession: null`.
  const { session } = await resolveWorkSession(actor);
  if (!session) redirect("/select-shop");

  const customer = await getCustomerForActor(actor, id).catch((e) => {
    if (e instanceof AppError && e.code === "NOT_FOUND") notFound();
    throw e;
  });

  const prizes = await listPrizes(actor, { shopId: session.shopId });

  // Deliberately narrowed to the four fields the cart needs. A Purchasing
  // manager's `listPrizes` response carries valuation; passing the whole DTO
  // into a client component would ship cost figures to the browser for a role
  // that may see them on the stock screen but has no reason to hold them here.
  const redeemable: RedeemablePrize[] = prizes
    .filter((p) => p.isActive && p.shopConfig?.isActive)
    .map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      ticketCost: p.ticketCost,
      onHand: p.onHand,
    }));

  return (
    <div className="space-y-5">
      <Button variant="ghost" size="sm" render={<Link href={`/customers/${id}`} />}>
        <ArrowLeft className="size-4" />
        {customer.name}
      </Button>

      <div>
        <h1 className="text-2xl font-bold tracking-tight">Redeem prizes</h1>
        <p className="mt-1 text-sm text-muted-foreground">{session.shop.name}</p>
      </div>

      <RedeemCart
        customerId={customer.id}
        customerName={customer.name}
        ticketBalance={customer.ticketBalance}
        prizes={redeemable}
      />
    </div>
  );
}
