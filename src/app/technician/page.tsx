import { forbidden, redirect } from "next/navigation";
import { getAuthSession } from "@/server/auth/session";
import { isTechnician } from "@/server/auth/technician";
import { listTechnicianUsers } from "@/server/services/technician";
import { TechnicianPanel } from "@/components/technician-controls";

export const metadata = { title: "Technician · Marblehouse" };
export const dynamic = "force-dynamic";
export default async function TechnicianPage() {
  const current = await getAuthSession();
  if (!current) redirect("/login");
  // A refresh or another open tab can revisit this URL after switching users.
  // Let the normal home router settle the borrowed user's password/shop gates.
  if (current.session.impersonatedBy) redirect("/");
  if (!isTechnician(current.user) || current.session.impersonatedBy || current.user.banned || current.user.mustChangePassword) forbidden();
  const users = await listTechnicianUsers(current.user.id);
  return <main className="mx-auto max-w-4xl px-4 py-8"><TechnicianPanel users={users} /></main>;
}
