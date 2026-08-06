import { requireActorPage } from "@/server/auth/page-guard";
import { selectableShops } from "@/server/auth/context";
import { formatBusinessDate } from "@/lib/business-date";
import { ChangeShopForm } from "./change-shop-form";

export const metadata = { title: "Current shop · Marblehouse" };
export const dynamic = "force-dynamic";

export default async function CurrentShopPage() {
  const actor = await requireActorPage();
  const shops = await selectableShops(actor);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Current shop</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Business day {formatBusinessDate(actor.businessDate)}. Changing this
          does not move records you have already made today, and every change is
          recorded in the audit log.
        </p>
      </div>

      <ChangeShopForm
        shops={shops.map((s) => ({ id: s.id, code: s.code, name: s.name }))}
        currentShopId={actor.workSession?.shopId ?? null}
      />
    </div>
  );
}
