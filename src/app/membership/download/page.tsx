import type { Metadata } from "next";
import { DownloadCard } from "./download-card";
export const metadata: Metadata = {
  title: "Kartu membership · Red Light Pinball",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export const dynamic = "force-dynamic";
export default function MembershipDownloadPage() {
  return (
    <main
      lang="id"
      className="mx-auto min-h-dvh w-full max-w-lg space-y-5 px-4 pt-[calc(1.5rem+env(safe-area-inset-top))] pb-[calc(2rem+env(safe-area-inset-bottom))]"
    >
      <header className="space-y-2 text-center">
        <p className="text-xs font-semibold tracking-widest text-red-700">
          RED LIGHT PINBALL
        </p>
        <h1 className="text-2xl font-bold">Kartu membership Anda</h1>
        <p className="text-sm text-muted-foreground">
          Download kartu ke HP untuk dipakai saat berkunjung.
        </p>
      </header>
      <DownloadCard />
    </main>
  );
}
