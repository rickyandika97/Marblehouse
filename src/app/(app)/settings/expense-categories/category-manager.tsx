"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The owner's category manager (§4.12, §8.8).
 *
 * The delete refusal is the screen's whole reason for existing, so it must
 * SHOW the count rather than a generic failure. `CATEGORY_IN_USE` carries
 * `details.usageCount`; the toast repeats the server's message, which already
 * names the number and points at archiving as the alternative.
 *
 * A category that is in use is not offered a Delete button at all — but the
 * button's absence is not the control. The server refuses regardless, which is
 * what the acceptance criterion tests.
 */
interface Category {
  id: string;
  name: string;
  isArchived: boolean;
  sortOrder: number;
}

export function CategoryManager({
  initialCategories,
}: {
  initialCategories: Category[];
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  async function create() {
    if (!name.trim() || busy) return;
    setBusy("create");
    try {
      const res = await fetch("/api/expense-categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(body?.error?.message ?? "Could not add that category.");
        return;
      }
      toast.success(`Added ${body.name}`);
      setName("");
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function setArchived(category: Category, isArchived: boolean) {
    setBusy(category.id);
    try {
      const res = await fetch(`/api/expense-categories/${category.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isArchived }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(body?.error?.message ?? "Could not update that category.");
        return;
      }
      toast.success(
        isArchived ? `Archived ${category.name}` : `Restored ${category.name}`,
      );
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function remove(category: Category) {
    setBusy(category.id);
    try {
      const res = await fetch(`/api/expense-categories/${category.id}`, {
        method: "DELETE",
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        // The 409 path. The server's message already carries the usage count
        // and names archiving as the alternative — showing it verbatim keeps
        // one wording rather than two that can drift apart.
        toast.error(body?.error?.message ?? "Could not delete that category.");
        return;
      }

      toast.success(`Deleted ${category.name}`);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3 rounded-xl border p-4">
        <label htmlFor="new-category" className="text-sm font-medium">
          New category
        </label>
        <div className="flex gap-2">
          <Input
            id="new-category"
            value={name}
            placeholder="Machine Maintenance"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void create();
            }}
          />
          <Button
            onClick={create}
            disabled={!name.trim() || busy === "create"}
          >
            <Plus className="size-4" />
            Add
          </Button>
        </div>
      </section>

      <ul className="space-y-2">
        {initialCategories.map((c) => (
          <li
            key={c.id}
            className="flex items-center justify-between gap-3 rounded-xl border p-4"
          >
            <div className="min-w-0 flex-1">
              <p className="font-medium">{c.name}</p>
              {c.isArchived && (
                <p className="text-sm text-muted-foreground">
                  Archived — hidden from new expenses
                </p>
              )}
            </div>

            <div className="flex shrink-0 gap-2">
              {c.isArchived ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy === c.id}
                  onClick={() => setArchived(c, false)}
                >
                  <ArchiveRestore className="size-4" />
                  Restore
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy === c.id}
                  onClick={() => setArchived(c, true)}
                >
                  <Archive className="size-4" />
                  Archive
                </Button>
              )}

              <Button
                variant="destructive"
                size="sm"
                disabled={busy === c.id}
                onClick={() => remove(c)}
              >
                <Trash2 className="size-4" />
                Delete
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
