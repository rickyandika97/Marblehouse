"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarDays, KeyRound, Loader2, Search, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type ShopRoleValue = "MANAGER" | "STAFF";

export interface ShopOption {
  id: string;
  code: string;
  name: string;
  /** Inactive shops are shown when already assigned, but never offered new. */
  isActive: boolean;
  isHqPseudoShop: boolean;
}

export interface EmployeeShopRole {
  shopId: string;
  shopName: string;
  shopCode: string;
  role: ShopRoleValue;
  canEnterCost: boolean;
}

export interface EmployeeRow {
  id: string;
  username: string | null;
  displayName: string;
  isOwner: boolean;
  phone: string | null;
  isActive: boolean;
  deactivationReason: string | null;
  mustChangePassword: boolean;
  defaultShopId: string | null;
  shopRoles: EmployeeShopRole[];
}

export interface EmployeeSchedule {
  id: string;
  userId: string;
  shopId: string;
  shopName: string;
  shopCode: string;
  shiftId: string;
  shiftName: string;
  startTime: string;
  endTime: string;
  daysOfWeek: number[];
}

const WEEKDAYS_MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatDays(days: number[]): string {
  return WEEKDAYS_MONDAY_FIRST.filter((day) => days.includes(day))
    .map((day) => DAY_SHORT[day])
    .join(", ");
}

/** In-progress shop-role selections, keyed by shopId — the shape both the
 *  create and edit forms share for their "checklist with a role dropdown"
 *  section. */
type ShopRoleDraft = Record<
  string,
  { checked: boolean; role: ShopRoleValue; canEnterCost: boolean }
>;

function emptyDraft(shops: ShopOption[]): ShopRoleDraft {
  return Object.fromEntries(
    shops.map((s) => [s.id, { checked: false, role: "STAFF" as const, canEnterCost: false }])
  );
}

function draftFromShopRoles(
  shops: ShopOption[],
  shopRoles: EmployeeShopRole[]
): ShopRoleDraft {
  const byShop = new Map(shopRoles.map((sr) => [sr.shopId, sr]));
  return Object.fromEntries(
    shops.map((s) => {
      const held = byShop.get(s.id);
      return [
        s.id,
        held
          ? { checked: true, role: held.role, canEnterCost: held.canEnterCost }
          : { checked: false, role: "STAFF" as const, canEnterCost: false },
      ];
    })
  );
}

function draftToShopRoles(draft: ShopRoleDraft): {
  shopId: string;
  role: ShopRoleValue;
  canEnterCost: boolean;
}[] {
  return Object.entries(draft)
    .filter(([, v]) => v.checked)
    .map(([shopId, v]) => ({ shopId, role: v.role, canEnterCost: v.canEnterCost }));
}

