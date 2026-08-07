import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { requireRolePage } from "@/server/auth/page-guard";
import { listCategories } from "@/server/services/expenses";
import { Button } from "@/components/ui/button";
import { CategoryManager } from "./category-manager";

export const metadata = { title: "Expense categories · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Owner-only category manager (§8.8, §4.12).
 *
 * Archived categories ARE listed here — this is the one screen that must show
 * them, because it is the only place they can be brought back.
 */
export default async function ExpenseCategoriesPage() {
  const actor = await requireRolePage("OWNER");
  const categories = await listCategories(actor, { includeArchived: true });

  return (
    <div className="space-y-5">
      <Button variant="ghost" size="sm" render={<Link href="/settings" />}>
        <ChevronLeft className="size-4" />
        Settings
      </Button>

      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          Expense categories
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A category still used by an expense cannot be deleted — archive it
          instead to hide it from new entries while keeping its history.
        </p>
      </div>

      <CategoryManager initialCategories={categories} />
    </div>
  );
}
