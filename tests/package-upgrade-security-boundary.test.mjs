/**
 * PAWSPACE-QA-004, validated at the security boundary rather than through the UI.
 *
 * tests/package-upgrade-authority.test.mjs drives the route from a development-preview host, which
 * resolves a superuser holding "*". That proves the workflow but proves nothing about authority: the
 * caller passed every permission check by construction. These tests authenticate as the REAL roles -
 * service_provider, manager, admin - through the workspace identity path, so "a provider cannot price
 * an upgrade" is an outcome rather than an assumption.
 *
 * The defect: `package_upgrade` wrote canonical_bookings.total_amount and booking_payments.amount
 * from the request body, gated only on `communications.message`, with `providerId` supplied in the
 * body and never compared to the booking's assigned provider.
 *
 * Note for reviewers: the partner app's "Package upgraded" button is NOT in scope. It 400s today
 * because the UI never sends upgradedPackageName/upgradedAmount, and PR #177 deliberately leaves that
 * alone - making the button work is a UI decision about collecting a proposed package and amount.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

installWorkersHooks("__BOPSEC_DB__", "__BOPSEC_ENV__");

// batch() is one transaction in D1: see tests/helpers/d1.mjs. The loop this replaced committed
// each statement as it went, so any atomicity claim below was measured against the wrong machine.
const makeD1 = (sqlite, options) => createD1(sqlite, options);

const BOOKING_TOTAL = 6000;
// The security DDL and role catalogue are memoized per isolate, so the suite shares one database and
// resets the booking between tests rather than building a new one each time.
const sqlite = new DatabaseSync(":memory:");
globalThis.__BOPSEC_DB__ = makeD1(sqlite);
globalThis.__BOPSEC_ENV__ = {};

const route = await import("../app/api/booking-operations/route.ts");

sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,provider_id TEXT,service_code TEXT,package_name TEXT,status TEXT,total_amount REAL,pricing_json TEXT DEFAULT '{}',scheduled_start TEXT,updated_at INTEGER)");
sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
sqlite.exec("CREATE TABLE IF NOT EXISTS booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',occurred_at INTEGER NOT NULL)");
sqlite.exec("CREATE TABLE IF NOT EXISTS provider_identity_links (email TEXT PRIMARY KEY, provider_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', verified_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");

// One authenticated call, as a named identity, through the workspace path - NOT the preview host.
const ACTORS = {
  provider: { email: "provider@pawspace.test", role: "service_provider", providerId: "PRV-REAL" },
  otherProvider: { email: "other.provider@pawspace.test", role: "service_provider", providerId: "PRV-OTHER" },
  manager: { email: "manager@pawspace.test", role: "manager", providerId: null },
  pricing: { email: "pricing@pawspace.test", role: "admin", providerId: null },
};

const post = (actor, body) => route.POST(new Request("https://app.pawspace.test/api/booking-operations", {
  method: "POST",
  headers: { "content-type": "application/json", "oai-authenticated-user-email": actor.email },
  body: JSON.stringify(body),
}));

const money = () => ({
  total: sqlite.prepare("SELECT total_amount FROM canonical_bookings WHERE id='BK-OWNED'").get().total_amount,
  payment: sqlite.prepare("SELECT amount FROM booking_payments WHERE booking_id='BK-OWNED'").get().amount,
});
const counts = () => ({
  requests: sqlite.prepare("SELECT COUNT(*) n FROM booking_package_upgrade_requests").get().n,
  events: sqlite.prepare("SELECT COUNT(*) n FROM booking_operational_events").get().n,
});

let bootstrapped = false;

/**
 * The route authenticates before it touches the database now, so an anonymous call no longer creates
 * the tables it owns - which is the point of the second layer, and which broke the old bootstrap. Give
 * it a provisioned identity first: resolveActor's own DDL creates app_users and seeds the role
 * catalogue, so the provider below resolves to service_provider and "running late" is permitted
 * (communications.message), which is enough to reach the handler body and its CREATE TABLEs.
 */
async function bootstrap() {
  if (bootstrapped) return;
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(globalThis.__BOPSEC_DB__);
  const now = Date.now();
  for (const actor of Object.values(ACTORS)) {
    sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)").run(`U-${actor.email}`, actor.email, actor.email, actor.role, now, now);
  }
  await route.POST(new Request("https://app.pawspace.test/api/booking-operations", {
    method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-email": ACTORS.provider.email },
    body: JSON.stringify({ bookingId: "BOOTSTRAP", providerId: "PRV-REAL", action: "running_late", reason: "bootstrap only" }),
  }));
  bootstrapped = true;
}

