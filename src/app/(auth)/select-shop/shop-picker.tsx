"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Search, Store } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface PickerShop {
  id: string;
  code: string;
  name: string;
}

/**
 * Day-start shop picker (§4.7, §8.1 step 3).
 *
 * Full-screen and non-dismissible: there is deliberately no close button and
 * no cancel path. The user's default shop is pre-selected and listed first.
 *
 * Past 8 shops this switches from a tile grid to a searchable list (§5.6) —
 * built now because it is ten minutes now and a rewrite later.
 */
export function ShopPicker({
  shops,
  defaultShopId,
  useSearch,
  businessDate,
}: {
  shops: PickerShop[];
  defaultShopId: string | null;
  useSearch: boolean;
  businessDate: string;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(defaultShopId);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Default shop first, then alphabetical (§4.7).
  const ordered = useMemo(() => {
    const rest = shops.filter((s) => s.id !== defaultShopId);
    const preferred = shops.find((s) => s.id === defaultShopId);
    return preferred ? [preferred, ...rest] : rest;
  }, [shops, defaultShopId]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter(
      (s) =>
        s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q)
    );
  }, [ordered, query]);

  async function confirm() {
    if (!selected || pending) return;

    setPending(true);
    setError(null);

    try {
      const res = await fetch("/api/work-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopId: selected }),
      });

      const body = await res.json();

      if (!res.ok) {
        setError(body?.error?.message ?? "Could not set your shop.");
        setPending(false);
        return;
      }

      router.replace("/");
      router.refresh();
    } catch {
      setError("Cannot reach the server. Check the shop's internet connection.");
      setPending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-5 py-8">
        <header className="shrink-0">
          <h1 className="text-2xl font-bold tracking-tight">
            Which shop are you working at today?
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Everything you record today is filed under this branch. Business day{" "}
            {businessDate}.
          </p>
        </header>

        {useSearch && (
          <div className="relative mt-6 shrink-0">
            <Search className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search branches by name or code"
              className="pl-12"
              autoFocus
            />
          </div>
        )}

        <div className="-mx-1 mt-6 flex-1 overflow-y-auto px-1">
          {visible.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No branch matches “{query}”.
            </p>
          ) : (
            <ul
              className={cn(
                "grid gap-3",
                useSearch ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2"
              )}
            >
              {visible.map((shop) => {
                const isSelected = shop.id === selected;
                const isDefault = shop.id === defaultShopId;

                return (
                  <li key={shop.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(shop.id)}
                      aria-pressed={isSelected}
                      className={cn(
                        "flex w-full items-center gap-4 rounded-xl border-2 p-4 text-left transition-colors",
                        "min-h-16",
                        isSelected
                          ? "border-primary bg-primary/5"
                          : "border-border hover:bg-muted"
                      )}
                    >
                      <span
                        className={cn(
                          "flex size-11 shrink-0 items-center justify-center rounded-lg",
                          isSelected
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground"
                        )}
                      >
                        {isSelected ? (
                          <Check className="size-5" />
                        ) : (
                          <Store className="size-5" />
                        )}
                      </span>

                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold">
                          {shop.name}
                        </span>
                        <span className="block text-sm text-muted-foreground">
                          {shop.code}
                          {isDefault && " · your usual branch"}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {error && (
          <p
            role="alert"
            className="mt-4 shrink-0 rounded-lg bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive"
          >
            {error}
          </p>
        )}

        <div className="mt-6 shrink-0">
          <Button
            size="xl"
            className="w-full"
            onClick={confirm}
            disabled={!selected || pending}
          >
            {pending && <Loader2 className="animate-spin" />}
            {pending ? "Setting up…" : "Start work here"}
          </Button>
        </div>
      </div>
    </div>
  );
}
