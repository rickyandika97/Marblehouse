"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, PackagePlus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/** Receive stock for the item whose inventory row opened this dialog. */
export function ReceiveBatchButton({
  shopId,
  prizeItemId,
  prizeName,
  shopName,
  showCost,
}: {
  shopId: string;
  prizeItemId: string;
  prizeName: string;
  shopName: string;
  showCost: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState("");
  const [unitCogs, setUnitCogs] = useState("");
  const [batchCode, setBatchCode] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const parsedQty = Number(qty);
  const canSubmit = !submitting && Number.isInteger(parsedQty) && parsedQty > 0;

  function reset() {
    setQty("");
    setUnitCogs("");
    setBatchCode("");
    setOpen(false);
  }

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const response = await fetch("/api/stock/batches", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // A double-tap on shop wifi must not book two deliveries.
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          shopId,
          prizeItemId,
          qtyReceived: parsedQty,
          batchCode: batchCode.trim() || undefined,
          // Supplier intentionally is not collected in this per-item flow.
          ...(showCost && unitCogs.trim() !== "" ? { unitCogs: Number(unitCogs) } : {}),
        }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(result?.error?.message ?? "Could not record that delivery.");
        return;
      }

      toast.success("Stock received", {
        description:
          showCost && unitCogs.trim() !== ""
            ? `${parsedQty} units added.`
            : `${parsedQty} units added — waiting for the owner to set a cost.`,
      });
      router.refresh();
      reset();
    } catch {
      toast.error("No connection. Check the wifi and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="h-8 min-h-0 rounded-lg px-3 text-xs font-semibold"
        onClick={(event) => {
          // The enclosing row opens the item drawer; this action must not.
          event.stopPropagation();
          setOpen(true);
        }}
      >
        + Batch
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) reset();
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="max-h-[88vh] max-w-[440px] gap-0 overflow-y-auto rounded-[18px] bg-popover p-6 sm:max-w-[440px]"
          onClick={(event) => event.stopPropagation()}
        >
          <DialogHeader className="flex-row items-start justify-between gap-3">
            <div>
              <DialogTitle className="text-xl font-bold leading-tight">
                Receive a delivery
              </DialogTitle>
              <p className="mt-1 text-[13px] text-muted-foreground">
                {prizeName} at {shopName}
              </p>
            </div>
            <DialogClose
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="-mr-2 -mt-2 size-9 text-muted-foreground"
                />
              }
            >
              <X className="size-5" />
              <span className="sr-only">Close</span>
            </DialogClose>
          </DialogHeader>

          <div className="mt-[18px] flex flex-col gap-3.5">
            <label className="text-[13px] font-semibold text-foreground">
              Quantity received
              <Input
                className="mt-[5px] h-11 rounded-[10px] bg-background px-3 text-lg font-bold tabular-nums"
                inputMode="numeric"
                value={qty}
                onChange={(event) => setQty(event.target.value.replace(/\D/g, ""))}
                placeholder="0"
                disabled={submitting}
              />
            </label>

            {showCost ? (
              <label className="text-[13px] font-semibold text-foreground">
                Unit cost
                <Input
                  className="mt-[5px] h-11 rounded-[10px] bg-background px-3 text-sm tabular-nums"
                  inputMode="numeric"
                  value={unitCogs}
                  onChange={(event) =>
                    setUnitCogs(event.target.value.replace(/[^\d.]/g, ""))
                  }
                  placeholder="Cost per single unit"
                  disabled={submitting}
                />
                <span className="mt-1 block text-xs font-normal text-muted-foreground">
                  Leave blank to price it later.
                </span>
              </label>
            ) : (
              <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
                Cost will be added by the owner.
              </p>
            )}

            <label className="text-[13px] font-semibold text-foreground">
              Batch code{" "}
              <span className="font-normal text-muted-foreground">(optional)</span>
              <Input
                className="mt-[5px] h-11 rounded-[10px] bg-background px-3 text-sm"
                value={batchCode}
                onChange={(event) => setBatchCode(event.target.value)}
                maxLength={60}
                disabled={submitting}
              />
            </label>

            <div className="flex gap-2.5">
              <Button
                className="h-12 rounded-[10px] px-5 text-[15px] font-semibold"
                disabled={!canSubmit}
                onClick={submit}
              >
                {submitting ? (
                  <Loader2 className="size-5 animate-spin" />
                ) : (
                  <PackagePlus className="size-5" />
                )}
                Receive stock
              </Button>
              <Button
                variant="ghost"
                className="h-12 rounded-[10px] px-5 text-[15px] font-semibold"
                onClick={reset}
                disabled={submitting}
              >
                Cancel
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
