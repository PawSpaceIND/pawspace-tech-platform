import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

// ===========================================================================
// PHASE 2 — FINDING D1 (P2, borderline P1). Ops-dashboard authorization sweep.
//
// Nine org-wide Operations GET reads were gated at `bookings.view`, a permission held by the field
// `service_provider` ("sees assigned jobs only") and by `associate`. That let either read org-wide
// operational data (taxi-ops alone joins unmasked customer names, pickup/drop-off addresses and
// financials). The remediation raises each GET to `bookings.manage` at the gateway, matching the
// already-fixed booking-command-center / canonical-bookings.
//
// This suite drives the REAL gateway (authorizeApiRequest) with REAL seeded roles, on a NON-localhost
// host (https://app.pawspace.in/...). A localhost host short-circuits the gateway to a dev-preview
// superuser (api-gateway.ts) and would pass every check for the wrong reason.
// ===========================================================================
installWorkersHooks("__CC_DB__", "__CC_ENV__");

function makeD1(sqlite) {
  // Uses the transactional D1 shim (BEGIN/COMMIT/ROLLBACK) from helpers/d1.mjs so a
  // failing batch() rolls back, exactly as Cloudflare D1 does.
  return createD1(sqlite);
}

// The nine org-wide Operations GET reads swept by D1 (api-gateway.ts).
const OPS_ROUTES = [
  "/api/taxi-ops",
  "/api/walking-ops",
  "/api/sitting-ops",
  "/api/boarding-ops",
  "/api/food-ops",
  "/api/food-supply-chain",
  "/api/ops-work-queue",
  "/api/unified-cases",
  "/api/training-ops",
];

const EMAIL = {
  service_provider: "provider@pawspace.in",
  associate: "associate@pawspace.in",
  manager: "manager@pawspace.in",
  admin: "admin@pawspace.in",
  founder: "founder@pawspace.in",
};

async function seed() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__CC_DB__ = db;
  // PAWSPACE_UAT_LOGIN unset on purpose: the header identity path must be what authenticates here.
  globalThis.__CC_ENV__ = { FOUNDER_EMAIL: "" };

  sqlite.exec("CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,role_code TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS role_definitions (code TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,permissions_json TEXT NOT NULL,system_role INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0)");

  const { defaultRoles } = await import("../lib/platform-security.ts");
  const now = Date.now();
  for (const role of defaultRoles) {
    sqlite.prepare("INSERT INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES (?,?,?,?,?,?)")
      .run(role.code, role.name, role.description, JSON.stringify(role.permissions), 1, now);
  }
  const users = [
    ["u-sp", EMAIL.service_provider, "Field Provider", "service_provider"],
    ["u-assoc", EMAIL.associate, "Associate", "associate"],
    ["u-mgr", EMAIL.manager, "Ops Manager", "manager"],
    ["u-admin", EMAIL.admin, "Admin", "admin"],
    ["u-founder", EMAIL.founder, "Founder", "founder"],
  ];
  for (const [id, email, name, role] of users) {
    sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id, email, name, role, "active", now, now);
  }
  return { sqlite, db };
}

const asRole = (url, email) => new Request(url, { headers: { "oai-authenticated-user-email": email } });

async function gateway(url, email) {
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  return authorizeApiRequest(asRole(url, email), { DB: globalThis.__CC_DB__, FOUNDER_EMAIL: "" });
}

// ---------------------------------------------------------------------------
// DENIED: the two low roles that hold only bookings.view are now refused every org-wide ops read.
// ---------------------------------------------------------------------------
for (const path of OPS_ROUTES) {
  const url = `https://app.pawspace.in${path}`;

  test(`D1 DENY — service_provider is refused GET ${path} (403, lacks bookings.manage)`, async () => {
    await seed();
    const resolved = await gateway(url, EMAIL.service_provider);
    assert.ok(resolved instanceof Response, `service_provider must be REFUSED a Response for ${path}, not granted the read`);
    assert.equal(resolved.status, 403, `service_provider denied 403 at the gateway for ${path}`);
  });

  test(`D1 DENY — associate is refused GET ${path} (403, lacks bookings.manage)`, async () => {
    await seed();
    const resolved = await gateway(url, EMAIL.associate);
    assert.ok(resolved instanceof Response, `associate must be REFUSED for ${path}`);
    assert.equal(resolved.status, 403, `associate denied 403 at the gateway for ${path}`);
  });

  test(`D1 ALLOW — a manager holding bookings.manage is granted GET ${path} and resolves bookings.manage`, async () => {
    await seed();
    const resolved = await gateway(url, EMAIL.manager);
    assert.ok(!(resolved instanceof Response), `manager unexpectedly refused for ${path}: ${resolved instanceof Response ? await resolved.text() : ""}`);
    assert.equal(resolved.permission, "bookings.manage", `${path} GET now resolves to bookings.manage`);
    assert.equal(resolved.actor.roleCode, "manager");
  });

  test(`D1 ALLOW — admin and founder (authorized staff) are still granted GET ${path}`, async () => {
    await seed();
    for (const role of ["admin", "founder"]) {
      const resolved = await gateway(url, EMAIL[role]);
      assert.ok(!(resolved instanceof Response), `${role} unexpectedly refused for ${path}`);
      assert.equal(resolved.permission, "bookings.manage");
    }
  });
}

// ---------------------------------------------------------------------------
// The permission gap that makes the deny real: manager/admin hold BOTH bookings.view and
// bookings.manage, so raising the gateway (and any handler self-check) to bookings.manage never breaks
// them; service_provider/associate hold only bookings.view, which is exactly why they are now denied.
// ---------------------------------------------------------------------------
test("D1 PERMISSIONS: manager and admin hold BOTH bookings.view and bookings.manage; sp/associate hold only view", async () => {
  const { defaultRoles } = await import("../lib/platform-security.ts");
  const find = (code) => defaultRoles.find((r) => r.code === code).permissions;
  for (const staff of ["manager", "admin"]) {
    assert.ok(find(staff).includes("bookings.view"), `${staff} holds bookings.view`);
    assert.ok(find(staff).includes("bookings.manage"), `${staff} holds bookings.manage — so no handler self-check on bookings.view can break it`);
  }
  for (const low of ["service_provider", "associate"]) {
    assert.ok(find(low).includes("bookings.view"), `${low} holds bookings.view`);
    assert.ok(!find(low).includes("bookings.manage"), `${low} must NOT hold bookings.manage — that gap is what denies it the org-wide ops reads`);
  }
});
