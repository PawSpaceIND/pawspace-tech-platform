import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ===========================================================================
// PHASE 2 — FINDINGS D3 & D4. Formerly-public unauthenticated writes.
//
// D3 /api/training-requirements: POST/PATCH wrote to the DB with NO auth and a hardcoded
//    updated_by='founder_uat'. GET (catalog read) stays public; writes now require pricing.manage and
//    stamp the real caller identity.
// D4 /api/host-trust: POST (review submission + action:"seed") wrote with NO auth and client-controlled
//    fields. GET stays public; POST now requires providers.manage, and the synthetic seed fixture is
//    additionally fail-closed behind PAWSPACE_UAT_LOGIN==="on" so it can never run in production.
//
// Real handlers, real resolveActor, on a NON-localhost host (https://app.pawspace.in/...): a localhost
// host would short-circuit resolveActor to a dev-preview superuser and pass for the wrong reason.
// ===========================================================================
installWorkersHooks("__CC_DB__", "__CC_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const EMAIL = {
  associate: "associate@pawspace.in",   // authenticated but holds neither pricing.manage nor providers.manage
  manager: "manager@pawspace.in",       // holds providers.manage, NOT pricing.manage
  admin: "admin@pawspace.in",           // holds both pricing.manage and providers.manage
};

async function seed() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__CC_DB__ = db;
  // PAWSPACE_UAT_LOGIN unset by default: header identity is what authenticates, and the seed fixture is
  // fail-closed. Individual tests flip PAWSPACE_UAT_LOGIN="on" where they need staging seeding.
  globalThis.__CC_ENV__ = { FOUNDER_EMAIL: "" };

  sqlite.exec("CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,role_code TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS role_definitions (code TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,permissions_json TEXT NOT NULL,system_role INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0)");
  // Pre-create the write targets empty so "no persisted row" is directly observable.
  sqlite.exec("CREATE TABLE IF NOT EXISTS training_requirements (id TEXT PRIMARY KEY NOT NULL,label TEXT NOT NULL UNIQUE,sort_order INTEGER NOT NULL,active INTEGER DEFAULT 1 NOT NULL,version INTEGER DEFAULT 1 NOT NULL,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS host_reviews (id TEXT PRIMARY KEY, host_provider_id TEXT NOT NULL, customer_id TEXT NOT NULL, booking_id TEXT NOT NULL UNIQUE, service_code TEXT NOT NULL, rating INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL)");

  const { defaultRoles } = await import("../lib/platform-security.ts");
  const now = Date.now();
  for (const role of defaultRoles) {
    sqlite.prepare("INSERT INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES (?,?,?,?,?,?)")
      .run(role.code, role.name, role.description, JSON.stringify(role.permissions), 1, now);
  }
  const users = [
    ["u-assoc", EMAIL.associate, "Associate", "associate"],
    ["u-mgr", EMAIL.manager, "Ops Manager", "manager"],
    ["u-admin", EMAIL.admin, "Admin", "admin"],
  ];
  for (const [id, email, name, role] of users) {
    sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id, email, name, role, "active", now, now);
  }
  return { sqlite, db };
}

