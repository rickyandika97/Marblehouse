import { requireActorPage } from "@/server/auth/page-guard";
import { ChangePasswordForm } from "./change-password-form";

export const metadata = { title: "Change password · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Forced password change (§5.4, §8.1 step 2).
 *
 * Reached with `allowUnsettled` because this is the ONE screen a user carrying
 * the mustChangePassword flag may see. There is no navigation away from it
 * while the flag is set — every other page redirects back here.
 */
export default async function ChangePasswordPage() {
  const actor = await requireActorPage({ allowUnsettled: true });
  const forced = actor.mustChangePassword;

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold tracking-tight">
            {forced ? "Choose your password" : "Change your password"}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {forced
              ? "You are signed in with a temporary password. Pick your own before you carry on."
              : `Signed in as ${actor.displayName}.`}
          </p>
        </div>

        <div className="rounded-2xl border bg-background p-6 shadow-sm">
          <ChangePasswordForm forced={forced} />
        </div>
      </div>
    </main>
  );
}
