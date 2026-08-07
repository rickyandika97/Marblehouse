"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { Role } from "@prisma/client";
import {
  LayoutDashboard,
  BarChart3,
  LogOut,
  Package,
  Settings,
  ShoppingCart,
  Clock,
  Store,
  User,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AttendanceBanner } from "@/components/attendance-banner";

/**
 * Role-dependent bottom tab bar (§8.0).
 *
 * These tabs are a convenience, NOT a permission. Every destination re-checks
 * the role server-side; hiding a tab only saves the user a pointless tap.
 *
 * Phase 1 shipped Dashboard, Sale and Settings; Phase 4 adds Stock for the
 * roles that manage it. The remaining tabs belong to later phases and are
 * deliberately absent rather than rendered as dead links.
 *
 * STAFF gets no Stock tab: §3.4 gives them redemption but not receiving or
 * opname, and they reach the prize grid from a customer instead (§8.6).
 */
const TABS: Record<Role, { href: string; label: string; icon: typeof User }[]> = {
  // Six tabs is one more than is comfortable on a phone, but the nav is the
  // ONLY route to Reports — dropping it to make room for Stock would strand a
  // working screen. Phase 10's polish pass should fold Reports and Settings
  // into a single "More" tab rather than removing either.
  OWNER: [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/sale", label: "Sales", icon: ShoppingCart },
    { href: "/customers", label: "Customers", icon: Users },
    { href: "/stock", label: "Stock", icon: Package },
    { href: "/reports/tickets-awarded", label: "Reports", icon: BarChart3 },
    { href: "/settings", label: "Settings", icon: Settings },
  ],
  MANAGER: [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/sale", label: "Sale", icon: ShoppingCart },
    { href: "/customers", label: "Customers", icon: Users },
    { href: "/stock", label: "Stock", icon: Package },
    { href: "/attendance", label: "Attendance", icon: Clock },
    { href: "/settings", label: "Settings", icon: Settings },
  ],
  STAFF: [
    { href: "/sale", label: "Sale", icon: ShoppingCart },
    { href: "/customers", label: "Customers", icon: Users },
    { href: "/attendance", label: "Attendance", icon: Clock },
    { href: "/settings", label: "Me", icon: User },
  ],
};

const ROLE_LABEL: Record<Role, string> = {
  OWNER: "Owner",
  MANAGER: "Manager",
  STAFF: "Staff",
};

export function AppShell({
  displayName,
  role,
  shopName,
  children,
}: {
  displayName: string;
  role: Role;
  shopName: string | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const tabs = TABS[role];

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen flex-col">
      {/* Top bar (§8.0): shop name, user, role chip, logout. */}
      <header className="sticky top-0 z-40 border-b bg-background">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-3 px-4">
          <Link
            href="/settings/shop"
            className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 hover:bg-muted"
            title="Change today's shop"
          >
            <Store className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate font-semibold">
              {shopName ?? "No shop selected"}
            </span>
          </Link>

          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-sm text-muted-foreground sm:inline">
              {displayName}
            </span>
            <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium">
              {ROLE_LABEL[role]}
            </span>
            <button
              type="button"
              onClick={signOut}
              aria-label="Sign out"
              className="flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <LogOut className="size-5" />
            </button>
          </div>
        </div>
      </header>

      {/*
        The red attendance banner (§4.13). Not dismissible by design — it
        clears only when the user has actually clocked in. OWNER never sees it
        (attendance is optional for them), and the component decides that from
        the server's answer rather than from the role prop.
      */}
      <AttendanceBanner />

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 pb-24">
        {children}
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-40 border-t bg-background">
        <ul className="mx-auto flex w-full max-w-5xl">
          {tabs.map((tab) => {
            const active =
              pathname === tab.href || pathname.startsWith(`${tab.href}/`);
            const Icon = tab.icon;

            return (
              <li key={tab.href} className="flex-1">
                <Link
                  href={tab.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-16 flex-col items-center justify-center gap-1 text-xs font-medium",
                    active
                      ? "text-primary"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <Icon className="size-5" />
                  {tab.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
