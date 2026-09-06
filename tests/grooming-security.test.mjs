/**
 * Grooming security — EXECUTED. Gateway permissions and trusted-identity ownership.
 *
 * WHAT THIS FILE USED TO BE. ONE test that read nine files as strings and made about thirty
 * `assert.match` calls against them: that `lib/api-gateway.ts` mentions "/api/identity-bindings", that
 * `lib/server-auth.ts` mentions "requireCustomerOwnership", that `lib/identity-binding.ts` contains
 * the literal `verification_state='verified'`. Every one of those is satisfied by the phrase existing.
 * The ownership guards are the only thing standing between one customer and another customer's
 * grooming booking, and the file never called them.
 *
 * The single test is now split into four EXECUTED ones — the count goes up, never down — each driving
 * the real guard and asserting on the refusal or the row.
 *
 * Every request is built on https://ops.pawspace.example. On localhost `npm test` resolves a
 * development-preview superuser holding ["*"], and every ownership assertion below would pass
 * vacuously against it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1 } from "./helpers/taxi-harness.mjs";

installWorkersHooks("__GROOM_SEC_DB__", "__GROOM_SEC_ENV__");

const auth = await import("../lib/server-auth.ts");
const bindings = await import("../lib/identity-binding.ts");

const OWN_CUSTOMER = "CUST-OWN";
const OTHER_CUSTOMER = "CUST-OTHER";
const OWN_PROVIDER = "groom_arun";
const OTHER_PROVIDER = "groom_kiran";

async function securityWorld() {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__GROOM_SEC_DB__ = db;
  globalThis.__GROOM_SEC_ENV__ = {};
  await auth.ensureSecurityTables(db);
  await bindings.ensureIdentityBindingTables(db);
  return { sqlite, db };
}

/** A customer-session actor: no staff permissions, identified by its principal key. */
const customerActor = (principalKey) => ({
  email: principalKey, name: "Customer", roleCode: "customer",
  permissions: ["pricing.view", "scheduling.book"], developmentPreview: false,
  identitySource: "customer_otp", principalType: "phone", principalKey,
});

/** A provider-session actor: sees assigned jobs, manages nothing. */
const providerActor = (principalKey) => ({
  email: principalKey, name: "Provider", roleCode: "service_provider",
  permissions: ["bookings.view", "scheduling.view", "communications.call", "self_service.view"],
  developmentPreview: false, identitySource: "partner_otp", principalType: "phone", principalKey,
});

/** What a thrown control Response says, or null when the call was allowed. */
async function denial(promise) {
  try { await promise; return null; }
  catch (error) {
    if (!(error instanceof Response)) throw error;
    return { status: error.status, body: await error.json().catch(() => null) };
  }
}

// ---------------------------------------------------------------------------------------------
test("Grooming security uses explicit gateway permissions and trusted identity ownership", async () => {
  // The gateway's real decisions, from authorizeApiRequest rather than from its source text.
  const gateway = await import("../lib/api-gateway.ts");
  const { db } = await securityWorld();
  const decide = async (path, method = "GET") => {
    const decision = await gateway.authorizeApiRequest(new Request(`https://ops.pawspace.example${path}`, method === "GET" ? {} : { method, headers: { "content-type": "application/json" } }), { DB: db });
    return decision instanceof Response ? { refused: decision.status } : { permission: decision.permission };
  };

  // Each grooming surface is MAPPED — a guarded route must never resolve to `null` (public).
  for (const path of ["/api/identity-bindings", "/api/partner-grooming-jobs", "/api/grooming-booking-change", "/api/grooming-finance"]) {
    const decision = await decide(path);
    assert.ok(decision.refused || decision.permission !== null,
      `${path} must require a permission, not be public: ${JSON.stringify(decision)}`);
  }

  // CONTRAST, so "must require a permission" is not vacuous: a genuinely public surface resolves to
  // permission null and is NOT refused. authorizeApiRequest refuses a guarded route before it reports
  // which permission it wanted, so the mapping is proven by the refusal plus this contrast.
  const publicQuote = await decide("/api/taxi-commercial");
  assert.equal(publicQuote.refused, undefined, "a public quote surface must not be refused");
  assert.equal(publicQuote.permission, null, "and carries no permission requirement");
  for (const path of ["/api/identity-bindings", "/api/grooming-finance", "/api/partner-grooming-jobs"]) {
    const decision = await decide(path);
    assert.ok(decision.refused === 401 || decision.refused === 403,
      `${path} must refuse an anonymous caller, unlike the public surface above: ${JSON.stringify(decision)}`);
  }

  // The customer role really is limited to pricing + booking — this is the role a customer session
  // gets, so the value matters, not the spelling.
  const { defaultRoles } = await import("../lib/platform-security.ts");
  const customer = defaultRoles.find((role) => role.code === "customer");
  assert.deepEqual([...customer.permissions].sort(), ["pricing.view", "scheduling.book"],
    "a customer identity must hold nothing that could read another customer's data");
});

