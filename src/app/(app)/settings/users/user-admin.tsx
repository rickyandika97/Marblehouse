"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, UserPlus } from "lucide-react";
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
}

export interface UserRow {
  id: string;
  username: string | null;
  displayName: string;
  role: Role;
  isActive: boolean;
  canEnterCost: boolean;
  mustChangePassword: boolean;
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
}: {
  initialUsers: UserRow[];
  shops: ShopOption[];
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
                    {u.username} · {u.role.toLowerCase()}
                    {u.canEnterCost && " · purchasing"}
                    {u.mustChangePassword && " · must set password"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
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