async function reset() {
  await bootstrap();
  const now = Date.now();
  for (const table of ["canonical_bookings", "booking_payments", "booking_operational_events", "booking_lifecycle_events", "booking_customer_notifications", "booking_package_upgrade_requests", "app_users", "provider_identity_links"]) {
    sqlite.exec(`DELETE FROM ${table}`);
  }
  for (const actor of Object.values(ACTORS)) {
    sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?, 'active',?,?)").run(`U-${actor.email}`, actor.email, actor.email, actor.role, now, now);
    if (actor.providerId) sqlite.prepare("INSERT INTO provider_identity_links (email,provider_id,status,verified_at,updated_at) VALUES (?,?,'active',?,?)").run(actor.email, actor.providerId, now, now);
  }
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-OWNED','CUS-1','PRV-REAL','grooming','Standard groom','confirmed',?,'{}','2026-09-01T09:00:00.000Z',?)").run(BOOKING_TOTAL, now);
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-OTHER','CUS-2','PRV-OTHER','grooming','Standard groom','confirmed',?,'{}','2026-09-02T09:00:00.000Z',?)").run(BOOKING_TOTAL, now);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES ('PAY-1','BK-OWNED','CUS-1',?,?,'INR','card','prepaid','created','uat_sandbox','idem-1','{}',?,?)").run(BOOKING_TOTAL, BOOKING_TOTAL, now, now);
}

const requestUpgrade = (actor = ACTORS.provider, bookingId = "BK-OWNED", providerId = "PRV-REAL") => post(actor, {
  bookingId, providerId, action: "package_upgrade",
  reason: "customer approved a package upgrade during service",
  upgradedPackageName: "Premium spa", upgradedAmount: 9000,
});

test("the identity path resolves the real roles, not a preview superuser", async () => {
  await reset();
  const { defaultRoles } = await import("../lib/platform-security.ts");
  const provider = defaultRoles.find((role) => role.code === "service_provider");
  const manager = defaultRoles.find((role) => role.code === "manager");
  const admin = defaultRoles.find((role) => role.code === "admin");
  assert.ok(provider.permissions.includes("communications.message") && !provider.permissions.includes("pricing.manage"));
  assert.ok(manager.permissions.includes("bookings.manage") && !manager.permissions.includes("pricing.manage"));
  assert.ok(admin.permissions.includes("pricing.manage"), "admin is the priced-decision role in these tests");
});

test("a provider can report an upgrade on their OWN booking, and no money moves", async () => {
  await reset();
  const response = await requestUpgrade();
  const body = await response.json();

  assert.equal(response.status, 201, "the normal non-monetary workflow still succeeds");
  assert.ok(body.data.upgradeRequestId);
  assert.deepEqual(money(), { total: BOOKING_TOTAL, payment: BOOKING_TOTAL }, "reporting is not pricing");
  assert.equal(sqlite.prepare("SELECT status FROM booking_package_upgrade_requests WHERE id=?").get(body.data.upgradeRequestId).status, "pricing_approval_required");
});

test("a provider cannot report an upgrade on ANOTHER provider's booking", async () => {
  await reset();
  const before = counts();
  const response = await post(ACTORS.provider, {
    bookingId: "BK-OTHER", providerId: "PRV-OTHER", action: "package_upgrade",
    reason: "trying another provider's booking", upgradedPackageName: "Premium spa", upgradedAmount: 9000,
  });

  assert.equal(response.status, 403, "provider ownership is checked against the identity, not the body");
  assert.deepEqual(counts(), before, "a refused call writes no request and no event");
  assert.equal(sqlite.prepare("SELECT total_amount FROM canonical_bookings WHERE id='BK-OTHER'").get().total_amount, BOOKING_TOTAL);
});

test("a provider cannot spoof providerId to reach a booking assigned elsewhere", async () => {
  await reset();
  // The original exploit request: claim the booking's provider id while being someone else.
  const response = await post(ACTORS.otherProvider, {
    bookingId: "BK-OWNED", providerId: "PRV-REAL", action: "package_upgrade",
    reason: "customer agreed on site", upgradedPackageName: "Premium spa", upgradedAmount: 1,
  });

  assert.equal(response.status, 403);
  assert.deepEqual(money(), { total: BOOKING_TOTAL, payment: BOOKING_TOTAL }, "the exploit moves no money");
  assert.deepEqual(counts(), { requests: 0, events: 0 });
});

test("a provider cannot price an upgrade, even with a hand-crafted request", async () => {
  await reset();
  const requested = await (await requestUpgrade()).json();
  const before = money();

  // Straight at the money action, bypassing any UI.
  const response = await post(ACTORS.provider, {
    bookingId: "BK-OWNED", providerId: "PRV-REAL", action: "apply_package_upgrade",
    upgradeRequestId: requested.data.upgradeRequestId, reason: "pricing it myself", upgradedAmount: 1,
  });

  assert.equal(response.status, 403, "pricing.manage is required and the provider does not hold it");
  assert.deepEqual(money(), before, "an authorization failure must not change booking money");
  assert.equal(sqlite.prepare("SELECT status FROM booking_package_upgrade_requests WHERE id=?").get(requested.data.upgradeRequestId).status, "pricing_approval_required");
});

