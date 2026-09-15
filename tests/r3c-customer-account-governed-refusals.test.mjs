/*
 * R3-C / F9 (P2) — /api/customer-account discarded its own validation reason.
 *
 * MEASURED: POST /api/customer-account with action "upsert_pet" and an unsupported vaccinationStatus
 * (originally "vaccinated", which lib/pet-vaccination-governance.ts really stamps and which the
 * endpoint now accepts, so the trigger moved to a value that is genuinely not a status)
 * answered 400 {"error":"Unable to update customer account"}. The engine knows exactly what is wrong -
 * petProfileIssues() in lib/customer-account.ts produces "Vaccination status must be not_provided,
 * verified or pending" - and raised it, but as an UNBRANDED Response. lib/server-auth.ts authError()
 * trusts a raised Response only by object identity (isGovernedHttpError), so it kept the 400 and
 * replaced the body with the route's generic fallback. The customer was told a form was wrong without
 * being told which field or why.
 *
 * The redaction is correct in general and is untouched; what changes is that this engine's refusals are
 * marked caller-safe, exactly as lib/boarding-proof-governance.ts and lib/sitting-governance.ts do.
 * Every refusal in the engine is branded, not only the reported one - the SWEEP below runs each of the
 * sibling refusals through the real route and asserts its real sentence survives.
 *
 * Real route, real authError, real SQLite, a real platform session.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { installWorkersHooks, enterWorkersDbScope } from "./helpers/module-hooks.mjs";

installWorkersHooks("__R3C_ACCT_DB__", "__R3C_ACCT_ENV__");

const ORIGIN = "https://uat.pawspace.in";
const CUSTOMER = "CUS-R3C-ACCOUNT";

async function world() {
  const harness = freshCountingD1();
  enterWorkersDbScope(harness.db);
  globalThis.__R3C_ACCT_DB__ = harness.db;
  globalThis.__R3C_ACCT_ENV__ = {};
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(harness.db);
  const { ensureCustomerAccountTables } = await import("../lib/customer-account.ts");
  await ensureCustomerAccountTables(harness.db);
  const now = Date.now();
  await harness.db.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,NULL,NULL,'customer_app','{}',?,?)")
    .bind(CUSTOMER, "blr", "Asha Rao", "9812345600", now, now).run();
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(harness.db, {
    identitySource: "customer_otp", principalType: "identity_subject", principalKey: `customer:${CUSTOMER}`,
    subjectType: "customer", subjectId: CUSTOMER, verificationState: "verified",
    actorId: "r3c", reason: "R3-C customer account refusal verification",
  });
  const issued = await issuePlatformSession(harness.db, {
    bindingId: String(binding.id), identitySource: "customer_otp",
    principalType: "identity_subject", principalKey: String(binding.principal_key),
    subjectType: "customer", subjectId: CUSTOMER,
  });
  harness.cookie = `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
  return harness;
}

async function post(harness, body) {
  const route = await import("../app/api/customer-account/route.ts");
  const response = await route.POST(new Request(`${ORIGIN}/api/customer-account`, {
    method: "POST", headers: { "content-type": "application/json", cookie: harness.cookie },
    body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), ...body }),
  }));
  return { status: response.status, body: await response.json() };
}

test("ACCT-01: the reported case - an unsupported vaccination status says which values are allowed", async () => {
  const harness = await world();
  const { status, body } = await post(harness, {
    action: "upsert_pet", pet: { sourceId: "bruno", name: "Bruno", species: "dog", vaccinationStatus: "definitely-not-a-status" },
  });
  assert.equal(status, 400, JSON.stringify(body).slice(0, 200));
  assert.equal(body.error, "Vaccination status must be one of not_provided, verified, pending, recorded, vaccinated",
    "the engine's own sentence must reach the customer, not the route's fallback");
  assert.equal(body.error.includes("Unable to update customer account"), false);
});

test("ACCT-02: a valid pet still saves - the fix governs the message, it does not weaken validation", async () => {
  // NON-VACUITY. If the engine simply stopped refusing, ACCT-01 would still pass.
  const harness = await world();
  const { status, body } = await post(harness, {
    action: "upsert_pet", pet: { sourceId: "bruno", name: "Bruno", species: "dog", vaccinationStatus: "verified" },
  });
  assert.equal(status, 201, JSON.stringify(body).slice(0, 300));
  assert.equal(harness.sqlite.prepare("SELECT vaccination_status v FROM canonical_pets WHERE customer_id=?").get(CUSTOMER).v, "pending",
    "the pet saved; an owner-supplied \"verified\" is stored as the claim it is, not as a staff verification");
});

test("ACCT-03: the sweep - every sibling refusal in the same engine reaches the caller too", async () => {
  const harness = await world();
  // A second account holding a number, so the profile branch's own refusal is reachable.
  harness.sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES ('CUS-OTHER','blr','Other Person','9800000999',NULL,NULL,'customer_app','{}',1,1)").run();
  const cases = [
    [{ action: "upsert_pet", pet: { sourceId: "x", name: "", species: "dog", vaccinationStatus: "verified" } }, 400, "Pet name is required"],
    [{ action: "upsert_pet", pet: { sourceId: "x", name: "Bruno", species: "dragon", vaccinationStatus: "verified" } }, 400, "Pet species must be dog, cat or other"],
    [{ action: "upsert_pet", pet: { sourceId: "x", name: "Bruno", species: "dog", vaccinationStatus: "verified", ageYears: 99 } }, 400, "Pet age must be between 0 and 40 years"],
    [{ action: "upsert_address", address: { label: "Home", line1: "", city: "Bengaluru" } }, 400, "Address line 1 is required"],
    [{ action: "update_profile", profile: { name: "Asha Rao", primaryPhone: "9800000999" } }, 409, "That phone number is already recorded on another PawSpace account"],
    [{ action: "teleport_pet" }, 400, "Unsupported customer account action"],
  ];
  for (const [payload, status, message] of cases) {
    const result = await post(harness, payload);
    assert.equal(result.status, status, `${payload.action}: ${JSON.stringify(result.body).slice(0, 200)}`);
    assert.equal(result.body.error, message, `${payload.action} must explain itself`);
  }
});

test("ACCT-04: an unknown customer is still refused without leaking anything else", async () => {
  const harness = await world();
  const route = await import("../app/api/customer-account/route.ts");
  const response = await route.POST(new Request(`${ORIGIN}/api/customer-account`, {
    method: "POST", headers: { "content-type": "application/json", cookie: harness.cookie },
    body: JSON.stringify({ customerId: "CUS-SOMEONE-ELSE", action: "upsert_pet", idempotencyKey: crypto.randomUUID(), pet: { sourceId: "x", name: "Bruno", species: "dog" } }),
  }));
  assert.equal(response.status >= 400, true, "another customer's record is not writable");
  const body = await response.json();
  assert.equal(String(body.error).includes("Bruno"), false, "and the refusal echoes nothing back");
});
