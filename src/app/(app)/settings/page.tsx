import Link from "next/link";
import {
  ChevronRight,
  DatabaseBackup,
  KeyRound,
  Receipt,
  ScrollText,
  Settings2,
  Store,
  Users,
} from "lucide-react";
import { requireActorPage } from "@/server/auth/page-guard";
import { Card } from "@/components/ui/card";

export const metadata = { title: "Settings · Marblehouse" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const actor = await requireActorPage();

  // D-122: role is per-shop — "not staff-only" now means "owner, or manager
  // at at least one shop", matching how the bottom nav decides the same
  // thing (app-shell.tsx).
  // D-138: the role that matters is the one at TODAY'S shop. "Manager at at
  // least one shop" offered the manager settings to someone working a shift
  // where they are only staff.
  const todayShopId = actor.workSession?.shopId ?? actor.defaultShopId ?? null;
  const isStaffOnly =
    !actor.isOwner &&
    (todayShopId === null ||
      actor.shopRoles.get(todayShopId)?.role !== "MANAGER");

  const items = [
    {
      href: "/settings/shops",
      icon: Store,
      title: "Shops",
      description:
        actor.isOwner
          ? "Pick today's shop, add a branch, or change its options and late grace"
          : actor.workSession
            ? `Working at ${actor.workSession.shop.name} today`
            : "Choose today's shop",
      show: true,
    },
    {
      href: "/settings/employees",
      icon: Users,
      title: "Employees",
      description: "Create accounts, set each shop's role and access",
      // Shown only to the owner — but the page enforces it again server-side.
      show: actor.isOwner,
    },
    {
      href: "/expenses",
      icon: Receipt,
      title: "Expenses",
      description:
        "Record and review branch and head-office costs, and manage categories",
      // Not a bottom-nav tab: OWNER and MANAGER are already at six, which
      // D-36 records as one more than fits a phone. Reached from here until
      // Phase 10 folds the nav behind a "More" tab.
      show: !isStaffOnly,
    },

    {
      href: "/settings/backups",
      icon: DatabaseBackup,
      title: "Backups",
      description: "Download a backup and record your off-machine copy",
      show: actor.isOwner,
    },
    {
      href: "/settings/audit-log",
      icon: ScrollText,
      title: "Audit log",
      description: "Every privileged change, with who and when",
      show: actor.isOwner,
    },
    {
      href: "/change-password",
      icon: KeyRound,
      title: "Change password",
      description: "Update the password for this account",
      show: true,
    },
    {
      href: "/settings/system",
      icon: Settings2,
      title: "System",
      description: "Ticket-award controls and business-wide settings",
      show: actor.isOwner,
    },
  ].filter((i) => i.show);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Signed in as {actor.displayName}.
        </p>
      </div>

      <Card className="divide-y p-0">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className="flex min-h-16 items-center gap-4 px-4 py-3 hover:bg-muted"
            >
              <Icon className="size-5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{item.title}</span>
                <span className="block truncate text-sm text-muted-foreground">
                  {item.description}
                </span>
              </span>
              <ChevronRight className="size-5 shrink-0 text-muted-foreground" />
            </Link>
          );
        })}
      </Card>
    </div>
  );
}