export function EmployeeAdmin({
  initialEmployees,
  schedules,
  shops,
  currentUserId,
}: {
  initialEmployees: EmployeeRow[];
  schedules: EmployeeSchedule[];
  shops: ShopOption[];
  /** Used to mark "You" and to explain the self-edit guards before they fire. */
  currentUserId: string;
}) {
  const router = useRouter();
  const [employees, setEmployees] = useState(initialEmployees);
  const [open, setOpen] = useState(initialEmployees.length === 0);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter(
      (e) =>
        e.displayName.toLowerCase().includes(q) ||
        (e.username ?? "").toLowerCase().includes(q) ||
        e.shopRoles.some((sr) => sr.shopName.toLowerCase().includes(q))
    );
  }, [employees, search]);

  // The owner is never deactivatable (D-134 — exactly one, D-123), so it
  // always lands on Active regardless of this split.
  const activeEmployees = filtered.filter((e) => e.isActive);
  const deactivatedEmployees = filtered.filter((e) => !e.isActive);
  const schedulesByEmployee = useMemo(() => {
    const grouped = new Map<string, EmployeeSchedule[]>();
    for (const schedule of schedules) {
      const existing = grouped.get(schedule.userId) ?? [];
      existing.push(schedule);
      grouped.set(schedule.userId, existing);
    }
    return grouped;
  }, [schedules]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Employees</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Create accounts and set each shop&apos;s role and access.
          </p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <UserPlus className="size-4" />
          New employee
        </Button>
      </div>

      <CreateEmployeeDialog
        open={open}
        shops={shops}
        onOpenChange={setOpen}
        onCreated={(e) => {
          setEmployees((prev) => [...prev, e]);
          setOpen(false);
          router.refresh();
        }}
      />

      <Card>
        <CardHeader className="space-y-3">
          <CardTitle>Existing accounts</CardTitle>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, username or shop"
              className="pl-9"
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {filtered.length === 0 ? (
            <p className="px-6 py-8 text-center text-sm text-muted-foreground">
              No accounts match &quot;{search}&quot;.
            </p>
          ) : (
            <Tabs defaultValue="active" className="px-6 pb-2">
              <TabsList>
                <TabsTrigger value="active">
                  Active
                  {activeEmployees.length > 0 && (
                    <span className="text-muted-foreground">
                      {activeEmployees.length}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="deactivated">
                  Deactivated
                  {deactivatedEmployees.length > 0 && (
                    <span className="text-muted-foreground">
                      {deactivatedEmployees.length}
                    </span>
                  )}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="active" className="-mx-6">
                {activeEmployees.length === 0 ? (
                  <p className="px-6 py-4 text-sm text-muted-foreground">
                    No active accounts match &quot;{search}&quot;.
                  </p>
                ) : (
                  <ul className="divide-y">
                    {activeEmployees.map((e) => (
                      <EmployeeListItem
                        key={e.id}
                        employee={e}
                        schedule={schedulesByEmployee.get(e.id) ?? []}
                        shops={shops}
                        currentUserId={currentUserId}
                        onChanged={(next) => {
                          setEmployees((prev) =>
                            prev.map((x) => (x.id === next.id ? next : x)),
                          );
                          router.refresh();
                        }}
                      />
                    ))}
                  </ul>
                )}
              </TabsContent>

              <TabsContent value="deactivated" className="-mx-6">
                {deactivatedEmployees.length === 0 ? (
                  <p className="px-6 py-4 text-sm text-muted-foreground">
                    No deactivated accounts.
                  </p>
                ) : (
                  <ul className="divide-y">
                    {deactivatedEmployees.map((e) => (
                      <EmployeeListItem
                        key={e.id}
                        employee={e}
                        schedule={schedulesByEmployee.get(e.id) ?? []}
                        shops={shops}
                        currentUserId={currentUserId}
                        onChanged={(next) => {
                          setEmployees((prev) =>
                            prev.map((x) => (x.id === next.id ? next : x)),
                          );
                          router.refresh();
                        }}
                      />
                    ))}
                  </ul>
                )}
              </TabsContent>
            </Tabs>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** "Manager"/"Staff" — the human label for a role value. */
const ROLE_LABEL: Record<ShopRoleValue, string> = {
  MANAGER: "Manager",
  STAFF: "Staff",
};

function shopRolesSummary(e: EmployeeRow): string {
  if (e.isOwner) return "Owner";
  if (e.shopRoles.length === 0) return "No shops assigned";
  return e.shopRoles
    .map((sr) => `${sr.shopCode}: ${ROLE_LABEL[sr.role]}`)
    .join(", ");
}

/**
 * One account, with its edit and password panels.
 *
 * The row stays read-only until the owner opens a panel — this list is mostly
 * read, and a page of expanded forms would be unreadable on a phone.
 */
function EmployeeListItem({
  employee,
  schedule,
  shops,
  currentUserId,
  onChanged,
}: {
  employee: EmployeeRow;
  schedule: EmployeeSchedule[];
  shops: ShopOption[];
  currentUserId: string;
  onChanged: (e: EmployeeRow) => void;
}) {
  const [panel, setPanel] = useState<"none" | "schedule" | "edit" | "password">("none");

  const isSelf = employee.id === currentUserId;

  return (
    <li className="px-6 py-4">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setPanel(panel === "schedule" ? "none" : "schedule")}
          className="min-w-0 flex-1 text-left"
          aria-expanded={panel === "schedule"}
        >
          <span className="block truncate font-medium">
            {employee.displayName}
            {/* No "Deactivated" badge here — which tab the row is in
                (D-135) already says that, same as D-132 on Settings →
                Shops. */}
            {isSelf && (
              <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                You
              </span>
            )}
          </span>
          <span className="block truncate text-sm text-muted-foreground">
            {employee.username} · {shopRolesSummary(employee)}
            {employee.mustChangePassword && " · must set password"}
          </span>
          {!employee.isActive && employee.deactivationReason && (
            <span className="block truncate text-xs text-muted-foreground">
              {employee.deactivationReason}
            </span>
          )}
        </button>

        <div className="flex shrink-0 gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPanel(panel === "schedule" ? "none" : "schedule")}
          >
            <CalendarDays className="size-4" />
            Schedule
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPanel(panel === "edit" ? "none" : "edit")}
          >
            Edit
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPanel(panel === "password" ? "none" : "password")}
          >
            <KeyRound className="size-4" />
            Password
          </Button>
        </div>
      </div>

      {panel === "schedule" && <EmployeeSchedulePanel schedule={schedule} />}

      <EditEmployeeDialog
        open={panel === "edit"}
        employee={employee}
        shops={shops}
        isSelf={isSelf}
        onOpenChange={(next) => setPanel(next ? "edit" : "none")}
        onSaved={(e) => {
          setPanel("none");
          onChanged(e);
        }}
      />

      {panel === "password" && (
        <div className="mt-4">
          <ResetPasswordForm
            employee={employee}
            onCancel={() => setPanel("none")}
            onDone={() => setPanel("none")}
          />
        </div>
      )}
    </li>
  );
}

/** The employee view groups recurring assignments by shop, never by a flat list. */
function EmployeeSchedulePanel({ schedule }: { schedule: EmployeeSchedule[] }) {
  const byShop = new Map<string, EmployeeSchedule[]>();
  for (const assignment of schedule) {
    const existing = byShop.get(assignment.shopId) ?? [];
    existing.push(assignment);
    byShop.set(assignment.shopId, existing);
  }

  return (
    <div className="mt-4 space-y-3 rounded-xl border bg-muted/30 p-4">
      <div>
        <h3 className="font-semibold">Regular schedule</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Recurring shifts only. One-day cover and leave stay on each shop&apos;s roster calendar.
        </p>
      </div>

      {byShop.size === 0 ? (
        <p className="rounded-lg border border-dashed bg-background p-3 text-sm text-muted-foreground">
          No recurring shifts assigned yet.
        </p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {[...byShop.values()].map((assignments) => {
            const shop = assignments[0]!;
            return (
              <section key={shop.shopId} className="rounded-lg border bg-background p-3">
                <h4 className="font-medium">{shop.shopName}</h4>
                <p className="text-xs text-muted-foreground">{shop.shopCode}</p>
                <ul className="mt-3 space-y-2">
                  {assignments.map((assignment) => (
                    <li key={assignment.id} className="text-sm">
                      <p className="font-medium">
                        {assignment.shiftName} · {assignment.startTime}–{assignment.endTime}
                      </p>
                      <p className="text-muted-foreground">{formatDays(assignment.daysOfWeek)}</p>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The "Shop access · set a role per shop" section shared by create and edit —
 * a search bar, then one row per shop: a checkbox, the shop name, and a role
 * dropdown that only matters once the row is checked. Matches the reference
 * screenshot's interaction model; styling is this app's own.
 */
function ShopAccessFields({
  shops,
  draft,
  setDraft,
  disabled,
}: {
  shops: ShopOption[];
  draft: ShopRoleDraft;
  setDraft: (next: ShopRoleDraft) => void;
  disabled: boolean;
}) {
  const [search, setSearch] = useState("");

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return shops
      .filter(
        (s) =>
          (s.isActive || draft[s.id]?.checked) &&
          (q === "" ||
            s.name.toLowerCase().includes(q) ||
            s.code.toLowerCase().includes(q))
      )
      // HQ first (matches Settings → Shops, D-128) — it is not a branch and
      // should not read as one buried in an alphabetical/creation-order list.
      .sort((a, b) => (a.isHqPseudoShop === b.isHqPseudoShop ? 0 : a.isHqPseudoShop ? -1 : 1));
  }, [shops, search, draft]);

  function toggle(shopId: string, isHqPseudoShop: boolean) {
    const wasChecked = draft[shopId]?.checked;
    setDraft({
      ...draft,
      [shopId]: {
        ...draft[shopId]!,
        checked: !wasChecked,
        // STAFF is a no-op at HQ — it accepts no sales, has no shifts, and
        // expense recording requires MANAGER (`assertCanRecordAgainst` in
        // expenses.ts). Force MANAGER the moment HQ is checked rather than
        // leaving it on the STAFF default and letting the owner discover
        // that only after saving (owner request, 2026-08-20).
        role: !wasChecked && isHqPseudoShop ? "MANAGER" : draft[shopId]!.role,
      },
    });
  }

  function setRole(shopId: string, role: ShopRoleValue) {
    setDraft({
      ...draft,
      [shopId]: {
        ...draft[shopId]!,
        role,
        canEnterCost: role === "MANAGER" ? draft[shopId]!.canEnterCost : false,
      },
    });
  }

  function setCanEnterCost(shopId: string, canEnterCost: boolean) {
    setDraft({ ...draft, [shopId]: { ...draft[shopId]!, canEnterCost } });
  }

  return (
    <fieldset className="space-y-3">
      <legend className="mb-1 text-sm font-medium">
        Shop access · set a role per shop
      </legend>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search shops"
          className="pl-9"
          disabled={disabled}
        />
      </div>

      <div className="grid gap-2">
        {visible.map((shop) => {
          const row = draft[shop.id];
          if (!row) return null;
          return (
            <div
              key={shop.id}
              className="flex min-h-14 items-center gap-3 rounded-lg border px-4"
            >
              <Checkbox
                checked={row.checked}
                onCheckedChange={() => toggle(shop.id, shop.isHqPseudoShop)}
                disabled={disabled}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{shop.name}</span>
                <span className="block text-xs text-muted-foreground">
                  {shop.code}
                  {shop.isHqPseudoShop && " · expenses only"}
                  {!shop.isActive && " · deactivated"}
                  {row.checked && row.role === "MANAGER" && (
                    <>
                      {" · "}
                      <label className="inline-flex cursor-pointer items-center gap-1.5">
                        <Checkbox
                          checked={row.canEnterCost}
                          onCheckedChange={(v) =>
                            setCanEnterCost(shop.id, v === true)
                          }
                          disabled={disabled}
                        />
                        Purchasing
                      </label>
                    </>
                  )}
                </span>
              </span>
              <Select
                value={row.role}
                onValueChange={(v) => setRole(shop.id, v as ShopRoleValue)}
                disabled={disabled || !row.checked}
              >
                <SelectTrigger size="sm" className="w-28 shrink-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {/* Staff is a no-op at HQ (see `toggle` above) — disabled
                      rather than omitted, so it is still visible as a role
                      that exists, just not one HQ can use. */}
                  <SelectItem value="STAFF" disabled={shop.isHqPseudoShop}>
                    Staff
                  </SelectItem>
                  <SelectItem value="MANAGER">Manager</SelectItem>
                </SelectContent>
              </Select>
            </div>
          );
        })}
        {visible.length === 0 && (
          <p className="px-1 text-sm text-muted-foreground">
            No shops match &quot;{search}&quot;.
          </p>
        )}
      </div>
    </fieldset>
  );
}

function CreateEmployeeDialog({
  open,
  shops,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  shops: ShopOption[];
  onOpenChange: (open: boolean) => void;
  onCreated: (e: EmployeeRow) => void;
}) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [draft, setDraft] = useState<ShopRoleDraft>(() => emptyDraft(shops));
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function reset() {
    setUsername("");
    setDisplayName("");
    setPassword("");
    setDraft(emptyDraft(shops));
    setFields({});
    setError(null);
  }

  function onCancel() {
    onOpenChange(false);
    reset();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;

    setPending(true);
    setError(null);
    setFields({});

    try {
      const res = await fetch("/api/employees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          displayName,
          password,
          shopRoles: draftToShopRoles(draft),
        }),
      });

      const body = await res.json();

      if (!res.ok) {
        setFields(body?.error?.details?.fields ?? {});
        setError(body?.error?.message ?? "Could not create the account.");
        setPending(false);
        return;
      }

      toast.success(`${body.displayName} can now sign in as "${body.username}".`);
      onCreated(body as EmployeeRow);
      reset();
    } catch {
      setError("Cannot reach the server. Check the internet connection.");
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New employee</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-5">
          <div className="max-h-[70vh] space-y-5 overflow-y-auto px-1">
            <div className="grid gap-5 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="displayName">Full name</Label>
                <Input
                  id="displayName"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="e.g. Budi Santoso"
                  required
                  disabled={pending}
                />
                <FieldError message={fields.displayName} />
              </div>

              <div className="space-y-2">
                <Label htmlFor="username">Username</Label>
                <Input
                  id="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="e.g. budi"
                  required
                  disabled={pending}
                />
                <FieldError message={fields.username} />
              </div>
            </div>
            <p className="-mt-3 text-xs text-muted-foreground">
              The username is what they type to sign in. It cannot be changed
              later.
            </p>

            <div className="space-y-2">
              <Label htmlFor="password">Initial password</Label>
              <Input
                id="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="min 8 characters"
                required
                disabled={pending}
              />
              <p className="text-xs text-muted-foreground">
                Tell it to them in person. They must change it when they first
                sign in.
              </p>
              <FieldError message={fields.password} />
            </div>

            <ShopAccessFields
              shops={shops}
              draft={draft}
              setDraft={setDraft}
              disabled={pending}
            />
            <FieldError message={fields.shopRoles} />

            {error && (
              <p
                role="alert"
                className="rounded-lg bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive"
              >
                {error}
              </p>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />}
              Create account
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-sm font-medium text-destructive">{message}</p>;
}

/**
 * Edit an existing account (§7.9, D-122).
 *
 * `username` is deliberately absent — immutable after creation (D-3), because
 * it seeds the synthetic login address. `displayName` is the mutable name.
 *
 * The server enforces every rule below and is the only thing that decides;
 * this form explains them up front so the owner is not taught by a red toast:
 *
 *  - You cannot deactivate yourself or change your own shop access.
 *  - The last active owner cannot be deactivated. There is exactly one
 *    owner, fixed when the system was set up — this screen can't create or
 *    promote another.
 *  - A manager or staff member needs at least one shop.
 *  - Purchasing is a manager-only permission, set per shop.
 */
function EditEmployeeDialog({
  open,
  employee,
  shops,
  isSelf,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  employee: EmployeeRow;
  shops: ShopOption[];
  isSelf: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (e: EmployeeRow) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit {employee.displayName}</DialogTitle>
        </DialogHeader>
        {/* Remounted fresh each time the dialog opens, so its form state
            never carries over from a previous open of the same employee. */}
        {open && (
          <EditEmployeeForm
            employee={employee}
            shops={shops}
            isSelf={isSelf}
            onCancel={() => onOpenChange(false)}
            onSaved={onSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditEmployeeForm({
  employee,
  shops,
  isSelf,
  onCancel,
  onSaved,
}: {
  employee: EmployeeRow;
  shops: ShopOption[];
  isSelf: boolean;
  onCancel: () => void;
  onSaved: (e: EmployeeRow) => void;
}) {
  const [displayName, setDisplayName] = useState(employee.displayName);
  const [phone, setPhone] = useState(employee.phone ?? "");
  const [draft, setDraft] = useState<ShopRoleDraft>(() =>
    draftFromShopRoles(shops, employee.shopRoles),
  );
  const [isActive, setIsActive] = useState(employee.isActive);
  const [deactivationReason, setDeactivationReason] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const deactivating = employee.isActive && !isActive;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;

    setPending(true);
    setError(null);
    setFields({});

    try {
      const res = await fetch(`/api/employees/${employee.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName,
          phone: phone.trim() || null,
          // Sent whole: this form shows EVERY shop the employee holds,
          // including deactivated branches, so nothing can be stripped by
          // being absent from the list (D-109, extended by D-122). Owner is
          // fixed at bootstrap and never sent from here (D-1xx).
          ...(employee.isOwner ? {} : { shopRoles: draftToShopRoles(draft) }),
          isActive,
          ...(deactivating && deactivationReason.trim()
            ? { deactivationReason: deactivationReason.trim() }
            : {}),
        }),
      });

      const body = await res.json();

      if (!res.ok) {
        setFields(body?.error?.details?.fields ?? {});
        setError(body?.error?.message ?? "Could not save those changes.");
        setPending(false);
        return;
      }

      toast.success(
        deactivating
          ? `${body.displayName} can no longer sign in.`
          : `Saved ${body.displayName}`,
      );
      onSaved(body as EmployeeRow);
    } catch {
      setError("Cannot reach the server. Check the internet connection.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="max-h-[70vh] space-y-5 overflow-y-auto px-1">
      <div className="space-y-2">
        <Label htmlFor={`name-${employee.id}`}>Full name</Label>
        <Input
          id={`name-${employee.id}`}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
          disabled={pending}
        />
        <p className="text-xs text-muted-foreground">
          Their username ({employee.username}) cannot be changed.
        </p>
        <FieldError message={fields.displayName} />
      </div>

      <div className="space-y-2">
        <Label htmlFor={`phone-${employee.id}`}>Phone (optional)</Label>
        <Input
          id={`phone-${employee.id}`}
          value={phone}
          inputMode="tel"
          onChange={(e) => setPhone(e.target.value)}
          disabled={pending}
        />
        <FieldError message={fields.phone} />
      </div>

      {employee.isOwner ? (
        <div className="flex min-h-14 items-center gap-3 rounded-lg border p-4">
          <span>
            <span className="block font-medium">Owner</span>
            <span className="block text-xs text-muted-foreground">
              Sees and does everything, across every shop. There is only one
              owner account, set up when the system was installed, and it
              cannot be changed here.
            </span>
          </span>
        </div>
      ) : (
        <ShopAccessFields
          shops={shops}
          draft={draft}
          setDraft={setDraft}
          disabled={pending || isSelf}
        />
      )}
      <FieldError message={fields.shopRoles} />

      {/*
        Omitted entirely for the owner, not just disabled — `updateEmployee`
        refuses deactivating the owner unconditionally (there is exactly one,
        D-123), so this control could never be usable on this row regardless
        of who is viewing it. A checkbox nobody can ever uncheck is not a
        setting, so it does not belong here at all (owner request,
        2026-08-20) — unlike the `isSelf` case below, which is a REAL
        row-specific state the control still needs to explain.
      */}
      {!employee.isOwner && (
        <label className="flex min-h-14 cursor-pointer items-center gap-3 rounded-lg border p-4">
          <Checkbox
            checked={isActive}
            onCheckedChange={(v) => setIsActive(v === true)}
            // The server refuses self-deactivation and refuses removing the
            // last active owner. Blocking the obvious one here keeps the
            // other as the server's job.
            disabled={pending || isSelf}
          />
          <span>
            <span className="block font-medium">Can sign in</span>
            <span className="block text-xs text-muted-foreground">
              {isSelf
                ? "You cannot deactivate your own account."
                : "Turning this off signs them out everywhere immediately. Their past sales and attendance are kept."}
            </span>
          </span>
        </label>
      )}

      {deactivating && (
        <div className="space-y-2">
          <Label htmlFor={`reason-${employee.id}`}>Reason (optional)</Label>
          <Input
            id={`reason-${employee.id}`}
            value={deactivationReason}
            placeholder="Left the company"
            onChange={(e) => setDeactivationReason(e.target.value)}
            disabled={pending}
          />
          <p className="text-xs text-muted-foreground">
            Recorded in the audit log.
          </p>
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="rounded-lg bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive"
        >
          {error}
        </p>
      )}
      </div>

      <DialogFooter className="gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending && <Loader2 className="animate-spin" />}
          Save changes
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * Set a temporary password for someone who has forgotten theirs (§5.4, §7.9).
 *
 * There is no email in this system (D-1), so the owner is the reset path. The
 * new password is shown once, in person — the server forces a change on next
 * login and destroys every existing session, which is what evicts whoever
 * prompted the reset in the first place.
 */
function ResetPasswordForm({
  employee,
  onDone,
  onCancel,
}: {
  employee: EmployeeRow;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;

    setPending(true);
    setError(null);

    try {
      const res = await fetch(`/api/employees/${employee.id}/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword }),
      });

      const body = await res.json().catch(() => null);

      if (!res.ok) {
        setError(
          body?.error?.details?.fields?.newPassword ??
            body?.error?.message ??
            "Could not reset that password.",
        );
        setPending(false);
        return;
      }

      toast.success(
        `Password set. Tell ${employee.displayName} in person — they must change it when they next sign in.`,
      );
      setNewPassword("");
      onDone();
    } catch {
      setError("Cannot reach the server. Check the internet connection.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-xl border p-4">
      <div className="space-y-2">
        <Label htmlFor={`pw-${employee.id}`}>Temporary password</Label>
        <Input
          id={`pw-${employee.id}`}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoComplete="off"
          required
          disabled={pending}
        />
        <p className="text-xs text-muted-foreground">
          At least 8 characters. Tell it to {employee.displayName} in person —
          they must change it when they next sign in, and this signs them out
          everywhere now.
        </p>
      </div>

      {error && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={pending || !newPassword}>
          {pending && <Loader2 className="animate-spin" />}
          Set password
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
