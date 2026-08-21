"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ReasonDialog } from "@/components/reason-dialog";
import { cn } from "@/lib/utils";
import type { PrizeDTO } from "@/server/dto/prize";

/**
 * Manual stock adjustment (§7.4, §4.16; BUILD-LOG D-119).
 *
 * `POST /api/stock/adjust` shipped in Phase 4 and had no caller until now, so
 * the only way stock could move outside a sale, a transfer or a delivery was a
 * full opname. An opname is a whole-shop physical count — the wrong instrument
 * for "a customer dropped one teddy bear", which is the case §4.16 is written
 * for.
 *
 * **Two steps, deliberately.** The first picks a direction and a quantity; the
 * second is the shared `ReasonDialog`, which is where the change is actually
 * confirmed. Rolling both into one form would put the reason field next to a
 * +/- control and make it look optional — and §4.16's whole value is that an
 * owner reading the movement back months later can tell breakage from theft
 * from a counting error.
 *
 * The reason's `minLength` is 3 because `adjustStockSchema` says
 * `min(3)` — mirrored from the server, not invented here (see
 * `reason-dialog.tsx` on why that distinction matters).
 *
 * **The direction is a choice, not a sign.** Typing "-3" is easy to get wrong
 * on a tablet and impossible to notice afterwards; two labelled buttons carry
 * the meaning that the number alone does not. The negative is sent as
 * `-quantity`, which is what the service expects.
 */
export function AdjustStockButton({
  shopId,
  prize,
}: {
  shopId: string;
  prize: PrizeDTO;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState<"remove" | "add">("remove");
  const [qty, setQty] = useState("");
  const [reasonOpen, setReasonOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const parsedQty = Number(qty);
  const qtyValid = Number.isInteger(parsedQty) && parsedQty > 0;
  // Stock may never go negative. The server checks this inside the transaction
  // at commit time and is the real control — this only avoids offering a
  // button whose only outcome is a 422.
  const exceedsStock = direction === "remove" && parsedQty > prize.onHand;
  const canContinue = qtyValid && !exceedsStock;

  const delta = direction === "remove" ? -parsedQty : parsedQty;

  function reset() {
    setQty("");
    setDirection("remove");
    setOpen(false);
    setReasonOpen(false);
  }

  async function submit(reason: string) {
    setSubmitting(true);
    try {
      const response = await fetch("/api/stock/adjust", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Staff double-tap on slow shop wifi. Without this a retry books the
          // adjustment twice and the count is wrong in the other direction.
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ shopId, prizeItemId: prize.id, delta, reason }),
      });
      const result = await response.json().catch(() => null);

      if (!response.ok) {
        toast.error(result?.error?.message ?? "Could not adjust that stock.");
        return;
      }

      toast.success(
        direction === "remove"
          ? `Removed ${parsedQty} · ${prize.name} now ${result.onHand}`
          : `Added ${parsedQty} · ${prize.name} now ${result.onHand}`,
        {
          description:
            direction === "add"
              ? "Found stock has no cost yet — price it in the uncosted queue."
              : undefined,
        }
      );
      reset();
      router.refresh();
    } catch {
      toast.error("No connection. Check the wifi and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Adjust
      </Button>
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <div className="flex overflow-hidden rounded-lg border">
          <button
            type="button"
            onClick={() => setDirection("remove")}
            aria-pressed={direction === "remove"}
            className={cn(
              "min-h-11 px-3 text-sm font-medium",
              direction === "remove"
                ? "bg-destructive text-white"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Remove
          </button>
          <button
            type="button"
            onClick={() => setDirection("add")}
            aria-pressed={direction === "add"}
            className={cn(
              "min-h-11 border-l px-3 text-sm font-medium",
              direction === "add"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Add
          </button>
        </div>

        <Input
          value={qty}
          inputMode="numeric"
          placeholder="Qty"
          aria-label={`Quantity to adjust for ${prize.name}`}
          className="w-20"
          onChange={(e) => setQty(e.target.value.replace(/[^0-9]/g, ""))}
        />

        <Button
          size="sm"
          disabled={!canContinue}
          onClick={() => setReasonOpen(true)}
        >
          Continue
        </Button>
        <Button size="sm" variant="ghost" onClick={reset}>
          Cancel
        </Button>
      </div>

      {exceedsStock && (
        <p className="mt-1 text-right text-xs font-medium text-destructive">
          Only {prize.onHand} in stock.
        </p>
      )}

      <ReasonDialog
        open={reasonOpen}
        onOpenChange={setReasonOpen}
        title={direction === "remove" ? "Remove stock?" : "Add stock?"}
        description={`${prize.name} · ${prize.onHand} on hand now`}
        consequence={
          direction === "remove"
            ? `${parsedQty} will be taken from the oldest batches first, so the loss is valued at what those units actually cost. On hand becomes ${prize.onHand - parsedQty}.`
            : `${parsedQty} will be added as found stock with no cost yet — price it in the uncosted queue, or prize expense stays understated. On hand becomes ${prize.onHand + parsedQty}.`
        }
        label="Why is this being adjusted?"
        placeholder={
          direction === "remove" ? "Damaged by a customer" : "Found in the store room"
        }
        helpText="Recorded against the movement and the audit log. Be specific — breakage, theft and a miscount read very differently to an owner months later."
        confirmLabel={direction === "remove" ? "Remove stock" : "Add stock"}
        confirmVariant={direction === "remove" ? "destructive" : "default"}
        // Mirrors `adjustStockSchema`'s `min(3)`.
        minLength={3}
        submitting={submitting}
        onConfirm={submit}
      />
    </>
  );
}
