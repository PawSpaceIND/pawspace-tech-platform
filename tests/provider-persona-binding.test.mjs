/**
 * Journey D needs two bound providers, and the staging fixture only ever had one.
 *
 * Tester 3's provider personas authenticated correctly and then hit a wall: with no
 * provider_identity_links row, ownProviderId() resolves null and every provider-owned lifecycle read
 * answers 403 "No active provider identity is linked to this session". Not a product defect - the
 * refusal is right, an unbound identity IS no provider - but a fixture omission that makes the whole
 * provider half of the run unexecutable.
 *
 * One binding is also not enough for the case that actually matters. To prove a provider cannot touch
 * another provider's work you need a second provider to be refused, so a fixture with exactly one
 * bound provider can only ever test the happy path.
 *
 * This drives the REAL /api/partner-job-feed handler against the REAL scripts/uat-demo-seed.sql, so it
 * fails if the binding is dropped from the seed again, and it fails if the seed stops loading at all.
 * Asserting on the generator's source text would have proved neither.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

installWorkersHooks("__PPB_DB__", "__PPB_ENV__");

const HOST = "https://pawspace-staging.example.dev";
const PROVIDER_A = "uat.demo.groomer@tkpetcare.in";
const PROVIDER_B = "uat.demo.groomer2@tkpetcare.in";

let sqlite;

async function seeded() {
  sqlite = new DatabaseSync(":memory:");
  const db = createD1(sqlite);
  globalThis.__PPB_DB__ = db;
  globalThis.__PPB_ENV__ = { FOUNDER_EMAIL: "founder@pawspace.test" };

  // The role catalogue first: the seed gives each persona a role_code, and resolveActor reads the
  // permissions for that code out of role_definitions.
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  sqlite.exec(readFileSync("scripts/uat-demo-seed.sql", "utf8"));
  // The capacity roster is NOT in the seed file - the product seeds it at runtime - so the fixture has
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

test("the staging seed binds two distinct provider personas to two real roster providers", async () => {
  await seeded();
  const links = sqlite.prepare("SELECT email,provider_id,status FROM provider_identity_links ORDER BY email").all();

  assert.ok(links.length >= 2, `Journey D needs at least two bound providers, the seed has ${links.length}`);
  const bound = new Map(links.map((row) => [String(row.email), String(row.provider_id)]));
  assert.ok(bound.has(PROVIDER_A), `${PROVIDER_A} is not bound`);
  assert.ok(bound.has(PROVIDER_B), `${PROVIDER_B} is not bound — Journey D cannot exercise provider-owned lifecycle`);
  assert.notEqual(bound.get(PROVIDER_A), bound.get(PROVIDER_B), "both personas point at the same provider, so no cross-provider case exists");

  for (const [email, providerId] of bound) {
    // A binding to a provider that is not on the capacity roster resolves, then fails downstream on
    // every read - which looks like a product bug rather than a fixture one.
    const roster = sqlite.prepare("SELECT id,status FROM provider_capacity_profiles WHERE id=?").get(providerId);
    assert.ok(roster, `${email} is bound to ${providerId}, which is not on the capacity roster`);
    assert.equal(String(roster.status), "active", `${email} is bound to ${providerId}, which is not active`);
    // And the login has to exist, or resolveActor never gets as far as the binding.
    const user = sqlite.prepare("SELECT status,role_code FROM app_users WHERE email=?").get(email);
    assert.ok(user, `${email} is bound to a provider but has no app_users login`);
    assert.equal(String(user.status), "active");
  }
});

test("each bound provider reads their own job feed without naming a providerId", async () => {
  await seeded();
  // This is the exact call Journey D makes and the exact 403 Tester 3 got for provider B.
  for (const email of [PROVIDER_A, PROVIDER_B]) {
    const own = await feed(email);
    assert.equal(own.status, 200, `${email} could not read their own feed: ${JSON.stringify(own.body)}`);
    assert.ok(own.body.data, `${email} got no feed payload`);
    assert.doesNotMatch(String(own.body.error ?? ""), /No active provider identity/);
  }
});

test("provider B has work of their own, so the positive half of Journey D is executable", async () => {
  await seeded();
  // Without this the binding could exist and Journey D would still stall, on an empty feed rather
  // than a 403 — a fixture that is bound but has nothing to progress is no more runnable.
  const bBooking = sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings WHERE provider_id='groom_kiran'").get();
  assert.ok(Number(bBooking.n) > 0, "provider B is bound but owns no seeded booking to act on");
  const bOrder = sqlite.prepare("SELECT COUNT(*) n FROM provider_work_orders WHERE provider_id='groom_kiran'").get();
  assert.ok(Number(bOrder.n) > 0, "provider B is bound but owns no work order to progress");
});

test("provider B cannot read provider A's job feed", async () => {
  await seeded();
  // The reason two bindings matter. requireProviderOwnership compares the named providerId against
  // the binding, so this is the cross-provider refusal that a single-binding fixture could not reach.
  const crossed = await feed(PROVIDER_B, "?providerId=groom_arun");

  assert.equal(crossed.status, 403, `provider B read provider A's feed: ${JSON.stringify(crossed.body)}`);
  assert.match(String(crossed.body.error), /ownership denied/i);
});

test("provider A naming their own id is still allowed", async () => {
  await seeded();
  // The positive control for the test above: it must be the OWNERSHIP that refuses, not the presence
  // of a providerId parameter.
  const own = await feed(PROVIDER_A, "?providerId=groom_arun");
  assert.equal(own.status, 200, `the rightful provider was refused their own id: ${JSON.stringify(own.body)}`);
});
