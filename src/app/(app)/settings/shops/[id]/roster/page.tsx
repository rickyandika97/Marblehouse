import { redirect } from "next/navigation";
import { requireManagerOrOwnerPage } from "@/server/auth/page-guard";

export const metadata = { title: "Roster · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Legacy Roster URL. Roster and shifts are one workflow now: the active week
 * belongs above the shift cards, where coverage is assigned. Keep this route
 * so a bookmarked old link lands at the combined screen rather than 404ing.
 */
export default async function ShopRosterPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ week?: string }>;
}) {
  await requireManagerOrOwnerPage();
  const { id } = await params;
  const { week } = await searchParams;
  redirect(`/settings/shops/${id}/shifts${week ? `?week=${week}` : ""}`);
}
