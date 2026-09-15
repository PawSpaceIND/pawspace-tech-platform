/*
 * R3-G / F3: every manager on this deployment was locked out of CRM, People and the Booking
 * Command Center.
 *
 * lib/organizational-scope.ts threw 403 "Manager organizational scope is not fully provisioned"
 * unless the manager's email matched an active employees row joined to a CURRENT
 * employee_employment_versions row carrying location + team + cost centre. Nothing creates that
 * record for a manager: app/api/platform-governance's create_user - the product's own user
 * management - writes app_users only, and org placement is People's data. So the outcome of
 * "create a manager in user management, then sign in as them" was three hard 403s.
 *
 * These tests execute the real routes against a real SQLite engine. They assert the OUTCOME the
 * operator sees - the manager's screens load - and, in the same breath, that the degradation did
 * not buy that by widening what a manager can see: another city's leads, another team's staff and
 * another city's bookings all stay invisible, and a manager WITH a placement is still confined to
 * their own domain.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world } from "./helpers/execution-harness.mjs";

installWorkersHooks("__R3G_SCOPE_DB__", "__R3G_SCOPE_ENV__");

const ORIGIN = "https://app.pawspace.in";
const ADMIN_EMAIL = "r3g.useradmin@pawspace.test";
const NEW_MANAGER = "r3g.newmanager@pawspace.test";
const PLACED_MANAGER = "r3g.placedmanager@pawspace.test";

const governance = await import("../app/api/platform-governance/route.ts");
const scopeLib = await import("../lib/organizational-scope.ts");

async function seed() {
  const { sqlite, db } = world("__R3G_SCOPE_DB__", "__R3G_SCOPE_ENV__");
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  const { ensurePeopleTables } = await import("../lib/people-foundation.ts");
  await ensureSecurityTables(db);
  await ensurePeopleTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?, 'active',?,?)")
    .run("U-R3G-ADMIN", ADMIN_EMAIL, "R3G User Admin", "admin", now, now);
  return { sqlite, db, now };
}

/** The product's own user-management call: this is how a manager account is actually created. */
const createManagerThroughUserManagement = (email, name) => governance.POST(new Request(`${ORIGIN}/api/platform-governance`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: ORIGIN, "oai-authenticated-user-email": ADMIN_EMAIL },
  body: JSON.stringify({ action: "create_user", email, name, roleCode: "manager" }),
}));

const asManager = (path, email) => new Request(`${ORIGIN}${path}`, { method: "GET", headers: { "oai-authenticated-user-email": email } });

/** Give PLACED_MANAGER a real CRM placement in Hyderabad, the way People would. */
function placeManager(sqlite, now) {
  sqlite.prepare("INSERT INTO employees (id,user_email,employee_code,display_name,work_email,phone,employment_status,joined_at,created_at,updated_at) VALUES (?,?,?,?,?,?, 'active',?,?,?)")
    .run("EMP-R3G-PLACED", PLACED_MANAGER, "EMP-R3G-1", "Placed Manager", PLACED_MANAGER, "9000000001", now - 86400000, now, now);
  sqlite.prepare("INSERT INTO employee_employment_versions (id,employee_id,version,effective_from,effective_until,employment_type,probation_status,title,team_code,manager_employee_id,cost_centre_code,location_code,reason,actor_id,created_at) VALUES (?,?,1,?,NULL,'full_time','confirmed','Sales Manager','sales',NULL,'CC-SALES','HYD','Placed by People',?,?)")
    .run("EEV-R3G-PLACED", "EMP-R3G-PLACED", now - 86400000, "test", now);
}

