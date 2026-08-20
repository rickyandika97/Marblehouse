"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Pencil, Store, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export interface ShopRow {
  id: string;
  code: string;
  name: string;
  address: string | null;
  phone: string | null;
  timezone: string;
  lateGraceMin: number;
  allowCustomAmount: boolean;
  allowDirectTransfer: boolean;
  requireClockOutPhoto: boolean;
  isHqPseudoShop: boolean;
  isActive: boolean;
  presetCount: number;
  shiftCount: number;
  staffCount: number;
}

/**
 * Settings → Shops, branch-administration section. Rendered only when the
 * page has already confirmed OWNER — but that render check is not the
 * permission; every mutation here still hits an API route that re-checks
 * (§3.4).
 *
 * A new branch is created EMPTY: no presets, no shifts, nobody assigned
 * (BUILD-LOG D-101). That makes the follow-up steps the owner's, so the list
 * has to make the emptiness impossible to miss rather than leaving them to
 * discover it when a staff member cannot ring up a sale.
 *
 * Create and edit are both modals (D-127) rather than an inline card or a
 * separate route — this list is what the owner should keep seeing while they
 * work, matching the Expenses screen's "Record expense" / edit-row pattern.
 */
export function ShopAdmin({ initialShops }: { initialShops: ShopRow[] }) {
  const router = useRouter();

  // HQ is never deactivatable (`updateShop` refuses it, D-101/§4.12), so it
  // always belongs on Active regardless of this split.
  const activeShops = initialShops.filter((s) => s.isActive);
  const archivedShops = initialShops.filter((s) => !s.isActive);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          Adding one here does not move any existing records.
        </p>
        <CreateShopDialog onCreated={() => router.refresh()} />
      </div>

      <Tabs defaultValue="active">
        <TabsList>
          <TabsTrigger value="active">
            Active
            {activeShops.length > 0 && (
              <span className="text-muted-foreground">{activeShops.length}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="archived">
            Archived
            {archivedShops.length > 0 && (
              <span className="text-muted-foreground">{archivedShops.length}</span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="active">
          <Card>
            <CardContent className="p-0">
              <ul className="divide-y">
                {activeShops.map((shop) => (
                  <ShopListItem key={shop.id} shop={shop} />
                ))}
              </ul>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="archived">
          <Card>
            <CardContent className="p-0">
              {archivedShops.length === 0 ? (
                <p className="px-6 py-4 text-sm text-muted-foreground">
                  No deactivated shops.
                </p>
              ) : (
                <ul className="divide-y">
                  {archivedShops.map((shop) => (
                    <ShopListItem key={shop.id} shop={shop} />
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ShopListItem({ shop }: { shop: ShopRow }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function setActive(isActive: boolean) {
    if (pending) return;
    setPending(true);
    try {
      const res = await fetch(`/api/shops/${shop.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        // The last-branch and HQ refusals both arrive here. The server's
        // message already explains which one it is and what to do instead.
        toast.error(body?.error?.message ?? "Could not update that shop.");
        return;
      }
      toast.success(
        isActive ? `${shop.name} reopened` : `${shop.name} deactivated`,
      );
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <li className="flex items-center gap-3 px-6 py-4">
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">
          {shop.name}
          {/* No "Deactivated" badge here — which tab the row is in (D-132)
              already says that. */}
          {shop.isHqPseudoShop && (
            <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
              Expenses only
            </span>
          )}
        </span>
        <span className="block truncate text-sm text-muted-foreground">
          {shop.code} · {shop.timezone}
          {/* HQ has no shifts and nobody clocks in there, so a lateness
              grace is meaningless on this row (owner request, 2026-08-20). */}
          {!shop.isHqPseudoShop && ` · ${shop.lateGraceMin} min grace`}
        </span>

        {/*
          The empty-branch warning. A shop with no preset cannot take a sale
          unless custom amounts are on, so this is a blocker, not a nicety —
          it is the cost of starting empty and it must be visible.
        */}
        {!shop.isHqPseudoShop &&
          shop.isActive &&
          shop.presetCount === 0 &&
          !shop.allowCustomAmount && (
            <Link
              href={`/settings/shops/${shop.id}/presets`}
              className="mt-1 flex items-start gap-1.5 text-sm text-destructive underline underline-offset-4"
            >
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              No sale prices yet — this branch cannot take a sale. Add one.
            </Link>
          )}

        {/*
          A softer warning than the price one, deliberately. No prices BLOCKS
          selling; no shifts silently records every arrival as punctual, which
          is worse in a way — the owner thinks lateness tracking is on.
        */}
        {!shop.isHqPseudoShop && shop.isActive && shop.shiftCount === 0 && (
          <Link
            href={`/settings/shops/${shop.id}/shifts`}
            className="mt-1 flex items-start gap-1.5 text-sm text-muted-foreground underline underline-offset-4"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            No shifts yet — nobody here can be recorded late. Set them up.
          </Link>
        )}

        {/*
          Destructive-red like the price warning: with nobody assigned the
          branch is absent from every non-owner shop picker, so nothing can be
          recorded here at all. A harder block than a missing price.
        */}
        {!shop.isHqPseudoShop && shop.isActive && shop.staffCount === 0 && (
          <Link
            href={`/settings/shops/${shop.id}/staff`}
            className="mt-1 flex items-start gap-1.5 text-sm text-destructive underline underline-offset-4"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            Nobody works here — the branch is hidden from every shop picker.
          </Link>
        )}
      </span>

      {!shop.isHqPseudoShop && (
        <div className="flex shrink-0 gap-2">
          <Link
            href={`/settings/shops/${shop.id}/presets`}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Prices
            {shop.presetCount > 0 && (
              <span className="text-muted-foreground">{shop.presetCount}</span>
            )}
          </Link>
          <Link
            href={`/settings/shops/${shop.id}/shifts`}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Shifts
            {shop.shiftCount > 0 && (
              <span className="text-muted-foreground">{shop.shiftCount}</span>
            )}
          </Link>
          <Link
            href={`/settings/shops/${shop.id}/roster`}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Roster
          </Link>
          <Link
            href={`/settings/shops/${shop.id}/staff`}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Staff
            {shop.staffCount > 0 && (
              <span className="text-muted-foreground">{shop.staffCount}</span>
            )}
          </Link>
          <EditShopDialog shop={shop} />
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => setActive(!shop.isActive)}
          >
            {pending && <Loader2 className="size-4 animate-spin" />}
            {shop.isActive ? "Deactivate" : "Reopen"}
          </Button>
        </div>
      )}
    </li>
  );
}

function CreateShopDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [lateGraceMin, setLateGraceMin] = useState("5");
  const [allowDirectTransfer, setAllowDirectTransfer] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function reset() {
    setCode("");
    setName("");
    setAddress("");
    setPhone("");
    setLateGraceMin("5");
    setAllowDirectTransfer(false);
    setFields({});
    setError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;

    setPending(true);
    setError(null);
    setFields({});

    try {
      const res = await fetch("/api/shops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          name,
          address: address.trim() || null,
          phone: phone.trim() || null,
          // Sent as a number: the schema is `z.number().int()`, and a string
          // would fail validation rather than being coerced.
          lateGraceMin: Number(lateGraceMin),
          allowDirectTransfer,
          // Every branch requires a clock-out photo; not a user-facing
          // option (owner request, 2026-08-20).
          requireClockOutPhoto: true,
        }),
      });

      const body = await res.json();

      if (!res.ok) {
        setFields(body?.error?.details?.fields ?? {});
        setError(body?.error?.message ?? "Could not create the shop.");
        setPending(false);
        return;
      }

      toast.success(`${body.name} created. Add its sale prices next.`);
      setOpen(false);
      reset();
      onCreated();
    } catch {
      setError("Cannot reach the server. Check the internet connection.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger
        render={
          <Button>
            <Store className="size-4" />
            New shop
          </Button>
        }
      />

      <DialogContent>
        <DialogHeader>
          <DialogTitle>New shop</DialogTitle>
          <DialogDescription>
            Starts empty — add sale prices and shifts, and assign staff, once
            it exists. It cannot take a sale until it has at least one preset.
          </DialogDescription>
        </DialogHeader>

        <form id="create-shop-form" onSubmit={submit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="shop-name">Name</Label>
            <Input
              id="shop-name"
              value={name}
              placeholder="Marblehouse Kelapa Gading"
              onChange={(e) => setName(e.target.value)}
              required
              disabled={pending}
              autoFocus
            />
            <FieldError message={fields.name} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="shop-code">Code</Label>
            <Input
              id="shop-code"
              value={code}
              placeholder="BR-2"
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              required
              disabled={pending}
            />
            <p className="text-xs text-muted-foreground">
              A short label for this branch on reports and exports. It cannot be
              changed later.
            </p>
            <FieldError message={fields.code} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="shop-address">Address (optional)</Label>
            <Input
              id="shop-address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              disabled={pending}
            />
            <FieldError message={fields.address} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="shop-phone">Phone (optional)</Label>
            <Input
              id="shop-phone"
              value={phone}
              inputMode="tel"
              onChange={(e) => setPhone(e.target.value)}
              disabled={pending}
            />
            <FieldError message={fields.phone} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="shop-grace">Late grace (minutes)</Label>
            <Input
              id="shop-grace"
              value={lateGraceMin}
              inputMode="numeric"
              onChange={(e) =>
                setLateGraceMin(e.target.value.replace(/[^0-9]/g, ""))
              }
              required
              disabled={pending}
            />
            <p className="text-xs text-muted-foreground">
              How late a staff member may clock in before it counts as late.
            </p>
            <FieldError message={fields.lateGraceMin} />
          </div>

          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">Options</legend>
            <div className="grid gap-2">
              <Toggle
                checked={allowDirectTransfer}
                onChange={setAllowDirectTransfer}
                disabled={pending}
                title="Allow direct marble transfers"
                help="Lets customers move marbles between each other at this branch."
              />
            </div>
          </fieldset>

          {error && (
            <p
              role="alert"
              className="rounded-lg bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive"
            >
              {error}
            </p>
          )}
        </form>

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button type="submit" form="create-shop-form" disabled={pending}>
            {pending && <Loader2 className="size-4 animate-spin" />}
            Create shop
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Settings → Shops → *this shop* → Edit, as a modal (D-127). Replaces the
 * D-126 `/settings/shops/[id]/edit` route with the same fields, following the
 * same exclusions: `code` is shown disabled (immutable, D-3), and
 * `allowCustomAmount`/`timezone` stay off this form entirely (D-125).
 * `isActive` is deliberately still the list's own Deactivate/Reopen button,
 * not duplicated here — that button already carries the last-branch and
 * HQ-cannot-deactivate refusal messages.
 */
function EditShopDialog({ shop }: { shop: ShopRow }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(shop.name);
  const [address, setAddress] = useState(shop.address ?? "");
  const [phone, setPhone] = useState(shop.phone ?? "");
  const [lateGraceMin, setLateGraceMin] = useState(String(shop.lateGraceMin));
  const [allowDirectTransfer, setAllowDirectTransfer] = useState(
    shop.allowDirectTransfer,
  );
  const [requireClockOutPhoto, setRequireClockOutPhoto] = useState(
    shop.requireClockOutPhoto,
  );
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Seeded from the row each time the dialog opens, so cancelling and
  // reopening never shows a stale half-edit (matches edit-expense.tsx).
  function reset() {
    setName(shop.name);
    setAddress(shop.address ?? "");
    setPhone(shop.phone ?? "");
    setLateGraceMin(String(shop.lateGraceMin));
    setAllowDirectTransfer(shop.allowDirectTransfer);
    setRequireClockOutPhoto(shop.requireClockOutPhoto);
    setFields({});
    setError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;

    setPending(true);
    setError(null);
    setFields({});

    try {
      const res = await fetch(`/api/shops/${shop.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          address: address.trim() || null,
          phone: phone.trim() || null,
          lateGraceMin: Number(lateGraceMin),
          allowDirectTransfer,
          requireClockOutPhoto,
        }),
      });

      const body = await res.json().catch(() => null);

      if (!res.ok) {
        setFields(body?.error?.details?.fields ?? {});
        setError(body?.error?.message ?? "Could not save these changes.");
        setPending(false);
        return;
      }

      toast.success(`${body.name} updated.`);
      setOpen(false);
      router.refresh();
    } catch {
      setError("Cannot reach the server. Check the internet connection.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <Pencil className="size-4" />
            Edit
          </Button>
        }
      />

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit shop</DialogTitle>
          <DialogDescription>
            {shop.name} · {shop.code}
          </DialogDescription>
        </DialogHeader>

        <form id={`edit-shop-form-${shop.id}`} onSubmit={submit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor={`edit-shop-name-${shop.id}`}>Name</Label>
            <Input
              id={`edit-shop-name-${shop.id}`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              disabled={pending}
              autoFocus
            />
            <FieldError message={fields.name} />
          </div>

          <div className="space-y-2">
            <Label>Code</Label>
            <Input value={shop.code} disabled readOnly />
            <p className="text-xs text-muted-foreground">
              Cannot be changed — it is already used on exports, the audit log
              and in conversation. Rename the shop instead.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor={`edit-shop-address-${shop.id}`}>
              Address (optional)
            </Label>
            <Input
              id={`edit-shop-address-${shop.id}`}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              disabled={pending}
            />
            <FieldError message={fields.address} />
          </div>

          <div className="space-y-2">
            <Label htmlFor={`edit-shop-phone-${shop.id}`}>
              Phone (optional)
            </Label>
            <Input
              id={`edit-shop-phone-${shop.id}`}
              value={phone}
              inputMode="tel"
              onChange={(e) => setPhone(e.target.value)}
              disabled={pending}
            />
            <FieldError message={fields.phone} />
          </div>

          <div className="space-y-2">
            <Label htmlFor={`edit-shop-grace-${shop.id}`}>
              Late grace (minutes)
            </Label>
            <Input
              id={`edit-shop-grace-${shop.id}`}
              value={lateGraceMin}
              inputMode="numeric"
              onChange={(e) =>
                setLateGraceMin(e.target.value.replace(/[^0-9]/g, ""))
              }
              required
              disabled={pending}
            />
            <p className="text-xs text-muted-foreground">
              How late a staff member may clock in before it counts as late.
            </p>
            <FieldError message={fields.lateGraceMin} />
          </div>

          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">Options</legend>
            <div className="grid gap-2">
              <Toggle
                checked={allowDirectTransfer}
                onChange={setAllowDirectTransfer}
                disabled={pending}
                title="Allow direct marble transfers"
                help="Lets customers move marbles between each other at this branch."
              />
              <Toggle
                checked={requireClockOutPhoto}
                onChange={setRequireClockOutPhoto}
                disabled={pending}
                title="Require a clock-out photo"
                help="Staff must take a photo when leaving, not just on arrival."
              />
            </div>
          </fieldset>

          {error && (
            <p
              role="alert"
              className="rounded-lg bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive"
            >
              {error}
            </p>
          )}
        </form>

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button type="submit" form={`edit-shop-form-${shop.id}`} disabled={pending}>
            {pending && <Loader2 className="size-4 animate-spin" />}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Toggle({
  checked,
  onChange,
  disabled,
  title,
  help,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
  title: string;
  help: string;
}) {
  return (
    <label
      className={cn(
        "flex min-h-14 cursor-pointer items-center gap-3 rounded-lg border p-4",
        disabled && "opacity-50",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-5"
        disabled={disabled}
      />
      <span>
        <span className="block font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{help}</span>
      </span>
    </label>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-sm font-medium text-destructive">
      {message}
    </p>
  );
}
