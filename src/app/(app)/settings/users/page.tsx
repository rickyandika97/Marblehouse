import { redirect } from "next/navigation";

/**
 * Redirect stub (D-122). Renamed to Settings → Employees when role became
 * per-shop — kept here for anyone with the old URL bookmarked.
 */
export default function UsersRedirectPage() {
  redirect("/settings/employees");
}
