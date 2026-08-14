/**
 * Journey D needs the two REAL Tester-3 provider personas bound to two distinct provider profiles.
 *
 * Asha (EMP001) and Rahul (EMP002) authenticate correctly on staging as service_provider - that was
 * never the problem. Neither had a provider_identity_links row, so ownProviderId() resolved null and
 * every provider-owned lifecycle read answered 403 "No active provider identity is linked to this
 * session". The refusal is right (an unbound identity IS no provider); the fixture was incomplete.
 *
 * One binding would not be enough either. To prove a provider cannot touch another provider's work you
 * need a second bound provider to be refused, so a fixture with one binding can only test the happy
 * path.
 *
 * WHY groom_arun AND groom_kiran, and why NOT by name. There is no name linkage between the staff
 * directory and the capacity roster: the roster is a separate synthetic identity space ("Arun R.",
 * "Kiran S."), and `employees` carries no provider column. Matching on first name would pick the wrong
 * profiles outright - the only "Asha" on the roster is sit_asha/walk_asha and the only "Rahul" is
 * taxi_rahul, so it would bind two groomers to sitting, walking and taxi profiles. The criterion that
 * actually exists is service + city + roster ownership, and the tests below assert it directly rather
 * than trusting the mapping.
 *
 * Everything drives the REAL /api/partner-job-feed handler against the REAL seed files, loaded in the
 * same order .github/workflows/seed-staging.yml loads them. Asserting on generator source text would
 * have proved neither the binding nor the refusal.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

installWorkersHooks("__PPB_DB__", "__PPB_ENV__");

const HOST = "https://pawspace-staging.example.dev";
// The identities Tester 3 actually signs in as. Both come from scripts/employee-seed.sql.
const PROVIDER_A = "asha.groomer1@tkpetcare.in";
const PROVIDER_B = "rahul.groomer2@tkpetcare.in";
const PROVIDER_A_PROFILE = "groom_arun";
const PROVIDER_B_PROFILE = "groom_kiran";

const EMPLOYEE_SEED = readFileSync("scripts/employee-seed.sql", "utf8");
const DEMO_SEED = readFileSync("scripts/uat-demo-seed.sql", "utf8");

/** The tables the employee/payroll/finance pack owns. Nothing in the demo pack may disturb these. */
const PEOPLE_AND_MONEY_TABLES = [
  "employees", "employee_compensation_assignments", "employee_payroll_results",
  "payroll_runs", "payroll_result_lines", "payslips", "salary_structure_versions",
  "finance_entities", "finance_invoices", "finance_invoice_lines",
  "groomer_incentive_brackets", "groomer_monthly_targets",
  "sales_employee_base", "sales_attributed_bookings",
  "tax_classifications", "tax_policy_versions", "tax_registrations",
];

let sqlite;

/** Stand up staging's load order: security DDL, staff directory, then the module-demo pack. */
async function seeded({ stopAfterEmployees = false } = {}) {
  sqlite = new DatabaseSync(":memory:");
  const db = createD1(sqlite);
  globalThis.__PPB_DB__ = db;
  globalThis.__PPB_ENV__ = { FOUNDER_EMAIL: "founder@pawspace.test" };

  // The role catalogue first: the seeds give each identity a role_code, and resolveActor reads the
  // permissions for that code out of role_definitions.
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  sqlite.exec(EMPLOYEE_SEED);
  if (stopAfterEmployees) return db;
  sqlite.exec(DEMO_SEED);
  // The capacity roster is NOT in any seed file - the product seeds it at runtime - so the fixture has
  // to stand it up the same way the Worker does, or "is this binding pointed at a real provider?"
  // cannot be asked at all.
  const { seedProviderCapacityDefaults } = await import("../lib/provider-capacity-governance.ts");
  await seedProviderCapacityDefaults(db);
  return db;
}

async function feed(email, query = "") {
  const route = await import("../app/api/partner-job-feed/route.ts");
  const response = await route.GET(new Request(`${HOST}/api/partner-job-feed${query}`, {
    headers: { "oai-authenticated-user-email": email },
  }));
  const text = await response.text();
  let body; try { body = JSON.parse(text); } catch { body = { error: text }; }
  return { status: response.status, body };
}

