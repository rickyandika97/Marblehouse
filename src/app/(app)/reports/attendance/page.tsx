import { redirect } from "next/navigation";

export const metadata = { title: "Attendance & Lateness · Marblehouse" };
export const dynamic = "force-dynamic";

export default async function AttendanceReportPage({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string;
    to?: string;
    shopId?: string;
    userId?: string;
  }>;
}) {
  const sp = await searchParams;
  const params = new URLSearchParams({ view: "report" });
  for (const [key, value] of Object.entries(sp)) {
    if (value) params.set(key, value);
  }
  redirect(`/attendance?${params.toString()}`);
}
