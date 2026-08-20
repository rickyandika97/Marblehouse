"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { formatMoney } from "@/lib/money";
import { EditExpense } from "./edit-expense";

/**
 * The §8.8 expense screen: the filtered history list, with a running total
 * shown above it. Recording and category management are separate modals
 * (`AddExpense`, `ManageCategoriesDialog`) triggered from the page header —
 * this component only renders what has already happened.
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
  categories,
  initialExpenses,
  nextCursor,
  canEdit = false,
}: {
  categories: CategoryOption[];
  initialExpenses: ExpenseRow[];
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
  return (
    <div className="space-y-6">
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
