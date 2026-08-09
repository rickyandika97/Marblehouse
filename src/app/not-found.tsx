import Link from "next/link";
import { SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * HTTP 404 page.
 *
 * `notFound()` is already called from three places — the customer and redeem
 * pages, and `asPageError` when a service raises `NOT_FOUND` (D-68) — but there
 * was no page to render it, so those paths fell through to Next's stock
 * black-and-white screen with no way back into the app.
 *
 * The copy names the two things that actually cause this in a shop: a
 * mistyped address, and a record someone else deleted while this tablet still
 * had the old link open. "404" appears nowhere — it means nothing to the
 * staff member reading it (§16's plain-language rule).
 */
export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="flex max-w-md flex-col items-center text-center">
        <span className="flex size-14 items-center justify-center rounded-full bg-muted">
          <SearchX className="size-7 text-muted-foreground" />
        </span>

        <h1 className="mt-6 text-xl font-bold tracking-tight">
          That page is not here
        </h1>

        <p className="mt-2 text-sm text-muted-foreground">
          The address may be mistyped, or whatever it pointed at may have been
          removed since this screen was opened.
        </p>

        <Button size="lg" className="mt-8" render={<Link href="/" />}>
          Back to your home screen
        </Button>
      </div>
    </main>
  );
}
