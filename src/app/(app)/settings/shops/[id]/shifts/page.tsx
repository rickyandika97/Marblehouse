import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireManagerOrOwnerPage, asPageError } from "@/server/auth/page-guard";
import { prisma } from "@/lib/prisma";
import { listShifts } from "@/server/services/shifts";
import { ShiftAdmin } from "./shift-admin";

export const metadata = { title: "Shifts · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Settings → Shops → *this shop* → Shifts (§4.14, §7.7).
 *
 * **Not owner-only**, unlike its sibling price screen. §3.4 gives shift
 * configuration to a manager at their own shops as well, and `shifts.ts`
 * already enforces exactly that (`assertCanManageShifts`: STAFF is refused,
 * everyone else must pass `assertShopAccess`). This page mirrors that rule
 * rather than inventing a stricter one — a manager who can be held to a
 * lateness rule should be able to see and set the shift it is measured from.
 *
 * The other half of D-101's empty start, and the twin of D-103: the API has
 * existed since Phase 6 with no way to reach it.
 */
export default async function ShopShiftsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // MANAGER or OWNER — never STAFF. `shifts.ts` refuses staff every MUTATION
  // but `listShifts` lets them READ (the clock-in screen needs the list), so
  // without this guard the configuration page renders for a staff account with
  // the buttons merely hidden. CLAUDE.md: hiding a button is not a permission.
  // Caught by verify-shops.sh section 11, which saw a 200 where it wanted 403.
  const actor = await requireManagerOrOwnerPage();
  const { id } = await params;

  try {
    // `listShifts` runs `assertShopAccess` — a manager reaching another branch
    // by URL is refused here, server-side, before anything renders. Do this
    // FIRST so the permission decision never depends on the display lookup.
    const shifts = await listShifts(actor, id);

    // Then read the shop for its name and grace. Deliberately NOT `getShop`,
    // which is OWNER-only and would 403 every manager on their own branch —
    // the exact class of bug D-64 records. Access is already settled above.
    const shop = await prisma.shop.findUnique({
      where: { id },
      select: { name: true, code: true, lateGraceMin: true },
    });
    if (!shop) notFound();

    return (
      <div className="space-y-6">
        <div>
          <Link
            href="/settings/shops"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="size-4" />
            Shops
          </Link>
          <h1 className="mt-2 text-2xl font-bold tracking-tight">Shifts</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {shop.name} · {shop.code}. Staff pick one of these when they clock
            in, and lateness is measured from its start time.
          </p>
        </div>

        <ShiftAdmin
          shopId={id}
          shopName={shop.name}
          lateGraceMin={shop.lateGraceMin}
          initialShifts={shifts}
        />
      </div>
    );
  } catch (e) {
    asPageError(e);
  }
}
