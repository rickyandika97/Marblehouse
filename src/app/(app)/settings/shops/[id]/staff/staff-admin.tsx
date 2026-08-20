"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, UserMinus, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface StaffRow {
  id: string;
  username: string | null;
  displayName: string;
  isOwner: boolean;
  isActive: boolean;
  mustChangePassword: boolean;
  /** This employee's role, Purchasing flag and shop name at EVERY shop they
   *  hold (D-122: role is per-shop). Use `.find(s => s.shopId === shopId)`
   *  for "their role here". */
  shopRoles: { shopId: string; role: "MANAGER" | "STAFF"; canEnterCost: boolean }[];
  /** True when this shop is their ONLY one — unassigning would strand them. */
  isOnlyShop: boolean;
}

/**
 * Settings → Shops → *shop* → Staff.
 *
 * Toggles one (user, shop) pair at a time. Deliberately NOT a "save the whole
 * list" form: `updateUser` replaces a user's entire shop array, so a stale
 * checkbox on this screen could revoke a branch the owner was not looking at.
 * One tap, one pair, no read-modify-write.
 *
 * Creating accounts stays in Settings → Users — this screen answers "who works
 * here?", not "who exists?".
 */
export function StaffAdmin({
  shopId,
  shopName,
  initialAssigned,
  initialAvailable,
}: {
  shopId: string;
  shopName: string;
  initialAssigned: StaffRow[];
  initialAvailable: StaffRow[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function setAssigned(
    user: StaffRow,
    assigned: boolean,
    role?: "MANAGER" | "STAFF",
  ) {
    setBusy(user.id);
    try {
      const res = await fetch(`/api/shops/${shopId}/staff`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, assigned, role }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        // The "this is their only shop" refusal lands here. The server's
        // message already names the person and the way out.
        toast.error(body?.error?.message ?? "Could not update that assignment.");
        return;
      }
      toast.success(
        assigned
          ? `${user.displayName} can now work at ${shopName}`
          : `${user.displayName} removed from ${shopName}`,
      );
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  function roleHere(u: StaffRow): "MANAGER" | "STAFF" {
    return u.shopRoles.find((s) => s.shopId === shopId)?.role ?? "STAFF";
  }

  // Managers before staff (owner request, 2026-08-20) — their role AT THIS
  // SHOP, since D-122 made role per-shop, so this has to be sorted here
  // rather than server-side without re-scoping the whole staff query — then
  // alphabetical by display name within each group. This is a full re-sort,
  // so `listShopStaff`'s active-before-deactivated ordering does not carry
  // through; a deactivated manager can sort ahead of an active one. Their
  // "Deactivated" badge is still shown inline, and nothing else on this
  // screen groups by active/deactivated, so this was not treated as a
  // property worth preserving.
  const assignedSorted = [...initialAssigned].sort((a, b) => {
    const roleDiff =
      (roleHere(a) === "MANAGER" ? 0 : 1) - (roleHere(b) === "MANAGER" ? 0 : 1);
    return roleDiff !== 0 ? roleDiff : a.displayName.localeCompare(b.displayName);
  });

  return (
    <div className="space-y-6">
      {initialAssigned.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Nobody works here yet</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {shopName} will not appear in anyone&apos;s shop picker, so no
              sale, stock movement or clock-in can be recorded here. Assign
              someone below.
            </p>
            {initialAvailable.length === 0 && (
              <p className="text-sm text-muted-foreground">
                There are no other accounts to assign yet — create one first.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {initialAssigned.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Works here</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y">
              {assignedSorted.map((u) => (
                <li key={u.id} className="flex items-center gap-3 px-6 py-4">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {u.displayName}
                      {!u.isActive && (
                        <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                          Deactivated
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-sm text-muted-foreground">
                      {u.username}
                      {u.shopRoles.find((s) => s.shopId === shopId)?.canEnterCost &&
                        " · purchasing"}
                    </span>
                    {/*
                      Say it before they tap, not after a failed toast. The
                      server refuses regardless — this is the explanation, not
                      the control.
                    */}
                    {u.isOnlyShop && (
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        Their only branch — assign them elsewhere before
                        removing them here.
                      </span>
                    )}
                  </span>
                  <Select
                    value={roleHere(u)}
                    disabled={busy === u.id}
                    onValueChange={(value) =>
                      setAssigned(u, true, value as "MANAGER" | "STAFF")
                    }
                  >
                    <SelectTrigger size="sm" className="w-28 shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="STAFF">Staff</SelectItem>
                      <SelectItem value="MANAGER">Manager</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy === u.id}
                    onClick={() => setAssigned(u, false)}
                  >
                    {busy === u.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <UserMinus className="size-4" />
                    )}
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {initialAvailable.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Add someone</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y">
              {initialAvailable.map((u) => (
                <li key={u.id} className="flex items-center gap-3 px-6 py-4">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {u.displayName}
                    </span>
                    <span className="block truncate text-sm text-muted-foreground">
                      {u.username}
                      {u.shopRoles.length > 0 &&
                        ` · already at ${u.shopRoles.length} ${
                          u.shopRoles.length === 1 ? "branch" : "branches"
                        }`}
                    </span>
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy === u.id}
                    onClick={() => setAssigned(u, true)}
                  >
                    {busy === u.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <UserPlus className="size-4" />
                    )}
                    Add
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/*
        Account creation stays in one place. Linking rather than duplicating
        the form keeps a single path for usernames and temporary passwords.
      */}
      <Link
        href="/settings/employees"
        className={buttonVariants({ variant: "outline" })}
      >
        <UserPlus className="size-4" />
        Create a new account
      </Link>

      <p className="text-xs text-muted-foreground">
        The owner reaches every branch without being assigned, so owner accounts
        are not listed here.
      </p>
    </div>
  );
}
