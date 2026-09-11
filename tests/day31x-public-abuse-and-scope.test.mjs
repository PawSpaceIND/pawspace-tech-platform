/*
 * Day-31 wave 10: two security controls that had no test importing them.
 *
 *   lib/public-abuse-gate.ts      - the only volume control on UNAUTHENTICATED writes
 *   lib/organizational-scope.ts   - what a manager is allowed to see
 *
 * Both share a property worth stating plainly: they fail by NOT APPLYING. A rate limit that lets
 * an unattributable caller through, or a domain scope that silently does not engage, produces no
 * error and no log line - the system simply stops defending itself while continuing to look
 * exactly as it did before.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world } from "./helpers/execution-harness.mjs";

installWorkersHooks("__D31X_SEC_DB__", "__D31X_SEC_ENV__");

const gate = await import("../lib/public-abuse-gate.ts");
const scope = await import("../lib/organizational-scope.ts");

const TABLE = "d31_rate_limits";
const fromIp = (ip) => new Request("https://app.pawspace.in/api/public-contact", {
  method: "POST", headers: ip ? { "cf-connecting-ip": ip } : {},
});

const seedGate = () => world("__D31X_SEC_DB__", "__D31X_SEC_ENV__");

/*
 * authFailure() throws a Response, not an Error, so a regex matcher silently fails to match and
 * assert.throws reports "did not throw" for a refusal that DID happen. Assert on the status.
 */
const refusal = (status = 403) => (thrown) => {
  assert.ok(thrown instanceof Response, `expected a governed Response refusal, got ${thrown}`);
  assert.equal(thrown.status, status);
  return true;
};
const attempt = (db, request, now, table = TABLE) =>
  gate.withinPublicRateLimit(db, request, { table, now });

test("exactly the limit is allowed, and the next attempt is not", async () => {
  const { db } = seedGate();
  const now = Date.now();
  const request = fromIp("203.0.113.10");
  for (let i = 1; i <= gate.PUBLIC_RATE_LIMIT; i++) {
    assert.equal(await attempt(db, request, now), true, `attempt ${i} of ${gate.PUBLIC_RATE_LIMIT} is within the limit`);
  }
  assert.equal(await attempt(db, request, now), false, "one past the limit must be refused");
  assert.equal(await attempt(db, request, now), false, "and it stays refused");
});

test("a caller with no attributable origin is refused, not waved through", async () => {
  /*
   * Failing OPEN here would mean the one caller a volume control exists for - an anonymous client
   * the platform cannot even attribute to an origin - is the one caller it does not apply to.
   */
  const { db } = seedGate();
  assert.equal(await attempt(db, fromIp(null), Date.now()), false);
  assert.equal(await attempt(db, fromIp("   "), Date.now()), false, "whitespace is not an origin");
  assert.equal(await gate.publicFingerprint(fromIp(null)), null);
});

test("the window rolls over, and the budget comes back with it", async () => {
  const { db } = seedGate();
  const start = Date.now();
  const request = fromIp("203.0.113.11");
  for (let i = 0; i < gate.PUBLIC_RATE_LIMIT; i++) await attempt(db, request, start);
  assert.equal(await attempt(db, request, start), false, "spent for this window");

  assert.equal(await attempt(db, request, start + gate.PUBLIC_RATE_WINDOW_MS - 1), false,
    "one millisecond before the window ends it is still spent");
  assert.equal(await attempt(db, request, start + gate.PUBLIC_RATE_WINDOW_MS + 1), true,
    "once the window has passed the caller may try again");
});

test("one caller's traffic never consumes another's budget", async () => {
  const { db } = seedGate();
  const now = Date.now();
  const noisy = fromIp("203.0.113.12"), quiet = fromIp("203.0.113.13");
  for (let i = 0; i < gate.PUBLIC_RATE_LIMIT + 3; i++) await attempt(db, noisy, now);
  assert.equal(await attempt(db, noisy, now), false);
  assert.equal(await attempt(db, quiet, now), true, "a different origin starts with a full budget");
});

test("one endpoint's traffic never consumes another endpoint's budget", async () => {
  const { db } = seedGate();
  const now = Date.now();
  const request = fromIp("203.0.113.14");
  for (let i = 0; i < gate.PUBLIC_RATE_LIMIT; i++) await attempt(db, request, now, "d31_contact_limits");
  assert.equal(await attempt(db, request, now, "d31_contact_limits"), false);
  assert.equal(await attempt(db, request, now, "d31_meet_greet_limits"), true,
    "each endpoint keeps its own budget, which is why the table is a parameter");
});

test("the origin is stored hashed, never as the raw IP", async () => {
  const { sqlite, db } = seedGate();
  const ip = "203.0.113.15";
  await attempt(db, fromIp(ip), Date.now());
  const rows = sqlite.prepare(`SELECT fingerprint FROM ${TABLE}`).all();
  assert.equal(rows.length, 1);
  assert.match(rows[0].fingerprint, /^[a-f0-9]{64}$/, "a SHA-256 digest, not an address");
  assert.ok(!rows[0].fingerprint.includes(ip), "a caller's IP must not be retained in the clear");
});

