import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Background jobs run only in the Node server runtime. Keep node-cron's
  // child_process/path imports out of Next's browser/edge webpack graph.
  serverExternalPackages: ["node-cron"],

  webpack(config, { isServer }) {
    if (isServer) {
      config.externals.push({ "node-cron": "commonjs node-cron" });
    }
    return config;
  },

  experimental: {
    /**
     * Enables `forbidden()` / `unauthorized()` from next/navigation.
     *
     * Needed so a denied page returns a real HTTP 403 with a forbidden.tsx UI.
     * Without it, a thrown guard error surfaces as a 500, which would make the
     * Phase 1 acceptance check ("a staff account gets a 403 when typing an
     * admin URL") pass visually but fail on the status code.
     */
    authInterrupts: true,
  },

  // This app is self-hosted behind a Cloudflare Tunnel. Nothing here may
  // depend on Vercel-only features (edge runtime, @vercel/*, ISR-on-CDN,
  // Vercel Blob/KV/Postgres). See PRD §5.2.

  // Lint locally with `npm run lint`, not during the Docker build. A style
  // warning should never be the reason a deploy to the shop fails at 9pm.
  eslint: {
    ignoreDuringBuilds: true,
  },

  // Type errors DO fail the build. That is deliberate — they catch real bugs.
  typescript: {
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