const boundProfile = (email) => {
  const row = sqlite.prepare("SELECT provider_id,status FROM provider_identity_links WHERE email=?").get(email);
  return row ? { providerId: String(row.provider_id), status: String(row.status) } : null;
};

// ---------------------------------------------------------------------------
// 1 + 2: each persona resolves to its intended profile, and they are different
// ---------------------------------------------------------------------------
test("Provider A resolves to groom_arun and Provider B to a different profile, groom_kiran", async () => {
  await seeded();

  const a = boundProfile(PROVIDER_A), b = boundProfile(PROVIDER_B);
  assert.ok(a, `${PROVIDER_A} has no provider binding — Journey D cannot start`);
  assert.ok(b, `${PROVIDER_B} has no provider binding — the cross-provider case cannot be tested`);
  assert.equal(a.providerId, PROVIDER_A_PROFILE);
  assert.equal(b.providerId, PROVIDER_B_PROFILE);
  assert.equal(a.status, "active");
  assert.equal(b.status, "active");
  assert.notEqual(a.providerId, b.providerId, "both personas point at one profile, so there is no cross-provider case");
});

test("both bound profiles are legitimate: same service, same city, live, and owning real work", async () => {
  await seeded();
  // The mapping was proposed, not proven. This is the check that makes it earned rather than assumed -
  // and it is the check that would have caught a name-based mapping, because sit_asha and taxi_rahul
  // fail the service test outright.
  for (const email of [PROVIDER_A, PROVIDER_B]) {
    // Read the profile the SEED actually binds, not the constant we expect it to be. Validating the
    // constant would pass even if the seed bound something else entirely, which is precisely the
    // failure mode being guarded against.
    const bound = boundProfile(email);
    assert.ok(bound, `${email} has no binding to validate`);
    const providerId = bound.providerId;
    const row = sqlite.prepare("SELECT id,city_id,services_json,zones_json,live,status FROM provider_capacity_profiles WHERE id=?").get(providerId);
    assert.ok(row, `${email} is bound to ${providerId}, which is not on the capacity roster at all`);
    assert.equal(String(row.status), "active", `${providerId} is not active`);
    assert.equal(Number(row.live), 1, `${providerId} is not live`);
    assert.equal(String(row.city_id), "blr", `${providerId} is not in the launched city these personas work in`);
    assert.ok(JSON.parse(String(row.services_json)).includes("grooming"),
      `${email} is a groomer but ${providerId} does not provide grooming (services: ${row.services_json}). A name-based mapping lands exactly here.`);

    // Bound to a profile with no work = a runnable login and an empty screen. Journey D needs both
    // halves: something to progress, and someone else's work to be refused.
    const bookings = sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings WHERE provider_id=? AND service_code='grooming'").get(providerId);
    assert.ok(Number(bookings.n) > 0, `${email} is bound to ${providerId}, which owns no seeded grooming booking to act on`);

    // And the login must already exist in the staff directory - we must not have minted a duplicate.
    const users = sqlite.prepare("SELECT id,role_code,status FROM app_users WHERE email=?").all(email);
    assert.equal(users.length, 1, `${email} has ${users.length} app_users rows; exactly one, from employee-seed.sql, is correct`);
    assert.equal(String(users[0].role_code), "service_provider");
    assert.equal(String(users[0].status), "active");
    assert.match(String(users[0].id), /^SEEDUSR-EMP/, `${email} resolves to ${users[0].id}, which is not the employee-seed row — a duplicate identity was created`);
  }
});

// ---------------------------------------------------------------------------
// 3 + 4: own-provider access succeeds for both
// ---------------------------------------------------------------------------
test("Provider A own-provider access succeeds", async () => {
  await seeded();
  // No providerId in the query: this is the exact call Journey D makes, and the exact 403 Tester 3 got.
  const own = await feed(PROVIDER_A);
  assert.equal(own.status, 200, `Provider A could not read their own feed: ${JSON.stringify(own.body)}`);
  assert.ok(own.body.data, "Provider A got no feed payload");
  assert.doesNotMatch(String(own.body.error ?? ""), /No active provider identity/);

  // Naming their own profile explicitly must also pass, or the refusal below would be about the
  // parameter rather than about ownership.
  const named = await feed(PROVIDER_A, `?providerId=${PROVIDER_A_PROFILE}`);
  assert.equal(named.status, 200, `Provider A was refused their own profile id: ${JSON.stringify(named.body)}`);
});

