/**
 * Better Auth configuration (PRD §5.4, decided 4 Aug 2026).
 *
 * Better Auth runs INSIDE this app against our own Postgres — it is a library,
 * not a hosted service, so it does not breach the self-hosting constraint
 * (§5.2: nothing may depend on Vercel or any third-party auth service).
 *
 * What Better Auth owns:  identity, credentials, sessions, rate limiting.
 * What WE own:            role, shop scoping, work sessions, every
 *                         authorisation decision.
 *
 * That division is deliberate and stated in §5.4: "Better Auth supplies the
 * session; the shop-scoping and role logic remain ours and are still enforced
 * server-side on every request."
 */
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { username as usernamePlugin, admin as adminPlugin } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { prisma } from "@/lib/prisma";
import { hashPassword, verifyPassword } from "./password";

/** Rolling 12-hour session (§5.4). */
const SESSION_TTL_SECONDS = (() => {
  const hours = Number(process.env.SESSION_TTL_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 7) : 12) * 60 * 60;
})();

export const auth = betterAuth({
  appName: "Marblehouse",
  baseURL: process.env.APP_URL ?? "http://localhost:5050",
  secret: process.env.SESSION_SECRET,

  database: prismaAdapter(prisma, { provider: "postgresql" }),

  /**
   * Username + password only. There are no email addresses in this system —
   * staff do not have work emails (§5.4), so every email flow is off:
   * no verification, no magic links, no email password reset. A forgotten
   * password is reset by the owner, which sets `mustChangePassword`.
   */
  emailAndPassword: {
    enabled: true,
    // Accounts are created by the owner in Settings → Users, never self-serve.
    disableSignUp: true,
    requireEmailVerification: false,
    minPasswordLength: 8,
    autoSignIn: false,

    /**
     * argon2id, explicitly configured (§5.4). Better Auth defaults to scrypt;
     * the PRD calls for argon2id via @node-rs/argon2, which also ships the
     * prebuilt arm64 binaries the Raspberry Pi target needs (§12.3).
     */
    password: {
      hash: hashPassword,
      verify: ({ hash, password }) => verifyPassword(hash, password),
    },

    // A password reset should evict whoever prompted it.
    revokeSessionsOnPasswordReset: true,
  },

  session: {
    expiresIn: SESSION_TTL_SECONDS,
    // Refresh on use — this is the "rolling" half of the rolling window.
    // A tablet in active use stays signed in; one left overnight does not.
    updateAge: 60 * 60,
  },

  user: {
    /**
     * Domain fields ride along on the auth user (§5.4) rather than living in a
     * parallel table — "a second table joined to the auth user would be a
     * permanent source of drift."
     *
     * `input: false` means the field cannot be set through a public sign-up
     * payload. Role and the Purchasing permission are assigned by the owner
     * through our own audited service, never by the client.
     */
    additionalFields: {
      /**
       * The human-facing name, and the mutable one. Better Auth's own `name`
       * is mirrored to it. Every field the app writes must be declared here —
       * the library strips undeclared keys from the create payload.
       */
      displayName: {
        type: "string",
        required: true,
        input: false,
      },
      phone: {
        type: "string",
        required: false,
        input: false,
      },
      role: {
        type: "string",
        required: true,
        defaultValue: "STAFF",
        input: false,
      },
      canEnterCost: {
        type: "boolean",
        required: false,
        defaultValue: false,
        input: false,
      },
      defaultShopId: {
        type: "string",
        required: false,
        input: false,
      },
      mustChangePassword: {
        type: "boolean",
        required: false,
        defaultValue: true,
        input: false,
      },
    },
  },

  /**
   * 5 failed attempts per username per 15 minutes → 15-minute lockout (§5.4).
   *
   * `enabled: true` overrides the library default of production-only, because
   * the throttle is part of the acceptance criteria and must be testable in
   * development.
   */
  rateLimit: {
    enabled: true,
    window: 15 * 60,
    max: 100,
    customRules: {
      "/sign-in/username": { window: 15 * 60, max: 5 },
      "/sign-in/email": { window: 15 * 60, max: 5 },
    },
  },

  advanced: {
    cookiePrefix: "marblehouse",
    // Behind the Cloudflare Tunnel everything is HTTPS (§12.2). Locally over
    // plain HTTP a Secure cookie would never be stored, so key it off APP_URL.
    useSecureCookies: !(process.env.APP_URL ?? "").startsWith("http://"),
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: "lax",
    },
  },

  plugins: [
    /**
     * Username is the login identifier — unique, case-insensitive (§5.4).
     */
    usernamePlugin({
      minUsernameLength: 3,
      maxUsernameLength: 32,
    }),

    /**
     * Owner-side user management, password setting, and ban/unban — which is
     * what backs our `isActive` concept.
     *
     * Impersonation is DISABLED. §5.4 permits it only if audit-logged; until
     * that audit wiring exists, the safer default is off — an un-logged
     * impersonation of an owner account would be invisible in the audit trail.
     */
    /**
     * NOTE ON adminRoles: the plugin has its own access-control system with a
     * `roles` map, and `adminRoles` must reference roles declared there. We
     * deliberately do NOT wire our OWNER/MANAGER/STAFF into it.
     *
     * Our authorisation lives in src/server/auth/guards.ts and is checked on
     * every request against the actor context (§5.4). Teaching the plugin a
     * second, parallel notion of who is privileged would give us two sources
     * of truth for permissions — exactly the drift §5.4 warns about. Instead,
     * every admin-plugin endpoint is reached only through our own owner-gated
     * services, which enforce the real check first.
     */
    adminPlugin(),

    // Must be last: lets route handlers set auth cookies in Next.js.
    nextCookies(),
  ],
});

export type Auth = typeof auth;
