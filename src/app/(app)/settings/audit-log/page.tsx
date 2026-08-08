import Link from "next/link";
import { requireOwnerPage, asPageError } from "@/server/auth/page-guard";
import { auditLogFilters, listAuditLog } from "@/server/services/audit-log";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Audit log · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * §4.16's audit log viewer — owner only.
 *
 * A server component that filters and pages by URL, the same shape D-68 chose
 * for the report screens: the page re-runs and the service re-checks
 * permissions from scratch on every navigation, and nothing about who may read
 * this is decided in the browser.
 */
export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireOwnerPage();
  const params = await searchParams;

  const one = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v) || undefined;

  const entity = one(params.entity);
  const action = one(params.action);
  const cursor = one(params.cursor);

  const [{ rows, nextCursor }, filters] = await Promise.all([
    listAuditLog(actor, { entity, action, cursor }).catch(asPageError),
    auditLogFilters(actor).catch(asPageError),
  ]);

  // Build a link that keeps the current filters — appending a cursor to a bare
  // path would silently drop them and page into a different result set (D-69).
  const linkWith = (patch: Record<string, string | undefined>) => {
    const sp = new URLSearchParams();
    const merged = { entity, action, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) sp.set(k, v);
    const qs = sp.toString();
    return qs ? `/settings/audit-log?${qs}` : "/settings/audit-log";
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Audit log</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every privileged change, oldest kept forever. This log cannot be
          edited or deleted from the app.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Link
          href={linkWith({ entity: undefined, cursor: undefined })}
          className={`inline-flex min-h-11 items-center rounded-md border px-3 text-sm ${
            entity ? "hover:bg-muted" : "bg-foreground text-background"
          }`}
        >
          All entities
        </Link>
        {filters.entities.map((e) => (
          <Link
            key={e}
            href={linkWith({ entity: e, cursor: undefined })}
            className={`inline-flex min-h-11 items-center rounded-md border px-3 text-sm ${
              entity === e ? "bg-foreground text-background" : "hover:bg-muted"
            }`}
          >
            {e}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">
          No audit entries match these filters.
        </Card>
      ) : (
        <Card className="divide-y p-0">
          {rows.map((r) => (
            <div key={r.id} className="space-y-1 px-4 py-3">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="font-medium">
                  {r.action} · {r.entity}
                </span>
                <span className="text-sm text-muted-foreground">
                  {new Date(r.occurredAt).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </span>
              </div>
              <div className="text-sm text-muted-foreground">
                {r.actor ?? "system"}
                {r.role ? ` (${r.role})` : ""}
                {r.shopName ? ` · ${r.shopName}` : ""}
                {r.entityId ? ` · ${r.entityId}` : ""}
              </div>
              {r.reason && (
                <div className="text-sm">
                  <span className="text-muted-foreground">Reason: </span>
                  {r.reason}
                </div>
              )}
            </div>
          ))}
        </Card>
      )}

      {nextCursor && (
        <Button
          variant="outline"
          className="w-full"
          render={<Link href={linkWith({ cursor: nextCursor })} />}
        >
          Load more
        </Button>
      )}
    </div>
  );
}
