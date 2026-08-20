import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireManagerOrOwnerPage } from "@/server/auth/page-guard";
import { listUncostedBatches } from "@/server/services/stock";
import { asPageError } from "@/server/auth/page-guard";
import { Button } from "@/components/ui/button";
import { UncostedQueue } from "./uncosted-queue";

export const metadata = { title: "Batches awaiting cost · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * The "Batches awaiting cost" queue (§7.5).
 *
 * Owner sees every shop; a Purchasing manager sees their own. A plain manager
 * reaching this URL directly gets a real 403 from the service — the guard here
 * only narrows to MANAGER/OWNER, and `listUncostedBatches` applies the cost
 * gate itself. That is deliberate: the page and the API cannot disagree,
 * because they run the same check.
 */
export default async function UncostedBatchesPage() {
  const actor = await requireManagerOrOwnerPage();

  const batches = await listUncostedBatches(actor).catch(asPageError);

  return (
    <div className="space-y-5">
      <Button variant="ghost" size="sm" render={<Link href="/stock" />}>
        <ArrowLeft className="size-4" />
        Stock
      </Button>

      <div>
        <h1 className="text-2xl font-bold tracking-tight">Batches awaiting cost</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Prize expense is understated until every delivery here has a unit cost.
          Setting one also corrects any redemption that already used the batch.
        </p>
      </div>

      {batches.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          Nothing is waiting for a cost. Every delivery has been priced.
        </p>
      ) : (
        <UncostedQueue batches={batches} />
      )}
    </div>
  );
}
