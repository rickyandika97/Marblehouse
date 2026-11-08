"use client";
import { useEffect, useRef, useState } from "react";
import { MembershipDownloadLink } from "@/components/membership-download-link";
import { Expand, X } from "lucide-react";
import { createMembershipCardImage } from "@/lib/membership-card-image";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogClose,
  DialogTrigger,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

type Card = {
  name: string;
  memberNumber: string;
  qr: string;
  canReplace: boolean;
};
export function MembershipCard({
  customerId,
  autoOpen = false,
  onDone,
}: {
  customerId: string;
  autoOpen?: boolean;
  onDone?: () => void;
}) {
  const [open, setOpen] = useState(autoOpen);
  const [expanded, setExpanded] = useState(false);
  const [card, setCard] = useState<Card | null>(null);
  const [cardImage, setCardImage] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const replacementKey = useRef(crypto.randomUUID());
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setExpanded(false);
    setCard(null);
    setCardImage(null);
    setError("");
    fetch(`/api/customers/${customerId}/membership`, { cache: "no-store" })
      .then(async (res) => {
        const body = await res.json();
        if (cancelled) return;
        if (res.ok) {
          const image = await createMembershipCardImage(body);
          if (cancelled) return;
          setCard(body);
          setCardImage(image);
        } else
          setError(body?.error?.message ?? "Unable to load membership card.");
      })
      .catch(() => {
        if (!cancelled) setError("Connection failed. Close and try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [open, customerId, version]);
  function close() {
    setExpanded(false);
    setOpen(false);
    setCard(null);
    onDone?.();
  }
  async function replace() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/customers/${customerId}/membership`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": replacementKey.current,
        },
        body: JSON.stringify({ reason }),
      });
      const body = await res.json();
      if (!res.ok) setError(body?.error?.message ?? "Unable to replace card.");
      else {
        replacementKey.current = crypto.randomUUID();
        setReason("");
        setVersion((value) => value + 1);
      }
    } catch {
      setError("Connection failed. Try again.");
    } finally {
      setBusy(false);
    }
  }
  function download() {
    if (!card || !cardImage) return;
    const anchor = document.createElement("a");
    anchor.href = cardImage;
    anchor.download = `redlight-membership-${card.memberNumber}.png`;
    anchor.click();
  }
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Membership card
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
          else setOpen(true);
        }}
      >
        <DialogContent className="max-h-[90dvh] max-w-md overflow-y-auto">
          <DialogTitle>Membership card</DialogTitle>
          <DialogDescription>
            Save this card on the customer&apos;s phone. Keep the QR private:
            anyone with a copy can use it.
          </DialogDescription>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {card ? (
            <>
              <Dialog open={expanded} onOpenChange={setExpanded}>
                <DialogTrigger
                  type="button"
                  aria-label="Enlarge membership card"
                  className="block w-full cursor-zoom-in rounded-[1.5rem] bg-neutral-100 p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 dark:bg-neutral-900"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={cardImage ?? undefined}
                    alt={`Red Light Pinball membership card for ${card.name}, member ${card.memberNumber}, with unique QR code`}
                    className="mx-auto block h-auto w-full"
                  />
                  <span className="flex items-center justify-center gap-1.5 py-2 text-xs text-muted-foreground">
                    <Expand className="size-3.5" aria-hidden="true" />
                    Tap card to enlarge
                  </span>
                </DialogTrigger>
                <DialogContent
                  showCloseButton={false}
                  className="fixed top-[max(0.5rem,env(safe-area-inset-top))] right-[max(0.5rem,env(safe-area-inset-right))] bottom-[max(0.5rem,env(safe-area-inset-bottom))] left-[max(0.5rem,env(safe-area-inset-left))] grid w-auto max-w-none grid-rows-[auto_minmax(0,1fr)] gap-2 overflow-hidden rounded-2xl p-3 sm:max-w-none sm:p-4"
                >
                  <div className="flex items-center justify-between gap-3">
                    <DialogTitle>Membership card</DialogTitle>
                    <DialogClose
                      render={
                        <Button
                          variant="outline"
                          size="icon"
                          aria-label="Close enlarged membership card"
                        />
                      }
                    >
                      <X className="size-5" aria-hidden="true" />
                    </DialogClose>
                  </div>
                  <DialogDescription className="sr-only">
                    Enlarged membership card for {card.name}. Use the close
                    button to return to card details.
                  </DialogDescription>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={cardImage ?? undefined}
                    alt={`Membership card for ${card.name}, member ${card.memberNumber}, with unique QR code`}
                    className="min-h-0 min-w-0 h-full w-full object-contain"
                  />
                </DialogContent>
              </Dialog>
              <Button onClick={download} disabled={!cardImage}>
                Save card image
              </Button>
              <MembershipDownloadLink customerId={customerId} />
              {card.canReplace && (
                <div className="space-y-2 rounded-lg border p-3">
                  <p className="text-sm">
                    Lost card? Verify the customer&apos;s identity independently
                    before replacing it. The old QR will stop working.
                  </p>
                  <Input
                    aria-label="Replacement reason"
                    placeholder="Reason for replacement"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                  <Button
                    variant="outline"
                    disabled={busy || reason.trim().length < 3}
                    onClick={replace}
                  >
                    Replace lost card
                  </Button>
                </div>
              )}
            </>
          ) : (
            !error && <p>Loading card…</p>
          )}
          <Button variant="ghost" onClick={close}>
            Done
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
