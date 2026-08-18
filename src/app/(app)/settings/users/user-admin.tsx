"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Loader2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type Role = "OWNER" | "MANAGER" | "STAFF";

export interface ShopOption {
  id: string;
  code: string;
  name: string;
  /** Inactive and HQ shops are shown when already assigned, but never offered. */
  isActive: boolean;
  isHqPseudoShop: boolean;
}

export interface UserRow {
  id: string;
  username: string | null;
  displayName: string;
  role: Role;
  phone: string | null;
  isActive: boolean;
  deactivationReason: string | null;
  canEnterCost: boolean;
  mustChangePassword: boolean;
  defaultShopId: string | null;
  shopIds: string[];
}

const ROLE_HELP: Record<Role, string> = {
  OWNER: "Sees and does everything, across every shop.",
  MANAGER: "Runs their assigned shops. Never sees cost or profit.",
  STAFF: "Records sales and looks after customers. No reporting.",
};

export function UserAdmin({
  initialUsers,
  shops,
  currentUserId,
}: {
  initialUsers: UserRow[];
  shops: ShopOption[];
  /** Used to mark "You" and to explain the self-edit guards before they fire. */
  currentUserId: string;
}) {
  const router = useRouter();
  const [users, setUsers] = useState(initialUsers);
  const [open, setOpen] = useState(initialUsers.length === 0);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Users</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Create accounts for your managers and staff.
          </p>
        </div>
        {!open && (
          <Button onClick={() => setOpen(true)}>
            <UserPlus className="size-4" />
            New user
          </Button>
        )}
      </div>

      {open && (
        <CreateUserCard
          shops={shops}
          onCancel={() => setOpen(false)}
          onCreated={(u) => {
            setUsers((prev) => [...prev, u]);
            setOpen(false);
            router.refresh();
          }}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Existing accounts</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ul className="divide-y">
            {users.map((u) => (
              <UserListItem
                key={u.id}
                user={u}
                shops={shops}
                currentUserId={currentUserId}
                onChanged={(next) => {
                  setUsers((prev) =>
                    prev.map((x) => (x.id === next.id ? next : x)),
                  );
                  router.refresh();
                }}
              />
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * One account, with its edit and password panels.
 *
 * The row stays read-only until the owner opens a panel — this list is mostly
 * read, and a page of expanded forms would be unreadable on a phone.
 */
function UserListItem({
  user,
  shops,
  currentUserId,
  onChanged,
}: {
  user: UserRow;
  shops: ShopOption[];
  currentUserId: string;
  onChanged: (u: UserRow) => void;
}) {
  const [panel, setPanel] = useState<"none" | "edit" | "password">("none");

  const isSelf = user.id === currentUserId;

  return (
    <li className="px-6 py-4">
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">
            {user.displayName}
            {!user.isActive && (
              <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                Deactivated
              </span>
            )}
            {isSelf && (
              <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                You
              </span>
            )}
          </span>
          <span className="block truncate text-sm text-muted-foreground">
            {user.username} · {user.role.toLowerCase()}
            {user.canEnterCost && " · purchasing"}
            {user.mustChangePassword && " · must set password"}
          </span>
          {!user.isActive && user.deactivationReason && (
            <span className="block truncate text-xs text-muted-foreground">
              {user.deactivationReason}
            </span>
          )}
        </span>

        <div className="flex shrink-0 gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPanel(panel === "edit" ? "none" : "edit")}
          >
            Edit
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPanel(panel === "password" ? "none" : "password")}
          >
            <KeyRound className="size-4" />
            Password
          </Button>
        </div>
      </div>

      {panel === "edit" && (
        <div className="mt-4">
          <EditUserForm
            user={user}
            shops={shops}
            isSelf={isSelf}
            onCancel={() => setPanel("none")}
            onSaved={(u) => {
              setPanel("none");
              onChanged(u);
            }}
          />
        </div>
      )}

      {panel === "password" && (
        <div className="mt-4">
          <ResetPasswordForm
            user={user}
            onCancel={() => setPanel("none")}
            onDone={() => setPanel("none")}
          />
        </div>
      )}
    </li>
  );
}

function CreateUserCard({
  shops,
  onCreated,
  onCancel,
}: {
  shops: ShopOption[];
  onCreated: (u: UserRow) => void;
  onCancel: () => void;
}) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("STAFF");
  const [shopIds, setShopIds] = useState<string[]>([]);
  const [canEnterCost, setCanEnterCost] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function toggleShop(id: string) {
    setShopIds((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;

    setPending(true);
    setError(null);
    setFields({});

    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          displayName,
          password,
          role,
          shopIds,
          canEnterCost: role === "MANAGER" ? canEnterCost : false,
        }),
      });

      const body = await res.json();

      if (!res.ok) {
        setFields(body?.error?.details?.fields ?? {});
        setError(body?.error?.message ?? "Could not create the account.");
        setPending(false);
        return;
      }

      toast.success(`${body.displayName} can now sign in as "${body.username}".`);
      onCreated(body as UserRow);
    } catch {
      setError("Cannot reach the server. Check the internet connection.");
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>New user</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="displayName">Full name</Label>
            <Input
              id="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
              disabled={pending}
            />
            <FieldError message={fields.displayName} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              disabled={pending}
            />
            <p className="text-xs text-muted-foreground">
              This is what they type to sign in. It cannot be changed later.
            </p>
            <FieldError message={fields.username} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">Temporary password</Label>
            <Input
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={pending}
            />
            <p className="text-xs text-muted-foreground">
              Tell it to them in person. They must change it when they first
              sign in.
            </p>
            <FieldError message={fields.password} />
          </div>

          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">Role</legend>
            <div className="grid gap-2">
              {(["STAFF", "MANAGER", "OWNER"] as Role[]).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRole(r)}
                  aria-pressed={role === r}
                  className={cn(
                    "flex min-h-14 flex-col justify-center rounded-lg border-2 px-4 py-2 text-left",
                    role === r
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-muted"
                  )}
                >
                  <span className="font-medium capitalize">
                    {r.toLowerCase()}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {ROLE_HELP[r]}
                  </span>
                </button>
              ))}
            </div>
          </fieldset>

          {role === "MANAGER" && (
            <label className="flex min-h-14 cursor-pointer items-center gap-3 rounded-lg border p-4">
              <input
                type="checkbox"
                checked={canEnterCost}
                onChange={(e) => setCanEnterCost(e.target.checked)}
                className="size-5"
                disabled={pending}
              />
              <span>
                <span className="block font-medium">Purchasing</span>
                <span className="block text-xs text-muted-foreground">
                  Lets this manager enter prize cost for their own shops. It
                  does not unlock profit or margin reports.
                </span>
              </span>
            </label>
          )}

          {role !== "OWNER" && (
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-medium">Shops</legend>
              <div className="grid gap-2">
                {shops.map((shop) => (
                  <label
                    key={shop.id}
                    className="flex min-h-14 cursor-pointer items-center gap-3 rounded-lg border px-4"
                  >
                    <input
                      type="checkbox"
                      checked={shopIds.includes(shop.id)}
                      onChange={() => toggleShop(shop.id)}
                      className="size-5"
                      disabled={pending}
                    />
                    <span className="font-medium">{shop.name}</span>
                    <span className="text-sm text-muted-foreground">
                      {shop.code}
                    </span>
                  </label>
                ))}
              </div>
              <FieldError message={fields.shopIds} />
            </fieldset>
          )}

          {error && (
            <p
              role="alert"
              className="rounded-lg bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive"
            >
              {error}
            </p>
          )}

          <div className="flex gap-3">
            <Button type="submit" size="lg" className="flex-1" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />}
              Create account
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="lg"
              onClick={onCancel}
              disabled={pending}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-sm font-medium text-destructive">{message}</p>;
}

