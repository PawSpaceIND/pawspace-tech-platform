/**
 * ADVERSARIAL RBAC — cross-domain self-escalation and permission-delegation boundaries.
 *
 * WHAT THIS FILE IS FOR, AND WHY IT IS NOT tests/founder-role-escalation.test.mjs.
 *
 * That file proves one thing well: no holder of `users.manage` can reach a FULL-ACCESS role
 * (`founder`, `superuser`, or any future role defined as ["*"]). It closes vertical escalation.
 *
 * It says nothing about SIDEWAYS escalation, and it cannot, for two reasons:
 *
 *   1. every request in it is posted to `http://localhost`, and `npm test` runs with NODE_ENV=test and
 *      PAWSPACE_LOCAL_PREVIEW=on — so isDevelopmentPreviewRequest() fires and resolveActor() hands back
 *      the development-preview SUPERUSER with ["*"], whatever email the header carries. That is the
 *      right harness for its claim (a rule about the role being ASSIGNED, which no caller may satisfy),
 *      but it means the file has never executed a request as a real `admin`. Every test here posts to a
 *      non-preview host so the actor is the genuine role under test, and RBAC-00 proves it.
 *
 *   2. the protected set is derived from `isFullAccessRole`, i.e. from the wildcard. `finance` is not a
 *      wildcard role, so it is not protected — and it holds four grants an `admin` does not:
 *      finance.manage, payments.manage, payroll.manage, compensation.view.
 *
 * The escalation chain these tests execute:
 *
 *      admin (users.manage, no finance.manage)
 *        -> POST /api/platform-governance {action:"update_user", id:<OWN row>, roleCode:"finance"}
 *        -> passes requirePermission(users.manage)
 *        -> target role `admin` is not protected, assigned role `finance` is not protected, and
 *           `finance` exists in role_definitions
 *        -> UPDATE app_users SET role_code='finance' WHERE id=<own id>
 *        -> next request authorises with finance.manage + payments.manage + payroll.manage
 *
 * Nothing in the route compares `id` (or the target's email) against the acting identity: a grep for
 * self-comparison across the file returns nothing. Authority to administer users is being read as
 * authority to grant oneself an authority one does not hold, which is the definition of privilege
 * escalation even though no single role in the transition is "higher" than the other.
 *
 * The second boundary is DELEGATION. save_role filters the submitted permission list against the global
 * `permissionCatalog` — every permission the platform defines — not against what the ACTOR holds. So a
 * custom role carrying `roles.manage` and nothing else can mint a role holding finance.manage and then
 * be assigned it. That is reachable in two steps from the state a founder can legitimately create.
 *
 * HOW TO READ A FAILURE HERE. Each test asserts the SECURITY PROPERTY, not today's behaviour. Tests
 * whose name is prefixed [OPEN] are expected to fail against the current route: they are the finding,
 * written as an executable assertion rather than prose, and they turn green the moment the guard lands.
 * Everything else is a regression lock on a boundary that already holds, and each one has been
 * mutation-checked (delete the guard, watch it fail).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__ADV_RBAC_DB__", "__ADV_RBAC_ENV__");

const route = await import("../app/api/platform-governance/route.ts");
const { parsePermissions } = await import("../lib/platform-security.ts");

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (items) => { const out = []; for (const item of items) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

/**
 * A NON-PREVIEW host. This single detail is what makes the file mean anything: on `localhost` every
 * actor is the preview superuser and every role boundary is unmeasurable.
 */
const URL_GOVERNANCE = "https://uat.pawspace.in/api/platform-governance";

const ADMIN = "admin.actor@pawspace.test";
const FINANCE = "finance.actor@pawspace.test";
const MANAGER = "manager.actor@pawspace.test";
const ASSOCIATE = "associate.actor@pawspace.test";
const FOUNDER = "founder.actor@pawspace.test";
/** Holds roles.manage and nothing else that matters. The delegation probe. */
const STEWARD = "steward.actor@pawspace.test";

