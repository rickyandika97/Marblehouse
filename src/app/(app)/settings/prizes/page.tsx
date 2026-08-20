import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireManagerOrOwnerPage, asPageError } from "@/server/auth/page-guard";
import { resolveWorkSession } from "@/server/services/work-session";
import { listPrizes } from "@/server/services/prizes";
import { PrizeAdmin } from "./prize-admin";

export const metadata = { title: "Prizes · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Settings → Prizes: the catalog (§4.8, §7.4). OWNER and MANAGER.
 *
 * Before this existed the catalog had no UI at all — the routes and services
 * shipped in Phase 5, but a prize could only be created by the seed or by SQL.
 * The Stock screen's Receive tab picks from a `<select>` of existing items, so
 * a fresh branch could never stock anything, and `redeem-cart.tsx` told the
 * user "a manager can add them" while pointing at nothing (D-116).
 *
 * MANAGER reaches this deliberately, matching what `POST /api/prizes` and
 * `PATCH /api/prizes/:id` have always allowed — this screen widens no
 * permission, it just stops the existing one being unreachable. The
 * consequence a manager must understand is that **the catalog is global**: a
 * reprice lands at every branch, including ones they do not manage. That is
 * why the reprice field carries a warning naming the branch count, and why
 * `updatePrize` raises an owner alert (§4.8).
 *
 * Scope comes from the WORK SESSION rather than a picker, because `listPrizes`
 * needs a shop for on-hand and low-stock, and `assertShopAccess` must pass for
 * a manager. The catalog rows themselves are global; the shop only decides
 * which stock figures sit beside them.
 */
export default async function PrizeCatalogPage() {
  const actor = await requireManagerOrOwnerPage();

  const { session } = await resolveWorkSession(actor);
  if (!session) redirect("/select-shop");

  try {
    // `includeUnstocked` is what makes this the CATALOG rather than the shop's
    // shelf — without it, an item this branch does not carry is invisible and
    // could never be edited from here.
    const prizes = await listPrizes(actor, {
      shopId: session.shopId,
      includeUnstocked: true,
    });

    return (
      <div className="space-y-6">
        <div>
          <Link
            href="/settings"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="size-4" />
            Settings
          </Link>
          <h1 className="mt-2 text-2xl font-bold tracking-tight">Prizes</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The prize catalog, shared by every branch. Stock figures shown are
            for {session.shop.name}.
          </p>
        </div>

        <PrizeAdmin shopName={session.shop.name} initialPrizes={prizes} />
      </div>
    );
  } catch (e) {
    asPageError(e);
  }
}
