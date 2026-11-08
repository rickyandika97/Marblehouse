"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

export function MembershipScanner({
  customerId,
  autoOpen = false,
  onVerified,
}: {
  customerId?: string;
  autoOpen?: boolean;
  onVerified?: (id: string) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(autoOpen);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const cancelled = useRef(false);
  const verified = useRef(onVerified);
  verified.current = onVerified;

  function handleOpenChange(next: boolean) {
    cancelled.current = !next;
    setOpen(next);
    // Full-page verification has no useful destination after cancellation.
    // Inline scanning on the customer list simply closes its dialog.
    if (!next && autoOpen) router.replace("/customers");
  }

  useEffect(() => {
    if (!open || !video) return;
    const element = video;
    let disposed = false;
    let controls: { stop: () => void } | undefined;
    let busy = false;
    setError("");
    async function start() {
      try {
        const { BrowserQRCodeReader } = await import("@zxing/browser");
        if (disposed || !video) return;
        const reader = new BrowserQRCodeReader();
        controls = await reader.decodeFromConstraints(
          { video: { facingMode: "environment" }, audio: false },
          video,
          async (result) => {
            if (!result || busy || disposed || cancelled.current) return;
            busy = true;
            try {
              const response = await fetch("/api/customers/scan", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ code: result.getText(), customerId }),
              });
              const body = await response.json();
              if (disposed || cancelled.current) return;
              if (!response.ok) {
                setError(body?.error?.message ?? "Could not verify this card.");
                busy = false;
                return;
              }
              controls?.stop();
              setOpen(false);
              if (verified.current) verified.current(body.customerId);
              else {
                router.push(`/customers/${body.customerId}`);
                router.refresh();
              }
            } catch {
              if (!disposed) setError("Connection failed. Try scanning again.");
              busy = false;
            }
          },
        );
        if (disposed) controls.stop();
      } catch {
        if (!disposed)
          setError(
            "Camera could not start. Allow camera access and use HTTPS (or localhost), then retry. Only the owner can help without a card.",
          );
      }
    }
    void start();
    return () => {
      disposed = true;
      controls?.stop();
      const stream = element?.srcObject as MediaStream | null;
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [open, customerId, attempt, router, video]);
  return (
    <>
      <Button variant="outline" onClick={() => handleOpenChange(true)}>
        Scan membership
      </Button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-md">
          <DialogTitle>Scan membership card</DialogTitle>
          <DialogDescription>
            {customerId
              ? "Scan the selected customer's QR card to open their account."
              : "Scan the customer's QR card to open their account."}
          </DialogDescription>
          <video
            ref={setVideo}
            muted
            playsInline
            className="aspect-square w-full rounded-lg bg-black object-cover"
          />
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button
            variant="outline"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Restart camera
          </Button>
          <Button variant="ghost" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
