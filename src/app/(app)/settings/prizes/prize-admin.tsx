"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ImageIcon,
  Loader2,
  Package,
  Plus,
  Search,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { PrizeDTO } from "@/server/dto/prize";

/**
 * The prize catalog manager (§4.8, §7.4).
 *
 * Two ideas have to stay visually separate on this screen, because confusing
 * them is expensive:
 *
 *   the CATALOG   — sku, name, category, ticket cost. GLOBAL. Editing
 *                   ticket cost reprices the item at every branch.
 *   this SHOP     — whether this branch carries the item, and its low-stock
 *                   threshold. Local, and set from the Stock screen.
 *
 * So the row shows catalog fields as the primary text and the shop's on-hand
 * as secondary, greyed — never side by side as equals.
 *
 * The props type is `PrizeDTO`, the RESTRICTED shape, deliberately. A Purchasing
 * manager's `listPrizes` returns `PrizeCostDTO` with a valuation on it, but
 * this screen is about the catalog and has no business rendering money — typing
 * the prop as `PrizeDTO` means the extra fields are not reachable here even
 * though they exist on the object at runtime (§7.5).
 */
export function PrizeAdmin({
  shopName,
  initialPrizes,
}: {
  shopName: string;
  initialPrizes: PrizeDTO[];
}) {
  const [adding, setAdding] = useState(initialPrizes.length === 0);
  const [query, setQuery] = useState("");

  const active = initialPrizes.filter((p) => p.isActive);
  const retired = initialPrizes.filter((p) => !p.isActive);

  // Filter in the browser rather than round-tripping `?q=`: the service caps
  // the catalog at 500 rows, which is small enough to search instantly and
  // avoids a spinner on every keystroke over shop wifi.
  const match = useCallback(
    (p: PrizeDTO) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        (p.category?.toLowerCase().includes(q) ?? false)
      );
    },
    [query]
  );

  const shownActive = useMemo(() => active.filter(match), [active, match]);
  const shownRetired = useMemo(() => retired.filter(match), [retired, match]);

  return (
    <div className="space-y-6">
      {initialPrizes.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>No prizes yet</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Nothing can be redeemed until the catalog has at least one item.
              Add one here, then use <strong>Stock → Receive</strong> to bring
              quantity into {shopName}.
            </p>
          </CardContent>
        </Card>
      )}

      {initialPrizes.length > 4 && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, SKU or category"
            className="pl-9"
            aria-label="Search prizes"
          />
        </div>
      )}

      {shownActive.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Catalog</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y">
              {shownActive.map((p) => (
                <PrizeItem key={p.id} prize={p} shopName={shopName} />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {query && shownActive.length === 0 && shownRetired.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Nothing matches “{query}”.
        </p>
      )}

      {adding ? (
        <AddPrizeCard
          onCancel={() => setAdding(false)}
          existingSkus={initialPrizes.map((p) => p.sku.toLowerCase())}
        />
      ) : (
        <Button variant="outline" onClick={() => setAdding(true)}>
          <Plus className="size-4" />
          Add a prize
        </Button>
      )}

      {shownRetired.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Retired</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y">
              {shownRetired.map((p) => (
                <PrizeItem key={p.id} prize={p} shopName={shopName} />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function PrizeItem({
  prize,
  shopName,
}: {
  prize: PrizeDTO;
  shopName: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  async function setActive(isActive: boolean) {
    setBusy(true);
    try {
      const res = await fetch(`/api/prizes/${prize.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(body?.error?.message ?? "Could not update that prize.");
        return;
      }
      toast.success(
        isActive
          ? `${prize.name} is back in the catalog`
          : `${prize.name} retired`
      );
      router.refresh();
    } catch {
      toast.error("Cannot reach the server. Check the internet connection.");
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <li className="px-6 py-4">
        <EditPrizeForm
          prize={prize}
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
      <PrizeThumb prize={prize} />
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{prize.name}</span>
        <span className="block truncate text-sm text-muted-foreground">
          {prize.sku}
          {prize.category && ` · ${prize.category}`}
          {" · "}
          <span className="font-medium text-foreground">
            {prize.ticketCost.toLocaleString("id-ID")} tickets
          </span>
        </span>
        {/*
          The shop-local half, kept visually subordinate. `shopConfig === null`
          means this branch has no config row at all, which is a different
          thing from carrying it with zero stock — say so rather than showing
          "0" and implying it ran out.
        */}
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {prize.shopConfig === null ? (
            <>Not carried at {shopName}</>
          ) : !prize.shopConfig.isActive ? (
            <>Not carried at {shopName} · {prize.onHand} in stock</>
          ) : (
            <>
              {prize.onHand} in stock at {shopName}
              {prize.isLowStock && (
                <span className="ml-1 font-medium text-amber-700">· low</span>
              )}
            </>
          )}
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
          Retire, never delete. A prize is referenced by past redemptions and
          by live batches — CLAUDE.md forbids hard-deleting anything touching
          stock, and `updatePrize` only offers `isActive`. There is no DELETE
          endpoint to call, so no button pretends otherwise.
        */}
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => setActive(!prize.isActive)}
        >
          {busy && <Loader2 className="size-4 animate-spin" />}
          {prize.isActive ? "Retire" : "Restore"}
        </Button>
      </div>
    </li>
  );
}

function EditPrizeForm({
  prize,
  onCancel,
  onSaved,
}: {
  prize: PrizeDTO;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(prize.name);
  const [category, setCategory] = useState(prize.category ?? "");
  const [ticketCost, setTicketCost] = useState(String(prize.ticketCost));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsedCost = Number(ticketCost);
  const costValid = Number.isInteger(parsedCost) && parsedCost > 0;
  const costChanged = costValid && parsedCost !== prize.ticketCost;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);

    try {
      const res = await fetch(`/api/prizes/${prize.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          // Empty clears the category. The schema is `.nullable()`, so send
          // null rather than "" — the service trims to null anyway, but being
          // explicit means the intent survives a future schema tightening.
          category: category.trim() || null,
          ticketCost: parsedCost,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error?.message ?? "Could not save that prize.");
        setPending(false);
        return;
      }
      toast.success(`Saved ${body.name}`);
      onSaved();
    } catch {
      setError("Cannot reach the server. Check the internet connection.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={`name-${prize.id}`}>Name</Label>
        <Input
          id={`name-${prize.id}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={120}
          disabled={pending}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor={`category-${prize.id}`}>Category (optional)</Label>
        <Input
          id={`category-${prize.id}`}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          maxLength={60}
          disabled={pending}
        />
      </div>

      <ImageField prize={prize} disabled={pending} />

      <div className="space-y-2">
        <Label htmlFor={`cost-${prize.id}`}>Ticket cost</Label>
        <Input
          id={`cost-${prize.id}`}
          value={ticketCost}
          inputMode="numeric"
          onChange={(e) => setTicketCost(e.target.value.replace(/[^0-9]/g, ""))}
          required
          disabled={pending}
        />
        <p className="text-xs text-muted-foreground">
          Whole tickets, at least 1.
        </p>
      </div>

      {/*
        §4.8's global-price warning, said BEFORE the change. The PRD asks for
        three mitigations; the audit row and the owner alert are already in
        `updatePrize`, and this is the third. It matters most for a MANAGER,
        who can reprice branches they do not manage and would otherwise have no
        way to know that from this screen.
      */}
      {costChanged && (
        <p className="flex gap-2 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-950">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            This changes the price from{" "}
            <strong>{prize.ticketCost.toLocaleString("id-ID")}</strong> to{" "}
            <strong>{parsedCost.toLocaleString("id-ID")}</strong> tickets{" "}
            <strong>at every branch</strong>, not just this one. The owner is
            notified and the change is recorded in the audit log.
          </span>
        </p>
      )}

      {error && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={pending || !costValid || !name.trim()}>
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

function AddPrizeCard({
  onCancel,
  existingSkus,
}: {
  onCancel: () => void;
  existingSkus: string[];
}) {
  const router = useRouter();
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [ticketCost, setTicketCost] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsedCost = Number(ticketCost);
  const costValid = Number.isInteger(parsedCost) && parsedCost > 0;
  const skuValid = /^[A-Za-z0-9._-]+$/.test(sku);
  // The server is the authority on this (it 409s on a duplicate), but catching
  // it here turns a round-trip and a red error into an inline hint.
  const skuTaken = existingSkus.includes(sku.trim().toLowerCase());

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);

    try {
      const res = await fetch("/api/prizes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sku: sku.trim(),
          name: name.trim(),
          category: category.trim() || undefined,
          ticketCost: parsedCost,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error?.message ?? "Could not add that prize.");
        setPending(false);
        return;
      }
      toast.success(`Added ${body.name}`);
      router.refresh();
      onCancel();
    } catch {
      setError("Cannot reach the server. Check the internet connection.");
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add a prize</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="new-name">Name</Label>
            <Input
              id="new-name"
              value={name}
              placeholder="Teddy bear, large"
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={120}
              disabled={pending}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-sku">SKU</Label>
            <Input
              id="new-sku"
              value={sku}
              placeholder="TEDDY-L"
              onChange={(e) => setSku(e.target.value)}
              required
              maxLength={40}
              disabled={pending}
            />
            <p className="text-xs text-muted-foreground">
              {sku && !skuValid
                ? "Letters, numbers, dots, dashes or underscores only."
                : skuTaken
                  ? "Another prize already uses this SKU."
                  : "Your own code for this item. It cannot be changed later."}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-category">Category (optional)</Label>
            <Input
              id="new-category"
              value={category}
              placeholder="Plush"
              onChange={(e) => setCategory(e.target.value)}
              maxLength={60}
              disabled={pending}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-cost">Ticket cost</Label>
            <Input
              id="new-cost"
              value={ticketCost}
              placeholder="250"
              inputMode="numeric"
              onChange={(e) => setTicketCost(e.target.value.replace(/[^0-9]/g, ""))}
              required
              disabled={pending}
            />
            <p className="text-xs text-muted-foreground">
              What a customer pays in tickets. The same at every branch (§4.8).
            </p>
          </div>

          {/*
            A new catalog item is carried by NO branch until someone stocks it
            — `createPrize` writes no `ShopPrizeConfig`. Say so, or the item
            appears to vanish from the redemption screen.
          */}
          <p className="flex gap-2 rounded-lg bg-muted px-4 py-3 text-sm text-muted-foreground">
            <Package className="mt-0.5 size-4 shrink-0" />
            <span>
              Adding it here creates the catalog entry only. Use{" "}
              <strong>Stock → Receive</strong> to bring quantity into a branch
              before it can be redeemed.
            </span>
          </p>

          {error && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <Button
              type="submit"
              disabled={
                pending || !costValid || !name.trim() || !skuValid || skuTaken
              }
            >
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

/**
 * The row thumbnail, and the placeholder when there is none (§8.6).
 *
 * A fixed-size box either way. If the placeholder collapsed to nothing, every
 * row without a photo would sit at a different indent from the rows with one,
 * and the list would read as misaligned rather than as "this one has no
 * picture yet".
 *
 * `<img>` rather than `next/image`: the source is our own authenticated route,
 * not a static asset, and Next's optimiser would need a loader configured for
 * an endpoint that already returns a right-sized 600px JPEG. Nothing to gain,
 * and D-4's rule against Vercel-flavoured infrastructure applies to the image
 * optimiser too.
 */
function PrizeThumb({ prize }: { prize: PrizeDTO }) {
  if (!prize.imagePath) {
    return (
      <span
        aria-hidden
        className="flex size-12 shrink-0 items-center justify-center rounded-lg border border-dashed text-muted-foreground"
      >
        <ImageIcon className="size-5" />
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/api/prizes/${prize.id}/image`}
      alt=""
      width={48}
      height={48}
      className="size-12 shrink-0 rounded-lg border object-cover"
    />
  );
}

/**
 * Add, replace or remove a prize's photo (§8.6).
 *
 * Uploads immediately on choosing a file rather than waiting for the form's
 * Save, because it posts to a DIFFERENT endpoint — the image is stored by
 * `POST /api/prizes/:id/image` while the text fields go to
 * `PATCH /api/prizes/:id`. Deferring it would mean one visible "Save" doing
 * two independent writes, where the second can fail after the first succeeded
 * and there is no sensible way to report that in a single message.
 *
 * The trade-off is stated in the hint text, because a photo that saves the
 * instant you pick it, next to fields that do not, is otherwise a surprise.
 */
function ImageField({
  prize,
  disabled,
}: {
  prize: PrizeDTO;
  disabled: boolean;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  // The route's URL never changes when the image does, and it is cached for an
  // hour — so a replaced photo would keep showing the old one. Bumping a
  // cache-buster on success is what makes the change visible immediately.
  const [version, setVersion] = useState(0);

  const src = `/api/prizes/${prize.id}/image${version ? `?v=${version}` : ""}`;

  async function upload(file: File) {
    setBusy(true);
    try {
      const body = new FormData();
      body.append("image", file);
      const res = await fetch(`/api/prizes/${prize.id}/image`, {
        method: "POST",
        body,
      });
      const result = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(result?.error?.message ?? "Could not upload that image.");
        return;
      }
      setVersion((v) => v + 1);
      toast.success("Photo updated");
      router.refresh();
    } catch {
      toast.error("No connection. Check the wifi and try again.");
    } finally {
      setBusy(false);
      // Clear the input, or choosing the SAME file again fires no change event
      // and a failed upload could not be retried.
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function remove() {
    setBusy(true);
    try {
      const res = await fetch(`/api/prizes/${prize.id}/image`, {
        method: "DELETE",
      });
      const result = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(result?.error?.message ?? "Could not remove that image.");
        return;
      }
      setVersion((v) => v + 1);
      toast.success("Photo removed");
      router.refresh();
    } catch {
      toast.error("No connection. Check the wifi and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={`image-${prize.id}`}>Photo</Label>

      <div className="flex items-center gap-3">
        {prize.imagePath ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={`Photo of ${prize.name}`}
            width={64}
            height={64}
            className="size-16 shrink-0 rounded-lg border object-cover"
          />
        ) : (
          <span
            aria-hidden
            className="flex size-16 shrink-0 items-center justify-center rounded-lg border border-dashed text-muted-foreground"
          >
            <ImageIcon className="size-6" />
          </span>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || busy}
            onClick={() => inputRef.current?.click()}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {prize.imagePath ? "Replace photo" : "Add photo"}
          </Button>

          {prize.imagePath && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled || busy}
              onClick={remove}
            >
              Remove
            </Button>
          )}
        </div>
      </div>

      <input
        ref={inputRef}
        id={`image-${prize.id}`}
        type="file"
        accept="image/*"
        className="sr-only"
        disabled={disabled || busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
        }}
      />

      <p className="text-xs text-muted-foreground">
        Shown to staff on the redemption screen. Saved as soon as you choose it,
        separately from the fields above. Square crop, JPEG, up to 12MB.
      </p>
    </div>
  );
}
