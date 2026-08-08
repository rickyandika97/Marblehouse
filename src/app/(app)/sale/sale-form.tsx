"use client";

/**
 * Record a sale (§8.2) — the most-used screen in the product.
 *
 * Design target: A SALE TAKES THREE TAPS. Preset → (payment already defaults to
 * CASH) → Record. Everything here serves that number, and the acceptance
 * criterion behind it: 20 sales in under 15 seconds each on a tablet.
 *
 * Consequences of that target, all deliberate:
 *   - Presets are big tiles, not a dropdown. A dropdown is two taps and a
 *     scroll.
 *   - Payment defaults to CASH and stays where it is between sales; most shops
 *     are overwhelmingly cash.
 *   - Customer defaults to Walk-in and RESETS after every sale, because the
 *     next customer in the queue is a different person. Amount resets too.
 *   - Success is a toast, not a modal — §8.2: "no modal to dismiss". A modal
 *     would add a fourth tap to every single sale.
 *   - The button disables during flight AND sends an Idempotency-Key, because
 *     the disable alone loses the race on a laggy connection (NF-5, R-3).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Search, UserRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ReasonDialog } from "@/components/reason-dialog";
import { cn } from "@/lib/utils";
import { formatMoney, parseAmount } from "@/lib/money";
import { CustomerPicker, type PickedCustomer } from "./customer-picker";

export interface Preset {
  id: string;
  label: string;
  amount: string;
}

export interface RecentSale {
  id: string;
  amount: string;
  paymentMethod: "CASH" | "EDC";
  status: "COMPLETED" | "VOIDED";
  occurredAt: string;
  customer: { id: string; name: string } | null;
}

export interface Summary {
  saleCount: number;
  total: string;
  recent: RecentSale[];
  canVoid: boolean;
}

type PaymentMethod = "CASH" | "EDC";

export function SaleForm({
  presets,
  allowCustomAmount,
  initialSummary,
  shopId,
}: {
  presets: Preset[];
  allowCustomAmount: boolean;
  initialSummary: Summary;
  shopId: string;
}) {
  const router = useRouter();

  const [presetId, setPresetId] = useState<string | null>(null);
  const [customAmount, setCustomAmount] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [payment, setPayment] = useState<PaymentMethod>("CASH");
  const [customer, setCustomer] = useState<PickedCustomer | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [summary, setSummary] = useState(initialSummary);

  /**
   * One idempotency key per *attempt to record a particular sale*, regenerated
   * only after a sale actually lands. If it were regenerated on every tap, a
   * double-tap would send two different keys and create two sales — which is
   * the exact bug the key exists to prevent.
   */
  const idempotencyKey = useRef<string>(crypto.randomUUID());

  const customValue = parseAmount(customAmount);
  const canSubmit =
    !submitting && (showCustom ? customValue !== null && customValue > 0 : presetId !== null);

  const refreshSummary = useCallback(async () => {
    try {
      const res = await fetch("/api/sales/today-summary", { cache: "no-store" });
      if (res.ok) setSummary(await res.json());
    } catch {
      // A stale total is not worth an error message — the sale itself landed.
    }
  }, []);

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);

    try {
      const res = await fetch("/api/sales", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey.current,
        },
        body: JSON.stringify({
          ...(showCustom ? { amount: customValue } : { presetId }),
          paymentMethod: payment,
          customerId: customer?.id ?? null,
        }),
      });

      const body = await res.json().catch(() => null);

      if (!res.ok) {
        toast.error(body?.error?.message ?? "Could not record that sale.");
        return;
      }

      toast.success(`Sale recorded — ${formatMoney(body.amount)}`, {
        description: body.customer ? body.customer.name : "Walk-in",
      });

      // A new sale is now a genuinely new sale — new key.
      idempotencyKey.current = crypto.randomUUID();

      // §8.2: "the form resets to a clean state within 300 ms."
      // Payment method deliberately persists; amount and customer do not.
      setPresetId(null);
      setCustomAmount("");
      setShowCustom(false);
      setCustomer(null);

      void refreshSummary();
      router.refresh();
    } catch {
      toast.error("No connection. Check the wifi and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-5">
      <section>
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">Amount</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {presets.map((preset) => {
            const selected = !showCustom && presetId === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => {
                  setPresetId(preset.id);
                  setShowCustom(false);
                }}
                aria-pressed={selected}
                className={cn(
                  "flex min-h-20 items-center justify-center rounded-xl border-2 px-3 text-xl font-bold tabular-nums transition-colors",
                  selected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background hover:bg-muted"
                )}
              >
                {formatMoney(preset.amount)}
              </button>
            );
          })}

          {allowCustomAmount && (
            <button
              type="button"
              onClick={() => {
                setShowCustom(true);
                setPresetId(null);
              }}
              aria-pressed={showCustom}
              className={cn(
                "flex min-h-20 items-center justify-center rounded-xl border-2 px-3 text-lg font-semibold transition-colors",
                showCustom
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-dashed border-border bg-background hover:bg-muted"
              )}
            >
              Custom
            </button>
          )}
        </div>

        {showCustom && (
          <div className="mt-3">
            <label htmlFor="custom-amount" className="sr-only">
              Custom amount in rupiah
            </label>
            <input
              id="custom-amount"
              // Numeric keypad on a tablet, not the full keyboard (§8.11).
              inputMode="numeric"
              autoFocus
              value={customAmount}
              onChange={(e) => setCustomAmount(e.target.value)}
              placeholder="Enter amount"
              className="h-14 w-full rounded-xl border-2 border-border bg-background px-4 text-2xl font-bold tabular-nums outline-none focus-visible:border-primary"
            />
            {customValue !== null && (
              <p className="mt-1 text-sm text-muted-foreground">
                {formatMoney(customValue)}
              </p>
            )}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">Payment</h2>
        <div className="grid grid-cols-2 gap-3">
          {(["CASH", "EDC"] as const).map((method) => (
            <button
              key={method}
              type="button"
              onClick={() => setPayment(method)}
              aria-pressed={payment === method}
              className={cn(
                "flex h-14 items-center justify-center rounded-xl border-2 text-base font-semibold transition-colors",
                payment === method
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background hover:bg-muted"
              )}
            >
              {method === "CASH" ? "Cash" : "Card / QRIS"}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">Customer</h2>
        {customer ? (
          <div className="flex items-center gap-3 rounded-xl border-2 border-border bg-muted/40 px-4 py-3">
            <UserRound className="size-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{customer.name}</p>
              <p className="truncate text-sm text-muted-foreground">
                {customer.phoneDisplay}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setCustomer(null)}
              aria-label="Remove customer — record as walk-in"
            >
              <X className="size-5" />
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            size="lg"
            className="w-full justify-start"
            onClick={() => setPickerOpen(true)}
          >
            <Search className="size-5" />
            Walk-in — tap to find a customer
          </Button>
        )}
      </section>

      <Button
        size="xl"
        className="w-full"
        disabled={!canSubmit}
        onClick={submit}
      >
        {submitting ? (
          <>
            <Loader2 className="size-5 animate-spin" />
            Recording…
          </>
        ) : (
          "Record sale"
        )}
      </Button>

      <TodayStrip summary={summary} onChanged={refreshSummary} />

      <CustomerPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        shopId={shopId}
        onPick={(picked) => {
          setCustomer(picked);
          setPickerOpen(false);
        }}
      />
    </div>
  );
}

/**
 * Today's total and the last five sales (§8.2).
 *
 * The void affordance appears only where permitted — but that is a convenience,
 * not the permission: the server re-checks role and business day on every void
 * (§3.4, §4.3).
 */
function TodayStrip({
  summary,
  onChanged,
}: {
  summary: Summary;
  onChanged: () => void;
}) {
  const router = useRouter();
  const [voiding, setVoiding] = useState<string | null>(null);
  // The sale the reason dialog is open for, or null. Holding the row rather
  // than a boolean means the dialog can name the amount being voided.
  const [voidTarget, setVoidTarget] = useState<RecentSale | null>(null);

  async function voidSale(sale: RecentSale, reason: string) {
    setVoiding(sale.id);
    try {
      const res = await fetch(`/api/sales/${sale.id}/void`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        toast.error(body?.error?.message ?? "Could not void that sale.");
        return;
      }

      toast.success("Sale voided");
      setVoidTarget(null);
      onChanged();
      router.refresh();
    } catch {
      toast.error("No connection. Check the wifi and try again.");
    } finally {
      setVoiding(null);
    }
  }

  return (
    <section className="rounded-xl border bg-muted/30 p-4">
      <p className="text-sm font-semibold">
        Today: {summary.saleCount}{" "}
        {summary.saleCount === 1 ? "sale" : "sales"} ·{" "}
        <span className="tabular-nums">{formatMoney(summary.total)}</span>
      </p>

      {summary.recent.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {summary.recent.map((sale) => (
            <li
              key={sale.id}
              className="flex items-center gap-2 text-sm text-muted-foreground"
            >
              <span
                className={cn(
                  "tabular-nums font-medium",
                  sale.status === "VOIDED"
                    ? "text-muted-foreground line-through"
                    : "text-foreground"
                )}
              >
                {formatMoney(sale.amount)}
              </span>
              <span>{sale.paymentMethod === "CASH" ? "Cash" : "Card"}</span>
              <span className="truncate">
                {sale.customer?.name ?? "Walk-in"}
              </span>
              <span className="ml-auto shrink-0 tabular-nums">
                {new Date(sale.occurredAt).toLocaleTimeString("id-ID", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>

              {summary.canVoid && sale.status === "COMPLETED" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-destructive"
                  disabled={voiding === sale.id}
                  onClick={() => setVoidTarget(sale)}
                >
                  {voiding === sale.id ? "…" : "Void"}
                </Button>
              )}

              {sale.status === "VOIDED" && (
                <span className="shrink-0 text-xs uppercase">Voided</span>
              )}
            </li>
          ))}
        </ul>
      )}

      <ReasonDialog
        open={voidTarget !== null}
        onOpenChange={(next) => {
          if (!next) setVoidTarget(null);
        }}
        title="Void this sale?"
        description={
          voidTarget
            ? `${formatMoney(voidTarget.amount)} · ${
                voidTarget.customer?.name ?? "Walk-in"
              }`
            : undefined
        }
        consequence="The sale is kept and marked voided, so the audit trail stays intact. It stops counting towards today's revenue."
        label="Why is it being voided?"
        placeholder="Rung up twice by mistake"
        confirmLabel="Void sale"
        submitting={voiding !== null}
        onConfirm={(reason) => {
          if (voidTarget) return voidSale(voidTarget, reason);
        }}
      />
    </section>
  );
}
