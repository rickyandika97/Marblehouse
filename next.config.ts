import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Background jobs run only in the Node server runtime. Keep node-cron's
  // child_process/path imports out of Next's browser/edge webpack graph.
  //
  // `sharp` is here for the same reason with a sharper edge: it loads platform
  // -specific native binaries, so bundling it fails at build time with a
  // module-not-found on its own internals (Phase 6). It is used only by the
  // attendance watermarker, which is server-only by definition.
  serverExternalPackages: ["node-cron", "sharp"],

  webpack(config, { isServer, nextRuntime }) {
    if (isServer) {
      config.externals.push({
        "node-cron": "commonjs node-cron",
        sharp: "commonjs sharp",
      });
    }

    // `instrumentation.ts` is compiled for BOTH the node and edge runtimes,
    // even though its body returns early unless NEXT_RUNTIME is "nodejs".
    // Webpack still walks the import graph, so the scheduler → photo-retention
    // → attendance-photo chain drags `node:fs/promises` and friends into the
    // edge bundle, where `node:` schemes are unsupported and the build fails.
    //
    // Excluding the photo module from the edge bundle breaks that chain.
    // Nothing in the edge runtime can legitimately reach it: it reads and
    // writes files, which the edge runtime cannot do at all. `externals` with
    // a matcher is used rather than a resolve alias, because an alias keyed on
    // the `@/` path did not intercept the request.
    //
    // Phase 9 added two more links to the same chain, and they fail the same
    // way:
    //
    //   instrumentation → scheduler → maintenance → reports → auth/context
    //                                                       → auth → argon2
    //   instrumentation → scheduler → backup → pg_dump via child_process
    //
    // `reports` is the one that bites: it reaches Better Auth and therefore
    // `@node-rs/argon2`, whose native/wasm variants webpack cannot resolve for
    // the edge target, and the dev server refuses to start at all. Making the
    // import dynamic does NOT help — webpack follows dynamic imports too, which
    // D-47 already recorded. The matcher is the only thing that works.
    if (nextRuntime === "edge") {
      const serverOnlyModules = [
        "services/attendance-photo",
        "services/reports",
        "services/backup",
        "services/maintenance",
      ];

      config.externals.push(
        (
          { request }: { request?: string },
          callback: (err?: Error | null, result?: string) => void,
        ) => {
          const match = serverOnlyModules.find((m) => request?.includes(m));
          if (match) {
            return callback(null, `commonjs @/server/${match}`);
          }
          return callback();
        },
      );
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
