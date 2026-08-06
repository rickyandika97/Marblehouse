"use client";

/**
 * Customer search (§8.5).
 *
 *   "Search-first screen: a single large input, keyboard defaults to numeric,
 *    matches partial phone or name. Result rows show name · phone · 🔵 marbles
 *    · 🎟 tickets — the four things staff need most."
 *
 * The balances shown here are Phase 3's data. They are rendered now because the
 * row is specified to show them and the columns already exist — they simply
 * read 0 until the ledgers land.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Search, UserRound } from "lucide-react";
import { Input } from "@/components/ui/input";

interface CustomerRow {
  id: string;
  name: string;
  phoneDisplay: string;
  marbleBalance: number;
  ticketBalance: number;
}

export function CustomerSearch({ initial }: { initial: CustomerRow[] }) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<CustomerRow[]>(initial);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/customers?q=${encodeURIComponent(query)}`,
          { cache: "no-store" }
        );
        if (!res.ok || cancelled) return;
        const body = await res.json();
        if (!cancelled) setRows(body.customers ?? []);
      } catch {
        // Leave the previous results on screen rather than blanking the list.
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 200);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" />
        <Input
          autoFocus
          inputMode="numeric"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Phone number or name"
          className="h-14 pl-11 text-lg"
        />
        {loading && (
          <Loader2 className="absolute right-3 top-1/2 size-5 -translate-y-1/2 animate-spin text-muted-foreground" />
        )}
      </div>

      {rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {query ? "Nobody matches that." : "No customers yet."}
        </p>
      ) : (
        <ul className="divide-y rounded-xl border">
          {rows.map((customer) => (
            <li key={customer.id}>
              <Link
                href={`/customers/${customer.id}`}
                className="flex items-center gap-3 px-4 py-4 hover:bg-muted"
              >
                <UserRound className="size-5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {customer.name}
                  </span>
                  <span className="block truncate text-sm text-muted-foreground">
                    {customer.phoneDisplay}
                  </span>
                </span>
                <span className="shrink-0 text-right text-sm">
                  <span className="block tabular-nums">
                    🔵 {customer.marbleBalance}
                  </span>
                  <span className="block tabular-nums">
                    🎟 {customer.ticketBalance}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
