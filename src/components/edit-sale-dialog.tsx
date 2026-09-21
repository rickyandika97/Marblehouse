"use client";

/**
 * Edit one sale (D-181) — OWNER only.
 *
 * §4.3 said sales could only be voided. The owner relaxed that for themselves
 * on 21 Sep 2026, because a void plus a re-entry leaves the shop's transaction
 * count permanently one too high and loses the original time of day. This
 * dialog is the whole of the relaxation: every field it offers is a fact about
 * the transaction, and every save carries a mandatory reason into the audit log
 * with a full before/after snapshot.
 *
 * Shared rather than duplicated because it is reached from three places — the
 * sale screen's recent strip, the owner's All sales screen, and the sales
 * report drill-downs. Three copies would be three places for the date handling
 * to drift, and the date is the part with real consequences.
 *
 * **The warnings in the copy are not decoration.** Moving the date moves money
 * between reporting days, and moving the shop moves it between branches — a
 * report someone already read can change underneath them. The dialog says so,
 * next to the field, at the moment the change is made.
 *
 * Permission is the SERVER's (`updateSale` checks `actor.isOwner`); the
 * `canEdit` prop only decides whether the button is drawn.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Pencil, RotateCcw, Search, UserRound, X } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { formatMoney, parseAmount } from "@/lib/money";
import { CustomerPicker, type PickedCustomer } from "@/app/(app)/sale/customer-picker";

export interface EditableSale {
  id: string;
  amount: string;
  paymentMethod: "CASH" | "EDC";
  status: "COMPLETED" | "VOIDED";
  isCustomAmount: boolean;
  note: string | null;
  shopId: string;
  occurredAt: string;
  preset: { id: string; label: string } | null;
  customer: { id: string; name: string } | null;
  recordedBy: { id: string; displayName: string };
  voidReason?: string | null;
}

export interface SaleEditOptions {
  shops: { id: string; name: string; code: string }[];
  presetsByShop: Record<string, { id: string; label: string; amount: string }[]>;
  staffByShop: Record<string, { id: string; displayName: string }[]>;
}

/**
 * An ISO instant as the value a `datetime-local` input wants, in the browser's
 * own zone.
 *
 * The shops are all Asia/Jakarta today and the owner works from there, so the
 * browser's zone IS the shop's zone in practice. If that ever stops being true,
 * this is the line to revisit — the SERVER always resolves the business date in
 * the shop's timezone regardless (D-18), so a mismatch here would mis-*display*
 * the time, never mis-file the money.
 */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

