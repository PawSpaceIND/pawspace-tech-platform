/**
 * One installation, one active authenticated customer. [PTJA-W3-DI]
 *
 * THE APPROVED RULE, supplied by the business:
 *   A physical device may be used by different customers, but one installation must have only ONE
 *   active authenticated customer context at a time. Do not silently transfer an installation between
 *   customers. A switch or handover requires: logout/account switch or session revocation; a successful
 *   OTP/login for the new customer; removal or rotation of the previous notification/session
 *   association; and an audit event recording the old and new account linkage. The authenticated
 *   session is authoritative. The installation identifier must NEVER be treated as proof of customer
 *   identity.
 *
 * WHAT WAS MEASURED BEFORE. identifyInstall's ON CONFLICT DO NOTHING closed the takeover - an install
 * is claimed once - but left two things wrong. There is no release, so a genuinely reset or resold
 * device can never be re-bound and its new owner is permanently unlinked. And worse, the function ends
 * with `customerId: String(link?.customer_id ?? customerId)`: when a SECOND customer verifies their own
 * phone on that device, the call returns the FIRST customer's id to them. A caller that trusts that
 * value has just been handed somebody else's identity by an install string.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_DI_DB__", "__PTJA_DI_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  let depth = 0;
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      const outer = depth === 0;
      if (outer) sqlite.exec("BEGIN IMMEDIATE");
      depth += 1;
      try { const out = []; for (const item of items) out.push(await item.run()); if (outer) sqlite.exec("COMMIT"); return out; }
      catch (error) { if (outer) sqlite.exec("ROLLBACK"); throw error; }
      finally { depth -= 1; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const attempt = (promise) => promise.then(
  (value) => ({ ok: true, value }),
  async (error) => ({ ok: false, status: error instanceof Response ? error.status : 0, message: error instanceof Response ? await error.clone().text() : String(error?.message ?? error) }),
);

const INSTALL = "INSTALL-1";
const ALICE = "CUS-ALICE";
const BOB = "CUS-BOB";

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_DI_DB__ = db;
  globalThis.__PTJA_DI_ENV__ = {};
  const funnel = await import("../lib/app-to-revenue-funnel.ts");
  await funnel.ensureFunnelTables(db);
  return { sqlite, db, funnel };
}

const events = (sqlite) => sqlite.prepare("SELECT event_type,install_id,previous_customer_id,customer_id,reason,actor_id FROM install_identity_events ORDER BY created_at").all();

// ---------------------------------------------------------------------------------------------------
// The first claim
// ---------------------------------------------------------------------------------------------------

test("DI-01: an unclaimed install binds to the customer who authenticated", async () => {
  const { sqlite, db, funnel } = await world();
  const result = await funnel.identifyInstall(db, { installId: INSTALL, customerId: ALICE });
  assert.equal(result.customerId, ALICE, `Alice's own id comes back: ${JSON.stringify(result)}`);
  assert.equal(result.bound, true, "and the install is bound to her");
  assert.equal(String(sqlite.prepare("SELECT customer_id FROM install_identity_links WHERE install_id=?").get(INSTALL).customer_id), ALICE);
  assert.ok(events(sqlite).some((row) => String(row.event_type) === "identified" && String(row.customer_id) === ALICE),
    `the binding is audited: ${JSON.stringify(events(sqlite))}`);
});

test("DI-02: the same customer identifying again is idempotent", async () => {
  const { sqlite, db, funnel } = await world();
  await funnel.identifyInstall(db, { installId: INSTALL, customerId: ALICE });
  const again = await funnel.identifyInstall(db, { installId: INSTALL, customerId: ALICE });
  assert.equal(again.customerId, ALICE, "the same customer still gets their own id");
  assert.equal(again.bound, true, "and stays bound");
  assert.equal(events(sqlite).filter((row) => String(row.event_type) === "identified").length, 1,
    "reopening the app does not write a second identification event");
});

// ---------------------------------------------------------------------------------------------------
// A second customer on the same device
// ---------------------------------------------------------------------------------------------------

test("DI-03: a second customer is NEVER handed the first customer's id", async () => {
  // The sharpest line in this rule. Bob proved his own phone; the install string must not answer for
  // who he is.
  const { db, funnel } = await world();
  await funnel.identifyInstall(db, { installId: INSTALL, customerId: ALICE });
  const bob = await funnel.identifyInstall(db, { installId: INSTALL, customerId: BOB });
  assert.notEqual(bob.customerId, ALICE, `Bob must not receive Alice's identity: ${JSON.stringify(bob)}`);
  assert.equal(bob.customerId, BOB, "he receives his own");
});

test("DI-04: a second customer does not silently take over the binding", async () => {
  const { sqlite, db, funnel } = await world();
  await funnel.identifyInstall(db, { installId: INSTALL, customerId: ALICE });
  const bob = await funnel.identifyInstall(db, { installId: INSTALL, customerId: BOB });
  assert.equal(bob.bound, false, `the install is not transferred by simply logging in: ${JSON.stringify(bob)}`);
  assert.equal(String(bob.conflict ?? ""), "install_bound_to_another_customer", "and the reason is stated");
  assert.equal(String(sqlite.prepare("SELECT customer_id FROM install_identity_links WHERE install_id=?").get(INSTALL).customer_id), ALICE,
    "Alice's acquisition attribution stays hers");
});

test("DI-05: the refused claim is audited", async () => {
  const { sqlite, db, funnel } = await world();
  await funnel.identifyInstall(db, { installId: INSTALL, customerId: ALICE });
  await funnel.identifyInstall(db, { installId: INSTALL, customerId: BOB });
  const refusal = events(sqlite).find((row) => String(row.event_type) === "claim_refused");
  assert.ok(refusal, `an attempted claim on a bound install is worth recording: ${JSON.stringify(events(sqlite))}`);
  assert.equal(String(refusal.customer_id), BOB, "naming who tried");
  assert.equal(String(refusal.previous_customer_id), ALICE, "and who holds it");
});

// ---------------------------------------------------------------------------------------------------
// The handover the rule describes: release, then authenticate
// ---------------------------------------------------------------------------------------------------

test("DI-06: releasing an install requires the current holder and a reason", async () => {
  const { db, funnel } = await world();
  await funnel.identifyInstall(db, { installId: INSTALL, customerId: ALICE });
  const byStranger = await attempt(funnel.releaseInstall(db, { installId: INSTALL, customerId: BOB, reason: "I want this device" }));
  assert.equal(byStranger.ok, false, `only the holder may release it: ${JSON.stringify(byStranger).slice(0, 250)}`);
  const noReason = await attempt(funnel.releaseInstall(db, { installId: INSTALL, customerId: ALICE, reason: "" }));
  assert.equal(noReason.ok, false, `and must say why: ${JSON.stringify(noReason).slice(0, 250)}`);
});

test("DI-07: after a release the next customer to authenticate binds successfully", async () => {
  // Non-vacuity for DI-04. Refusing every second claim would satisfy it and permanently orphan a reset
  // or resold device.
  const { sqlite, db, funnel } = await world();
  await funnel.identifyInstall(db, { installId: INSTALL, customerId: ALICE });
  await funnel.releaseInstall(db, { installId: INSTALL, customerId: ALICE, reason: "Signing out, selling the phone" });
  const bob = await funnel.identifyInstall(db, { installId: INSTALL, customerId: BOB });
  assert.equal(bob.bound, true, `Bob may now claim it: ${JSON.stringify(bob)}`);
  assert.equal(bob.customerId, BOB, "with his own identity");
  assert.equal(String(sqlite.prepare("SELECT customer_id FROM install_identity_links WHERE install_id=?").get(INSTALL).customer_id), BOB);
});

test("DI-08: the handover records both the old and the new linkage", async () => {
  const { sqlite, db, funnel } = await world();
  await funnel.identifyInstall(db, { installId: INSTALL, customerId: ALICE });
  await funnel.releaseInstall(db, { installId: INSTALL, customerId: ALICE, reason: "Signing out, selling the phone" });
  await funnel.identifyInstall(db, { installId: INSTALL, customerId: BOB });
  const trail = events(sqlite);
  const released = trail.find((row) => String(row.event_type) === "released");
  assert.ok(released, "the sign-out is recorded");
  assert.equal(String(released.customer_id), ALICE, "naming who left");
  assert.match(String(released.reason), /selling the phone/, "and why");
  const rebound = trail.find((row) => String(row.event_type) === "identified" && String(row.customer_id) === BOB);
  assert.ok(rebound, "and the new binding is recorded");
  assert.equal(String(rebound.previous_customer_id), ALICE, "carrying the account it replaced, so the linkage is traceable both ways");
});

test("DI-09: a released install is not left as an active association", async () => {
  const { sqlite, db, funnel } = await world();
  await funnel.identifyInstall(db, { installId: INSTALL, customerId: ALICE });
  await funnel.releaseInstall(db, { installId: INSTALL, customerId: ALICE, reason: "Signing out of this device" });
  const current = await funnel.installIdentity(db, INSTALL);
  assert.equal(current, null, `nothing is bound after a release: ${JSON.stringify(current)}`);
  const row = sqlite.prepare("SELECT status FROM install_identity_links WHERE install_id=?").get(INSTALL);
  assert.ok(!row || String(row.status) !== "active", "and no active row survives to be inherited silently");
});

test("DI-10: releasing an install nobody holds is refused, not quietly accepted", async () => {
  const { db, funnel } = await world();
  const result = await attempt(funnel.releaseInstall(db, { installId: "INSTALL-NOBODY", customerId: ALICE, reason: "Signing out" }));
  assert.equal(result.ok, false, `there is nothing to release: ${JSON.stringify(result).slice(0, 250)}`);
});

test("DI-11: identifying without an authenticated customer is refused", async () => {
  // "The installation identifier must never be treated as proof of customer identity." An install id on
  // its own must therefore not be able to produce a binding.
  const { db, funnel } = await world();
  const result = await attempt(funnel.identifyInstall(db, { installId: INSTALL, customerId: "" }));
  assert.equal(result.ok, false, `an install id alone identifies nobody: ${JSON.stringify(result).slice(0, 250)}`);
});

// ---------------------------------------------------------------------------------------------------
// The administrative surface
// ---------------------------------------------------------------------------------------------------

test("DI-12: the funnel route answers 409 on a refused claim and never leaks the holder", async () => {
  const { db, funnel } = await world();
  const auth = await import("../lib/server-auth.ts");
  await auth.ensureSecurityTables(db);
  const now = Date.now();
  await db.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('u-mk','marketing@pawspace.test','Marketing','founder','active',?,?)").bind(now, now).run();
  await funnel.identifyInstall(db, { installId: INSTALL, customerId: ALICE });

  const route = await import("../app/api/acquisition-funnel/route.ts");
  const call = (body) => route.POST(new Request("https://uat.pawspace.in/api/acquisition-funnel", {
    method: "POST",
    headers: { "content-type": "application/json", "oai-authenticated-user-email": "marketing@pawspace.test", "oai-authenticated-user-full-name": "Marketing" },
    body: JSON.stringify(body),
  }));

  const refused = await call({ action: "identify", installId: INSTALL, customerId: BOB });
  const refusedBody = await refused.json().catch(() => null);
  assert.equal(refused.status, 409, `a refused claim is a conflict, not a quiet 201: ${JSON.stringify(refusedBody).slice(0, 300)}`);
  assert.equal(JSON.stringify(refusedBody).includes(ALICE), false,
    `and the holder's identity must not appear in it: ${JSON.stringify(refusedBody).slice(0, 300)}`);

  const released = await call({ action: "release", installId: INSTALL, customerId: ALICE, reason: "Device handed over to a new owner" });
  assert.equal(released.status, 201, `staff can perform the release step: ${released.status}`);
  const rebound = await call({ action: "identify", installId: INSTALL, customerId: BOB });
  assert.equal(rebound.status, 201, "and the new customer then binds normally");
});