test("F3: a manager created through user management can open CRM, People and the Booking Command Center", async () => {
  const { sqlite, db, now } = await seed();

  const created = await createManagerThroughUserManagement(NEW_MANAGER, "R3G New Manager");
  assert.equal(created.status, 200, `create_user must succeed: ${await created.clone().text()}`);
  assert.equal(sqlite.prepare("SELECT role_code FROM app_users WHERE email=?").get(NEW_MANAGER)?.role_code, "manager");
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) c FROM employees WHERE lower(COALESCE(user_email,work_email))=?").get(NEW_MANAGER).c, 0,
    "premise of the defect: user management creates no employment record, so the manager has no placement",
  );

  const crm = await import("../app/api/crm/route.ts");
  const people = await import("../app/api/people-foundation/route.ts");
  const command = await import("../app/api/booking-command-center/route.ts");

  for (const [label, response] of [
    ["/api/crm", await crm.GET(asManager("/api/crm", NEW_MANAGER))],
    ["/api/people-foundation", await people.GET(asManager("/api/people-foundation", NEW_MANAGER))],
    ["/api/booking-command-center", await command.GET(asManager("/api/booking-command-center", NEW_MANAGER))],
  ]) {
    const body = await response.text();
    assert.equal(response.status, 200, `${label} must load for a manager, got ${response.status} ${body.slice(0, 200)}`);
    assert.ok(!/Manager organizational scope is not fully provisioned["']?\s*}/.test(body), `${label} must not answer with the bare refusal`);
  }
  assert.ok(db);
  assert.ok(now);
});

test("F3: the unprovisioned manager sees unassigned work only - never another city, team or cost centre", async () => {
  const { sqlite, now } = await seed();
  await createManagerThroughUserManagement(NEW_MANAGER, "R3G New Manager");

  const crm = await import("../app/api/crm/route.ts");
  // ensureTables() is the route's own; run it once so the columns exist before we seed rows.
  await crm.GET(asManager("/api/crm", NEW_MANAGER));

  const insert = sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,secondary_phone,email,area,pet_names,pet_summary,stage,owner,source,lifetime_value,next_action,opportunity,city_id,team_code,department_code,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'New lead','Unassigned','Test',0,'Call','Discover',?,?,?,?,?)");
  insert.run("CU-OTHERCITY", "Hyderabad Only Lead", "+919000000011", null, null, "Hyderabad", "Pet", "", "hyd", "sales", "cc-sales", now, now);
  insert.run("CU-UNCLAIMED", "Unclaimed Whatsapp Lead", "+919000000012", null, null, "Bangalore", "Pet", "", null, null, null, now, now);

  const body = await (await crm.GET(asManager("/api/crm", NEW_MANAGER))).text();
  assert.ok(!body.includes("CU-OTHERCITY"), "a lead placed in another city/team/cost centre must stay invisible");
  assert.ok(!body.includes("Hyderabad Only Lead"), "…and so must its customer name, anywhere in the payload");
  assert.ok(body.includes("CU-UNCLAIMED"), "the work nobody has been placed over is what an unplaced manager gets");

  // People: an employee placed in another org must not appear.
  sqlite.prepare("INSERT INTO employees (id,user_email,employee_code,display_name,work_email,phone,employment_status,joined_at,created_at,updated_at) VALUES (?,?,?,?,?,?, 'active',?,?,?)")
    .run("EMP-R3G-OTHER", "r3g.other@pawspace.test", "EMP-R3G-OTHER", "Other Org Employee", "r3g.other@pawspace.test", "9000000002", now - 86400000, now, now);
  sqlite.prepare("INSERT INTO employee_employment_versions (id,employee_id,version,effective_from,effective_until,employment_type,probation_status,title,team_code,manager_employee_id,cost_centre_code,location_code,reason,actor_id,created_at) VALUES (?,?,1,?,NULL,'full_time','confirmed','Ops','operations',NULL,'CC-OPERATIONS','HYD','seed',?,?)")
    .run("EEV-R3G-OTHER", "EMP-R3G-OTHER", now - 86400000, "test", now);
  const people = await import("../app/api/people-foundation/route.ts");
  const peopleBody = await (await people.GET(asManager("/api/people-foundation", NEW_MANAGER))).text();
  assert.ok(!peopleBody.includes("Other Org Employee"), "People must not widen to another city/team for an unplaced manager");

  // Bookings: a real booking in a real city must not appear for a manager with no city.
  const command = await import("../app/api/booking-command-center/route.ts");
  await command.GET(asManager("/api/booking-command-center", NEW_MANAGER));
  const start = new Date(now + 86400000).toISOString(), end = new Date(now + 90000000).toISOString();
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("CUS-R3G", "blr", "Bengaluru Booking Customer", "+919000000013", null, null, "test", "{}", now, now);
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("BK-R3G", "IDEM-R3G", "CUS-R3G", "[]", "[]", "blr", "blr-east", "grooming", "g-basic", "Basic", "GRP-R3G", "PRO-R3G", start, end, "confirmed", "customer_app", 1200, "INR", "{}", "test", now, now);
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,occurrence_count,status,assignment_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("WO-R3G", "BK-R3G", "GRP-R3G", "PRO-R3G", "Provider R3G", "commission", "grooming", start, end, 1, "assigned", "{}", now, now);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("PAY-R3G", "BK-R3G", "CUS-R3G", 1200, 1200, "INR", "card", "prepaid", "captured", "sandbox", "PAYIDEM-R3G", "{}", now, now);

  const commandResponse = await command.GET(asManager("/api/booking-command-center", NEW_MANAGER));
  assert.equal(commandResponse.status, 200);
  const commandBody = await commandResponse.text();
  assert.ok(!commandBody.includes("BK-R3G"), "a booking in a real city must not reach a manager with no city scope");
  assert.ok(!commandBody.includes("Bengaluru Booking Customer"));
});