export function EditSaleDialog({
  sale,
  options,
  onDone,
  trigger = "icon",
}: {
  sale: EditableSale;
  options: SaleEditOptions;
  /** Called after a successful save or restore, before the router refresh. */
  onDone?: () => void;
  trigger?: "icon" | "text";
}) {
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const [shopId, setShopId] = useState(sale.shopId);
  const [presetId, setPresetId] = useState<string | null>(sale.preset?.id ?? null);
  const [customAmount, setCustomAmount] = useState(
    sale.isCustomAmount ? sale.amount : ""
  );
  const [useCustom, setUseCustom] = useState(sale.isCustomAmount);
  const [payment, setPayment] = useState<"CASH" | "EDC">(sale.paymentMethod);
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(
    sale.customer
  );
  const [recordedById, setRecordedById] = useState(sale.recordedBy.id);
  const [occurredAt, setOccurredAt] = useState(toLocalInput(sale.occurredAt));
  const [note, setNote] = useState(sale.note ?? "");
  const [reason, setReason] = useState("");

  /** Seeded from the row each time the dialog opens, never from a stale edit. */
  function reset() {
    setShopId(sale.shopId);
    setPresetId(sale.preset?.id ?? null);
    setCustomAmount(sale.isCustomAmount ? sale.amount : "");
    setUseCustom(sale.isCustomAmount);
    setPayment(sale.paymentMethod);
    setCustomer(sale.customer);
    setRecordedById(sale.recordedBy.id);
    setOccurredAt(toLocalInput(sale.occurredAt));
    setNote(sale.note ?? "");
    setReason("");
  }

  const presets = options.presetsByShop[shopId] ?? [];
  const staff = options.staffByShop[shopId] ?? [];

  /**
   * Moving the shop invalidates two selections at once: a preset belongs to one
   * branch's price list (D-15) and a staff member to one branch's roster. Rather
   * than silently sending a value the server will reject, fall back here — to a
   * custom amount carrying the same figure, and to whoever the sale is already
   * attributed to if they work at the new branch.
   */
  useEffect(() => {
    if (shopId === sale.shopId) return;

    if (presetId && !presets.some((p) => p.id === presetId)) {
      setPresetId(null);
      setUseCustom(true);
      setCustomAmount((current) => current || sale.amount);
    }
    if (!staff.some((s) => s.id === recordedById)) {
      setRecordedById(staff[0]?.id ?? recordedById);
    }
    // `presets`/`staff` are derived from shopId; depending on shopId alone
    // keeps this to one run per actual shop change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shopId]);

  const customValue = parseAmount(customAmount);
  const amountValid = useCustom ? customValue !== null && customValue > 0 : presetId !== null;
  const reasonValid = reason.trim().length >= 3;

  /** What the form would send, so "nothing changed" can disable the button. */
  const changed = useMemo(() => {
    const sameAmount = useCustom
      ? sale.isCustomAmount && String(customValue) === sale.amount
      : presetId === (sale.preset?.id ?? null) && !sale.isCustomAmount;

    return (
      shopId !== sale.shopId ||
      !sameAmount ||
      payment !== sale.paymentMethod ||
      (customer?.id ?? null) !== (sale.customer?.id ?? null) ||
      recordedById !== sale.recordedBy.id ||
      occurredAt !== toLocalInput(sale.occurredAt) ||
      note.trim() !== (sale.note ?? "")
    );
  }, [
    shopId,
    useCustom,
    customValue,
    presetId,
    payment,
    customer,
    recordedById,
    occurredAt,
    note,
    sale,
  ]);

  const movesDay =
    occurredAt.slice(0, 10) !== toLocalInput(sale.occurredAt).slice(0, 10);
  const movesShop = shopId !== sale.shopId;

  async function save() {
    if (!amountValid || !reasonValid || !changed || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/sales/${sale.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopId,
          // Exactly one of the two, mirroring the server's union.
          ...(useCustom ? { amount: customValue } : { presetId }),
          paymentMethod: payment,
          customerId: customer?.id ?? null,
          recordedById,
          // The server derives businessDate from this instant in the shop's
          // timezone (D-18). It is never sent.
          occurredAt: new Date(occurredAt).toISOString(),
          note: note.trim() === "" ? null : note.trim(),
          reason: reason.trim(),
        }),
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        toast.error(body?.error?.message ?? "Could not save that change.");
        return;
      }

      toast.success(`Sale updated — ${formatMoney(body.amount)}`, {
        description: movesDay ? `Now dated ${body.businessDate}` : undefined,
      });
      setOpen(false);
      onDone?.();
      router.refresh();
    } catch {
      toast.error("No connection. Check the wifi and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function restore() {
    if (!reasonValid || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/sales/${sale.id}/unvoid`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        toast.error(body?.error?.message ?? "Could not restore that sale.");
        return;
      }

      toast.success("Sale restored — it counts towards revenue again");
      setOpen(false);
      onDone?.();
      router.refresh();
    } catch {
      toast.error("No connection. Check the wifi and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const isVoided = sale.status === "VOIDED";

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="shrink-0"
        aria-label={`Edit sale of ${formatMoney(sale.amount)}`}
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        <Pencil className="size-4" />
        {trigger === "text" && <span className="ml-1">Edit</span>}
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{isVoided ? "Restore this sale?" : "Edit sale"}</DialogTitle>
            <DialogDescription>
              {formatMoney(sale.amount)} ·{" "}
              {new Date(sale.occurredAt).toLocaleString("en-GB", {
                day: "numeric",
                month: "short",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </DialogDescription>
          </DialogHeader>

          {/*
            A voided sale is a reversed sale. Editing one would produce a figure
            nobody took and no report counts, so the server refuses it — the
            dialog offers the restore instead, and the edit becomes available
            once it is back.
          */}
          {isVoided ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                This sale was voided
                {sale.voidReason ? ` — “${sale.voidReason}”` : ""}. Restoring it
                puts it back in revenue from its original date. The void stays in
                the audit trail.
              </p>
            </div>
          ) : (
            <div className="space-y-5">
              {/* ── Shop ── */}
              {options.shops.length > 1 && (
                <Field label="Branch">
                  <div className="flex flex-wrap gap-2">
                    {options.shops.map((s) => (
                      <Chip
                        key={s.id}
                        selected={shopId === s.id}
                        onClick={() => setShopId(s.id)}
                      >
                        {s.name}
                      </Chip>
                    ))}
                  </div>
                  {movesShop && (
                    <Warning>
                      This moves the money off {
                        options.shops.find((s) => s.id === sale.shopId)?.name ??
                        "the original branch"
                      }’s revenue and onto this one. Both branches’ reports change.
                    </Warning>
                  )}
                </Field>
              )}

              {/* ── Amount ── */}
              <Field label="Amount">
                <div className="flex flex-wrap gap-2">
                  {presets.map((p) => (
                    <Chip
                      key={p.id}
                      selected={!useCustom && presetId === p.id}
                      onClick={() => {
                        setPresetId(p.id);
                        setUseCustom(false);
                      }}
                    >
                      {formatMoney(p.amount)}
                    </Chip>
                  ))}
                  <Chip
                    selected={useCustom}
                    dashed
                    onClick={() => {
                      setUseCustom(true);
                      setPresetId(null);
                      if (customAmount === "") setCustomAmount(sale.amount);
                    }}
                  >
                    Custom
                  </Chip>
                </div>
                {useCustom && (
                  <Input
                    inputMode="numeric"
                    value={customAmount}
                    onChange={(e) => setCustomAmount(e.target.value)}
                    placeholder="Enter amount"
                    className="mt-2 tabular-nums"
                    aria-label="Custom amount in rupiah"
                  />
                )}
              </Field>

              {/* ── Payment ── */}
              <Field label="Payment">
                <div className="flex gap-2">
                  {(["CASH", "EDC"] as const).map((m) => (
                    <Chip
                      key={m}
                      selected={payment === m}
                      onClick={() => setPayment(m)}
                    >
                      {m === "CASH" ? "Cash" : "Card / QRIS"}
                    </Chip>
                  ))}
                </div>
              </Field>

              {/* ── Customer ── */}
              <Field label="Customer">
                {customer ? (
                  <div className="flex items-center gap-2 rounded-lg border px-3 py-2">
                    <UserRound className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {customer.name}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setCustomer(null)}
                      aria-label="Remove customer — record as walk-in"
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    className="w-full justify-start"
                    onClick={() => setPickerOpen(true)}
                  >
                    <Search className="size-4" />
                    Walk-in — tap to find a customer
                  </Button>
                )}
              </Field>

              {/* ── Staff ── */}
              <Field label="Recorded by">
                <select
                  value={recordedById}
                  onChange={(e) => setRecordedById(e.target.value)}
                  className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm"
                  aria-label="Staff member this sale is attributed to"
                >
                  {/*
                    Someone who has since left the branch still appears, so an
                    old sale keeps showing who actually rang it up rather than
                    silently switching to a colleague.
                  */}
                  {!staff.some((s) => s.id === recordedById) && (
                    <option value={recordedById}>
                      {sale.recordedBy.displayName} (no longer at this branch)
                    </option>
                  )}
                  {staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.displayName}
                    </option>
                  ))}
                </select>
              </Field>

              {/* ── When ── */}
              <Field label="Date and time">
                <Input
                  type="datetime-local"
                  value={occurredAt}
                  onChange={(e) => setOccurredAt(e.target.value)}
                  max={toLocalInput(new Date().toISOString())}
                />
                {movesDay && (
                  <Warning>
                    This moves the sale to another reporting day. The old day’s
                    total goes down and the new day’s goes up — including on
                    reports already read.
                  </Warning>
                )}
              </Field>

              {/* ── Note ── */}
              <Field label="Note (optional)">
                <Input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Anything worth remembering about this sale"
                  maxLength={500}
                />
              </Field>
            </div>
          )}

          {/* The reason is required for both paths, and is what the audit log reads back. */}
          <div className="space-y-1 border-t pt-4">
            <label htmlFor="edit-sale-reason" className="text-sm font-medium">
              {isVoided ? "Why are you restoring it?" : "Why are you changing it?"}
            </label>
            <Input
              id="edit-sale-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={
                isVoided ? "Voided by mistake" : "Keyed in on the wrong day"
              }
              maxLength={500}
            />
            <p className="text-xs text-muted-foreground">
              At least 3 characters. Recorded in the audit log with the old and
              new values, and cannot be edited afterwards.
            </p>
          </div>

          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            {isVoided ? (
              <Button onClick={restore} disabled={submitting || !reasonValid}>
                {submitting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RotateCcw className="size-4" />
                )}
                Restore sale
              </Button>
            ) : (
              <Button
                onClick={save}
                disabled={submitting || !amountValid || !reasonValid || !changed}
              >
                {submitting && <Loader2 className="size-4 animate-spin" />}
                Save changes
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CustomerPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={(picked: PickedCustomer) => {
          setCustomer({ id: picked.id, name: picked.name });
          setPickerOpen(false);
        }}
      />
    </>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">{label}</p>
      {children}
    </div>
  );
}

/** A tap target that clears §8.11's 44px floor, as used on the sale screen. */
function Chip({
  selected,
  dashed,
  onClick,
  children,
}: {
  selected: boolean;
  dashed?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "min-h-11 rounded-lg border px-3 text-sm font-medium transition-colors",
        dashed && !selected && "border-dashed",
        selected
          ? "border-primary bg-primary text-primary-foreground"
          : "hover:bg-muted"
      )}
    >
      {children}
    </button>
  );
}

/** Shown only while the change is actually pending, next to the field causing it. */
function Warning({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
      {children}
    </p>
  );
}
