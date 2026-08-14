/**
 * Staff-alert authority and resolution integrity.
 *
 * Reported by an independent review of `main`, all five confirmed in the source before being fixed:
 *
 *   1. app/api/staff-alerts/route.ts:10 gated the whole POST on `customers.manage`, so one permission
 *      carried authority over every alert type.
 *   2. `payment_failure` alerts are raised critical and owned by Finance
 *      (lib/staff-alert-center.ts:50, teamCode:"finance"), yet a Manager - who holds
 *      `customers.manage` and neither `finance.manage` nor `payments.manage` - could resolve them.
 *   3. updateStaffAlert() authorised nothing on team_code, recipient_role, recipient_email or type.
 *   4. Resolving an already-resolved alert overwrote resolved_at/resolved_by.
 *   5. The resolution event is INSERT OR IGNORE, so a second resolution rewrote the row while the
 *      event was dropped - the alert then credited one person and its audit history another.
 *
 * And one the report did not reach, because it only shows up once you read the role table: the
 * Finance role does not hold `customers.manage` (lib/platform-security.ts:26), so the same gate that
 * let Managers close Finance's alerts also refused Finance itself. The bug was not simply "too
 * permissive" - it granted the wrong team and denied the right one.
 *
 * These run the real modules against node:sqlite, so they fail if the authorisation is removed rather
 * than merely reworded.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

installWorkersHooks("__ALERT_DB__", "__ALERT_ENV__");

// batch() is one transaction in D1: see tests/helpers/d1.mjs. The loop this replaced committed
// each statement as it went, so any atomicity claim below was measured against the wrong machine.
const makeD1 = (sqlite, options) => createD1(sqlite, options);

// The real roles, read from the platform's own role table rather than invented for the test - if
// someone grants Manager `finance.manage` these fixtures change with it.
async function roles() {
  const { defaultRoles } = await import("../lib/platform-security.ts");
  const byCode = (code) => {
    const role = defaultRoles.find((entry) => entry.code === code);
    assert.ok(role, `the ${code} role exists`);
    return { email: `${code}@pawspace.test`, permissions: role.permissions };
  };
  return { manager: byCode("manager"), finance: byCode("finance"), associate: byCode("associate"), founder: byCode("founder") };
}

async function seed() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  const { ensureStaffAlertTables } = await import("../lib/staff-alert-center.ts");
  await ensureStaffAlertTables(db);
  const now = Date.now();
  const add = (id, alertType, severity, teamCode, recipientRole, recipientEmail) =>
    sqlite.prepare("INSERT INTO staff_alerts (id,idempotency_key,alert_type,severity,status,source_type,source_id,title,body,team_code,recipient_role,recipient_email,due_at,created_at,updated_at) VALUES (?,?,?,?,'open','test',?,?,?,?,?,?,?,?,?)")
      .run(id, `${id}-key`, alertType, severity, id, `${alertType} title`, "body", teamCode, recipientRole, recipientEmail, now, now, now);

  add("ALERT-PAY", "payment_failure", "critical", "finance", "manager", null);
  add("ALERT-LEAD", "lead_sla_breach", "medium", "sales", "owner", "associate@pawspace.test");
  add("ALERT-CASE", "case_manager_escalation", "high", "operations", "manager", null);
  add("ALERT-UNKNOWN", "some_future_alert_type", "high", null, "manager", null);
  globalThis.__ALERT_DB__ = db;
  globalThis.__ALERT_ENV__ = {};
  return { sqlite, db };
}

const rowOf = (sqlite, id) => sqlite.prepare("SELECT * FROM staff_alerts WHERE id=?").get(id);
const eventsOf = (sqlite, id) => sqlite.prepare("SELECT event_type,actor_id FROM staff_alert_events WHERE alert_id=? ORDER BY created_at,id").all(id);

test("a Manager cannot resolve a Finance payment-failure alert", async () => {
  const { sqlite, db } = await seed();
  const { manager } = await roles();
  const { updateStaffAlert, StaffAlertAuthorityError } = await import("../lib/staff-alert-center.ts");

  // The exact shape of the report: customers.manage, no finance.manage, no payments.manage.
  assert.ok(manager.permissions.includes("customers.manage"), "the Manager role does hold customers.manage");
  assert.ok(!manager.permissions.includes("finance.manage") && !manager.permissions.includes("payments.manage"), "and holds no Finance authority");

  await assert.rejects(
    () => updateStaffAlert(db, { alertId: "ALERT-PAY", action: "resolve", actorId: manager.email, actorPermissions: manager.permissions }),
    (error) => error instanceof StaffAlertAuthorityError && /Finance owns this alert/.test(error.message),
    "a Manager must not be able to close Finance's follow-up on real money",
  );

  // Acknowledging is the same authority: it takes the alert out of the open queue.
  await assert.rejects(
    () => updateStaffAlert(db, { alertId: "ALERT-PAY", action: "acknowledge", actorId: manager.email, actorPermissions: manager.permissions }),
    (error) => error instanceof StaffAlertAuthorityError,
  );
  assert.equal(rowOf(sqlite, "ALERT-PAY").status, "open");
});

test("an unauthorised attempt leaves the alert and the event history untouched", async () => {
  const { sqlite, db } = await seed();
  const { manager } = await roles();
  const { updateStaffAlert } = await import("../lib/staff-alert-center.ts");

  const before = rowOf(sqlite, "ALERT-PAY");
  const eventsBefore = eventsOf(sqlite, "ALERT-PAY");
  await assert.rejects(() => updateStaffAlert(db, { alertId: "ALERT-PAY", action: "resolve", actorId: manager.email, actorPermissions: manager.permissions }));

  assert.deepEqual({ ...rowOf(sqlite, "ALERT-PAY") }, { ...before }, "not one column may move on a refused attempt");
  assert.equal(rowOf(sqlite, "ALERT-PAY").resolved_by, null);
  assert.equal(rowOf(sqlite, "ALERT-PAY").resolved_at, null);
  assert.deepEqual(eventsOf(sqlite, "ALERT-PAY").map((e) => ({ ...e })), eventsBefore.map((e) => ({ ...e })), "and no event may be written");
});

test("a Finance-authorised actor can resolve it, and is recorded once", async () => {
  const { sqlite, db } = await seed();
  const { finance } = await roles();
  const { updateStaffAlert } = await import("../lib/staff-alert-center.ts");

  // The half the report did not reach: Finance holds no customers.manage, so the old endpoint gate
  // refused the very team that owns the alert.
  assert.ok(!finance.permissions.includes("customers.manage"), "Finance holds no customers.manage");

  const result = await updateStaffAlert(db, { alertId: "ALERT-PAY", action: "resolve", actorId: finance.email, actorPermissions: finance.permissions });
  assert.equal(result.status, "resolved");
  assert.equal(result.alreadyResolved, false);

  const row = rowOf(sqlite, "ALERT-PAY");
  assert.equal(row.status, "resolved");
  assert.equal(row.resolved_by, finance.email);
  assert.ok(Number(row.resolved_at) > 0, "the time of resolution is recorded");
  assert.deepEqual(eventsOf(sqlite, "ALERT-PAY").map((e) => e.event_type), ["resolve"], "exactly one resolution event");
});

test("a second resolution cannot rewrite who resolved the alert or when", async () => {
  const { sqlite, db } = await seed();
  const { finance, founder } = await roles();
  const { updateStaffAlert } = await import("../lib/staff-alert-center.ts");

  await updateStaffAlert(db, { alertId: "ALERT-PAY", action: "resolve", actorId: finance.email, actorPermissions: finance.permissions });
  const first = rowOf(sqlite, "ALERT-PAY");

  // A later actor with MORE authority than the first, so this cannot be mistaken for a permission
  // failure - resolution is write-once regardless of who arrives second.
  const second = await updateStaffAlert(db, { alertId: "ALERT-PAY", action: "resolve", actorId: founder.email, actorPermissions: founder.permissions });
  assert.equal(second.alreadyResolved, true, "the second resolve is a no-op that reports the existing record");
  assert.equal(second.resolvedBy, finance.email, "and hands back the original resolver, not the caller");

  const after = rowOf(sqlite, "ALERT-PAY");
  assert.equal(after.resolved_by, first.resolved_by, "resolved_by is immutable once set");
  assert.equal(after.resolved_at, first.resolved_at, "resolved_at is immutable once set");
});

test("the alert row and staff_alert_events always agree about the resolution", async () => {
  const { sqlite, db } = await seed();
  const { finance, founder } = await roles();
  const { updateStaffAlert } = await import("../lib/staff-alert-center.ts");

  await updateStaffAlert(db, { alertId: "ALERT-PAY", action: "resolve", actorId: finance.email, actorPermissions: finance.permissions });
  await updateStaffAlert(db, { alertId: "ALERT-PAY", action: "resolve", actorId: founder.email, actorPermissions: founder.permissions });
  await updateStaffAlert(db, { alertId: "ALERT-PAY", action: "resolve", actorId: founder.email, actorPermissions: founder.permissions });

  // The old failure exactly: the row was overwritten by the later actor while INSERT OR IGNORE
  // dropped the duplicate event, so the row credited the founder and the history credited finance.
  const resolutionEvents = eventsOf(sqlite, "ALERT-PAY").filter((event) => event.event_type === "resolve");
  assert.equal(resolutionEvents.length, 1, "one resolution, one event, however many times it is retried");
  assert.equal(resolutionEvents[0].actor_id, rowOf(sqlite, "ALERT-PAY").resolved_by, "the row and its history name the same person");
});

test("a generic customers.manage does not carry authority over every alert type", async () => {
  const { sqlite, db } = await seed();
  const { manager } = await roles();
  const { updateStaffAlert, StaffAlertAuthorityError } = await import("../lib/staff-alert-center.ts");

  // The point of the whole change: the same permission is authority for Sales and Operations alerts
  // and is not authority for Finance ones.
  const operations = await updateStaffAlert(db, { alertId: "ALERT-CASE", action: "resolve", actorId: manager.email, actorPermissions: manager.permissions });
  assert.equal(operations.status, "resolved");
  assert.equal(rowOf(sqlite, "ALERT-CASE").resolved_by, manager.email, "normal non-Finance handling still works");

  await assert.rejects(
    () => updateStaffAlert(db, { alertId: "ALERT-PAY", action: "resolve", actorId: manager.email, actorPermissions: manager.permissions }),
    (error) => error instanceof StaffAlertAuthorityError,
    "while the same actor is refused the Finance alert",
  );
});

test("an alert addressed to a named owner may be closed by that owner", async () => {
  const { sqlite, db } = await seed();
  const { associate } = await roles();
  const { updateStaffAlert } = await import("../lib/staff-alert-center.ts");

  // ALERT-LEAD is routed to associate@pawspace.test, who holds no customers.manage. Their own SLA
  // alert is their own work - refusing it would break legitimate handling to fix the Finance hole.
  assert.ok(!associate.permissions.includes("customers.manage"));
  const result = await updateStaffAlert(db, { alertId: "ALERT-LEAD", action: "acknowledge", actorId: associate.email, actorPermissions: associate.permissions });
  assert.equal(result.status, "acknowledged");
  assert.equal(rowOf(sqlite, "ALERT-LEAD").acknowledged_by, associate.email);
});

test("being addressed is not authority over a Finance alert", async () => {
  const { db } = await seed();
  const { associate } = await roles();
  const { updateStaffAlert, StaffAlertAuthorityError } = await import("../lib/staff-alert-center.ts");
  const { staffAlertAuthority } = await import("../lib/staff-alert-authority.ts");

  assert.equal(staffAlertAuthority({ alert_type: "payment_failure" }).assignedRecipientMayAct, false, "money is never closed by addressing alone");
  // Even if a payment alert were routed to them by name, it still needs Finance authority.
  await assert.rejects(
    () => updateStaffAlert(db, { alertId: "ALERT-PAY", action: "resolve", actorId: associate.email, actorPermissions: associate.permissions }),
    (error) => error instanceof StaffAlertAuthorityError,
  );
});

test("an alert type with no policy is refused rather than opened to anyone", async () => {
  const { sqlite, db } = await seed();
  const { manager, founder } = await roles();
  const { updateStaffAlert, StaffAlertAuthorityError } = await import("../lib/staff-alert-center.ts");

  // A new alert type added without a policy entry must become visibly un-actionable, not quietly
  // actionable by whoever holds a common permission. That is how the original hole was created.
  await assert.rejects(
    () => updateStaffAlert(db, { alertId: "ALERT-UNKNOWN", action: "resolve", actorId: manager.email, actorPermissions: manager.permissions }),
    (error) => error instanceof StaffAlertAuthorityError && /no configured owner/.test(error.message),
  );
  assert.equal(rowOf(sqlite, "ALERT-UNKNOWN").status, "open");

  const owner = await updateStaffAlert(db, { alertId: "ALERT-UNKNOWN", action: "resolve", actorId: founder.email, actorPermissions: founder.permissions });
  assert.equal(owner.status, "resolved", "a platform owner is never locked out of the queue");
});

test("acknowledgement is write-once and cannot reopen a resolved alert", async () => {
  const { sqlite, db } = await seed();
  const { manager } = await roles();
  const { updateStaffAlert } = await import("../lib/staff-alert-center.ts");

  const first = await updateStaffAlert(db, { alertId: "ALERT-CASE", action: "acknowledge", actorId: manager.email, actorPermissions: manager.permissions });
  assert.equal(first.acknowledgedBy, manager.email);
  const second = await updateStaffAlert(db, { alertId: "ALERT-CASE", action: "acknowledge", actorId: "someone.else@pawspace.test", actorPermissions: manager.permissions });
  assert.equal(second.acknowledgedBy, manager.email, "the first acknowledgement is the record");

  await updateStaffAlert(db, { alertId: "ALERT-CASE", action: "resolve", actorId: manager.email, actorPermissions: manager.permissions });
  await assert.rejects(
    () => updateStaffAlert(db, { alertId: "ALERT-CASE", action: "acknowledge", actorId: manager.email, actorPermissions: manager.permissions }),
    /Resolved alert cannot be acknowledged/,
  );
  assert.equal(rowOf(sqlite, "ALERT-CASE").status, "resolved");
});

test("the endpoint and the gateway agree, and a refusal is audited as denied", async () => {
  const route = await readFile(new URL("../app/api/staff-alerts/route.ts", import.meta.url), "utf8");
  const gateway = await readFile(new URL("../lib/api-gateway.ts", import.meta.url), "utf8");

  // The gateway pre-check is the other half of the fix: it gated every POST on customers.manage, so
  // Finance was refused before the route was ever reached.
  assert.match(gateway, /body\.action==="sweep"\?"customers\.manage":"reports\.view"/, "the gateway keeps sweep at manager level and lets the owning team through to the route");
  assert.match(route, /requirePermission\(actor,"customers\.manage"\)/, "sweep authority is unchanged");
  assert.match(route, /actorPermissions:actor\.permissions/, "the route hands the actor's real permissions to the per-alert policy");
  assert.match(route, /StaffAlertAuthorityError/);
  assert.match(route, /"denied"/, "a refused attempt is written to the security audit");
});