test("Provider B own-provider access succeeds", async () => {
  await seeded();
  const own = await feed(PROVIDER_B);
  assert.equal(own.status, 200, `Provider B could not read their own feed: ${JSON.stringify(own.body)}`);
  assert.ok(own.body.data, "Provider B got no feed payload");
  assert.doesNotMatch(String(own.body.error ?? ""), /No active provider identity/);

  const named = await feed(PROVIDER_B, `?providerId=${PROVIDER_B_PROFILE}`);
  assert.equal(named.status, 200, `Provider B was refused their own profile id: ${JSON.stringify(named.body)}`);
});

// ---------------------------------------------------------------------------
// 5 + 6: neither can read the other's protected provider data
// ---------------------------------------------------------------------------
test("Provider A cannot read Provider B's protected provider data", async () => {
  await seeded();
  const crossed = await feed(PROVIDER_A, `?providerId=${PROVIDER_B_PROFILE}`);
  assert.equal(crossed.status, 403, `Provider A read Provider B's feed: ${JSON.stringify(crossed.body)}`);
  assert.match(String(crossed.body.error), /ownership denied/i);
  assert.ok(!crossed.body.data, "a refused cross-provider read still returned provider data");
});

test("Provider B cannot read Provider A's protected provider data", async () => {
  await seeded();
  const crossed = await feed(PROVIDER_B, `?providerId=${PROVIDER_A_PROFILE}`);
  assert.equal(crossed.status, 403, `Provider B read Provider A's feed: ${JSON.stringify(crossed.body)}`);
  assert.match(String(crossed.body.error), /ownership denied/i);
  assert.ok(!crossed.body.data, "a refused cross-provider read still returned provider data");
});

test("the refusal is ownership, not a missing permission — service_provider holds no bypass", async () => {
  await seeded();
  // If service_provider held providers.manage / grooming.manage / bookings.manage, requireProviderOwnership
  // would short-circuit and the two 403s above would be vacuous. Pinning it means a later permission
  // widening cannot silently turn this suite green-but-meaningless.
  const { defaultRoles } = await import("../lib/platform-security.ts");
  const role = defaultRoles.find((r) => r.code === "service_provider");
  assert.ok(role, "the service_provider role has been removed or renamed");
  for (const bypass of ["providers.manage", "grooming.manage", "bookings.manage", "*"]) {
    assert.ok(!role.permissions.includes(bypass),
      `service_provider now holds ${bypass}, which short-circuits requireProviderOwnership and makes the cross-provider tests vacuous`);
  }
  assert.ok(role.permissions.includes("bookings.view"), "service_provider lost bookings.view; the feed reads above would fail for the wrong reason");
});