test("a manager with bookings.manage but no pricing.manage cannot price an upgrade either", async () => {
  await reset();
  const requested = await (await requestUpgrade()).json();
  const response = await post(ACTORS.manager, {
    bookingId: "BK-OWNED", providerId: "PRV-REAL", action: "apply_package_upgrade",
    upgradeRequestId: requested.data.upgradeRequestId, reason: "manager approving", upgradedAmount: 9000,
  });

  assert.equal(response.status, 403, "booking administration is not pricing authority");
  assert.deepEqual(money(), { total: BOOKING_TOTAL, payment: BOOKING_TOTAL });
});

test("a pricing.manage holder can price it, and only then does money move", async () => {
  await reset();
  const requested = await (await requestUpgrade()).json();
  const response = await post(ACTORS.pricing, {
    bookingId: "BK-OWNED", providerId: "PRV-REAL", action: "apply_package_upgrade",
    upgradeRequestId: requested.data.upgradeRequestId, reason: "priced against the premium spa card", upgradedAmount: 9000,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(money(), { total: 9000, payment: 9000 });
  const applied = sqlite.prepare("SELECT status,approved_by,requested_by FROM booking_package_upgrade_requests WHERE id=?").get(requested.data.upgradeRequestId);
  assert.equal(applied.status, "applied");
  assert.equal(applied.approved_by, ACTORS.pricing.email, "the approver is the priced-decision holder");
  assert.equal(applied.requested_by, ACTORS.provider.email, "and is not the requester");
});

test("the requester cannot price their own request, even holding pricing.manage", async () => {
  await reset();
  // The pricing holder files the request themselves, then tries to approve it.
  const requested = await (await post(ACTORS.pricing, {
    bookingId: "BK-OWNED", providerId: "PRV-REAL", action: "package_upgrade",
    reason: "recording an agreed upgrade", upgradedPackageName: "Premium spa", upgradedAmount: 9000,
  })).json();
  assert.equal(requested.data ? 201 : 0, 201, "an admin may also report an upgrade");

  const response = await post(ACTORS.pricing, {
    bookingId: "BK-OWNED", providerId: "PRV-REAL", action: "apply_package_upgrade",
    upgradeRequestId: requested.data.upgradeRequestId, reason: "approving my own request", upgradedAmount: 9000,
  });

  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /Segregation of duties/);
  assert.deepEqual(money(), { total: BOOKING_TOTAL, payment: BOOKING_TOTAL });
});

test("an approved amount below the current total is refused", async () => {
  await reset();
  const requested = await (await requestUpgrade()).json();
  for (const amount of [BOOKING_TOTAL - 1, 1, 0, -5000]) {
    const response = await post(ACTORS.pricing, {
      bookingId: "BK-OWNED", providerId: "PRV-REAL", action: "apply_package_upgrade",
      upgradeRequestId: requested.data.upgradeRequestId, reason: "attempting to lower the total", upgradedAmount: amount,
    });
    assert.ok(response.status >= 400, `${amount} must be refused`);
    assert.deepEqual(money(), { total: BOOKING_TOTAL, payment: BOOKING_TOTAL }, `${amount} must not reach the booking`);
  }
  // The floor is the current total, so exactly the total is allowed.
  assert.equal((await post(ACTORS.pricing, {
    bookingId: "BK-OWNED", providerId: "PRV-REAL", action: "apply_package_upgrade",
    upgradeRequestId: requested.data.upgradeRequestId, reason: "no price change", upgradedAmount: BOOKING_TOTAL,
  })).status, 200);
});

test("a priced upgrade cannot be priced again", async () => {
  await reset();
  const requested = await (await requestUpgrade()).json();
  const apply = (amount) => post(ACTORS.pricing, {
    bookingId: "BK-OWNED", providerId: "PRV-REAL", action: "apply_package_upgrade",
    upgradeRequestId: requested.data.upgradeRequestId, reason: "pricing decision", upgradedAmount: amount,
  });

  assert.equal((await apply(9000)).status, 200);
  const second = await apply(50000);
  assert.equal(second.status, 409, "a priced upgrade is closed");
  assert.deepEqual(money(), { total: 9000, payment: 9000 }, "and cannot be re-priced");
});

test("an unprovisioned identity is refused before anything is written", async () => {
  await reset();
  const before = { ...money(), ...counts() };
  const response = await post({ email: "stranger@pawspace.test" }, {
    bookingId: "BK-OWNED", providerId: "PRV-REAL", action: "package_upgrade",
    reason: "no account here", upgradedPackageName: "Premium spa", upgradedAmount: 9000,
  });

  assert.equal(response.status, 403);
  assert.deepEqual({ ...money(), ...counts() }, before, "a refused identity changes nothing");
});
