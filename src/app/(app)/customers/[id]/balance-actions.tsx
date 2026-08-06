"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
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

type Action =
  | "marble-deposit"
  | "marble-withdraw"
  | "ticket-award"
  | "marble-adjust"
  | "ticket-adjust";

const DETAILS: Record<Action, { title: string; endpoint: string; success: string }> = {
  "marble-deposit": {
    title: "Deposit marbles",
    endpoint: "/api/marbles/deposit",
    success: "Marbles deposited",
  },
  "marble-withdraw": {
    title: "Withdraw marbles",
    endpoint: "/api/marbles/withdraw",
    success: "Marbles withdrawn",
  },
  "ticket-award": {
    title: "Award tickets",
    endpoint: "/api/tickets/award",
    success: "Tickets awarded",
  },
  "marble-adjust": {
    title: "Correct marble balance",
    endpoint: "/api/marbles/adjust",
    success: "Marble balance corrected",
  },
  "ticket-adjust": {
    title: "Correct ticket balance",
    endpoint: "/api/tickets/adjust",
    success: "Ticket balance corrected",
  },
};

export function BalanceActions({
  customerId,
  canAdjust,
  awardReasonThreshold,
}: {
  customerId: string;
  canAdjust: boolean;
  awardReasonThreshold: number;
}) {
  const router = useRouter();
  const [action, setAction] = useState<Action | null>(null);
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [ticketsCollected, setTicketsCollected] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const key = useRef(crypto.randomUUID());

  function open(next: Action) {
    setAction(next);
    setQuantity("");
    setReason("");
    setTicketsCollected(false);
    key.current = crypto.randomUUID();
  }

  const parsed = Number(quantity);
  const isAdjust = action === "marble-adjust" || action === "ticket-adjust";
  const needsAwardReason = action === "ticket-award" && parsed > awardReasonThreshold;
  const canSubmit =
    !submitting &&
    Number.isInteger(parsed) &&
    (isAdjust ? parsed !== 0 : parsed > 0) &&
    (!isAdjust || reason.trim().length >= 3) &&
    (!needsAwardReason || reason.trim().length >= 1) &&
    (action !== "ticket-award" || ticketsCollected);

  async function submit() {
    if (!action || !canSubmit) return;
    setSubmitting(true);
    try {
      const body = isAdjust
        ? { customerId, delta: parsed, reason: reason.trim() }
        : action === "ticket-award"
          ? {
              customerId,
              qty: parsed,
              note: reason.trim() || undefined,
              ticketsCollected,
            }
          : { customerId, qty: parsed, note: reason.trim() || undefined };
      const response = await fetch(DETAILS[action].endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": key.current,
        },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(result?.error?.message ?? "Could not update that balance.");
        return;
      }

      toast.success(DETAILS[action].success, {
        description: `New balance: ${result.entry.balanceAfter.toLocaleString("id-ID")}`,
      });
      key.current = crypto.randomUUID();
      setAction(null);
      router.refresh();
    } catch {
      toast.error("No connection. Check the wifi and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <Button size="lg" onClick={() => open("marble-deposit")}>Deposit marbles</Button>
        <Button size="lg" variant="outline" onClick={() => open("marble-withdraw")}>
          Withdraw marbles
        </Button>
        <Button size="lg" variant="secondary" onClick={() => open("ticket-award")}>
          Award tickets
        </Button>
      </div>

      {canAdjust && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Button variant="ghost" onClick={() => open("marble-adjust")}>
            Correct marble balance
          </Button>
          <Button variant="ghost" onClick={() => open("ticket-adjust")}>
            Correct ticket balance
          </Button>
        </div>
      )}

      <Dialog open={action !== null} onOpenChange={(openState) => !openState && setAction(null)}>
        <DialogContent>
          {action && (
            <>
              <DialogHeader>
                <DialogTitle>{DETAILS[action].title}</DialogTitle>
                <DialogDescription>
                  {isAdjust
                    ? "Use a positive number to add or a negative number to remove. The reason is permanently audited."
                    : "Enter the physical quantity handled at the counter."}
                </DialogDescription>
              </DialogHeader>

              <label className="font-medium">
                {isAdjust ? "Change" : "Quantity"}
                <Input
                  className="mt-1 text-xl font-bold tabular-nums"
                  inputMode={isAdjust ? "text" : "numeric"}
                  autoFocus
                  value={quantity}
                  onChange={(event) => setQuantity(event.target.value.replace(isAdjust ? /[^\d-]/g : /\D/g, ""))}
                  placeholder={isAdjust ? "+50 or -25" : "0"}
                />
              </label>

              {!isAdjust && (
                <div className="grid grid-cols-4 gap-2">
                  {[10, 25, 50, 100].map((amount) => (
                    <Button
                      key={amount}
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setQuantity(String((Number(quantity) || 0) + amount))}
                    >
                      +{amount}
                    </Button>
                  ))}
                </div>
              )}

              {(isAdjust || action === "ticket-award") && (
                <label className="font-medium">
                  {isAdjust || needsAwardReason ? "Reason" : "Note (optional)"}
                  <textarea
                    className="mt-1 min-h-24 w-full rounded-lg border bg-background p-3 text-base"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    maxLength={500}
                    placeholder={
                      needsAwardReason
                        ? `Required above ${awardReasonThreshold} tickets`
                        : isAdjust
                          ? "Why is this correction needed?"
                          : "Optional note"
                    }
                  />
                </label>
              )}

              {action === "ticket-award" && (
                <label className="flex min-h-14 items-center gap-3 rounded-lg border-2 border-amber-400 bg-amber-50 p-3 text-sm font-semibold text-amber-950">
                  <input
                    type="checkbox"
                    className="size-6 shrink-0"
                    checked={ticketsCollected}
                    onChange={(event) => setTicketsCollected(event.target.checked)}
                  />
                  Tickets counted and collected?
                </label>
              )}

              <DialogFooter>
                <Button variant="outline" onClick={() => setAction(null)}>Cancel</Button>
                <Button disabled={!canSubmit} onClick={submit}>
                  {submitting && <Loader2 className="size-4 animate-spin" />}
                  Confirm
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

