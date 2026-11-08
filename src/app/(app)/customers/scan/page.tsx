import Link from "next/link";
import { requireActorPage } from "@/server/auth/page-guard";
import { MembershipScanner } from "@/components/membership-scanner";
import { Button } from "@/components/ui/button";
export const metadata = { title: "Scan membership · Marblehouse" };
export default async function ScanPage({
  searchParams,
}: {
  searchParams: Promise<{ customerId?: string }>;
}) {
  await requireActorPage();
  const { customerId } = await searchParams;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Verify membership</h1>
      <p>
        Ask the customer to present their membership QR. Lost cards must be
        handled by the owner.
      </p>
      <MembershipScanner customerId={customerId} autoOpen />
      <Button variant="ghost" render={<Link href="/customers" />}>
        All customers
      </Button>
    </div>
  );
}