const anon = (url, method, body) => new Request(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const asStaff = (url, method, email, body) => new Request(url, { method, headers: { "content-type": "application/json", "oai-authenticated-user-email": email }, body: body === undefined ? undefined : JSON.stringify(body) });

const trLabelCount = (sqlite, label) => Number(sqlite.prepare("SELECT COUNT(*) c FROM training_requirements WHERE label=?").get(label).c);
const hostReviewCount = (sqlite) => Number(sqlite.prepare("SELECT COUNT(*) c FROM host_reviews").get().c);

// ===========================================================================
// D3 — training-requirements writes.
// ===========================================================================
const TR_URL = "https://app.pawspace.in/api/training-requirements";

test("D3 DENY — anonymous POST to training-requirements is refused (401) and persists NO row", async () => {
  const { sqlite } = await seed();
  const { POST } = await import("../app/api/training-requirements/route.ts");
  const label = "Anon injected requirement";
  const res = await POST(anon(TR_URL, "POST", { label }));
  assert.ok([401, 403].includes(res.status), `anonymous POST must be denied, got ${res.status}`);
  assert.equal(trLabelCount(sqlite, label), 0, "no training_requirements row may be persisted by an anonymous caller");
});

test("D3 DENY — anonymous PATCH to training-requirements is refused (401) and changes nothing", async () => {
  const { sqlite } = await seed();
  sqlite.prepare("INSERT INTO training_requirements (id,label,sort_order,active,version,updated_by,updated_at) VALUES (?,?,?,?,?,?,?)").run("tr-x", "Recall", 1, 1, 1, "founder_seed", Date.now());
  const { PATCH } = await import("../app/api/training-requirements/route.ts");
  const res = await PATCH(anon(TR_URL, "PATCH", { id: "tr-x", label: "Hijacked label" }));
  assert.ok([401, 403].includes(res.status), `anonymous PATCH must be denied, got ${res.status}`);
  const row = sqlite.prepare("SELECT label,version,updated_by FROM training_requirements WHERE id=?").get("tr-x");
  assert.equal(row.label, "Recall", "label must be unchanged");
  assert.equal(row.version, 1, "version must not bump");
  assert.equal(row.updated_by, "founder_seed", "updated_by must not change");
});

test("D3 DENY — an authenticated staff member WITHOUT pricing.manage (manager) is refused POST (403)", async () => {
  const { sqlite } = await seed();
  const { POST } = await import("../app/api/training-requirements/route.ts");
  const label = "Manager tried this";
  const res = await POST(asStaff(TR_URL, "POST", EMAIL.manager, { label }));
  assert.equal(res.status, 403, "a manager lacks pricing.manage and must be refused");
  assert.equal(trLabelCount(sqlite, label), 0, "no row persisted for an under-privileged staff member");
});

test("D3 ALLOW — an authorized staff member (admin, holds pricing.manage) POSTs and the row is stamped with THEIR identity", async () => {
  const { sqlite } = await seed();
  const { POST } = await import("../app/api/training-requirements/route.ts");
  const label = "Crate training";
  const res = await POST(asStaff(TR_URL, "POST", EMAIL.admin, { label }));
  assert.equal(res.status, 201, `admin with pricing.manage must succeed, got ${res.status}`);
  const row = sqlite.prepare("SELECT label,updated_by FROM training_requirements WHERE label=?").get(label);
  assert.ok(row, "the requirement row is persisted");
  assert.equal(row.updated_by, EMAIL.admin, "updated_by is the server-derived staff identity, NOT the hardcoded 'founder_uat'");
  assert.notEqual(row.updated_by, "founder_uat");
});

// ===========================================================================
// D4 — host-trust writes.
// ===========================================================================
const HT_URL = "https://app.pawspace.in/api/host-trust";

test("D4 public read — anonymous GET host-trust is NOT gated by auth (reaches the handler's own 400)", async () => {
  await seed();
  const { GET } = await import("../app/api/host-trust/route.ts");
  const res = await GET(anon(HT_URL, "GET"));
  assert.notEqual(res.status, 401, "GET is a public catalog read and must not require a session");
  assert.equal(res.status, 400, "the handler's own missing-hostProviderId validation runs, proving it is reachable unauthenticated");
});

test("D4 DENY — anonymous POST review to host-trust is refused (401) and persists NO review", async () => {
  const { sqlite } = await seed();
  const { POST } = await import("../app/api/host-trust/route.ts");
  const res = await POST(anon(HT_URL, "POST", { hostProviderId: "h1", customerId: "c1", bookingId: "b1", rating: 5, title: "Injected", body: "Injected review body content" }));
  assert.ok([401, 403].includes(res.status), `anonymous review POST must be denied, got ${res.status}`);
  assert.equal(hostReviewCount(sqlite), 0, "no host_reviews row may be persisted anonymously");
});

test("D4 DENY — anonymous POST action:seed is refused (401) and seeds NO rows", async () => {
  const { sqlite } = await seed();
  globalThis.__CC_ENV__.PAWSPACE_UAT_LOGIN = "on"; // even with the switch on, anonymity alone must block seeding
  const { POST } = await import("../app/api/host-trust/route.ts");
  const res = await POST(anon(HT_URL, "POST", { action: "seed" }));
  assert.ok([401, 403].includes(res.status), `anonymous seed must be denied, got ${res.status}`);
  assert.equal(hostReviewCount(sqlite), 0, "no synthetic seed rows may be created anonymously");
});

test("D4 DENY — an authenticated staff member WITHOUT providers.manage (associate) is refused seed (403)", async () => {
  const { sqlite } = await seed();
  globalThis.__CC_ENV__.PAWSPACE_UAT_LOGIN = "on";
  const { POST } = await import("../app/api/host-trust/route.ts");
  const res = await POST(asStaff(HT_URL, "POST", EMAIL.associate, { action: "seed" }));
  assert.equal(res.status, 403, "associate lacks providers.manage and must be refused");
  assert.equal(hostReviewCount(sqlite), 0, "no seed rows for an under-privileged staff member");
});

test("D4 DENY — authorized staff (providers.manage) is STILL refused seed when PAWSPACE_UAT_LOGIN is off (fail-closed)", async () => {
  const { sqlite } = await seed();
  // PAWSPACE_UAT_LOGIN left unset — production-like. Seeding must be impossible even for authorized staff.
  const { POST } = await import("../app/api/host-trust/route.ts");
  const res = await POST(asStaff(HT_URL, "POST", EMAIL.admin, { action: "seed" }));
  assert.equal(res.status, 403, "the synthetic seed fixture is fail-closed off the UAT switch, even for authorized staff");
  assert.equal(hostReviewCount(sqlite), 0, "no seed rows created when the UAT switch is off");
});

test("D4 ALLOW — authorized staff (admin, providers.manage) seeds ONLY with PAWSPACE_UAT_LOGIN='on'", async () => {
  const { sqlite } = await seed();
  globalThis.__CC_ENV__.PAWSPACE_UAT_LOGIN = "on";
  const { POST } = await import("../app/api/host-trust/route.ts");
  const res = await POST(asStaff(HT_URL, "POST", EMAIL.admin, { action: "seed" }));
  assert.equal(res.status, 200, `authorized staff on UAT must be able to seed, got ${res.status}`);
  assert.ok(hostReviewCount(sqlite) > 0, "the synthetic host reviews are persisted");
});
