"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";

/**
 * The §8.8 "record an expense" form, now a modal rather than an inline
 * section — the history is the thing worth seeing by default when the tab
 * opens; recording is an action you reach for, not a wall of form above it.
 *
 * Amount is typed as a STRING and posted as one (D-13) — it is never put
 * through `Number()`, because a 14-digit rupiah value is already near the edge
 * of what a double represents exactly, and §4.1 forbids float money.
 *
 * One idempotency key per attempt, held in a ref and regenerated only after an
 * expense lands. Regenerating per render would let a double-tap send two
 * different keys and create two expenses — the exact failure NF-5 exists to
 * prevent, and the same shape the sale screen uses.
 */
interface CategoryOption {
  id: string;
  name: string;
}

export function AddExpense({
  currentShopId,
  shops,
  categories,
  businessDate,
}: {
  currentShopId: string;
  shops: { id: string; name: string }[];
  categories: CategoryOption[];
  /** Today's business date, `YYYY-MM-DD` — the default and the latest date the picker allows (D-124). */
  businessDate: string;
}) {
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [shopId, setShopId] = useState(currentShopId);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [date, setDate] = useState(businessDate);
  const [submitting, setSubmitting] = useState(false);

  const idempotencyKey = useRef(crypto.randomUUID());

  function reset() {
    setShopId(currentShopId);
    setCategoryId(null);
    setAmount("");
    setNote("");
    setDate(businessDate);
  }

  const canSubmit =
    categoryId !== null &&
    amount.trim() !== "" &&
    date.trim() !== "" &&
    date <= businessDate &&
    !submitting;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);

    try {
      const response = await fetch("/api/expenses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey.current,
        },
        body: JSON.stringify({
          shopId,
          categoryId,
          amount: amount.trim(),
          note: note.trim() || undefined,
          // Only sent when backdated — omitting it on the common case (today)
          // keeps the request identical to before D-124 for the normal path.
          businessDate: date !== businessDate ? date : undefined,
        }),
      });
      const body = await response.json().catch(() => null);

      if (!response.ok) {
        toast.error(body?.error?.message ?? "Could not record that expense.");
        return;
      }

      toast.success(`Recorded ${formatMoney(body.amount)}`);

      // A new key only AFTER one lands, so a retry of a failed attempt still
      // replays rather than duplicating.
      idempotencyKey.current = crypto.randomUUID();
      setOpen(false);
      reset();
      router.refresh();
    } catch {
      toast.error("No connection. Check the wifi and try again.");
    } finally {
      setSubmitting(false);
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
          <Button size="lg">
            <Plus className="size-4" />
            Record expense
          </Button>
        }
      />

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record expense</DialogTitle>
          <DialogDescription>
            Defaults to today. Back-date it if you&apos;re entering a receipt
            late — it cannot be dated in the future.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="expense-date" className="text-sm font-medium">
              Date
            </label>
            <Input
              id="expense-date"
              type="date"
              value={date}
              max={businessDate}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>

          {shops.length > 1 && (
            <div className="space-y-1">
              <label htmlFor="expense-shop" className="text-sm font-medium">
                Shop
              </label>
              {/* HQ is in this list on purpose (§4.12) — it is where a
                  non-branch cost goes. It is absent from the sale screen. */}
              <select
                id="expense-shop"
                value={shopId}
                onChange={(e) => setShopId(e.target.value)}
                className="h-12 w-full rounded-lg border bg-background px-3"
              >
                {shops.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="space-y-1">
            <p className="text-sm font-medium">Category</p>
            {categories.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No categories yet. Add one from &quot;Manage categories&quot;.
              </p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {categories.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setCategoryId(c.id)}
                      aria-pressed={categoryId === c.id}
                      className={cn(
                        "min-h-11 rounded-lg border px-4 text-sm",
                        categoryId === c.id
                          ? "border-primary bg-primary text-primary-foreground"
                          : "hover:bg-muted",
                      )}
                    >
                      {c.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-1">
            <label htmlFor="expense-amount" className="text-sm font-medium">
              Amount
            </label>
            <Input
              id="expense-amount"
              // §8.11: numeric inputs use inputMode="numeric" so a tablet shows
              // the number pad rather than a full keyboard.
              inputMode="numeric"
              placeholder="250000"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
              autoFocus
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="expense-note" className="text-sm font-medium">
              Note <span className="text-muted-foreground">(optional)</span>
            </label>
            <Input
              id="expense-note"
              placeholder="August electricity"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {submitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            Record expense
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
