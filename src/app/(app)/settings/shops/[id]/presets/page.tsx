import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { requireOwnerPage, asPageError } from "@/server/auth/page-guard";
import { getShop, listPresetsForAdmin } from "@/server/services/shops";
import { PresetAdmin } from "./preset-admin";

export const metadata = { title: "Sale prices · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Settings → Shops → *this shop* → Sale prices (§4.3, §7.2). OWNER only.
 *
 * This is the screen a newly created branch sends you to. D-101 made a new
 * shop start empty, which is only a reasonable decision if filling it is
 * obvious — before this existed, `POST /api/shops/:id/presets` did not either,
 * so an empty branch was a dead end (D-103).
 */
export default async function ShopPresetsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requireOwnerPage();
  const { id } = await params;

  try {
    const [shop, presets] = await Promise.all([
      getShop(actor, id),
      listPresetsForAdmin(actor, id),
    ]);

    return (
      <div className="space-y-6">
        <div>
          <Link
            href="/settings/shops"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="size-4" />
            Shops
          </Link>
          <h1 className="mt-2 text-2xl font-bold tracking-tight">Sale prices</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {shop.name} · {shop.code}. These are the buttons staff tap on the
            sale screen.
          </p>
        </div>

        <PresetAdmin
          shopId={shop.id}
          shopName={shop.name}
          allowCustomAmount={shop.allowCustomAmount}
          initialPresets={presets}
        />
      </div>
    );
  } catch (e) {
    // A bad shop id in the URL bar is a 404, not a 500 (D-64).
    asPageError(e);
  }
}
