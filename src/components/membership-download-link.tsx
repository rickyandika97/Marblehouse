"use client";
import { useEffect, useRef, useState } from "react";
import { QrCode } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

type DownloadLink = { qr: string; expiresAt: string };
export function MembershipDownloadLink({ customerId }: { customerId: string }) {
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState<DownloadLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const requestKey = useRef(crypto.randomUUID());
  const generation = useRef(0);
  useEffect(() => {
    if (!open || !link) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open, link]);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  function close() {
    generation.current++;
    setOpen(false);
    setLink(null);
    setBusy(false);
    setError("");
    requestKey.current = crypto.randomUUID();
  }
  async function generate() {
    if (busy) return;
    const attempt = ++generation.current;
    setOpen(true);
    setBusy(true);
    setError("");
    setLink(null);
    try {
      const response = await fetch(
        `/api/customers/${customerId}/membership/download-link`,
        {
          method: "POST",
          headers: { "Idempotency-Key": requestKey.current },
        },
      );
      const body = await response.json();
      if (generation.current !== attempt) return;
      if (!response.ok) {
        if (response.status === 404 || response.status === 409)
          requestKey.current = crypto.randomUUID();
        setError(body?.error?.message ?? "QR download belum bisa dibuat.");
        return;
      }
      setNow(Date.now());
      setLink(body);
      requestKey.current = crypto.randomUUID();
    } catch {
      if (generation.current === attempt)
        setError("Koneksi terputus. Coba lagi.");
    } finally {
      if (generation.current === attempt) setBusy(false);
    }
  }
  const remaining = link
    ? Math.max(0, Math.ceil((new Date(link.expiresAt).getTime() - now) / 1000))
    : 0;
  return (
    <>
      <Button variant="outline" onClick={generate} disabled={busy}>
        <QrCode className="size-4" />
        Download link untuk customer
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogTitle>Download kartu membership</DialogTitle>
          <DialogDescription>
            Minta customer scan QR ini dengan kamera HP, lalu tekan Simpan
            kartu. Tidak perlu login.
          </DialogDescription>
          {busy && <p role="status">Membuat QR download…</p>}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {link && remaining > 0 && (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={link.qr}
                alt="QR link download kartu membership sementara"
                className="mx-auto aspect-square w-full max-w-xs rounded-xl bg-white"
              />
              <p
                aria-live="off"
                className="text-center text-sm text-muted-foreground"
              >
                Berlaku {Math.floor(remaining / 60)}:
                {String(remaining % 60).padStart(2, "0")} lagi
              </p>
              <p className="text-xs text-muted-foreground">
                QR ini untuk download kartu. QR pada kartu membership tetap
                sama.
              </p>
            </>
          )}
          {link && remaining === 0 && (
            <p role="status">Link sudah kedaluwarsa. Buat QR download baru.</p>
          )}
          {(error || (link && remaining === 0)) && (
            <Button onClick={generate} disabled={busy}>
              Buat QR baru
            </Button>
          )}
          <Button variant="ghost" onClick={close}>
            Tutup
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
