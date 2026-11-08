"use client";
import { useEffect, useRef, useState } from "react";
import { Download, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createMembershipCardImage } from "@/lib/membership-card-image";

type ReadyCard = { image: string; name: string; file: File; canShare: boolean };
export function DownloadCard() {
  const [card, setCard] = useState<ReadyCard | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const token = useRef("");
  useEffect(() => {
    let cancelled = false;
    if (!token.current) token.current = window.location.hash.slice(1);
    // Keep the fragment for reload/retry; fragments never reach server access logs.
    if (!token.current) {
      setError("Link tidak lengkap. Scan QR download yang ditampilkan staf.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    async function load() {
      try {
        const response = await fetch("/api/membership-download", {
          method: "POST",
          cache: "no-store",
          credentials: "omit",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: token.current }),
        });
        const body = await response.json();
        if (cancelled) return;
        if (!response.ok) {
          setError(
            body?.error?.message ??
              "Kartu belum bisa dimuat. Minta bantuan staf.",
          );
          return;
        }
        const image = await createMembershipCardImage(body);
        if (cancelled) return;
        const bytes = Uint8Array.from(atob(image.split(",")[1]!), (character) =>
          character.charCodeAt(0),
        );
        const file = new File(
          [bytes],
          `redlight-membership-${body.memberNumber}.png`,
          { type: "image/png" },
        );
        let canShare = false;
        try {
          canShare = !!navigator.canShare?.({ files: [file] });
        } catch {
          /* Download remains available. */
        }
        setCard({ image, name: body.name, file, canShare });
      } catch {
        if (!cancelled)
          setError("Koneksi terputus. Periksa internet lalu coba lagi.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [attempt]);
  function save() {
    if (!card) return;
    const anchor = document.createElement("a");
    anchor.href = card.image;
    anchor.download = card.file.name;
    anchor.click();
  }
  async function share() {
    if (!card) return;
    try {
      await navigator.share({
        files: [card.file],
        title: "Kartu membership Red Light Pinball",
      });
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError"))
        setError(
          "Gunakan Simpan kartu, atau tekan lama gambar untuk menyimpannya.",
        );
    }
  }
  return (
    <div className="space-y-4">
      {loading && (
        <p role="status" className="py-12 text-center">
          Menyiapkan kartu Anda…
        </p>
      )}
      {error && (
        <div role="alert" className="space-y-3 rounded-xl border p-4">
          <p>{error}</p>
          {!card && (
            <Button
              variant="outline"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Coba lagi
            </Button>
          )}
        </div>
      )}
      {card && (
        <>
          <p className="text-center text-sm text-muted-foreground">
            Kartu untuk{" "}
            <span className="font-medium text-foreground">{card.name}</span>
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={card.image}
            alt={`Kartu membership Red Light Pinball untuk ${card.name}`}
            className="h-auto w-full"
          />
          <Button className="w-full" size="lg" onClick={save}>
            <Download className="size-5" />
            Simpan kartu
          </Button>
          {card.canShare && (
            <Button
              variant="outline"
              className="w-full"
              size="lg"
              onClick={share}
            >
              <Share2 className="size-5" />
              Bagikan / simpan ke Foto
            </Button>
          )}
          <p className="text-center text-sm text-muted-foreground">
            Jika gambar terbuka di tab baru, tekan lama gambar lalu pilih Simpan
            Gambar.
          </p>
          <p className="text-center text-xs text-muted-foreground">
            Simpan kartu ini untuk kunjungan berikutnya. Jaga QR Anda tetap
            pribadi.
          </p>
        </>
      )}
    </div>
  );
}