// ---------------------------------------------------------------------------
// 7: no payroll / finance / employee record is touched
// ---------------------------------------------------------------------------
test("the demo pack modifies no payroll, finance or employee record from the staff directory", async () => {
  // "Changed" has to mean UPDATE or DELETE, not "the table grew". The demo pack has always carried
  // four UATD-* demo employees with their own payroll run - that predates this work and is the point
  // of the pack. What must never happen is a real staff row being rewritten underneath the finance
  // screens, and what must never happen HERE is this alignment adding anything at all.
  await seeded({ stopAfterEmployees: true });
  const before = {};
  for (const table of PEOPLE_AND_MONEY_TABLES) {
    before[table] = sqlite.prepare(`SELECT * FROM ${table}`).all().map((r) => JSON.stringify(r));
  }
  assert.ok(before.employees.length > 0, "the staff directory seeded no employees; this test would be vacuous");
  assert.ok(before.payslips.length > 0, "the staff directory seeded no payslips; this test would be vacuous");

  sqlite.exec(DEMO_SEED);

  for (const table of PEOPLE_AND_MONEY_TABLES) {
    const after = new Set(sqlite.prepare(`SELECT * FROM ${table}`).all().map((r) => JSON.stringify(r)));
    // Every staff-directory row survives byte-identical: nothing updated, nothing deleted.
    for (const row of before[table]) {
      assert.ok(after.has(row), `the demo pack modified or removed a ${table} row from the staff directory:\n${row}`);
    }
    // And anything the demo pack added is its own demo record, never a real staff or payroll one.
    const added = [...after].filter((row) => !before[table].includes(row));
    for (const row of added) {
      assert.match(row, /UATD-/, `the demo pack added a non-demo ${table} row, which this alignment must not do:\n${row}`);
    }
  }

  // Specifically: binding a persona to a provider profile gives them no second employment record,
  // no extra payslip and no extra payroll result. Compared against the counts taken BEFORE the demo
  // pack loaded, so this measures the change rather than restating the current state.
  for (const email of [PROVIDER_A, PROVIDER_B]) {
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM employees WHERE user_email=?").get(email).n, 1,
      `${email} does not have exactly one employees row`);
    const employeeId = String(sqlite.prepare("SELECT id FROM employees WHERE user_email=?").get(email).id);
    for (const [table, rows] of [["payslips", before.payslips], ["employee_payroll_results", before.employee_payroll_results]]) {
      const priorCount = rows.filter((row) => JSON.parse(row).employee_id === employeeId).length;
      const nowCount = Number(sqlite.prepare(`SELECT COUNT(*) n FROM ${table} WHERE employee_id=?`).get(employeeId).n);
      assert.equal(nowCount, priorCount, `${email} gained ${nowCount - priorCount} ${table} row(s) from the demo pack`);
    }
  }
});

// ---------------------------------------------------------------------------
// 8: the seed delta is the minimum intended one
// ---------------------------------------------------------------------------
test("the demo pack adds exactly two provider bindings and no new provider identity", async () => {
  // Read against the generated SQL, because that is the artefact applied to staging.
  const bindingLines = DEMO_SEED.split("\n").filter((line) => line.startsWith("INSERT") && line.includes("provider_identity_links"));
  assert.equal(bindingLines.length, 3, `expected 3 provider bindings (1 pre-existing demo + 2 personas), found ${bindingLines.length}:\n${bindingLines.join("\n")}`);

  await seeded();
  const links = sqlite.prepare("SELECT email,provider_id FROM provider_identity_links ORDER BY email").all()
    .map((r) => `${r.email} -> ${r.provider_id}`);
  assert.deepEqual(links, [
    `${PROVIDER_A} -> ${PROVIDER_A_PROFILE}`,
    `${PROVIDER_B} -> ${PROVIDER_B_PROFILE}`,
    // Pre-existing, predates this work, and still used by the partner-workspace demo. Kept
    // deliberately: it is legal for two logins to resolve to one profile (email is the primary key,
    // provider_id is not unique), and it does not weaken the cross-provider tests, which run
    // Asha against Rahul.
    "uat.demo.groomer@tkpetcare.in -> groom_arun",
  ], "the binding set is not the intended minimum");

  // The scaffolding identity introduced in the previous commit existed only to stand in for a real
  // second persona. It has no independent release need and must be gone.
  assert.ok(!DEMO_SEED.includes("uat.demo.groomer2@tkpetcare.in"),
    "the placeholder uat.demo.groomer2 identity is still in the seed");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM app_users WHERE email LIKE 'uat.demo.groomer2%'").get().n, 0);

  // No app_users row is minted by the demo pack for either persona - they must come from the staff
  // directory, or staging ends up with two identities that both claim to be Asha.
  const demoAppUserLines = DEMO_SEED.split("\n").filter((line) => line.startsWith("INSERT") && line.includes("INTO app_users"));
  for (const email of [PROVIDER_A, PROVIDER_B]) {
    const duplicate = demoAppUserLines.filter((line) => line.includes(email));
    assert.deepEqual(duplicate, [], `the demo pack creates an app_users row for ${email}; employee-seed.sql already owns it`);
  }
});
