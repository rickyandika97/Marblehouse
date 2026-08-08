"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
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

/**
 * The shared "give a reason, then confirm" dialog (Phase 10).
 *
 * This replaces `window.prompt` at the three sites that still used it — sale
 * void, transfer cancel and attendance excuse. It is deliberately ONE component
 * rather than three copies of `expenses/edit-expense.tsx`'s delete branch
 * (D-70), which is the shape it is modelled on: three copies would be three
 * places for the minimum-length rule to drift, and only one of them would get
 * fixed the next time the rule changes.
 *
 * **`minLength` is per-site because the SERVER rules genuinely differ**, and
 * this component must not invent a rule the server does not have:
 *
 * | Site | Server schema | So `minLength` |
 * |---|---|---|
 * | Sale void | `voidSaleSchema` — `min(3)` | 3, mirroring the server |
 * | Transfer cancel | `cancelTransferSchema` — `min(3)` | 3, mirroring the server |
 * | Attendance excuse | `editAttendanceSchema` — `note` is **optional** | 3, a UI-only rule |
 *
 * The excuse case is the one to read carefully. The server accepts an excuse
 * with no note at all, so the requirement here is a product decision, not a
 * mirrored constraint: an excuse whose reason is blank tells the owner nothing
 * when they read it back months later, and this is the only place that record
 * gets written. It is enforced in the UI and stated in the copy — but do not
 * "tidy" it into a claim that the server requires it, and do not relax the
 * other two, where it genuinely does.
 *
 * What the prompt could not do, and this does:
 * - enforce the minimum before the round trip, instead of after a 422 and a toast
 * - show the consequence of confirming, in the copy, next to the field
 * - meet §8.11's 44px floor on every control
 */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  consequence,
  label,
  placeholder,
  helpText,
  confirmLabel,
  confirmVariant = "destructive",
  minLength = 3,
  maxLength = 500,
  submitting = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Phrased as the question being answered, e.g. "Void this sale?" */
  title: string;
  /** What is being acted on — the amount, the branch, the date. */
  description?: React.ReactNode;
  /** What confirming will do. Shown above the field. */
  consequence?: React.ReactNode;
  label: string;
  placeholder?: string;
  /** Overrides the default "At least N characters…" line. */
  helpText?: React.ReactNode;
  confirmLabel: string;
  /**
   * Defaults to `destructive`, which is right for a void or a cancel. An
   * attendance excuse is a correction rather than a reversal, so it passes
   * `default` — colouring an approval red misreads what the owner is doing.
   */
  confirmVariant?: "destructive" | "default";
  minLength?: number;
  maxLength?: number;
  submitting?: boolean;
  /** Receives the trimmed reason. Close the dialog from the caller on success. */
  onConfirm: (reason: string) => void | Promise<void>;
}) {
  const [reason, setReason] = useState("");

  const trimmed = reason.trim();
  const valid = trimmed.length >= minLength && trimmed.length <= maxLength;

  function close(next: boolean) {
    onOpenChange(next);
    // Clearing on close means reopening never shows the previous attempt's
    // half-typed reason against a different record.
    if (!next) setReason("");
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <div className="space-y-3">
          {consequence && (
            <p className="text-sm text-muted-foreground">{consequence}</p>
          )}

          <div className="space-y-1">
            <label htmlFor="reason-dialog-input" className="text-sm font-medium">
              {label}
            </label>
            <Input
              id="reason-dialog-input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={placeholder}
              maxLength={maxLength}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && valid && !submitting) {
                  e.preventDefault();
                  void onConfirm(trimmed);
                }
              }}
            />
            <p className="text-xs text-muted-foreground">
              {helpText ?? (
                <>At least {minLength} characters. This is recorded and cannot be edited.</>
              )}
            </p>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => close(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant={confirmVariant}
            onClick={() => void onConfirm(trimmed)}
            disabled={submitting || !valid}
          >
            {submitting && <Loader2 className="size-4 animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
