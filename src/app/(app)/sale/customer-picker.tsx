"use client";

/**
 * Customer picker sheet (§8.2).
 *
 *   "Search field that matches on partial phone digits or name, a 'recent
 *    customers at this shop' list, and a '+ New customer' form (name + phone).
 *    'Skip — walk-in' is always the easy option."
 *
 * Walk-in is the default state of the sale form, so "skip" here is simply
 * closing the sheet — which is why Cancel is a full-width control rather than a
 * small × in a corner.
 *
 * Why the phone number is asked for at all is stated in the copy: it is the
 * only way stored marbles and tickets can follow a customer between branches
 * (§4.4). Staff who do not know that will not bother collecting it.
 */

import { useEffect, useRef, useState } from "react";
import { Loader2, Plus, Search, UserRound } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface PickedCustomer {
  id: string;
  name: string;
  phoneDisplay: string;
  marbleBalance: number;
  ticketBalance: number;
}

export function CustomerPicker({
  open,
  onOpenChange,
  onPick,
  shopId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (customer: PickedCustomer) => void;
  /** Scopes the empty-query list to this shop's regulars (§8.2). */
  shopId: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PickedCustomer[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  // Reset to a clean sheet each time it opens — the previous customer's search
  // is never what you want for the next person in the queue.
  useEffect(() => {
    if (open) {
      setQuery("");
      setCreating(false);
    }
  }, [open]);

  /**
   * Debounced search. 200 ms is below the threshold where typing feels laggy
   * but well above the rate that would fire a query per keystroke on a tablet
   * keyboard.
   */
  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        // With no query typed, scope to this shop so the picker opens on the
        // regulars staff actually see (§8.2) rather than every customer ever.
        const params = new URLSearchParams({ q: query });
        if (query.trim() === "") params.set("shopId", shopId);

        const res = await fetch(`/api/customers?${params}`, {
          cache: "no-store",
        });
        if (!res.ok || cancelled) return;
        const body = await res.json();
        if (!cancelled) setResults(body.customers ?? []);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 200);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, open, shopId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{creating ? "New customer" : "Find customer"}</DialogTitle>
          <DialogDescription>
            {creating
              ? "A phone number is what lets stored marbles and tickets follow them to any branch."
              : "Search by phone number or name."}
          </DialogDescription>
        </DialogHeader>

        {creating ? (
          <NewCustomerForm
            initialQuery={query}
            onCreated={onPick}
            onCancel={() => setCreating(false)}
          />
        ) : (
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                // Staff type digits far more often than letters here.
                inputMode="numeric"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Phone or name"
                className="pl-11"
              />
            </div>

            <div className="max-h-72 space-y-1 overflow-y-auto">
              {loading && results.length === 0 && (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  <Loader2 className="mx-auto size-5 animate-spin" />
                </p>
              )}

              {!loading && results.length === 0 && (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  {query
                    ? "Nobody matches that."
                    : "No customers yet at this shop."}
                </p>
              )}

              {results.map((customer) => (
                <button
                  key={customer.id}
                  type="button"
                  onClick={() => onPick(customer)}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-muted"
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
                  {/* The two numbers staff are asked about most (§8.5). */}
                  <span className="shrink-0 text-right text-xs text-muted-foreground">
                    <span className="block tabular-nums">
                      🔵 {customer.marbleBalance}
                    </span>
                    <span className="block tabular-nums">
                      🎟 {customer.ticketBalance}
                    </span>
                  </span>
                </button>
              ))}
            </div>

            <div className="grid gap-2">
              <Button variant="outline" size="lg" onClick={() => setCreating(true)}>
                <Plus className="size-5" />
                New customer
              </Button>
              <Button
                variant="ghost"
                size="lg"
                onClick={() => onOpenChange(false)}
              >
                Skip — walk-in
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function NewCustomerForm({
  initialQuery,
  onCreated,
  onCancel,
}: {
  initialQuery: string;
  onCreated: (customer: PickedCustomer) => void;
  onCancel: () => void;
}) {
  // If they typed digits into the search, it was almost certainly the phone
  // number they were looking for — carry it across rather than making them
  // type it twice.
  const looksNumeric = /^[\d+\-\s]+$/.test(initialQuery) && initialQuery.length > 3;

  const [name, setName] = useState(looksNumeric ? "" : initialQuery);
  const [phone, setPhone] = useState(looksNumeric ? initialQuery : "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const idempotencyKey = useRef<string>(crypto.randomUUID());

  async function save() {
    if (!name.trim() || !phone.trim() || saving) return;

    setSaving(true);
    setError(null);

    try {
      const res = await fetch("/api/customers", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey.current,
        },
        body: JSON.stringify({ name: name.trim(), phone: phone.trim() }),
      });

      const body = await res.json().catch(() => null);

      if (!res.ok) {
        setError(body?.error?.message ?? "Could not save that customer.");
        // A failed attempt is a different attempt next time.
        idempotencyKey.current = crypto.randomUUID();
        return;
      }

      onCreated(body);
    } catch {
      setError("No connection. Check the wifi and try again.");
      idempotencyKey.current = crypto.randomUUID();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <label htmlFor="new-name" className="text-sm font-medium">
          Name
        </label>
        <Input
          id="new-name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Customer name"
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="new-phone" className="text-sm font-medium">
          Phone
        </label>
        <Input
          id="new-phone"
          inputMode="numeric"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="0812…"
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="grid gap-2">
        <Button
          size="lg"
          disabled={!name.trim() || !phone.trim() || saving}
          onClick={save}
        >
          {saving ? <Loader2 className="size-5 animate-spin" /> : "Save and use"}
        </Button>
        <Button variant="ghost" size="lg" onClick={onCancel}>
          Back
        </Button>
      </div>
    </div>
  );
}