test("the table name is an identifier, and anything else is refused", async () => {
  /*
   * A table name cannot be a bound parameter - it is interpolated. Every caller passes a literal
   * today, so nothing here is reachable from a request; the guard exists because the cost of the
   * next caller threading a request-derived value through would be total.
   */
  const { db } = seedGate();
  for (const table of [
    "rate_limits; DROP TABLE app_users;--",
    "rate limits",
    "rate-limits",
    "1_starts_with_a_digit",
    "",
    "x".repeat(64),
  ]) {
    await assert.rejects(() => attempt(db, fromIp("203.0.113.16"), Date.now(), table),
      /public_abuse_table_name_invalid/, `"${table}" must not be interpolated into SQL`);
  }
  assert.equal(await attempt(db, fromIp("203.0.113.16"), Date.now(), "meet_greet_rate_limits"), true,
    "a real table name still works");
});

/* ---------------------------------------------------------------------------------------------- */

const actor = (over = {}) => ({
  email: "priya.manager@pawspace.in", name: "Priya", roleCode: "manager", permissions: ["customers.manage"],
  developmentPreview: false, identitySource: "workspace", principalType: "email",
  principalKey: "priya.manager@pawspace.in", ...over,
});

test("a manager is recognised as scoped; a superuser and a preview session are not", async () => {
  assert.equal(scope.isManagerScopedActor(actor()), true);
  assert.equal(scope.isManagerScopedActor(actor({ permissions: ["*"] })), false, "a superuser is not domain-scoped");
  assert.equal(scope.isManagerScopedActor(actor({ developmentPreview: true })), false);
  assert.equal(scope.isManagerScopedActor(actor({ roleCode: "sales_executive" })), false);
});

test("the manager role is matched however it was spelled in app_users", async () => {
  /*
   * A null scope means NO restriction, so this predicate decides whether the domain check applies
   * at all. Hinging that on the exact case stored in app_users.role_code means a row seeded as
   * "Manager" would silently skip the check - the same shape as a kill switch that is engaged and
   * does nothing.
   */
  for (const roleCode of ["manager", "Manager", "MANAGER", " manager "]) {
    assert.equal(scope.isManagerScopedActor(actor({ roleCode })), true,
      `a role stored as "${roleCode}" is still a manager`);
  }
});

test("a manager inside their domain passes; outside it they are refused", async () => {
  const inside = { employeeId: "E1", cityId: "blr", teamCode: "sales", departmentCode: "cc-sales" };
  assert.doesNotThrow(() => scope.requireManagerDomain(inside, scope.CRM_MANAGER_DOMAIN));

  const opsManager = { employeeId: "E2", cityId: "blr", teamCode: "operations", departmentCode: "cc-operations" };
  assert.throws(() => scope.requireManagerDomain(opsManager, scope.CRM_MANAGER_DOMAIN), refusal(403),
    "an operations manager has no business in the CRM domain");
  assert.doesNotThrow(() => scope.requireManagerDomain(opsManager, scope.OPERATIONS_MANAGER_DOMAIN));
});

test("domain membership is matched on the normalised code, not the exact string", async () => {
  /*
   * People data is entered by humans: "Customer_Experience", "CX", "cc-crm". A scope check that
   * refuses a legitimate manager on a underscore is an outage; one that admits the wrong manager
   * is a data leak. Both directions are asserted.
   */
  for (const [teamCode, departmentCode] of [
    ["CRM", "CC-CRM"], ["customer_experience", "cc_customer_experience"], ["Sales", "Sales"],
  ]) {
    assert.doesNotThrow(
      () => scope.requireManagerDomain({ employeeId: "E", cityId: "blr", teamCode, departmentCode }, scope.CRM_MANAGER_DOMAIN),
      `${teamCode}/${departmentCode} is inside the CRM domain`,
    );
  }
  assert.throws(
    () => scope.requireManagerDomain({ employeeId: "E", cityId: "blr", teamCode: "finance", departmentCode: "cc-finance" }, scope.CRM_MANAGER_DOMAIN),
    refusal(403),
    "normalisation must not widen the domain to teams that are not in it",
  );
});

test("an unprovisioned manager is refused rather than given the run of the platform", async () => {
  /*
   * The dangerous direction. A manager whose employment record is missing a team or a cost centre
   * must not resolve to a null scope, because null means unrestricted.
   */
  const { db } = seedGate();
  const { ensurePeopleTables } = await import("../lib/people-foundation.ts");
  await ensurePeopleTables(db);
  await assert.rejects(
    () => scope.resolveManagerOrganizationalScope(db, actor()),
    refusal(403),
    "no employment record must mean no access, not unlimited access",
  );
});

test("a non-manager resolves to no scope, and no scope means the domain check does not apply", async () => {
  const { db } = seedGate();
  assert.equal(await scope.resolveManagerOrganizationalScope(db, actor({ permissions: ["*"] })), null);
  assert.doesNotThrow(() => scope.requireManagerDomain(null, scope.CRM_MANAGER_DOMAIN),
    "a superuser is gated by permissions, not by organizational domain");
});