/**
 * Edit an existing account (§7.9).
 *
 * `username` is deliberately absent — immutable after creation (D-3), because
 * it seeds the synthetic login address. `displayName` is the mutable name.
 *
 * The server enforces every rule below and is the only thing that decides;
 * this form explains them up front so the owner is not taught by a red toast:
 *
 *  - You cannot deactivate yourself or change your own role.
 *  - The last active owner cannot be demoted or deactivated.
 *  - A manager or staff member needs at least one shop.
 *  - Purchasing is a manager-only permission.
 */
function EditUserForm({
  user,
  shops,
  isSelf,
  onSaved,
  onCancel,
}: {
  user: UserRow;
  shops: ShopOption[];
  isSelf: boolean;
  onSaved: (u: UserRow) => void;
  onCancel: () => void;
}) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [phone, setPhone] = useState(user.phone ?? "");
  const [role, setRole] = useState<Role>(user.role);
  const [shopIds, setShopIds] = useState<string[]>(user.shopIds);
  const [canEnterCost, setCanEnterCost] = useState(user.canEnterCost);
  const [isActive, setIsActive] = useState(user.isActive);
  const [deactivationReason, setDeactivationReason] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function toggleShop(id: string) {
    setShopIds((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id],
    );
  }

  const deactivating = user.isActive && !isActive;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;

    setPending(true);
    setError(null);
    setFields({});

    try {
      const res = await fetch(`/api/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName,
          phone: phone.trim() || null,
          role,
          // Sent whole: this form shows EVERY shop the user holds, including
          // HQ and deactivated branches, so nothing can be stripped by being
          // absent from the list (D-109).
          shopIds,
          canEnterCost: role === "MANAGER" ? canEnterCost : false,
          isActive,
          ...(deactivating && deactivationReason.trim()
            ? { deactivationReason: deactivationReason.trim() }
            : {}),
        }),
      });

      const body = await res.json();

      if (!res.ok) {
        setFields(body?.error?.details?.fields ?? {});
        setError(body?.error?.message ?? "Could not save those changes.");
        setPending(false);
        return;
      }

      toast.success(
        deactivating
          ? `${body.displayName} can no longer sign in.`
          : `Saved ${body.displayName}`,
      );
      onSaved(body as UserRow);
    } catch {
      setError("Cannot reach the server. Check the internet connection.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5 rounded-xl border p-4">
      <div className="space-y-2">
        <Label htmlFor={`name-${user.id}`}>Full name</Label>
        <Input
          id={`name-${user.id}`}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
          disabled={pending}
        />
        <p className="text-xs text-muted-foreground">
          Their username ({user.username}) cannot be changed.
        </p>
        <FieldError message={fields.displayName} />
      </div>

      <div className="space-y-2">
        <Label htmlFor={`phone-${user.id}`}>Phone (optional)</Label>
        <Input
          id={`phone-${user.id}`}
          value={phone}
          inputMode="tel"
          onChange={(e) => setPhone(e.target.value)}
          disabled={pending}
        />
        <FieldError message={fields.phone} />
      </div>

      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium">Role</legend>
        <div className="grid gap-2">
          {(["STAFF", "MANAGER", "OWNER"] as Role[]).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRole(r)}
              aria-pressed={role === r}
              // You cannot change your own role — the server refuses, and a
              // dead button with an explanation beats a red toast.
              disabled={pending || isSelf}
              className={cn(
                "flex min-h-14 flex-col justify-center rounded-lg border-2 px-4 py-2 text-left",
                role === r
                  ? "border-primary bg-primary/5"
                  : "border-border hover:bg-muted",
                isSelf && "opacity-50",
              )}
            >
              <span className="font-medium capitalize">{r.toLowerCase()}</span>
              <span className="text-xs text-muted-foreground">
                {ROLE_HELP[r]}
              </span>
            </button>
          ))}
        </div>
        {isSelf && (
          <p className="text-xs text-muted-foreground">
            You cannot change your own role.
          </p>
        )}
        <FieldError message={fields.role} />
      </fieldset>

      {role === "MANAGER" && (
        <label className="flex min-h-14 cursor-pointer items-center gap-3 rounded-lg border p-4">
          <input
            type="checkbox"
            checked={canEnterCost}
            onChange={(e) => setCanEnterCost(e.target.checked)}
            className="size-5"
            disabled={pending}
          />
          <span>
            <span className="block font-medium">Purchasing</span>
            <span className="block text-xs text-muted-foreground">
              Lets this manager enter prize cost for their own shops. It does
              not unlock profit or margin reports.
            </span>
          </span>
        </label>
      )}

      {role !== "OWNER" && (
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">Shops</legend>
          <div className="grid gap-2">
            {shops
              // Show every shop they already hold — including HQ and any
              // deactivated branch — plus the active ones they could be added
              // to. Hiding a held shop would strip it on save (D-109).
              .filter((shop) => shop.isActive || shopIds.includes(shop.id))
              .map((shop) => (
                <label
                  key={shop.id}
                  className="flex min-h-14 cursor-pointer items-center gap-3 rounded-lg border px-4"
                >
                  <input
                    type="checkbox"
                    checked={shopIds.includes(shop.id)}
                    onChange={() => toggleShop(shop.id)}
                    className="size-5"
                    disabled={pending}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {shop.name}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {shop.code}
                      {shop.isHqPseudoShop && " · expenses only"}
                      {!shop.isActive && " · deactivated"}
                    </span>
                  </span>
                </label>
              ))}
          </div>
          <FieldError message={fields.shopIds} />
        </fieldset>
      )}

      <label className="flex min-h-14 cursor-pointer items-center gap-3 rounded-lg border p-4">
        <input
          type="checkbox"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
          className="size-5"
          // The server refuses self-deactivation and refuses removing the last
          // active owner. Blocking the obvious one here keeps the other as the
          // server's job.
          disabled={pending || isSelf}
        />
        <span>
          <span className="block font-medium">Can sign in</span>
          <span className="block text-xs text-muted-foreground">
            {isSelf
              ? "You cannot deactivate your own account."
              : "Turning this off signs them out everywhere immediately. Their past sales and attendance are kept."}
          </span>
        </span>
      </label>

      {deactivating && (
        <div className="space-y-2">
          <Label htmlFor={`reason-${user.id}`}>Reason (optional)</Label>
          <Input
            id={`reason-${user.id}`}
            value={deactivationReason}
            placeholder="Left the company"
            onChange={(e) => setDeactivationReason(e.target.value)}
            disabled={pending}
          />
          <p className="text-xs text-muted-foreground">
            Recorded in the audit log.
          </p>
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="rounded-lg bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive"
        >
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending && <Loader2 className="animate-spin" />}
          Save changes
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * Set a temporary password for someone who has forgotten theirs (§5.4, §7.9).
 *
 * There is no email in this system (D-1), so the owner is the reset path. The
 * new password is shown once, in person — the server forces a change on next
 * login and destroys every existing session, which is what evicts whoever
 * prompted the reset in the first place.
 */
function ResetPasswordForm({
  user,
  onDone,
  onCancel,
}: {
  user: UserRow;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;

    setPending(true);
    setError(null);

    try {
      const res = await fetch(`/api/users/${user.id}/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword }),
      });

      const body = await res.json().catch(() => null);

      if (!res.ok) {
        setError(
          body?.error?.details?.fields?.newPassword ??
            body?.error?.message ??
            "Could not reset that password.",
        );
        setPending(false);
        return;
      }

      toast.success(
        `Password set. Tell ${user.displayName} in person — they must change it when they next sign in.`,
      );
      setNewPassword("");
      onDone();
    } catch {
      setError("Cannot reach the server. Check the internet connection.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-xl border p-4">
      <div className="space-y-2">
        <Label htmlFor={`pw-${user.id}`}>Temporary password</Label>
        <Input
          id={`pw-${user.id}`}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoComplete="off"
          required
          disabled={pending}
        />
        <p className="text-xs text-muted-foreground">
          At least 8 characters. Tell it to {user.displayName} in person — they
          must change it when they next sign in, and this signs them out
          everywhere now.
        </p>
      </div>

      {error && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={pending || !newPassword}>
          {pending && <Loader2 className="animate-spin" />}
          Set password
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
