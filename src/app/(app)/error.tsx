"use client";

import { Button } from "@/components/ui/button";

/**
 * Error boundary for the authenticated shell.
 *
 * Permission denials do NOT come through here — they are raised with
 * `forbidden()` and rendered by app/forbidden.tsx with a real 403 status.
 * This boundary is for genuine faults only.
 */
export default function AppError({ reset }: { reset: () => void }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center py-16 text-center">
      <h1 className="text-xl font-bold tracking-tight">Something went wrong</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Try again. If it keeps happening, tell the owner.
      </p>
      <Button size="lg" className="mt-8" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
