"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil } from "lucide-react";
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

/** Correct a customer's contact details without affecting their history or balances. */
export function EditCustomer({
  customer,
}: {
  customer: { id: string; name: string; phoneDisplay: string };
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(customer.name);
  const [phone, setPhone] = useState(customer.phoneDisplay);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setName(customer.name);
    setPhone(customer.phoneDisplay);
  }

  const changed =
    name.trim() !== customer.name || phone.trim() !== customer.phoneDisplay;

  async function save() {
    if (!name.trim() || !phone.trim() || !changed || submitting) return;

    setSubmitting(true);
    try {
      const response = await fetch(`/api/customers/${customer.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), phone: phone.trim() }),
      });
      const body = await response.json().catch(() => null);

      if (!response.ok) {
        toast.error(body?.error?.message ?? "Could not update that customer.");
        return;
      }

      toast.success("Customer details updated");
      setOpen(false);
      router.refresh();
    } catch {
      toast.error("No connection. Check the wifi and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Pencil className="size-4" />
        Edit customer
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
            <DialogTitle>Edit customer</DialogTitle>
            <DialogDescription>
              Correct their name or phone number. Balances and history are unchanged.
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
              <label htmlFor="customer-name" className="text-sm font-medium">
                Name
              </label>
              <Input
                id="customer-name"
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Customer name"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="customer-phone" className="text-sm font-medium">
                Phone
              </label>
              <Input
                id="customer-phone"
                inputMode="tel"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="0812…"
              />
            </div>
            <DialogFooter className="gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!name.trim() || !phone.trim() || !changed || submitting}
              >
                {submitting && <Loader2 className="size-4 animate-spin" />}
                Save changes
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
