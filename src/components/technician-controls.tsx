"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

type SupportUser = {
  id: string; username: string | null; displayName: string; isOwner: boolean; banned: boolean | null;
  userShops: { role: string; shop: { name: string } }[];
};
async function action(path: string, body: object = {}) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? data.error?.message ?? "Could not complete this action.");
  window.location.assign(data.landingPath ?? "/login");
}
export function TechnicianPanel({ users }: { users: SupportUser[] }) {
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  async function start(user: SupportUser) {
    setPending(user.id);
    try { await action("/api/auth/technician/start", { userId: user.id }); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Could not start session."); setPending(null); }
  }
  const filtered = users.filter(user => `${user.displayName} ${user.username} ${user.isOwner ? "owner" : user.userShops.map(s => `${s.role} ${s.shop.name}`).join(" ")}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="space-y-6">
    <div className="flex items-center justify-between gap-4"><div><h1 className="text-2xl font-bold">Technician</h1><p className="text-sm text-muted-foreground">Choose a user to troubleshoot with their permissions.</p></div><Button variant="outline" onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.assign("/login"); }}>Sign out</Button></div>
    <Input aria-label="Search users" placeholder="Search users, roles or shops" value={query} onChange={event => setQuery(event.target.value)} />
    <ul className="divide-y rounded-xl border">{filtered.map(user => <li key={user.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
      <div className="min-w-0"><p className="font-medium">{user.displayName} <span className="font-normal text-muted-foreground">@{user.username}</span></p><p className="text-sm text-muted-foreground">{user.isOwner ? "Owner · All shops" : user.userShops.map(s => `${s.shop.name}: ${s.role === "MANAGER" ? "Manager" : "Staff"}`).join(" · ") || "No shops assigned"}{user.banned && " · Deactivated"}</p></div>
      <Button disabled={Boolean(user.banned) || pending !== null} onClick={() => start(user)}>{pending === user.id ? "Opening…" : "Sign in as"}</Button>
    </li>)}</ul>{filtered.length === 0 && <p className="text-sm text-muted-foreground">No users match your search.</p>}
  </div>;
}
export function TechnicianReturnBanner({ name }: { name: string }) {
  const [pending, setPending] = useState(false);
  async function stop() {
    setPending(true);
    try { await action("/api/auth/technician/stop"); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Sign in to your technician account again."); setPending(false); }
  }
  return <aside role="status" className="flex flex-wrap items-center justify-center gap-3 border-b bg-amber-100 px-4 py-3 text-sm text-amber-950"><span>Support session: {name}. Changes affect real records.</span><Button variant="outline" size="sm" disabled={pending} onClick={stop}>{pending ? "Returning…" : "Return to technician"}</Button><Button variant="outline" size="sm" onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.assign("/login"); }}>Sign out</Button></aside>;
}
