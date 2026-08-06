import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getActor } from "@/server/auth/context";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in · Marblehouse" };

/** Cookies are read per request; never cache this page. */
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  // A valid session should not sit on the login screen.
  const actor = await getActor();
  if (actor) redirect("/");

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-tight">Marblehouse</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Sign in to record sales and look up customers.
          </p>
        </div>

        <div className="rounded-2xl border bg-background p-6 shadow-sm">
          <Suspense fallback={null}>
            <LoginForm />
          </Suspense>
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Forgotten your password? Ask the owner to reset it for you.
        </p>
      </div>
    </main>
  );
}
