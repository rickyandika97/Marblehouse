"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Store, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
 * Settings → Shops. OWNER only — but the button being here is not the
 * permission; the page guard and the API both re-check (§3.4).
 *
 * A new branch is created EMPTY: no presets, no shifts, nobody assigned
 * (BUILD-LOG D-101). That makes the follow-up steps the owner's, so the list
 * has to make the emptiness impossible to miss rather than leaving them to
 * discover it when a staff member cannot ring up a sale.
 */
export function ShopAdmin({ initialShops }: { initialShops: ShopRow[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(initialShops.length === 0);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Shops</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your branches. Adding one here does not move any existing records.
          </p>
        </div>
        {!open && (
          <Button onClick={() => setOpen(true)}>
            <Store className="size-4" />
            New shop
          </Button>
        )}
      </div>

      {open && (
        <CreateShopCard
          onCancel={() => setOpen(false)}
          onCreated={() => {
            setOpen(false);
            router.refresh();
          }}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Existing shops</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ul className="divide-y">
            {initialShops.map((shop) => (
              <ShopListItem key={shop.id} shop={shop} />
            ))}
          </ul>
        </CardContent>
      </Card>
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
          {!shop.isActive && (
            <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
              Deactivated
            </span>
          )}
          {shop.isHqPseudoShop && (
            <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
              Expenses only
            </span>
          )}
        </span>
        <span className="block truncate text-sm text-muted-foreground">
          {shop.code} · {shop.timezone} · {shop.lateGraceMin} min grace
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
            href={`/settings/shops/${shop.id}/staff`}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Staff
            {shop.staffCount > 0 && (
              <span className="text-muted-foreground">{shop.staffCount}</span>
            )}
          </Link>
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

function CreateShopCard({
  onCreated,
  onCancel,
}: {
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [lateGraceMin, setLateGraceMin] = useState("5");
  const [allowCustomAmount, setAllowCustomAmount] = useState(false);
  const [allowDirectTransfer, setAllowDirectTransfer] = useState(false);
  const [requireClockOutPhoto, setRequireClockOutPhoto] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

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
          allowCustomAmount,
          allowDirectTransfer,
          requireClockOutPhoto,
        }),
      });

      const body = await res.json();

      if (!res.ok) {
        setFields(body?.error?.details?.fields ?? {});
        setError(body?.error?.message ?? "Could not create the shop.");
        setPending(false);
        return;
      }

      toast.success(
        `${body.name} created. Add its sale prices next.`,
      );
      onCreated();
    } catch {
      setError("Cannot reach the server. Check the internet connection.");
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>New shop</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="shop-name">Name</Label>
            <Input
              id="shop-name"
              value={name}
              placeholder="Marblehouse Kelapa Gading"
              onChange={(e) => setName(e.target.value)}
              required
              disabled={pending}
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
                checked={allowCustomAmount}
                onChange={setAllowCustomAmount}
                disabled={pending}
                title="Allow custom sale amounts"
                help="Lets staff type any amount instead of only picking a preset."
              />
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

          {/*
            Says plainly what the owner is about to get. The empty start is the
            decision (D-101); a branch that quietly cannot sell would be the
            defect it produces if nobody is told.
          */}
          <p className="rounded-lg bg-muted px-4 py-3 text-sm text-muted-foreground">
            The new shop starts empty. After creating it, add its sale presets
            and shifts, and assign staff from Settings → Users. It cannot take a
            sale until it has at least one preset.
          </p>

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
              Create shop
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
