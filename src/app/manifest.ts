import type { MetadataRoute } from "next";

/**
 * Web app manifest (§8.11, Phase 10).
 *
 * This exists so a tablet can "Add to home screen" and run the app full-screen,
 * without the browser chrome eating vertical space the sale screen needs (§8.2
 * asks for it to be usable in portrait and landscape without scrolling).
 *
 * **It does NOT add offline support, and must never be described as if it
 * does.** §8.11 is explicit about that. There is no service worker in this
 * project and no cache manifest; every screen still needs the server. A staff
 * member whose wifi drops sees the same failure they see in a browser tab. The
 * one thing that would change that — caching sales locally and syncing later —
 * is out of scope for v1 (§1.5) and would need real conflict rules for money,
 * not a manifest.
 *
 * Built as `manifest.ts` rather than a static `public/manifest.json` so Next
 * serves it at `/manifest.webmanifest` with the right content type and the
 * fields stay typed. Icons are SVG data URIs (see `icon.svg`) — nothing is
 * fetched at build time, which is the same constraint that keeps
 * `next/font/google` out of `layout.tsx` (D-7).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Marblehouse",
    short_name: "Marblehouse",
    description: "Pinball arcade management — sales, balances, stock and attendance",
    start_url: "/",
    // Full-screen without the URL bar. `standalone` rather than `fullscreen`
    // so the OS status bar (clock, battery, wifi) stays visible — staff need
    // to see the time and the signal, and the wifi indicator is the first
    // thing to check when a sale will not save.
    display: "standalone",
    // The sale screen is designed for either orientation (§8.11), so this is
    // deliberately unlocked rather than pinned to portrait.
    orientation: "any",
    background_color: "#ffffff",
    // Matches `viewport.themeColor` in layout.tsx. If one changes, change both.
    theme_color: "#dc2626",
    lang: "id",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/icon-maskable.svg",
        sizes: "any",
        type: "image/svg+xml",
        // Android crops a non-maskable icon into a circle and can clip the
        // artwork; the maskable variant keeps its content inside the safe zone.
        purpose: "maskable",
      },
    ],
  };
}
