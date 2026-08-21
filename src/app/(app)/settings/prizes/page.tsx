import { redirect } from "next/navigation";

/**
 * Settings → Prizes MERGED INTO THE INVENTORY SCREEN (D-156).
 *
 * The catalog and the shop's stock were always two views of one `listPrizes`
 * call, and keeping them on separate screens meant editing an item and seeing
 * its stock were different journeys through different menus. Catalog editing
 * now lives in the inventory row's drawer, beside the batches it prices.
 *
 * The redirect stays rather than the route being deleted: the old path is in
 * the owner's muscle memory and quite possibly a bookmark.
 */
export default function PrizeCatalogPage() {
  redirect("/stock");
}
