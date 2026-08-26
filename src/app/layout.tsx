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
    // Matches themeColor below, so the iOS status bar blends into the app's
    // (white) background instead of sitting in a black strip above it.
    statusBarStyle: "black-translucent",
  },
  icons: {
    // Modern browsers prefer the SVG. `public/favicon.ico` covers the legacy
    // root-convention request that browsers and crawlers make regardless of
    // what is declared here.
    icon: "/icon.svg",
    /**
     * iOS ignores the manifest's icons array entirely and looks for this —
     * but it CANNOT use an SVG. Pointing this at `/icon.svg` (as it did until
     * D-166) meant iOS silently discarded the link, probed
     * `/apple-touch-icon.png` and `/apple-touch-icon-precomposed.png`, got
     * 404s for both, and fell back to a screenshot of the page as the
     * home-screen icon.
     *
     * The PNG is deliberately full-bleed and un-rounded, unlike `icon.svg`:
     * iOS applies its own corner mask, and composites any transparency onto
     * black rather than honouring it.
     */
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Tablet-first. Locked scale so the sale screen can't be pinch-zoomed
  // out of usability mid-shift.
  maximumScale: 1,
  // Matches the app's actual background (globals.css `--background`), not the
  // brand red used for the icon — the in-app UI is white/grayscale
  // throughout, so a red status bar/toolbar was the only red pixel on
  // screen (D-167).
  themeColor: "#ffffff",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="id"
      suppressHydrationWarning
      style={{ ["--font-sans" as string]: FONT_STACK }}
    >
      <body className="min-h-full subpixel-antialiased">
        <Providers>
          {children}
          <Toaster position="top-center" richColors />
        </Providers>
      </body>
    </html>
  );
}
