"use client";

import { useEffect, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { Input } from "@/components/ui/input";

/** Filters stay in the URL so their complete, server-filtered result set pages consistently. */
export function AuditLogFilters({
  q,
  from,
  to,
}: {
  q?: string;
  from?: string;
  to?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState(q ?? "");
  const [pending, startTransition] = useTransition();

  useEffect(() => setQuery(q ?? ""), [q]);

  function apply(next: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(next)) {
      if (!value) params.delete(key);
      else params.set(key, value);
    }
    params.delete("cursor");

    startTransition(() => {
      router.push(params.size ? `${pathname}?${params}` : pathname);
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <form
        className="flex min-w-56 flex-1 items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          apply({ q: query.trim() || null });
        }}
      >
        <label className="flex flex-1 flex-col gap-1 text-xs font-medium text-muted-foreground">
          Search audit log
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Person, shop, action, reason…"
            maxLength={120}
            disabled={pending}
          />
        </label>
        <Button type="submit" disabled={pending}>
          Search
        </Button>
      </form>

      <DateRangePicker
        from={from}
        to={to}
        onChange={(nextFrom, nextTo) =>
          apply({ from: nextFrom || null, to: nextTo || null })
        }
      />

      {(q || from || to) && (
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() => apply({ q: null, from: null, to: null })}
        >
          <X className="size-3.5" />
          Clear
        </Button>
      )}

      {pending && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
    </div>
  );
}