/**
 * A governance world with one real holder of each default role, plus two CUSTOM (system_role=0) roles.
 *
 * The custom roles are the delegation fixture: save_role refuses built-in roles outright, so a
 * delegation boundary can only be measured on a role the route is willing to edit at all. `role_steward`
 * is deliberately the narrowest possible holder of roles.manage — if it can grant finance.manage, the
 * filter is not a delegation check.
 */
async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__ADV_RBAC_DB__ = db;
  globalThis.__ADV_RBAC_ENV__ = {};
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  // Seeds role_definitions from defaultRoles with system_role=1, so every permission set below is the
  // platform's real definition rather than a fixture that could drift from it.
  await ensureSecurityTables(db);
  const now = Date.now();
  const user = sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)");
  user.run("U-ADMIN", ADMIN, "Admin Actor", "admin", now, now);
  user.run("U-FINANCE", FINANCE, "Finance Actor", "finance", now, now);
  user.run("U-MANAGER", MANAGER, "Manager Actor", "manager", now, now);
  user.run("U-ASSOCIATE", ASSOCIATE, "Associate Actor", "associate", now, now);
  user.run("U-FOUNDER", FOUNDER, "Founder Actor", "founder", now, now);
  user.run("U-STEWARD", STEWARD, "Role Steward", "role_steward", now, now);
  user.run("U-TARGET", "ordinary.target@pawspace.test", "Ordinary Target", "associate", now, now);
  const role = sqlite.prepare("INSERT INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES (?,?,?,?,0,?)");
  role.run("role_steward", "Role steward", "Maintains custom roles. Holds roles.manage and nothing else.", JSON.stringify(["dashboard.view", "roles.manage"]), now);
  role.run("city_lead", "City lead", "A custom role, editable through save_role.", JSON.stringify(["dashboard.view"]), now);
  return { sqlite, db };
}

const post = (email, body) => route.POST(new Request(URL_GOVERNANCE, {
  method: "POST",
  headers: { "content-type": "application/json", "oai-authenticated-user-email": email },
  body: JSON.stringify(body),
}));

const get = (email) => route.GET(new Request(URL_GOVERNANCE, { headers: { "oai-authenticated-user-email": email } }));

const answer = async (response) => ({ status: response.status, body: await response.json().catch(() => null) });

const roleOf = (sqlite, id) => sqlite.prepare("SELECT role_code FROM app_users WHERE id=?").get(id)?.role_code;
const statusOf = (sqlite, id) => sqlite.prepare("SELECT status FROM app_users WHERE id=?").get(id)?.status;
const grantsOf = (sqlite, code) => parsePermissions(sqlite.prepare("SELECT permissions_json FROM role_definitions WHERE code=?").get(code)?.permissions_json);

/** What this identity would actually authorise with on its NEXT request. The escalation measurement. */
const effectiveGrants = (sqlite, email) => {
  const row = sqlite.prepare("SELECT r.permissions_json AS p FROM app_users u JOIN role_definitions r ON r.code=u.role_code WHERE u.email=?").get(email);
  return parsePermissions(row?.p);
};

const denials = (sqlite) => sqlite.prepare("SELECT actor_email,action,outcome,detail_json FROM security_audit_events WHERE outcome='denied'").all();

// ===========================================================================================
// 0. Harness integrity. Without this the whole file is vacuous.
// ===========================================================================================

