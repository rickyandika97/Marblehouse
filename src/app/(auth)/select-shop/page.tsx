import { redirect } from "next/navigation";
import { requireActorPage } from "@/server/auth/page-guard";
import { resolveWorkSession } from "@/server/services/work-session";
import { formatBusinessDate } from "@/lib/business-date";
import { ShopPicker } from "./shop-picker";

export const metadata = { title: "Choose your shop · Marblehouse" };
export const dynamic = "force-dynamic";

export default async function SelectShopPage() {
  const actor = await requireActorPage();
  const resolution = await resolveWorkSession(actor);

  // Already answered today, or auto-selected because there was only one
  // choice — either way there is nothing to ask (§4.7).
  if (!resolution.needsPicker) redirect("/");

  return (
    <ShopPicker
      shops={resolution.shops.map((s) => ({
        id: s.id,
        code: s.code,
        name: s.name,
      }))}
      defaultShopId={resolution.defaultShopId}
      useSearch={resolution.useSearch}
      businessDate={formatBusinessDate(actor.businessDate)}
    />
  );
}