// ---------------------------------------------------------------------------------------------
test("Grooming security: customer ownership is enforced against the binding, not the request", async () => {
  const { db } = await securityWorld();

  // A verified binding for OWN_CUSTOMER, created through the real upsert path.
  await bindings.upsertIdentityBinding(db, {
    identitySource: "customer_otp", principalType: "phone", principalKey: "+919800000001",
    subjectType: "customer", subjectId: OWN_CUSTOMER, verificationState: "verified",
    actorId: "otp@pawspace.test", reason: "verified OTP sign-in",
  });
  const actor = customerActor("+919800000001");

  // Its OWN customer id is allowed — non-vacuity first.
  assert.ok(await auth.requireCustomerOwnership(db, actor, OWN_CUSTOMER), "a bound customer reaches its own record");

  // ANOTHER customer's id is refused 403. This is the guard the source-text version only named.
  const cross = await denial(auth.requireCustomerOwnership(db, actor, OTHER_CUSTOMER));
  assert.equal(cross?.status, 403, `a customer must not reach another customer's record: ${JSON.stringify(cross)}`);

  // An UNBOUND principal is refused even for a customer id that exists.
  const stranger = await denial(auth.requireCustomerOwnership(db, customerActor("+919800000099"), OWN_CUSTOMER));
  assert.equal(stranger?.status, 403, "an unbound principal owns nothing");

  // A REVOKED binding stops working immediately — the binding is authority, so removing it removes
  // access. `status='revoked'` was previously only a string in the source.
  const live = await bindings.findIdentityBinding(db, { identitySource: "customer_otp", principalType: "phone", principalKey: "+919800000001", subjectType: "customer" });
  assert.ok(live, "the binding is findable before revocation");
  await bindings.revokeIdentityBinding(db, { id: String(live.id), actorId: "ops@pawspace.test", reason: "device lost" });
  const revoked = await denial(auth.requireCustomerOwnership(db, actor, OWN_CUSTOMER));
  assert.equal(revoked?.status, 403, "a revoked binding must not still grant access");
});

// ---------------------------------------------------------------------------------------------
test("Grooming security: an unverified binding is not authority", async () => {
  const { db } = await securityWorld();

  // A binding created as PENDING must not grant anything. findIdentityBinding filters on
  // verification_state='verified', and this is that filter, executed.
  await bindings.upsertIdentityBinding(db, {
    identitySource: "customer_otp", principalType: "phone", principalKey: "+919800000002",
    subjectType: "customer", subjectId: OWN_CUSTOMER, verificationState: "pending",
    actorId: "otp@pawspace.test", reason: "awaiting OTP confirmation",
  });
  const pendingActor = customerActor("+919800000002");
  assert.equal(await bindings.findIdentityBinding(db, { identitySource: "customer_otp", principalType: "phone", principalKey: "+919800000002", subjectType: "customer" }), null,
    "a pending binding is not returned as a usable binding");
  const refused = await denial(auth.requireCustomerOwnership(db, pendingActor, OWN_CUSTOMER));
  assert.equal(refused?.status, 403, "and it must not open the customer record");

  // An EXPIRED verified binding is likewise not authority.
  await bindings.upsertIdentityBinding(db, {
    identitySource: "customer_otp", principalType: "phone", principalKey: "+919800000003",
    subjectType: "customer", subjectId: OWN_CUSTOMER, verificationState: "verified",
    expiresAt: Date.now() - 1000, actorId: "otp@pawspace.test", reason: "short-lived binding",
  });
  const expired = await denial(auth.requireCustomerOwnership(db, customerActor("+919800000003"), OWN_CUSTOMER));
  assert.equal(expired?.status, 403, "an expired binding grants nothing");
});

// ---------------------------------------------------------------------------------------------
test("Grooming security: provider ownership separates a partner from other partners", async () => {
  const { db } = await securityWorld();

  await bindings.upsertIdentityBinding(db, {
    identitySource: "partner_otp", principalType: "phone", principalKey: "+919700000001",
    subjectType: "provider", subjectId: OWN_PROVIDER, verificationState: "verified",
    actorId: "otp@pawspace.test", reason: "verified partner sign-in",
  });
  const partner = providerActor("+919700000001");

  assert.ok(await auth.requireProviderOwnership(db, partner, OWN_PROVIDER), "a partner reaches its own provider record");

  const cross = await denial(auth.requireProviderOwnership(db, partner, OTHER_PROVIDER));
  assert.equal(cross?.status, 403, `a partner must not reach another partner's jobs: ${JSON.stringify(cross)}`);

  // A partner is NOT staff: it must not satisfy the provider-management predicate that lets an operator
  // through, which is what keeps a provider from lifting a restriction staff placed on it.
  assert.equal(auth.actorManagesProviders(partner), false, "a partner session does not manage providers");
  assert.equal(auth.actorManagesProviders({ ...partner, permissions: ["providers.manage"] }), true,
    "and an operator holding providers.manage does — non-vacuity for the line above");

  // A customer principal cannot borrow a provider binding: the subject_type is part of the lookup.
  const asCustomer = await denial(auth.requireProviderOwnership(db, customerActor("+919700000001"), OWN_PROVIDER));
  assert.equal(asCustomer?.status, 403, "the same phone on a customer session is not the partner");
});
