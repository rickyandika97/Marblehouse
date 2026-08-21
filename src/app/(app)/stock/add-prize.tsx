"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Package, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Create a catalog item (§4.8) — recovered from `prize-admin.tsx` when
 * Settings → Prizes merged into this screen (D-156).
 *
 * **This must exist somewhere.** `POST /api/prizes` shipped in Phase 5 with no
 * UI at all, which D-116 fixed by building the Settings screen; deleting that
 * screen without moving the form here would have reintroduced exactly the same
 * defect — a catalog that can only be added to by SQL, with no item to receive
 * stock against.
 */
export function AddPrizeButton({ existingSkus }: { existingSkus: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [ticketCost, setTicketCost] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsedCost = Number(ticketCost);
  const costValid = Number.isInteger(parsedCost) && parsedCost > 0;
  const skuValid = /^[A-Za-z0-9._-]+$/.test(sku);
  // The server is the authority (it 409s on a duplicate), but catching it here
  // turns a round-trip and a red error into an inline hint.
  const skuTaken = existingSkus.includes(sku.trim().toLowerCase());

  function reset() {
    setSku("");
    setName("");
    setCategory("");
    setTicketCost("");
    setError(null);
    setOpen(false);
  }

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
      setPending(false);
      reset();
    } catch {
      setError("Cannot reach the server. Check the internet connection.");
      setPending(false);
    }
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Plus className="size-4" />
        Add prize
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) reset();
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add a prize</DialogTitle>
          </DialogHeader>

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
                onChange={(e) =>
                  setTicketCost(e.target.value.replace(/[^0-9]/g, ""))
                }
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
                This creates the catalog entry only. Use <strong>+ Batch</strong>{" "}
                on the inventory row to bring quantity into this branch before it can be
                redeemed.
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
              <Button
                type="button"
                variant="ghost"
                onClick={reset}
                disabled={pending}
              >
                Cancel
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
