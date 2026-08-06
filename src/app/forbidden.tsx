import Link from "next/link";
import { ShieldX } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * HTTP 403 page (§3.4 enforcement rule).
 *
 * Rendered by `forbidden()` from a server-side guard. This is the visible half
 * of the Phase 1 acceptance criterion: a staff account that types an admin URL
 * into the address bar is stopped here, with a 403 status, before any of the
 * protected page is produced.
 */
export default function Forbidden() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="flex max-w-md flex-col items-center text-center">
        <span className="flex size-14 items-center justify-center rounded-full bg-destructive/10">
          <ShieldX className="size-7 text-destructive" />
        </span>

        <h1 className="mt-6 text-xl font-bold tracking-tight">
          You do not have access to this page
        </h1>

        <p className="mt-2 text-sm text-muted-foreground">
          Your account does not have permission for this part of the app. If you
          think it should, ask the owner.
        </p>

        <Button size="lg" className="mt-8" render={<Link href="/" />}>
          Back to your home screen
        </Button>
      </div>
    </main>
  );
}
