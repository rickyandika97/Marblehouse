import { cookies } from "next/headers";
import { auth } from "@/server/auth/auth";
import { getAuthSession } from "@/server/auth/session";
import { TechnicianReturnBanner } from "./technician-controls";
export async function TechnicianStatus() {
  const context = await auth.$context;
  if (!(await cookies()).has(context.createAuthCookie("technician_session").name)) return null;
  const current = await getAuthSession();
  return <TechnicianReturnBanner name={current?.session.impersonatedBy ? current.user.displayName : "session ended"} />;
}
