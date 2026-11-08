/** Dev/test DB only. Start the app on :5051 and pass the private credentials file. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/server/auth/password";
assert(/(?:_dev|_test)(?:\?|$)/.test(process.env.DATABASE_URL ?? ""), "Dev/test database required");
const db = new PrismaClient({ log: [] });
const ids: string[] = [];
const base = "http://localhost:5051";
const password = randomUUID();
class Browser {
  jar = new Map<string,string>();
  async call(path: string, body?: object, method?: string, origin = base) {
    const result = await fetch(base + path, {
      method: method ?? (body ? "POST" : "GET"), redirect: "manual",
      headers: { Origin: origin, "Content-Type": "application/json", Cookie: [...this.jar].map(([k,v]) => `${k}=${v}`).join("; ") },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    for (const value of result.headers.getSetCookie()) {
      const pair = value.split(";")[0]!; const index = pair.indexOf("=");
      if (/max-age=0/i.test(value)) this.jar.delete(pair.slice(0,index));
      else this.jar.set(pair.slice(0,index), pair.slice(index+1));
    }
    return result;
  }
}
async function user(role: "OWNER" | "MANAGER" | "STAFF", banned = false) {
  const username = `ts-${randomUUID().slice(0,8)}`;
  const u = await db.user.create({ data: { username, displayUsername: username,
    email: `${username}@marblehouse.invalid`, name: username, displayName: username,
    isOwner: role === "OWNER", banned, mustChangePassword: false,
  } });
  ids.push(u.id);
  await db.account.create({ data: { userId: u.id, providerId: "credential", accountId: u.id, password: await hashPassword(password) } });
  return u;
}
async function main() {
  const file = await readFile(process.argv[2]!, "utf8");
  const technicianPassword = file.match(/^Password: (.+)$/m)![1]!;
  const technicianUsername = file.match(/^Username: (.+)$/m)![1]!;
  const technician = await db.user.findUniqueOrThrow({ where: { username: technicianUsername } });
  assert.equal(technician.id, process.env.TECHNICIAN_USER_ID);
  const initialLogin = technician.lastLoginAt;
  const a = new Browser();
  try {
    const owner = await user("OWNER"), manager = await user("MANAGER"), staff = await user("STAFF"), banned = await user("STAFF",true);
    const shop = await db.shop.findFirstOrThrow({ where: { isActive: true, isHqPseudoShop: false } });
    for (const [person, role] of [[manager,"MANAGER"],[staff,"STAFF"]] as const) {
      await db.userShop.create({ data: { userId: person.id, shopId: shop.id, role } });
    }
    const auditScope = { userId: { in: [...ids, technician.id] } };
    const initialAudits = await db.auditLog.count({ where: auditScope });
    assert.equal((await a.call("/api/auth/login", { username: technicianUsername, password: technicianPassword })).status, 200);
    assert.equal((await a.call("/")).headers.get("location"), "/technician");
    const panel = await a.call("/technician");
    assert.equal(panel.status, 200);
    const html = await panel.text();
    for (const label of [owner.displayName, manager.displayName, staff.displayName, "Owner", "Manager", "Staff", "Sign in as"]) assert.ok(html.includes(label), label);
    assert.equal((await a.call("/api/employees")).status, 403, "support identity cannot use business APIs directly");
    assert.equal((await a.call("/api/expense-categories")).status, 403);
    assert.equal((await a.call("/api/auth/technician/start", { userId: owner.id }, "POST", "https://untrusted.invalid")).status, 403);
    assert.equal((await a.call("/api/auth/technician/start", { userId: technician.id })).status, 403);
    assert.equal((await a.call("/api/auth/technician/start", { userId: banned.id })).status, 403);
    for (const person of [owner, manager, staff]) {
      const b = new Browser();
      assert.equal((await b.call("/api/auth/login", { username: person.username, password })).status, 200);
      assert.equal((await b.call("/api/auth/technician/start", { userId: owner.id })).status, 403);
      assert.equal((await b.call("/technician")).status, 403);
      assert.equal((await a.call("/api/auth/technician/start", { userId: person.id })).status, 200);
      const me = await (await a.call("/api/auth/me")).json();
      assert.equal(me.user.id, person.id);
      assert.equal(me.user.isOwner, person.isOwner);
      if (person.isOwner) {
        const employees = await (await a.call("/api/employees")).json();
        assert.ok(!JSON.stringify(employees).includes(technician.id));
        const roster = await (await a.call(`/api/shops/${shop.id}/staff`)).json();
        assert.ok(!JSON.stringify(roster).includes(technician.id));
        assert.equal((await a.call(`/api/employees/${technician.id}`, { displayName: "changed" }, "PATCH")).status, 404);
        assert.equal((await a.call(`/api/employees/${technician.id}/reset-password`, { newPassword: password })).status, 404);
        assert.equal((await a.call(`/api/shops/${shop.id}/staff`, { userId: technician.id, assigned: true }, "PATCH")).status, 404);
      } else assert.equal((await a.call("/api/employees")).status, 403);
      assert.equal((await a.call("/api/auth/technician/start", { userId: owner.id })).status, 403, "no nesting");
      assert.equal((await a.call("/api/auth/change-password", { newPassword: password })).status, 403);
      assert.ok((await (await a.call("/select-shop")).text()).includes("Return to technician"));
      const borrowed = await db.session.findFirstOrThrow({ where: { userId: person.id, impersonatedBy: technician.id } });
      await db.session.update({ where: { id: borrowed.id }, data: { createdAt: new Date(Date.now() - 3600_001), expiresAt: new Date(Date.now()+3600_000) } });
      assert.equal((await a.call("/api/auth/me")).status, 401, "hard expiry");
      assert.equal((await a.call("/api/auth/technician/stop", {})).status, 200);
      assert.equal(await db.session.count({ where: { id: borrowed.id } }), 0);
    }
    assert.equal(await db.auditLog.count({ where: auditScope }), initialAudits, "no support activity audit entries");
    assert.deepEqual((await db.user.findUniqueOrThrow({ where: { id: technician.id } })).lastLoginAt, initialLogin);
    assert.equal((await a.call("/api/auth/admin/impersonate-user", { userId: owner.id })).status, 404);
    assert.equal((await a.call("/api/auth/technician/start", { userId: owner.id })).status, 200);
    await db.session.deleteMany({ where: { userId: technician.id } });
    assert.equal((await a.call("/api/auth/me")).status, 401, "parent revocation");
    assert.equal((await a.call("/api/auth/login", { username: technicianUsername, password: technicianPassword })).status, 200);
    assert.ok(![...a.jar.keys()].some(key => key.endsWith("technician_session")));
    assert.equal((await a.call("/api/auth/technician/start", { userId: staff.id })).status, 200);
    assert.equal((await a.call("/api/auth/logout", {})).status, 200);
    assert.ok(![...a.jar.keys()].some(key => key.endsWith("technician_session")));
    console.log("PASS: login and user/role screen; all three roles; business-user denial; hidden/protected account; CSRF; expiry/return/revocation; no support audit or last-login writes; logout cleanup");
  } finally {
    await db.session.deleteMany({ where: { OR: [{ userId: technician.id }, { impersonatedBy: technician.id }] } });
    await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await db.workSession.deleteMany({ where: { userId: { in: ids } } });
    await db.userShop.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