test("RBAC-00 (non-vacuity): the acting identity is a REAL admin, not the development-preview superuser", async () => {
  const { sqlite } = await world();
  const result = await answer(await get(ADMIN));
  assert.equal(result.status, 200, `an admin may read governance: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(result.body.current.roleCode, "admin", "the resolved actor must be the seeded admin");
  assert.equal(result.body.current.permissions.includes("*"), false,
    "a wildcard here means the preview branch fired and no role boundary in this file is measurable");
  // The exact asymmetry every escalation test below exploits, asserted rather than assumed.
  const admin = effectiveGrants(sqlite, ADMIN);
  assert.equal(admin.includes("users.manage"), true, "admin administers users");
  for (const grant of ["finance.manage", "payments.manage", "payroll.manage", "compensation.view", "roles.manage"]) {
    assert.equal(admin.includes(grant), false, `admin must not already hold ${grant}, or the escalation tests prove nothing`);
  }
  assert.equal(effectiveGrants(sqlite, FINANCE).includes("finance.manage"), true, "and finance does hold it");
});

test("RBAC-01 (non-vacuity): an ordinary, in-authority role change still succeeds", async () => {
  // Refusing everything would satisfy every assertion below. This is the control that stops it.
  const { sqlite } = await world();
  const result = await answer(await post(ADMIN, { action: "update_user", id: "U-TARGET", roleCode: "manager", status: "active" }));
  assert.equal(result.status, 200, `a legitimate change must go through: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(roleOf(sqlite, "U-TARGET"), "manager", "and must actually be applied");
});

// ===========================================================================================
// 1. Cross-domain SELF escalation. The live gap.
// ===========================================================================================

test("[OPEN] RBAC-02: an admin cannot promote THEMSELVES to finance", async () => {
  const { sqlite } = await world();
  const result = await answer(await post(ADMIN, { action: "update_user", id: "U-ADMIN", roleCode: "finance", status: "active" }));
  assert.equal(result.status, 403, `a self-directed cross-domain switch must be refused 403: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(roleOf(sqlite, "U-ADMIN"), "admin", "and the actor's own role must be untouched in the database");
});

test("[OPEN] RBAC-03: an admin cannot end a request holding a grant it did not start with", async () => {
  // The property that matters, stated without reference to any role name: whatever the transition, the
  // actor must not come out of it with authority it could not exercise going in. Written this way so a
  // fix that only blacklists the literal "finance" does not satisfy it.
  const { sqlite } = await world();
  const before = effectiveGrants(sqlite, ADMIN);
  await post(ADMIN, { action: "update_user", id: "U-ADMIN", roleCode: "finance", status: "active" });
  const after = effectiveGrants(sqlite, ADMIN);
  const gained = after.filter((grant) => !before.includes(grant));
  assert.deepEqual(gained, [], `self-service role change granted the actor new authority: ${gained.join(", ")}`);
});

test("[OPEN] RBAC-04: an admin cannot promote ANOTHER user into a domain it does not hold", async () => {
  // Delegation, on the user path. Handing finance.manage to a colleague is the same grant the actor
  // could not give itself; routing it through a second account must not launder it.
  const { sqlite } = await world();
  const result = await answer(await post(ADMIN, { action: "update_user", id: "U-TARGET", roleCode: "finance", status: "active" }));
  assert.equal(result.status, 403, `assigning an unheld grant must be refused 403: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(roleOf(sqlite, "U-TARGET"), "associate", "and the target must keep the role it had");
});

test("[OPEN] RBAC-05: an admin cannot self-assign a CUSTOM role carrying roles.manage", async () => {
  // The compounding case: roles.manage is the lever that reaches every other permission through
  // save_role, and it is the one grant a full-access-only protected set can never cover, because a
  // custom role holding it is not a wildcard role.
  const { sqlite } = await world();
  const result = await answer(await post(ADMIN, { action: "update_user", id: "U-ADMIN", roleCode: "role_steward", status: "active" }));
  assert.equal(result.status, 403, `self-assigning roles.manage must be refused 403: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(roleOf(sqlite, "U-ADMIN"), "admin", "and must not be applied");
});

test("[OPEN] RBAC-06: a refused cross-domain escalation is recorded as a denial", async () => {
  // Every other refusal on this route writes one denied audit row (denyAndAudit). A refusal that
  // records nothing is worse than none, because the trail then reads as complete while omitting the
  // most interesting attempt anyone could make on this surface.
  const { sqlite } = await world();
  await post(ADMIN, { action: "update_user", id: "U-ADMIN", roleCode: "finance", status: "active" });
  const rows = denials(sqlite).filter((row) => String(row.actor_email) === ADMIN);
  assert.equal(rows.length, 1, `exactly one denial must be recorded, found ${rows.length}`);
  assert.match(String(rows[0].detail_json), /finance/, "naming the role that was refused");
});

// ===========================================================================================
// 2. Escalation attempts by roles that do NOT administer users. These boundaries already hold.
// ===========================================================================================

for (const [label, email, id, from] of [
  ["a finance user", FINANCE, "U-FINANCE", "finance"],
  ["a manager", MANAGER, "U-MANAGER", "manager"],
  ["an associate", ASSOCIATE, "U-ASSOCIATE", "associate"],
]) {
  test(`RBAC-07/${from}: ${label} cannot promote itself at all — no users.manage, no transition`, async () => {
    const { sqlite } = await world();
    const result = await answer(await post(email, { action: "update_user", id, roleCode: "admin", status: "active" }));
    assert.equal(result.status, 403, `permission must be denied: ${JSON.stringify(result).slice(0, 300)}`);
    assert.equal(roleOf(sqlite, id), from, "and the role must be unchanged");
  });
}

test("RBAC-08: a role that cannot administer users also cannot reach the role editor", async () => {
  const { sqlite } = await world();
  const result = await answer(await post(FINANCE, { action: "save_role", code: "city_lead", permissions: ["dashboard.view", "finance.manage", "users.manage"] }));
  assert.equal(result.status, 403, `save_role needs roles.manage: ${JSON.stringify(result).slice(0, 300)}`);
  assert.deepEqual(grantsOf(sqlite, "city_lead"), ["dashboard.view"], "and the role definition must be untouched");
});

test("RBAC-09: an admin holds users.manage but NOT roles.manage, and the route enforces the difference", async () => {
  // Worth its own test because it is the only thing standing between the RBAC-02 gap and a two-step
  // path to ["*"]-equivalent authority: promote self to a custom role, then edit that role freely.
  const { sqlite } = await world();
  const result = await answer(await post(ADMIN, { action: "save_role", code: "city_lead", permissions: ["dashboard.view", "users.manage", "roles.manage"] }));
  assert.equal(result.status, 403, `an admin must not edit role definitions: ${JSON.stringify(result).slice(0, 300)}`);
  assert.deepEqual(grantsOf(sqlite, "city_lead"), ["dashboard.view"], "and nothing is written");
});

// ===========================================================================================
// 3. Delegation boundaries inside save_role.
// ===========================================================================================

test("RBAC-10 (non-vacuity): a role steward CAN grant a permission it holds itself", async () => {
  const { sqlite } = await world();
  const result = await answer(await post(STEWARD, { action: "save_role", code: "city_lead", permissions: ["dashboard.view"] }));
  assert.equal(result.status, 200, `an in-authority role edit must succeed: ${JSON.stringify(result).slice(0, 300)}`);
  assert.deepEqual(grantsOf(sqlite, "city_lead"), ["dashboard.view"], "and be applied");
});

test("[OPEN] RBAC-11: a role steward cannot grant finance.manage, which it does not hold", async () => {
  const { sqlite } = await world();
  const result = await answer(await post(STEWARD, { action: "save_role", code: "city_lead", permissions: ["dashboard.view", "finance.manage"] }));
  assert.equal(result.status, 403, `granting an unheld permission must be refused 403: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(grantsOf(sqlite, "city_lead").includes("finance.manage"), false,
    "and the permission must not reach the role definition");
});

test("[OPEN] RBAC-12: a role steward cannot grant users.manage either", async () => {
  // The other half of the two-step: mint a role that administers users, then have somebody hold it.
  const { sqlite } = await world();
  const result = await answer(await post(STEWARD, { action: "save_role", code: "city_lead", permissions: ["dashboard.view", "users.manage"] }));
  assert.equal(result.status, 403, `granting users.manage from a role that lacks it must be refused: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(grantsOf(sqlite, "city_lead").includes("users.manage"), false, "and must not be written");
});

test("[OPEN] RBAC-13: the two-step chain — mint an over-privileged role, then wear it — is closed at both ends", async () => {
  // Written as ONE test because the exposure is the composition, not either step. It stays failing
  // while either half is open, and only goes green when neither can be walked.
  const { sqlite } = await world();
  await post(STEWARD, { action: "save_role", code: "city_lead", permissions: ["dashboard.view", "finance.manage", "payroll.manage"] });
  await post(ADMIN, { action: "update_user", id: "U-TARGET", roleCode: "city_lead", status: "active" });
  const reached = effectiveGrants(sqlite, "ordinary.target@pawspace.test");
  for (const grant of ["finance.manage", "payroll.manage"]) {
    assert.equal(reached.includes(grant), false, `an ordinary account reached ${grant} through the role editor`);
  }
});

test("RBAC-14: the wildcard cannot be smuggled in through the permission list", async () => {
  // "*" is deliberately absent from permissionCatalog, so the filter drops it. That is the ONE
  // delegation control save_role does have, and it is the most important one.
  const { sqlite } = await world();
  const result = await answer(await post(STEWARD, { action: "save_role", code: "city_lead", permissions: ["*"] }));
  assert.equal(result.status, 200, `the request is accepted and sanitised: ${JSON.stringify(result).slice(0, 300)}`);
  const saved = grantsOf(sqlite, "city_lead");
  assert.equal(saved.includes("*"), false, "the wildcard must never reach a role definition");
  assert.deepEqual(saved, [], "and nothing else is invented in its place");
});

test("RBAC-15: an invented permission string is filtered rather than stored", async () => {
  const { sqlite } = await world();
  await post(STEWARD, { action: "save_role", code: "city_lead", permissions: ["dashboard.view", "everything.always", "admin", "constructor"] });
  assert.deepEqual(grantsOf(sqlite, "city_lead"), ["dashboard.view"], "only catalogued permissions survive");
});

// ===========================================================================================
// 4. Vertical escalation, re-measured as a REAL admin rather than the preview superuser.
// ===========================================================================================

for (const protectedRole of ["founder", "superuser"]) {
  test(`RBAC-16/${protectedRole}: a real admin cannot promote itself to ${protectedRole}`, async () => {
    const { sqlite } = await world();
    const result = await answer(await post(ADMIN, { action: "update_user", id: "U-ADMIN", roleCode: protectedRole, status: "active" }));
    assert.notEqual(result.status, 200, `must be refused: ${JSON.stringify(result).slice(0, 300)}`);
    assert.equal(roleOf(sqlite, "U-ADMIN"), "admin", "and leave the actor's own role alone");
    assert.equal(effectiveGrants(sqlite, ADMIN).includes("*"), false, "the wildcard must remain unreachable");
  });
}

test("[OPEN] RBAC-17: a refused privilege escalation answers 403, not 400", async () => {
  // Response CLASS, separated from behaviour on purpose. The refusals above are correct and durable;
  // they are just reported as 400 Bad Request, which says "you sent something malformed" about a
  // request that was well-formed and deliberate. A client cannot distinguish it from a typo, and an
  // alert on 403 volume — the ordinary way an authorization probe is spotted — never fires.
  await world();
  const result = await answer(await post(ADMIN, { action: "update_user", id: "U-ADMIN", roleCode: "founder", status: "active" }));
  assert.equal(result.status, 403, `an authorization refusal must carry an authorization status, got ${result.status}`);
});

test("RBAC-18: an admin cannot DEMOTE or disable a founder", async () => {
  // The escalation nobody writes down: not gaining authority, but removing the identity that outranks
  // you. `status` is a sibling field of `roleCode` on the same action, and `associate` is deliberately
  // chosen as the target role — sending "founder" back would be caught by the ASSIGNMENT guard, and the
  // test would then pass without the holder guard existing at all. Mutation-checked: deleting the
  // protected-holder guard while keeping the assignment guard leaves this red, and the founder demoted.
  const { sqlite } = await world();
  const result = await answer(await post(ADMIN, { action: "update_user", id: "U-FOUNDER", roleCode: "associate", status: "disabled" }));
  assert.notEqual(result.status, 200, `editing a protected holder must be refused: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(roleOf(sqlite, "U-FOUNDER"), "founder", "the founder must keep the role");
  assert.equal(statusOf(sqlite, "U-FOUNDER"), "active", "and must remain active");
  assert.equal(effectiveGrants(sqlite, FOUNDER).includes("*"), true, "and keep full authority");
});

test("RBAC-18b: a superuser holder cannot be demoted from user management either", async () => {
  // The protected set is derived from the wildcard, so it must cover both holders, not just the one
  // named `founder`.
  const { sqlite } = await world();
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('U-SUPER','real.superuser@pawspace.test','Real Superuser','superuser','active',0,0)").run();
  const result = await answer(await post(ADMIN, { action: "update_user", id: "U-SUPER", roleCode: "associate", status: "disabled" }));
  assert.notEqual(result.status, 200, `must be refused: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(roleOf(sqlite, "U-SUPER"), "superuser", "the superuser must keep the role");
});

test("RBAC-19: a prototype-shaped role code is refused rather than resolved", async () => {
  // `Object.hasOwn`-class hazard, on the SQL side: the route looks the code up in role_definitions, so
  // "__proto__" and "constructor" find nothing and are refused. Locked because the same lookup written
  // against an in-memory object would have returned a truthy prototype and admitted the write.
  const { sqlite } = await world();
  for (const code of ["__proto__", "constructor", "prototype"]) {
    const result = await answer(await post(ADMIN, { action: "update_user", id: "U-TARGET", roleCode: code, status: "active" }));
    assert.notEqual(result.status, 200, `${code} must not be assignable: ${JSON.stringify(result).slice(0, 200)}`);
    assert.equal(roleOf(sqlite, "U-TARGET"), "associate", `${code} must not reach app_users`);
  }
});

test("[OPEN] RBAC-20: create_user cannot mint an account in a domain the actor does not hold", async () => {
  // update_user is not the only writer of role_code. A delegation rule that lands only there leaves
  // this door open: create the account carrying the grant instead of promoting one into it. Paired with
  // RBAC-04 deliberately — whichever way that decision goes, these two must agree, and a fix applied to
  // one action only will show up here as a still-red test.
  const { sqlite } = await world();
  const result = await answer(await post(ADMIN, { action: "create_user", email: "new.finance@pawspace.test", name: "New Finance", roleCode: "finance" }));
  assert.equal(result.status, 403, `create_user must not admit an unheld grant: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM app_users WHERE email=?").get("new.finance@pawspace.test").c, 0,
    "and no account may be created at all");
});

test("RBAC-21: create_user is still refused for a full-access role, as a real admin", async () => {
  // Non-vacuity for RBAC-20: proves this action does refuse SOMETHING, so a green RBAC-20 after a fix
  // cannot be a route that started refusing every create.
  const { sqlite } = await world();
  const result = await answer(await post(ADMIN, { action: "create_user", email: "new.founder@pawspace.test", name: "New Founder", roleCode: "superuser" }));
  assert.notEqual(result.status, 200, `must be refused: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM app_users WHERE email=?").get("new.founder@pawspace.test").c, 0,
    "no account behind a refused create");
});