test("F3: the refusal is replaced by an explicit notice, not by a silently empty screen", async () => {
  const { sqlite } = await seed();
  await createManagerThroughUserManagement(NEW_MANAGER, "R3G New Manager");
  const people = await import("../app/api/people-foundation/route.ts");
  const payload = await (await people.GET(asManager("/api/people-foundation", NEW_MANAGER))).json();
  assert.equal(payload.organizationalScope.unprovisioned, true, "the scope must say it is unprovisioned, machine-readably");
  assert.match(payload.organizationalScope.notice, /not fully provisioned/i);
  assert.match(payload.organizationalScope.notice, /People/, "the notice must name where the missing record is recorded");
  assert.ok(sqlite);
});

test("F3 must not have widened the scope: a placed manager is still confined to their own org and domain", async () => {
  const { sqlite, db, now } = await seed();
  placeManager(sqlite, now);

  const resolved = await scopeLib.resolveManagerOrganizationalScope(db, {
    email: PLACED_MANAGER, name: "Placed", roleCode: "manager", permissions: ["customers.view"],
    developmentPreview: false, identitySource: "workspace", principalType: "email", principalKey: PLACED_MANAGER,
  });
  assert.deepEqual({ ...resolved }, { employeeId: "EMP-R3G-PLACED", cityId: "hyd", teamCode: "sales", departmentCode: "cc-sales" },
    "a provisioned manager still resolves to exactly their recorded placement");
  assert.equal(resolved.unprovisioned, undefined, "a real placement is never flagged unprovisioned");

  // A sales/CRM manager still has no business in the operations domain.
  assert.throws(() => scopeLib.requireManagerDomain(resolved, scopeLib.OPERATIONS_MANAGER_DOMAIN),
    (thrown) => thrown instanceof Response && thrown.status === 403,
    "the domain check must still refuse a CRM manager at the Booking Command Center");

  const command = await import("../app/api/booking-command-center/route.ts");
  const denied = await command.GET(asManager("/api/booking-command-center", PLACED_MANAGER));
  assert.equal(denied.status, 403, "and the route must still return that refusal");
});

test("F3: an unprovisioned manager never resolves to null - null means unrestricted", async () => {
  const { db } = await seed();
  const resolved = await scopeLib.resolveManagerOrganizationalScope(db, {
    email: NEW_MANAGER, name: "New", roleCode: "manager", permissions: ["customers.view"],
    developmentPreview: false, identitySource: "workspace", principalType: "email", principalKey: NEW_MANAGER,
  });
  assert.notEqual(resolved, null, "null would switch the domain and data filters off entirely");
  assert.equal(resolved.unprovisioned, true);
  assert.deepEqual([resolved.cityId, resolved.teamCode, resolved.departmentCode], ["", "", ""],
    "the degraded scope must match nothing that carries a placement");
});
