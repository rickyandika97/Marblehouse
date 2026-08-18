"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney, parseAmount } from "@/lib/money";

export interface PresetRow {
  id: string;
  label: string;
  amount: string;
  sortOrder: number;
  isActive: boolean;
  useCount: number;
}

/**
 * The owner's sale-price manager (§4.3).
 *
 * The screen has to teach one rule without a wall of text: **a price that has
 * been sold cannot be deleted or silently re-priced.** So a used preset offers
 * Deactivate instead of Delete, and re-pricing one warns that it will create a
 * new price rather than change the old — because that is what the server does,
 * and a surprise duplicate row would look like a bug.
 */
export function PresetAdmin({
  shopId,
  shopName,
  allowCustomAmount,
  initialPresets,
}: {
  shopId: string;
  shopName: string;
  allowCustomAmount: boolean;
  initialPresets: PresetRow[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(initialPresets.length === 0);

  const active = initialPresets.filter((p) => p.isActive);
  const retired = initialPresets.filter((p) => !p.isActive);

  async function seedDefaults() {
    setBusy("defaults");
    try {
      const res = await fetch(`/api/shops/${shopId}/presets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaults: true }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(body?.error?.message ?? "Could not add the standard prices.");
        return;
      }
      toast.success("Added the five standard prices.");
      setAdding(false);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function setActive(preset: PresetRow, isActive: boolean) {
    setBusy(preset.id);
    try {
      const res = await fetch(`/api/shops/${shopId}/presets/${preset.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(body?.error?.message ?? "Could not update that price.");
        return;
      }
      toast.success(
        isActive
          ? `${preset.label} is back on the sale screen`
          : `${preset.label} removed from the sale screen`,
      );
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function remove(preset: PresetRow) {
    setBusy(preset.id);
    try {
      const res = await fetch(`/api/shops/${shopId}/presets/${preset.id}`, {
        method: "DELETE",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        // The 409 path: the price has sales against it. The server's message
        // already names the count and points at deactivating instead.
        toast.error(body?.error?.message ?? "Could not delete that price.");
        return;
      }
      toast.success(`Deleted ${preset.label}`);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      {/*
        The empty state is the whole reason this screen exists — a branch
        created by D-101's flow lands here with nothing. Offer the documented
        defaults as one tap, and adding one by hand as the alternative.
      */}
      {initialPresets.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>No prices yet</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {shopName} cannot take a sale until it has at least one price.
              {allowCustomAmount &&
                " Custom amounts are on, so staff can type a figure — but the buttons are faster."}
            </p>
            <Button
              onClick={seedDefaults}
              disabled={busy === "defaults"}
              size="lg"
              className="w-full"
            >
              {busy === "defaults" ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Sparkles className="size-4" />
              )}
              Use the standard prices (20k · 50k · 100k · 200k · 500k)
            </Button>
            <p className="text-xs text-muted-foreground">
              You can edit or remove any of them afterwards.
            </p>
          </CardContent>
        </Card>
      )}

      {active.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>On the sale screen</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y">
              {active.map((p) => (
                <PresetItem
                  key={p.id}
                  preset={p}
                  shopId={shopId}
                  busy={busy === p.id}
                  onDeactivate={() => setActive(p, false)}
                  onDelete={() => remove(p)}
                />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {adding ? (
        <AddPresetCard
          shopId={shopId}
          onCancel={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            router.refresh();
          }}
        />
      ) : (
        <Button variant="outline" onClick={() => setAdding(true)}>
          <Plus className="size-4" />
          Add a price
        </Button>
      )}

      {retired.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Retired</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y">
              {retired.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center gap-3 px-6 py-4 text-muted-foreground"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">
                      {formatMoney(p.amount)}
                    </span>
                    <span className="block truncate text-sm">
                      {p.label}
                      {p.useCount > 0 &&
                        ` · kept for ${p.useCount} past ${p.useCount === 1 ? "sale" : "sales"}`}
                    </span>
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy === p.id}
                    onClick={() => setActive(p, true)}
                  >
                    Restore
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function PresetItem({
  preset,
  shopId,
  busy,
  onDeactivate,
  onDelete,
}: {
  preset: PresetRow;
  shopId: string;
  busy: boolean;
  onDeactivate: () => void;
  onDelete: () => void;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <li className="px-6 py-4">
        <EditPresetForm
          shopId={shopId}
          preset={preset}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            router.refresh();
          }}
        />
      </li>
    );
  }

  return (
    <li className="flex items-center gap-3 px-6 py-4">
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{formatMoney(preset.amount)}</span>
        <span className="block truncate text-sm text-muted-foreground">
          {preset.label}
          {preset.useCount > 0 &&
            ` · used by ${preset.useCount} ${preset.useCount === 1 ? "sale" : "sales"}`}
        </span>
      </span>

      <div className="flex shrink-0 gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => setEditing(true)}
        >
          Edit
        </Button>

        {/*
          A used price can never be deleted (§4.3), so it is not offered — the
          server refuses regardless, which is what the test checks. Offering a
          button that always fails would just teach the owner to distrust it.
        */}
        {preset.useCount > 0 ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={onDeactivate}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Retire
          </Button>
        ) : (
          <Button variant="destructive" size="sm" disabled={busy} onClick={onDelete}>
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4" />
            )}
            Delete
          </Button>
        )}
      </div>
    </li>
  );
}

function EditPresetForm({
  shopId,
  preset,
  onCancel,
  onSaved,
}: {
  shopId: string;
  preset: PresetRow;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState(preset.label);
  const [amount, setAmount] = useState(preset.amount);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amountChanged = amount.replace(/^0+/, "") !== preset.amount.replace(/^0+/, "");
  const willSupersede = amountChanged && preset.useCount > 0;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);

    try {
      const res = await fetch(`/api/shops/${shopId}/presets/${preset.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, amount }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error?.message ?? "Could not save that price.");
        setPending(false);
        return;
      }
      toast.success(
        body?.supersededId
          ? `New price created. The old one was retired so past sales keep their amount.`
          : `Saved ${body.label}`,
      );
      onSaved();
    } catch {
      setError("Cannot reach the server. Check the internet connection.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={`label-${preset.id}`}>Label</Label>
        <Input
          id={`label-${preset.id}`}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          required
          disabled={pending}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor={`amount-${preset.id}`}>Amount (rupiah)</Label>
        <Input
          id={`amount-${preset.id}`}
          value={amount}
          inputMode="numeric"
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))}
          required
          disabled={pending}
        />
        <p className="text-xs text-muted-foreground">
          {parseAmount(amount) ? formatMoney(amount) : "Digits only"}
        </p>
      </div>

      {/*
        §4.3's supersede rule, said before it happens. The server does this
        whether or not the UI mentions it; an unexplained extra row afterwards
        would read as a duplicate-creation bug.
      */}
      {willSupersede && (
        <p className="rounded-lg bg-muted px-4 py-3 text-sm text-muted-foreground">
          {preset.useCount} {preset.useCount === 1 ? "sale uses" : "sales use"}{" "}
          this price. Saving a new amount creates a <strong>new</strong> price
          and retires this one, so those past sales keep their original amount.
        </p>
      )}

      {error && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending && <Loader2 className="animate-spin" />}
          Save
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function AddPresetCard({
  shopId,
  onAdded,
  onCancel,
}: {
  shopId: string;
  onAdded: () => void;
  onCancel: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [label, setLabel] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The label is almost always just the formatted amount, so fill it in and
  // let the owner override rather than making them type it twice.
  const effectiveLabel = label.trim() || (parseAmount(amount) ? formatMoney(amount) : "");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);

    try {
      const res = await fetch(`/api/shops/${shopId}/presets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, label: effectiveLabel }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error?.message ?? "Could not add that price.");
        setPending(false);
        return;
      }
      toast.success(`Added ${body.label}`);
      onAdded();
    } catch {
      setError("Cannot reach the server. Check the internet connection.");
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add a price</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="new-amount">Amount (rupiah)</Label>
            <Input
              id="new-amount"
              value={amount}
              placeholder="50000"
              inputMode="numeric"
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))}
              required
              disabled={pending}
            />
            <p className="text-xs text-muted-foreground">
              {parseAmount(amount) ? formatMoney(amount) : "Digits only, no dots"}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-label">Label (optional)</Label>
            <Input
              id="new-label"
              value={label}
              placeholder={effectiveLabel || "Rp 50.000"}
              onChange={(e) => setLabel(e.target.value)}
              disabled={pending}
            />
            <p className="text-xs text-muted-foreground">
              What staff see on the button. Defaults to the amount.
            </p>
          </div>

          {error && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <Button type="submit" disabled={pending || !parseAmount(amount)}>
              {pending && <Loader2 className="animate-spin" />}
              Add
            </Button>
            <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
