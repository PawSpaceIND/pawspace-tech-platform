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

// ---------------------------------------------------------------------------------------------
// Concurrency, audit atomicity, and the two review findings that came with them.
// ---------------------------------------------------------------------------------------------

/** Async at every call, like the real D1 client - all the interleaving a check-then-act race needs. */
let injectFailure = null;
function makeConcurrentD1(sqlite) {
  let queue = Promise.resolve();
  function statement(sql, args) {
    const guard = () => { if (injectFailure && injectFailure.test(sql)) throw new Error(`INJECTED FAILURE: ${sql.slice(0, 40)}`); };
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { await null; guard(); const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { await null; guard(); const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => { await null; guard(); return { results: sqlite.prepare(sql).all(...args) }; },
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    // D1 runs a batch in a transaction: all statements commit, or none do. Modelling that is the whole
    // point of these tests - a non-atomic shim would leave partial writes D1 would have rolled back,
    // and every failure-injection assertion below would be judging the harness instead of the route.
    // Serialised because one sqlite connection cannot nest BEGIN; D1 gives each batch its own.
    batch: async (list) => {
      const mine = queue.then(async () => {
        sqlite.exec("BEGIN");
        try { const out = []; for (const item of list) out.push(await item.run()); sqlite.exec("COMMIT"); return out; }
        catch (error) { sqlite.exec("ROLLBACK"); throw error; }
      });
      queue = mine.catch(() => {});
      return mine;
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

async function seedConcurrent() {
  injectFailure = null;
  const { sqlite, route } = await seed();
  globalThis.__BOPS_DB__ = makeConcurrentD1(sqlite);
  sqlite.exec("CREATE TABLE IF NOT EXISTS security_audit_events (id TEXT PRIMARY KEY, actor_email TEXT NOT NULL, actor_role TEXT NOT NULL, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT, outcome TEXT NOT NULL, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL)");
  return { sqlite, route };
}

test("two simultaneous approvals: exactly one prices the upgrade", async () => {
  // The review finding: the compare-and-set was the first statement of the same batch that moved the
  // money, and nothing read its result - so the losing approval still rewrote total_amount with its own
  // figure, and the price was decided by whoever finished last.
  const { sqlite, route } = await seedConcurrent();
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
  const [a, b] = await Promise.all([apply(9000), apply(50000)]);

  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409], `exactly one approval may win, got ${JSON.stringify(statuses)}`);

  const winner = a.status === 200 ? 9000 : 50000;
  assert.deepEqual(money(sqlite), { total: winner, payment: winner }, "the booking carries the winner's figure, not the last writer's");
  const row = sqlite.prepare("SELECT status,approved_amount FROM booking_package_upgrade_requests WHERE id=?").get(requested.data.upgradeRequestId);
  assert.equal(row.status, "applied");
  assert.equal(row.approved_amount, winner, "the request and the booking agree on one price");
});

test("money and its audit record land together", async () => {
  const { sqlite, route } = await seedConcurrent();
  const requested = await (await post(route, {
    bookingId: "BK-1", providerId: "PRV-REAL", action: "package_upgrade",
    reason: "customer approved a package upgrade during service",
    upgradedPackageName: "Premium spa", upgradedAmount: 9000,
  })).json();
  sqlite.prepare("UPDATE booking_package_upgrade_requests SET requested_by='partner@pawspace.test' WHERE id=?").run(requested.data.upgradeRequestId);

  await post(route, {
    bookingId: "BK-1", providerId: "PRV-REAL", action: "apply_package_upgrade",
    upgradeRequestId: requested.data.upgradeRequestId, reason: "priced", upgradedAmount: 9000,
  });

  const audits = sqlite.prepare("SELECT action,outcome,detail_json FROM security_audit_events WHERE action='booking_operations.apply_package_upgrade'").all();
  assert.equal(audits.length, 1, "the priced decision is audited");
  assert.equal(JSON.parse(audits[0].detail_json).approvedAmount, 9000);
  assert.deepEqual(money(sqlite), { total: 9000, payment: 9000 });
  // The audit is written inside the same batch as the money, so a repriced booking can never exist
  // without the record of who repriced it.
  const src = await (await import("node:fs/promises")).readFile(new URL("../app/api/booking-operations/route.ts", import.meta.url), "utf8");
  const applyBlock = src.slice(src.indexOf('if (input.action === "apply_package_upgrade")'), src.indexOf('if (input.action === "refund_status")'));
  // Structural: the claim, the money and the audit are one batch, and every dependent statement is
  // guarded by this attempt's own claim token so a loser cannot ride the winner's claim.
  assert.match(applyBlock, /await db\.batch\(\[[\s\S]*INSERT INTO security_audit_events[\s\S]*\]\);/, "the audit insert is inside the money batch");
  assert.match(applyBlock, /UPDATE booking_package_upgrade_requests SET status='applied'[\s\S]{0,600}claim_token=\?/, "the CAS writes this attempt's claim token");
  assert.match(applyBlock, /applied\[0\]\?\.meta\?\.changes \|\| 0\) !== 1/, "and the CAS result decides the outcome");
  assert.ok(!/await securityAudit\(/.test(applyBlock), "the audit is not a separate write after the batch");
  assert.equal((applyBlock.match(/EXISTS \(SELECT 1 FROM booking_package_upgrade_requests WHERE id=\? AND claim_token=\?\)/g) || []).length >= 1, true, "dependent statements are token-guarded");
});

test("a losing approval changes no money and writes no audit", async () => {
  const { sqlite, route } = await seedConcurrent();
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
  const loser = await apply(50000);
  assert.equal(loser.status, 409);
  assert.deepEqual(money(sqlite), { total: 9000, payment: 9000 }, "the loser moved nothing");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM security_audit_events WHERE action='booking_operations.apply_package_upgrade'").get().n, 1, "one priced decision, one audit row");
});

test("the gateway and the route require the same permission for every action", async () => {
  // Review finding: the route mapped rebook_requested and refund_requested to communications.message
  // while the gateway sent them down the bookings.manage fallback, so a provider raising either from
  // the partner app was refused at the door for an action the route considered theirs.
  const { readFile } = await import("node:fs/promises");
  const route = await readFile(new URL("../app/api/booking-operations/route.ts", import.meta.url), "utf8");
  const gateway = await readFile(new URL("../lib/api-gateway.ts", import.meta.url), "utf8");

  const routeMap = Object.fromEntries([...route.matchAll(/^\s{2}(\w+): "([a-z_.]+)",$/gm)].map((m) => [m[1], m[2]]));
  const gatewayList = gateway.match(/booking-operations[\s\S]*?return \[([^\]]*)\]\.includes\(String\(body\.action\)\)\?"communications\.message"/)[1]
    .split(",").map((entry) => entry.trim().replace(/"/g, ""));

  for (const [action, permission] of Object.entries(routeMap)) {
    if (permission !== "communications.message") continue;
    assert.ok(gatewayList.includes(action), `${action} is communications.message in the route but not in the gateway list`);
  }
  for (const action of gatewayList) {
    assert.equal(routeMap[action], "communications.message", `${action} is communications.message in the gateway but ${routeMap[action]} in the route`);
  }
  assert.ok(gatewayList.includes("rebook_requested") && gatewayList.includes("refund_requested"), "both flagged actions are aligned");
});

test("a requested upgrade tells the customer nothing has changed yet", async () => {
  // The notice still said the revised scope, price and timing were visible on the booking - written
  // when package_upgrade moved the money. It records a request now, so the customer was being told
  // about a price change that had not happened.
  const { sqlite, route } = await seedConcurrent();
  await post(route, {
    bookingId: "BK-1", providerId: "PRV-REAL", action: "package_upgrade",
    reason: "customer approved a package upgrade during service",
    upgradedPackageName: "Premium spa", upgradedAmount: 9000,
  });
  const pending = sqlite.prepare("SELECT message FROM booking_customer_notifications WHERE booking_id='BK-1' ORDER BY created_at").all().map((row) => row.message);
  assert.ok(pending.every((message) => /awaiting confirmation|has been requested/i.test(message)), `pending notice must not claim a change: ${JSON.stringify(pending)}`);
  assert.ok(pending.every((message) => !/revised service scope, price and timing are visible/i.test(message)));
  assert.deepEqual(money(sqlite), { total: BOOKING_TOTAL, payment: BOOKING_TOTAL }, "and indeed nothing changed");
});

// ---------------------------------------------------------------------------------------------
// Failure injection. `applied` must mean the financial application committed - not merely that an
// approver won the claim. Independent QA proved the previous shape left the request reading
// `applied / Rs 9,000` while the booking stayed at Rs 6,000, with no audit and no way to retry.
// ---------------------------------------------------------------------------------------------

const PENDING = "pricing_approval_required";
const upgradeRow = (sqlite) => sqlite.prepare("SELECT status,approved_by,approved_amount,claim_token FROM booking_package_upgrade_requests WHERE booking_id='BK-1'").get();
const sideEffects = (sqlite) => ({
  audits: sqlite.prepare("SELECT COUNT(*) n FROM security_audit_events WHERE action='booking_operations.apply_package_upgrade'").get().n,
  appliedEvents: sqlite.prepare("SELECT COUNT(*) n FROM booking_operational_events WHERE booking_id='BK-1' AND event_type='package_upgrade.applied'").get().n,
  confirmations: sqlite.prepare("SELECT COUNT(*) n FROM booking_customer_notifications WHERE booking_id='BK-1' AND template_code='package_upgrade.applied'").get().n,
});

async function pendingUpgrade() {
  const { sqlite, route } = await seedConcurrent();
  const requested = await (await post(route, {
    bookingId: "BK-1", providerId: "PRV-REAL", action: "package_upgrade",
    reason: "customer approved a package upgrade during service",
    upgradedPackageName: "Premium spa", upgradedAmount: 9000,
  })).json();
  sqlite.prepare("UPDATE booking_package_upgrade_requests SET requested_by='partner@pawspace.test' WHERE id=?").run(requested.data.upgradeRequestId);
  const applyAs = (amount) => post(route, {
    bookingId: "BK-1", providerId: "PRV-REAL", action: "apply_package_upgrade",
    upgradeRequestId: requested.data.upgradeRequestId, reason: "pricing decision", upgradedAmount: amount,
  });
  return { sqlite, route, id: requested.data.upgradeRequestId, applyAs };
}

test("B: a money-statement failure leaves the request retryable and the money untouched", async () => {
  const { sqlite, applyAs } = await pendingUpgrade();
  injectFailure = /UPDATE booking_payments SET amount=/;
  let response;
  try { response = await applyAs(9000); } catch { response = { status: "THREW" }; }
  injectFailure = null;

  assert.equal(response.status, 500, "the caller is told it failed");
  assert.deepEqual(money(sqlite), { total: BOOKING_TOTAL, payment: BOOKING_TOTAL }, "no money moved");
  assert.deepEqual(sideEffects(sqlite), { audits: 0, appliedEvents: 0, confirmations: 0 }, "and nothing was left behind");
  const row = upgradeRow(sqlite);
  assert.equal(row.status, PENDING, "the request reverted to pending rather than claiming an approval that never applied");
  assert.equal(row.approved_by, null);
  assert.equal(row.approved_amount, null);

  // The point of the whole change: a legitimate approval can still land afterwards.
  const retry = await applyAs(9000);
  assert.equal(retry.status, 200, "a subsequent approval retries successfully");
  assert.deepEqual(money(sqlite), { total: 9000, payment: 9000 });
  assert.deepEqual(sideEffects(sqlite), { audits: 1, appliedEvents: 1, confirmations: 1 });
  assert.equal(upgradeRow(sqlite).status, "applied");
});

test("C: an audit-insert failure leaves the request retryable and the money untouched", async () => {
  const { sqlite, applyAs } = await pendingUpgrade();
  injectFailure = /INSERT INTO security_audit_events/;
  let response;
  try { response = await applyAs(9000); } catch { response = { status: "THREW" }; }
  injectFailure = null;

  assert.equal(response.status, 500);
  assert.deepEqual(money(sqlite), { total: BOOKING_TOTAL, payment: BOOKING_TOTAL }, "money never moves without its audit");
  assert.deepEqual(sideEffects(sqlite), { audits: 0, appliedEvents: 0, confirmations: 0 });
  assert.equal(upgradeRow(sqlite).status, PENDING, "no applied state");

  const retry = await applyAs(9000);
  assert.equal(retry.status, 200, "and the approval retries successfully");
  assert.deepEqual(money(sqlite), { total: 9000, payment: 9000 });
  assert.equal(sideEffects(sqlite).audits, 1);
});

test("A: the winner's claim token is what authorises the money, so a loser writes nothing", async () => {
  const { sqlite, applyAs } = await pendingUpgrade();
  const [a, b] = await Promise.all([applyAs(9000), applyAs(50000)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);

  const winner = a.status === 200 ? 9000 : 50000;
  const loser = a.status === 200 ? 50000 : 9000;
  const row = upgradeRow(sqlite);
  assert.equal(row.status, "applied");
  assert.equal(row.approved_amount, winner);
  assert.ok(row.claim_token, "the winning attempt stamped its claim token");
  assert.deepEqual(money(sqlite), { total: winner, payment: winner });
  assert.deepEqual(sideEffects(sqlite), { audits: 1, appliedEvents: 1, confirmations: 1 }, "exactly one of everything");

  const everything = JSON.stringify([
    sqlite.prepare("SELECT * FROM canonical_bookings WHERE id='BK-1'").all(),
    sqlite.prepare("SELECT * FROM booking_payments WHERE booking_id='BK-1'").all(),
    sqlite.prepare("SELECT * FROM booking_package_upgrade_requests WHERE booking_id='BK-1'").all(),
    sqlite.prepare("SELECT * FROM security_audit_events").all(),
    sqlite.prepare("SELECT * FROM booking_operational_events WHERE booking_id='BK-1'").all(),
    sqlite.prepare("SELECT * FROM booking_customer_notifications WHERE booking_id='BK-1'").all(),
  ]);
  assert.ok(!everything.includes(String(loser)), `the losing amount ${loser} must appear nowhere`);
});
