"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil, Trash2 } from "lucide-react";
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
} from "@/components/ui/dialog";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";

/**
 * Edit or delete one expense (§8.8) — OWNER only.
 *
 * **Category, amount and note are editable. Shop and business date are not**,
 * and that is the service's rule rather than a UI shortcut. A cost recorded
 * against the wrong branch or the wrong reporting day is not a typo — it is a
 * different event, and silently moving the figure would change a report someone
 * may already have read. The fix for those is delete-with-a-reason and
 * re-record, which leaves both rows in the audit trail.
 *
 * The delete reason uses a real dialog rather than `window.prompt`. This was the
 * first such dialog (D-70) and the shape Phase 10's sweep copied: the other
 * three sites — sale void, transfer cancel, attendance excuse — now share
 * `components/reason-dialog.tsx`. This one stays inline because its dialog does
 * double duty as the *edit* form; the shared component only handles the
 * reason-then-confirm case.
 */
interface CategoryOption {
  id: string;
  name: string;
}

export function EditExpense({
  expense,
  categories,
}: {
  expense: {
    id: string;
    amount: string;
    note: string | null;
    businessDate: string;
    shop: { id: string; name: string };
    category: { id: string; name: string };
  };
  categories: CategoryOption[];
}) {
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Seeded from the row each time the dialog opens, so cancelling and
  // reopening never shows a stale half-edit.
  const [categoryId, setCategoryId] = useState(expense.category.id);
  const [amount, setAmount] = useState(expense.amount);
  const [note, setNote] = useState(expense.note ?? "");
  const [reason, setReason] = useState("");

  function reset() {
    setCategoryId(expense.category.id);
    setAmount(expense.amount);
    setNote(expense.note ?? "");
    setReason("");
    setConfirmingDelete(false);
  }

  const amountValid = /^\d{1,12}(\.\d{1,2})?$/.test(amount.trim()) && Number(amount) > 0;
  const changed =
    categoryId !== expense.category.id ||
    amount.trim() !== expense.amount ||
    note.trim() !== (expense.note ?? "");

  async function save() {
    if (!amountValid || !changed) return;
    setSubmitting(true);
    try {
      const response = await fetch(`/api/expenses/${expense.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categoryId,
          // A string all the way to the server (D-13). Never Number().
          amount: amount.trim(),
          // null clears the note; undefined would leave it untouched.
          note: note.trim() === "" ? null : note.trim(),
        }),
      });
      const body = await response.json().catch(() => null);

      if (!response.ok) {
        toast.error(body?.error?.message ?? "Could not save that change.");
        return;
      }

      toast.success(`Updated to ${formatMoney(body.amount)}`);
      setOpen(false);
      router.refresh();
    } catch {
      toast.error("No connection. Check the wifi and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function remove() {
    // The server requires 3 characters; checking here saves a round trip and a
    // confusing error on a form the user is still filling in.
    if (reason.trim().length < 3) return;
    setSubmitting(true);
    try {
      const response = await fetch(`/api/expenses/${expense.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const body = await response.json().catch(() => null);

      if (!response.ok) {
        toast.error(body?.error?.message ?? "Could not delete that expense.");
        return;
      }

      toast.success("Expense deleted");
      setOpen(false);
      router.refresh();
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
        variant="ghost"
        aria-label={`Edit ${expense.category.name} expense of ${formatMoney(expense.amount)}`}
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        <Pencil className="size-4" />
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmingDelete ? "Delete this expense?" : "Edit expense"}
            </DialogTitle>
            <DialogDescription>
              {expense.businessDate} · {expense.shop.name}
              {/* Stated rather than left to be discovered by a missing field. */}
              {!confirmingDelete && " · the branch and date cannot be changed"}
            </DialogDescription>
          </DialogHeader>

          {confirmingDelete ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                The record is kept and marked deleted, so the audit trail stays
                intact. It will stop counting towards expense totals.
              </p>
              <div className="space-y-1">
                <label htmlFor="delete-reason" className="text-sm font-medium">
                  Why are you deleting it?
                </label>
                <Input
                  id="delete-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Recorded twice by mistake"
                  autoFocus
                />
                <p className="text-xs text-muted-foreground">
                  At least 3 characters. This is written to the audit log.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-1">
                <p className="text-sm font-medium">Category</p>
                <ul className="flex flex-wrap gap-2">
                  {categories.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => setCategoryId(c.id)}
                        aria-pressed={categoryId === c.id}
                        className={cn(
                          "min-h-11 rounded-lg border px-3 text-sm",
                          categoryId === c.id
                            ? "border-primary bg-primary text-primary-foreground"
                            : "hover:bg-muted"
                        )}
                      >
                        {c.name}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="space-y-1">
                <label htmlFor="edit-amount" className="text-sm font-medium">
                  Amount
                </label>
                <Input
                  id="edit-amount"
                  inputMode="numeric"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
                />
                {amount.trim() !== "" && !amountValid && (
                  <p className="text-xs text-red-600">
                    Enter an amount like 250000, more than zero.
                  </p>
                )}
              </div>

              <div className="space-y-1">
                <label htmlFor="edit-note" className="text-sm font-medium">
                  Note <span className="text-muted-foreground">(optional)</span>
                </label>
                <Input
                  id="edit-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="August electricity"
                />
              </div>
            </div>
          )}

          <DialogFooter className="gap-2">
            {confirmingDelete ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => setConfirmingDelete(false)}
                  disabled={submitting}
                >
                  Back
                </Button>
                <Button
                  variant="destructive"
                  onClick={remove}
                  disabled={submitting || reason.trim().length < 3}
                >
                  {submitting && <Loader2 className="size-4 animate-spin" />}
                  Delete expense
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="ghost"
                  onClick={() => setConfirmingDelete(true)}
                  disabled={submitting}
                  className="mr-auto text-red-600 hover:text-red-700"
                >
                  <Trash2 className="size-4" />
                  Delete
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setOpen(false)}
                  disabled={submitting}
                >
                  Cancel
                </Button>
                <Button onClick={save} disabled={submitting || !changed || !amountValid}>
                  {submitting && <Loader2 className="size-4 animate-spin" />}
                  Save changes
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
