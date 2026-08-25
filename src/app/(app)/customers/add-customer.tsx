"use client";

/**
 * Manually add a customer from the Customers tab (§8.5's screen had no way in
 * except through a sale — the phone-number-first walk-in in §8.2's picker).
 * Same endpoint, same idempotency discipline; the difference is where it lands
 * you: straight to their new record, since there's no cart waiting.
 */

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, UserRoundPlus } from "lucide-react";
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

export function AddCustomer() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [duplicateOf, setDuplicateOf] = useState<{ id: string; name: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const idempotencyKey = useRef<string>(crypto.randomUUID());

  function reset() {
    setName("");
    setPhone("");
    setError(null);
    setDuplicateOf(null);
  }

  async function save() {
    if (!name.trim() || !phone.trim() || saving) return;

    setSaving(true);
    setError(null);
    setDuplicateOf(null);

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
        if (body?.error?.code === "DUPLICATE_PHONE" && body.error.details?.customerId) {
          setDuplicateOf({
            id: body.error.details.customerId,
            name: body.error.details.name ?? "That customer",
          });
        } else {
          setError(body?.error?.message ?? "Could not save that customer.");
        }
        idempotencyKey.current = crypto.randomUUID();
        return;
      }

      setOpen(false);
      reset();
      router.push(`/customers/${body.id}`);
    } catch {
      setError("No connection. Check the wifi and try again.");
      idempotencyKey.current = crypto.randomUUID();
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <UserRoundPlus className="size-4" />
        Add customer
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New customer</DialogTitle>
            <DialogDescription>
              A phone number is what lets stored marbles and tickets follow
              them to any branch.
            </DialogDescription>
          </DialogHeader>

          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="space-y-1.5">
              <label htmlFor="new-customer-name" className="text-sm font-medium">
                Name
              </label>
              <Input
                id="new-customer-name"
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Customer name"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="new-customer-phone" className="text-sm font-medium">
                Phone
              </label>
              <Input
                id="new-customer-phone"
                inputMode="numeric"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="0812…"
              />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            {duplicateOf && (
              <p className="text-sm text-destructive">
                {duplicateOf.name} already uses that number.{" "}
                <Link href={`/customers/${duplicateOf.id}`} className="underline">
                  Open their record
                </Link>{" "}
                instead.
              </p>
            )}

            <DialogFooter className="gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!name.trim() || !phone.trim() || saving}>
                {saving && <Loader2 className="size-4 animate-spin" />}
                Save customer
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
