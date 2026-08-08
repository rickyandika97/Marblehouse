"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import { EditExpense } from "./edit-expense";

/**
 * The §8.8 expense screen: a list with a running total, and an add form.
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

interface ExpenseRow {
  id: string;
  amount: string;
  note: string | null;
  businessDate: string;
  shop: { id: string; name: string };
  category: { id: string; name: string };
  recordedBy: { id: string; displayName: string };
}

export function ExpenseScreen({
  currentShopId,
  shops,
  categories,
  initialExpenses,
  nextCursor,
  canEdit = false,
}: {
  currentShopId: string;
  shops: { id: string; name: string }[];
  categories: CategoryOption[];
  initialExpenses: ExpenseRow[];
  canManageCategories: boolean;
  /** Opaque continuation from `listExpenses`; null when this is the last page. */
  nextCursor?: string | null;
  /**
   * OWNER only — edit and delete are owner-only in the service (§7.6).
   * Hiding the control is NOT the permission: `updateExpense` and
   * `deleteExpense` both re-check the role server-side. This only avoids
   * offering a manager a button that would 403.
   */
  canEdit?: boolean;
}) {
  const router = useRouter();

  const [shopId, setShopId] = useState(currentShopId);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const idempotencyKey = useRef(crypto.randomUUID());

  const canSubmit = categoryId !== null && amount.trim() !== "" && !submitting;

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
      setAmount("");
      setNote("");
      router.refresh();
    } catch {
      toast.error("No connection. Check the wifi and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3 rounded-xl border p-4">
        <h2 className="font-medium">Add an expense</h2>

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
              No categories yet. The owner adds them in Settings.
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

        <Button
          size="lg"
          className="w-full"
          onClick={submit}
          disabled={!canSubmit}
        >
          {submitting ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Plus className="size-4" />
          )}
          Record expense
        </Button>
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">Recent</h2>
        {initialExpenses.length === 0 ? (
          // Deliberately does not say "for this branch" — with a filter applied
          // that would be wrong, and it is the case where a puzzled reader most
          // needs the message to be accurate.
          <p className="rounded-xl border p-4 text-sm text-muted-foreground">
            No expenses match. Try a wider date range or clear the filters.
          </p>
        ) : (
          <ul className="space-y-2">
            {initialExpenses.map((e) => (
              <li
                key={e.id}
                className="flex items-center justify-between gap-3 rounded-xl border p-4"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{e.category.name}</p>
                  <p className="truncate text-sm text-muted-foreground">
                    {e.businessDate} · {e.shop.name} · {e.recordedBy.displayName}
                    {e.note ? ` · ${e.note}` : ""}
                  </p>
                </div>
                <p className="shrink-0 font-semibold tabular-nums">
                  {formatMoney(e.amount)}
                </p>
                {canEdit && <EditExpense expense={e} categories={categories} />}
              </li>
            ))}
          </ul>
        )}

        {nextCursor && <LoadMore cursor={nextCursor} />}
      </section>
    </div>
  );
}

/**
 * §8.8's paging. NF-4 caps every list at 50 rows, so a branch with a year of
 * expenses needs a way to reach the rest.
 *
 * A link rather than a fetch: it carries the CURRENT filters forward by
 * building on the existing search params, so paging inside a filtered view
 * stays inside that view. Appending a cursor to a bare path would silently
 * drop the filters and show the wrong second page.
 */
function LoadMore({ cursor }: { cursor: string }) {
  const searchParams = useSearchParams();
  const params = new URLSearchParams(searchParams.toString());
  params.set("cursor", cursor);

  return (
    <Link
      href={`/expenses?${params}`}
      scroll={false}
      className="flex min-h-11 w-full items-center justify-center rounded-xl border text-sm font-medium hover:bg-muted"
    >
      Load more
    </Link>
  );
}
