"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Minus, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Redemption cart (§8.6).
 *
 * Three things here are load-bearing rather than cosmetic:
 *
 *  - Prizes the customer cannot afford are GREYED AND VISIBLE, not hidden.
 *    §4.9 is explicit: seeing the reward you are short of motivates the
 *    customer, so the badge says "needs 80 more" rather than removing the card.
 *  - The ticket balance in the header decrements LIVE as the cart fills, so
 *    staff can answer "can I afford this too?" without arithmetic.
 *  - ONE idempotency key per redemption attempt, held in a ref and regenerated
 *    only after a redemption lands — the Phase 2 sale-screen rule. A key
 *    regenerated per render would turn a double-tap into two redemptions,
 *    which is the exact failure it exists to prevent.
 */
export interface RedeemablePrize {
  id: string;
  name: string;
  category: string | null;
  ticketCost: number;
  onHand: number;
}

export function RedeemCart({
  customerId,
  customerName,
  ticketBalance,
  prizes,
}: {
  customerId: string;
  customerName: string;
  ticketBalance: number;
  prizes: RedeemablePrize[];
}) {
  const router = useRouter();
  const [cart, setCart] = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);
  const key = useRef(crypto.randomUUID());

  const byId = useMemo(() => new Map(prizes.map((p) => [p.id, p])), [prizes]);

  const lines = Object.entries(cart)
    .filter(([, qty]) => qty > 0)
    .map(([prizeItemId, qty]) => ({ prize: byId.get(prizeItemId)!, qty }))
    .filter((l) => l.prize !== undefined);

  const totalTickets = lines.reduce(
    (sum, l) => sum + l.prize.ticketCost * l.qty,
    0
  );
  const remaining = ticketBalance - totalTickets;

  function add(prize: RedeemablePrize) {
    setCart((current) => {
      const qty = current[prize.id] ?? 0;
      // Two independent ceilings: physical stock, and what the remaining
      // balance can pay for. The server re-checks both — this only stops the
      // staff member building a cart that is guaranteed to be rejected.
      if (qty >= prize.onHand) return current;
      if (prize.ticketCost > remaining) return current;
      return { ...current, [prize.id]: qty + 1 };
    });
  }

  function remove(prizeId: string) {
    setCart((current) => {
      const qty = (current[prizeId] ?? 0) - 1;
      if (qty <= 0) {
        const { [prizeId]: _removed, ...rest } = current;
        return rest;
      }
      return { ...current, [prizeId]: qty };
    });
  }

  async function confirm() {
    if (lines.length === 0 || submitting) return;
    setSubmitting(true);
    try {
      const response = await fetch("/api/redemptions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": key.current,
        },
        body: JSON.stringify({
          customerId,
          lines: lines.map((l) => ({ prizeItemId: l.prize.id, qty: l.qty })),
        }),
      });
      const result = await response.json().catch(() => null);

      if (!response.ok) {
        toast.error(result?.error?.message ?? "Could not complete that redemption.");
        return;
      }

      // §8.6 wants a success screen showing WHAT TO HAND OVER. The toast
      // carries it because the page navigates straight back to the customer.
      toast.success("Redemption complete", {
        description: `Hand over: ${lines
          .map((l) => `${l.qty} × ${l.prize.name}`)
          .join(", ")} · New balance ${result.ticketBalanceAfter.toLocaleString("id-ID")} tickets`,
        duration: 10_000,
      });

      key.current = crypto.randomUUID();
      setCart({});
      router.push(`/customers/${customerId}`);
      router.refresh();
    } catch {
      toast.error("No connection. Check the wifi and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Pinned header: the balance staff are spending, decrementing live. */}
      <div className="sticky top-14 z-30 -mx-4 border-b bg-background px-4 py-3">
        <div className="flex items-baseline gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{customerName}</p>
            <p className="text-xs text-muted-foreground">
              {totalTickets > 0
                ? `${totalTickets.toLocaleString("id-ID")} tickets in cart`
                : "No prizes selected yet"}
            </p>
          </div>
          <div className="text-right">
            <p
              className={cn(
                "text-2xl font-bold tabular-nums",
                remaining < 0 && "text-destructive"
              )}
            >
              {remaining.toLocaleString("id-ID")}
            </p>
            <p className="text-xs text-muted-foreground">tickets left</p>
          </div>
        </div>
      </div>

      {prizes.length === 0 ? (
        <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          This shop has no prizes stocked yet. A manager can add them from
          Stock → Receive.
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {prizes.map((prize) => {
            const qty = cart[prize.id] ?? 0;
            const outOfStock = prize.onHand === 0;
            const shortfall = prize.ticketCost - (ticketBalance - totalTickets);
            const unaffordable = !outOfStock && qty === 0 && shortfall > 0;
            const atStockLimit = qty >= prize.onHand;
            const disabled = outOfStock || (qty === 0 && unaffordable);

            return (
              <li
                key={prize.id}
                className={cn(
                  "rounded-xl border p-4",
                  disabled && "bg-muted/40 opacity-60"
                )}
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{prize.name}</p>
                    <p className="mt-0.5 text-sm text-muted-foreground tabular-nums">
                      {prize.ticketCost.toLocaleString("id-ID")} tickets
                      {" · "}
                      {outOfStock ? "none left" : `${prize.onHand} in stock`}
                    </p>

                    {/* §4.9: show the gap rather than hiding the prize. */}
                    {outOfStock && (
                      <span className="mt-2 inline-block rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
                        Out of stock
                      </span>
                    )}
                    {unaffordable && (
                      <span className="mt-2 inline-block rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
                        Needs {shortfall.toLocaleString("id-ID")} more
                      </span>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {qty > 0 && (
                      <>
                        <Button
                          size="icon"
                          variant="outline"
                          aria-label={`Remove one ${prize.name}`}
                          onClick={() => remove(prize.id)}
                        >
                          <Minus className="size-4" />
                        </Button>
                        <span className="min-w-8 text-center text-lg font-bold tabular-nums">
                          {qty}
                        </span>
                      </>
                    )}
                    <Button
                      size="icon"
                      variant={qty > 0 ? "outline" : "default"}
                      aria-label={`Add one ${prize.name}`}
                      disabled={disabled || atStockLimit || prize.ticketCost > remaining}
                      onClick={() => add(prize)}
                    >
                      <Plus className="size-4" />
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {lines.length > 0 && (
        <div className="sticky bottom-20 space-y-3 rounded-xl border bg-background p-4 shadow-lg">
          <ul className="space-y-1 text-sm">
            {lines.map((l) => (
              <li key={l.prize.id} className="flex gap-2">
                <span className="font-medium tabular-nums">{l.qty}×</span>
                <span className="min-w-0 flex-1 truncate">{l.prize.name}</span>
                <span className="tabular-nums text-muted-foreground">
                  {(l.prize.ticketCost * l.qty).toLocaleString("id-ID")}
                </span>
              </li>
            ))}
          </ul>

          <div className="flex items-baseline justify-between border-t pt-3 text-sm">
            <span className="font-semibold">Total</span>
            <span className="text-lg font-bold tabular-nums">
              {totalTickets.toLocaleString("id-ID")} tickets
            </span>
          </div>

          <Button
            size="xl"
            className="w-full"
            disabled={submitting || remaining < 0}
            onClick={confirm}
          >
            {submitting ? (
              <Loader2 className="size-5 animate-spin" />
            ) : (
              <Check className="size-5" />
            )}
            Confirm redemption
          </Button>
        </div>
      )}
    </div>
  );
}
