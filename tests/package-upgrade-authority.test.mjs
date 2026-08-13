/**
 * A provider could set any booking's price to any number.
 *
 * /api/booking-operations `package_upgrade` wrote canonical_bookings.total_amount and
 * booking_payments.amount straight from `upgradedAmount` in the request body. The gateway gated that
 * action on `communications.message` - a messaging permission that the service_provider and associate
 * roles both hold - and the route performed no authorization or ownership check of its own, while
 * `providerId` also arrived in the body and was never compared to the booking's assigned provider.
 *
 * Reproduced on main: a caller sending providerId "PRV-SOMEONE-ELSE" against a booking assigned to
 * "PRV-REAL" got HTTP 201, total_amount 6000 -> 1 and booking_payments.amount 6000 -> 1. A second
 * call with -5000 was also accepted, because validation only tested falsiness.
 *
 * The fix splits the action: reporting an agreed upgrade records a request and moves no money;
 * pricing it is `apply_package_upgrade`, which needs pricing.manage, refuses the requester, and
 * refuses to lower a total. These execute the real route against node:sqlite.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__BOPS_DB__", "__BOPS_ENV__");

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const BOOKING_TOTAL = 6000;

async function seed() {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__BOPS_DB__ = makeD1(sqlite);
  globalThis.__BOPS_ENV__ = {};
  const route = await import("../app/api/booking-operations/route.ts");
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,provider_id TEXT,service_code TEXT,package_name TEXT,status TEXT,total_amount REAL,pricing_json TEXT DEFAULT '{}',scheduled_start TEXT,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',occurred_at INTEGER NOT NULL)");
  const now = Date.now();
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-1','CUS-1','PRV-REAL','grooming','Standard groom','confirmed',?,'{}','2026-09-01T09:00:00.000Z',?)").run(BOOKING_TOTAL, now);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES ('PAY-1','BK-1','CUS-1',?,?,'INR','card','prepaid','created','uat_sandbox','idem-1','{}',?,?)").run(BOOKING_TOTAL, BOOKING_TOTAL, now, now);
  return { sqlite, route };
}

// The development-preview host resolves a superuser actor, which is how the other route suites drive
// an authorized caller. Preview holds "*", so it passes every permission check.
const post = (route, body) => route.POST(new Request("http://localhost/api/booking-operations", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}));

const money = (sqlite) => ({
  total: sqlite.prepare("SELECT total_amount FROM canonical_bookings WHERE id='BK-1'").get().total_amount,
  payment: sqlite.prepare("SELECT amount FROM booking_payments WHERE booking_id='BK-1'").get().amount,
});

test("reporting an agreed upgrade records a request and moves no money", async () => {
  const { sqlite, route } = await seed();
  const response = await post(route, {
    bookingId: "BK-1", providerId: "PRV-REAL", action: "package_upgrade",
    reason: "customer approved a package upgrade during service",
    upgradedPackageName: "Premium spa", upgradedAmount: 9000,
  });
  const body = await response.json();

  assert.equal(response.status, 201, "the provider workflow still works");
  assert.ok(body.data.upgradeRequestId, "and produces a request to price");
  assert.deepEqual(money(sqlite), { total: BOOKING_TOTAL, payment: BOOKING_TOTAL }, "but the price does not move on the provider's say-so");

  const request = sqlite.prepare("SELECT status,requested_amount,previous_amount FROM booking_package_upgrade_requests WHERE booking_id='BK-1'").get();
  assert.equal(request.status, "pricing_approval_required");
  assert.equal(request.requested_amount, 9000, "the proposed figure is recorded as a proposal");
  assert.equal(request.previous_amount, BOOKING_TOTAL);
});

test("a caller cannot act for a provider the booking is not assigned to", async () => {
  const { sqlite, route } = await seed();
  // The exact exploit request from the report: providerId is body-supplied and was never checked.
  const response = await post(route, {
    bookingId: "BK-1", providerId: "PRV-SOMEONE-ELSE", action: "package_upgrade",
    reason: "customer agreed on site", upgradedPackageName: "Premium spa", upgradedAmount: 1,
  });

  assert.equal(response.status, 403);
  assert.deepEqual(money(sqlite), { total: BOOKING_TOTAL, payment: BOOKING_TOTAL }, "a refused call moves nothing");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM booking_package_upgrade_requests").get().n, 0, "and records nothing");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM booking_operational_events").get().n, 0);
});

test("pricing an upgrade applies the approved figure and names who approved it", async () => {
  const { sqlite, route } = await seed();
  const requested = await (await post(route, {
    bookingId: "BK-1", providerId: "PRV-REAL", action: "package_upgrade",
    reason: "customer approved a package upgrade during service",
    upgradedPackageName: "Premium spa", upgradedAmount: 9000,
  })).json();
  // Segregation of duties: the preview actor filed the request, so a different actor must price it.
  sqlite.prepare("UPDATE booking_package_upgrade_requests SET requested_by='partner@pawspace.test' WHERE id=?").run(requested.data.upgradeRequestId);

  const response = await post(route, {
    bookingId: "BK-1", providerId: "PRV-REAL", action: "apply_package_upgrade",
    upgradeRequestId: requested.data.upgradeRequestId, reason: "priced against the premium spa card", upgradedAmount: 9000,
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(money(sqlite), { total: 9000, payment: 9000 }, "the priced decision is what moves the money");
  assert.equal(body.data.previousAmount, BOOKING_TOTAL);
  const applied = sqlite.prepare("SELECT status,approved_by,approved_amount FROM booking_package_upgrade_requests WHERE id=?").get(requested.data.upgradeRequestId);
  assert.equal(applied.status, "applied");
  assert.equal(applied.approved_amount, 9000);
  assert.ok(applied.approved_by, "the approver is recorded, not just the requester");
});

test("a package upgrade can never reduce what the customer owes", async () => {
  const { sqlite, route } = await seed();
  const requested = await (await post(route, {
    bookingId: "BK-1", providerId: "PRV-REAL", action: "package_upgrade",
    reason: "customer approved a package upgrade during service",
    upgradedPackageName: "Premium spa", upgradedAmount: 9000,
  })).json();
  sqlite.prepare("UPDATE booking_package_upgrade_requests SET requested_by='partner@pawspace.test' WHERE id=?").run(requested.data.upgradeRequestId);

  for (const amount of [1, -5000, 0]) {
    const response = await post(route, {
      bookingId: "BK-1", providerId: "PRV-REAL", action: "apply_package_upgrade",
      upgradeRequestId: requested.data.upgradeRequestId, reason: "attempting to lower the total", upgradedAmount: amount,
    });
    assert.ok(response.status >= 400, `an upgrade to ${amount} must be refused`);
    assert.deepEqual(money(sqlite), { total: BOOKING_TOTAL, payment: BOOKING_TOTAL }, `${amount} must not reach the booking`);
  }
});

test("the requester cannot price their own upgrade", async () => {
  const { sqlite, route } = await seed();
  const requested = await (await post(route, {
    bookingId: "BK-1", providerId: "PRV-REAL", action: "package_upgrade",
    reason: "customer approved a package upgrade during service",
    upgradedPackageName: "Premium spa", upgradedAmount: 9000,
  })).json();
  // requested_by is left as the caller who filed it, so the same actor applying it is self-approval.
  const response = await post(route, {
    bookingId: "BK-1", providerId: "PRV-REAL", action: "apply_package_upgrade",
    upgradeRequestId: requested.data.upgradeRequestId, reason: "approving my own request", upgradedAmount: 9000,
  });

  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /Segregation of duties/);
  assert.deepEqual(money(sqlite), { total: BOOKING_TOTAL, payment: BOOKING_TOTAL });
});

test("an upgrade cannot be priced twice", async () => {
  const { sqlite, route } = await seed();
  const requested = await (await post(route, {
    bookingId: "BK-1", providerId: "PRV-REAL", action: "package_upgrade",
    reason: "customer approved a package upgrade during service",
    upgradedPackageName: "Premium spa", upgradedAmount: 9000,
  })).json();
  sqlite.prepare("UPDATE booking_package_upgrade_requests SET requested_by='partner@pawspace.test' WHERE id=?").run(requested.data.upgradeRequestId);
  const apply = (amount) => post(route, {
    bookingId: "BK-1", providerId: "PRV-REAL", action: "apply_package_upgrade",
    upgradeRequestId: requested.data.upgradeRequestId, reason: "pricing decision", upgradedAmount: amount,
  });

  assert.equal((await apply(9000)).status, 200);
  const second = await apply(50000);
  assert.equal(second.status, 409, "a priced upgrade is closed");
  assert.deepEqual(money(sqlite), { total: 9000, payment: 9000 }, "and cannot be re-priced to something else");
});

test("the route and the gateway agree on which permission each action needs", async () => {
  const { readFile } = await import("node:fs/promises");
  const route = await readFile(new URL("../app/api/booking-operations/route.ts", import.meta.url), "utf8");
  const gateway = await readFile(new URL("../lib/api-gateway.ts", import.meta.url), "utf8");

  // The route authorises itself: the gateway alone was the whole gate, and it mapped a money write to
  // a messaging permission.
  assert.match(route, /requirePermission\(actor, REQUIRED_PERMISSION\[input\.action\]\)/);
  assert.match(route, /apply_package_upgrade: "pricing\.manage"/);
  assert.match(route, /package_upgrade: "communications\.message"/);
  assert.match(route, /requireProviderOwnership\(db, actor, input\.providerId\)/);
  assert.match(gateway, /body\.action==="apply_package_upgrade"\)return "pricing\.manage"/);

  // And the money write lives only in the priced branch.
  const reportBranch = route.slice(route.indexOf('if (input.action === "package_upgrade") {'));
  assert.ok(!/UPDATE canonical_bookings SET package_name=\?,total_amount=\?[\s\S]{0,400}input\.upgradedAmount/.test(reportBranch), "reporting an upgrade must not write a price");
});

test("the roles that hold the reporting permission cannot price an upgrade", async () => {
  const { defaultRoles } = await import("../lib/platform-security.ts");
  for (const code of ["service_provider", "associate"]) {
    const role = defaultRoles.find((entry) => entry.code === code);
    assert.ok(role.permissions.includes("communications.message"), `${code} may still report an upgrade`);
    assert.ok(!role.permissions.includes("pricing.manage"), `${code} must not be able to price one`);
  }
  // Manager holds customers.manage and bookings.manage but not pricing.manage - a price is a pricing
  // decision, not a booking-admin one.
  const manager = defaultRoles.find((entry) => entry.code === "manager");
  assert.ok(!manager.permissions.includes("pricing.manage"));
});
