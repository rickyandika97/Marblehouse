import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { Toaster } from "@/components/ui/sonner";

/**
 * Deliberately NOT using next/font/google.
 *
 * `next/font/google` downloads the font at BUILD time. This app is built in
 * Docker on the owner's own machine and redeployed from a shop network; a
 * build that needs fonts.googleapis.com is a build that can fail at 9pm for a
 * reason that has nothing to do with the code. A system font stack costs one
 * line and never fails.
 */
const FONT_STACK =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export const metadata: Metadata = {
  title: "Marblehouse",
  description: "Pinball arcade management",
  // §8.11's "Add to home screen". The manifest itself is app/manifest.ts;
  // these are the parts iOS does not read from it.
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Marblehouse",
    // Matches themeColor below, so the iOS status bar blends into the app bar
    // instead of sitting in a black strip above it.
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: "/icon.svg",
    // iOS ignores the manifest's icons array entirely and looks for this.
    apple: "/icon.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Tablet-first. Locked scale so the sale screen can't be pinch-zoomed
  // out of usability mid-shift.
  maximumScale: 1,
  themeColor: "#dc2626",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="id" style={{ ["--font-sans" as string]: FONT_STACK }}>
      <body className="min-h-full antialiased">
        <Providers>{children}</Providers>
        <Toaster position="top-center" richColors />
      </body>
    </html>
  );
}
