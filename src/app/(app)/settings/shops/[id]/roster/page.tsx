import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireManagerOrOwnerPage, asPageError } from "@/server/auth/page-guard";
import { prisma } from "@/lib/prisma";
import { listShifts } from "@/server/services/shifts";
import {
  listAssignments,
  listLeave,
  resolveWeek,
} from "@/server/services/schedule";
import { RosterAdmin } from "./roster-admin";

export const metadata = { title: "Roster · Marblehouse" };
export const dynamic = "force-dynamic";

/** The Monday of the week containing `from`, as `YYYY-MM-DD`. */
function mondayOf(from: Date): string {
  const day = from.getUTCDay();
  // getUTCDay is 0 = Sunday; Monday is the start of a working week here, so
  // Sunday belongs to the week that has just ended, not the one beginning.
  const back = day === 0 ? 6 : day - 1;
  return new Date(from.getTime() - back * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Settings → Shops → *this shop* → Roster (§4.14.1).
 *
 * **Manager-or-owner, matching Shifts rather than Prices.** §3.4 delegates
 * shift configuration to a manager at their own branch, and rostering is the
 * same class of decision — a manager who runs the branch decides who is on it.
 * `schedule.ts` enforces exactly that (`assertCanManageSchedule`); this page
 * mirrors the service instead of inventing a stricter rule.
 *
 * STAFF are refused outright rather than shown a read-only page: D-106 records
 * why a rendered configuration screen with hidden buttons is not a permission.
 */
export default async function ShopRosterPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ week?: string }>;
}) {
  const actor = await requireManagerOrOwnerPage();
  const { id } = await params;
  const { week } = await searchParams;

  try {
    const startDate = week ?? mondayOf(actor.businessDate);

    // `listShifts` runs `assertShopAccess` first, so a manager reaching another
    // branch by URL is refused server-side before anything renders — the same
    // ordering the Shifts page uses, and for the same reason.
    const shifts = await listShifts(actor, id);
    /**
     * `includeRemoved` so a removed schedule can be restored after a mis-tap
     * (D-140). Removed rows are rendered apart from the live roster and
     * collapsed by default — keeping them out of the way is the whole reason
     * Remove exists.
     */
    const [assignments, grid, leave] = await Promise.all([
      listAssignments(actor, id, { includeRemoved: true }),
      resolveWeek(actor, id, startDate),
      listLeave(actor, id),
    ]);

    // NOT `getShop`, which is OWNER-only and would 403 a manager on their own
    // branch (D-64). Access is already settled above.
    const shop = await prisma.shop.findUnique({
      where: { id },
      select: { name: true, code: true, isHqPseudoShop: true },
    });
    if (!shop) notFound();

    // Who can be rostered here at all. The service refuses anyone without a
    // UserShop row, so offering them in the picker would only produce errors.
    const staff = await prisma.userShop.findMany({
      where: { shopId: id, user: { banned: false } },
      select: {
        userId: true,
        role: true,
        user: { select: { displayName: true, username: true } },
      },
      orderBy: [{ role: "asc" }, { user: { displayName: "asc" } }],
    });

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
          <h1 className="mt-2 text-2xl font-bold tracking-tight">Roster</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {shop.name} · {shop.code}. Who works which shift, and when. Staff
            are greeted with a clock-in prompt only on the days they are
            rostered here.
          </p>
        </div>

        <RosterAdmin
          shopId={id}
          startDate={startDate}
          shifts={shifts.filter((s) => s.isActive)}
          staff={staff.map((s) => ({
            userId: s.userId,
            name: s.user.displayName,
            username: s.user.username ?? "",
            role: s.role,
          }))}
          initialAssignments={assignments}
          initialGrid={grid.days}
          initialLeave={leave}
        />
      </div>
    );
  } catch (e) {
    asPageError(e);
  }
}
