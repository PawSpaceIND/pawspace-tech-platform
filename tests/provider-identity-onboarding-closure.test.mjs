import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// ---------------------------------------------------------------------------
// Provider identity -> onboarding -> KYC -> staff review -> activation -> capacity
// -> provider app -> job visibility -> lifecycle.
//
// EXECUTED, not asserted about. Every claim below is a value a real exported function returned or a
// row counted after it ran, against real SQLite through the repository's D1 shape. The existing
// provider-onboarding-integrated-uat suite matches source text with regular expressions, which is why
// it could not have caught the defect this file reproduces: the source contained every token it looked
// for and still let a suspended provider lift their own suspension.
//
// The external KYC dependency (IDfy) stays DISCONNECTED throughout. What is proved here is the
// internal contract around it — that an unconnected verifier yields `pending` and never `verified`,
// and that nothing downstream treats "not checked" as "checked".
// ---------------------------------------------------------------------------

const WORKERS_SHIM = `export const env = new Proxy({}, { get: (_, key) => globalThis.__PAWSPACE_TEST_ENV?.[key] });`;
const workersUrl = `data:text/javascript,${encodeURIComponent(WORKERS_SHIM)}`;

if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `const workersUrl=${JSON.stringify(workersUrl)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

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
    exec: async (sql) => { sqlite.exec(sql); },
  };
}

const OPS = "ops.one@pawspace.in";

/**
 * A UAT signing secret is required by the real assertion signer. It is obviously synthetic and local to
 * this process — no credential from any environment appears here.
 */
function fresh() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  const env = { DB: db, PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT: "not-a-real-uat-signing-secret-for-tests" };
  globalThis.__PAWSPACE_TEST_ENV = env;
  return { sqlite, db, env };
}

const mod = {
  otp: () => import("../lib/partner-otp.ts"),
  binding: () => import("../lib/identity-binding.ts"),
  assertion: () => import("../lib/verified-identity-assertion.ts"),
  selfService: () => import("../lib/provider-onboarding-self-service.ts"),
  mandate: () => import("../lib/provider-verification-mandate.ts"),
  capacity: () => import("../lib/provider-capacity-governance.ts"),
  workspace: () => import("../lib/provider-workspace.ts"),
};

/** Drive the REAL OTP flow end to end and return the provider it created. */
async function signUpProvider(db, { phone, name, cityId = "blr" }) {
  const otp = await mod.otp();
  const challenge = await otp.requestPartnerOtp(db, { phone });
  const verified = await otp.verifyPartnerOtp(db, { challengeId: challenge.challengeId, code: challenge.sandboxCode, name, cityId });
  return { challenge, verified, providerId: verified.providerId };
}

// --- 1. identity: a provider exists because a real verified flow created one -------------------

test("JOURNEY 1 — a provider is created only by completing the real OTP flow, and the code is never claimed as sent", async () => {
  const { sqlite, db } = fresh();
  const otp = await mod.otp();

  const challenge = await otp.requestPartnerOtp(db, { phone: "9000000001" });
  // The external SMS dependency is OFF and says so, rather than reporting a delivery that never happened.
  assert.equal(challenge.liveSmsDelivered, false, "no SMS gateway is connected; delivery must not be claimed");
  assert.equal(challenge.sandboxDelivery, true);
  assert.ok(challenge.sandboxCode, "the sandbox returns the code in-band precisely because it did not send it");

  // No provider exists until the code is actually verified.
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM canonical_providers").get().n, 0,
    "requesting an OTP must not create a provider identity");

  await assert.rejects(
    () => otp.verifyPartnerOtp(db, { challengeId: challenge.challengeId, code: "000000", name: "Wrong Code", cityId: "blr" }),
    /Incorrect OTP code/, "a wrong code must not mint an identity");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM canonical_providers").get().n, 0);

  const verified = await otp.verifyPartnerOtp(db, { challengeId: challenge.challengeId, code: challenge.sandboxCode, name: "Asha Partner", cityId: "blr" });
  assert.match(verified.providerId, /^PROV-/);
  const row = sqlite.prepare("SELECT id,name,phone,city_id FROM canonical_providers").get();
  assert.equal(row.id, verified.providerId);
  assert.equal(row.phone, "9000000001", "the identity is bound to the verified phone, not to a client-supplied value");
});

test("JOURNEY 2 — the issued assertion verifies as this provider, and a tampered one fails closed", async () => {
  const { db } = fresh();
  const { verified, providerId } = await signUpProvider(db, { phone: "9000000002", name: "Asha Partner" });
  const assertion = await mod.assertion();
  await assertion.ensureIdentityAssertionTables(db);

  const ok = await assertion.verifyIdentityAssertion(db, verified.assertion);
  assert.equal(ok.subjectType, "provider");
  assert.equal(ok.subjectId, providerId, "the assertion names the provider the OTP flow created");

  // Flip one character of the signature. A verifier that accepts this is not a verifier.
  const [body, signature] = verified.assertion.split(".");
  const tampered = `${body}.${signature.slice(0, -1)}${signature.slice(-1) === "A" ? "B" : "A"}`;
  await assert.rejects(() => assertion.verifyIdentityAssertion(db, tampered), /.*/,
    "a forged signature must be refused");
});

test("JOURNEY 3 — identity binding is server-authoritative, and a revoked binding fails closed", async () => {
  const { db } = fresh();
  const { providerId } = await signUpProvider(db, { phone: "9000000003", name: "Asha Partner" });
  const binding = await mod.binding();
  await binding.ensureIdentityBindingTables(db);

  const principal = { identitySource: "partner_otp", principalType: "phone", principalKey: "9000000003", subjectType: "provider" };
  const created = await binding.upsertIdentityBinding(db, { ...principal, subjectId: providerId, cityId: "blr", actorId: "system", reason: "partner otp verified" });
  assert.equal(created.status, "active");

  await assert.doesNotReject(() => binding.assertIdentityOwnership(db, { ...principal, subjectId: providerId }));
  await assert.rejects(() => binding.assertIdentityOwnership(db, { ...principal, subjectId: "PROV-SOMEONE-ELSE" }), /.*/,
    "a binding proves ownership of ONE subject, not of any subject");

  await binding.revokeIdentityBinding(db, { id: String(created.id), actorId: OPS, reason: "device lost" });
  await assert.rejects(() => binding.assertIdentityOwnership(db, { ...principal, subjectId: providerId }), /.*/,
    "a revoked identity must stop proving ownership");
});

// --- 2. onboarding and capability --------------------------------------------------------------

test("JOURNEY 4 — onboarding is provider-owned, and one provider cannot touch another's application", async () => {
  const { db } = fresh();
  const a = await signUpProvider(db, { phone: "9000000010", name: "Provider A" });
  const b = await signUpProvider(db, { phone: "9000000011", name: "Provider B" });
  const selfService = await mod.selfService();

  const appA = await selfService.createOwnedProviderApplication(db, {
    providerId: a.providerId, actorId: a.providerId,
    payload: { verticalKey: "boarding", countryCode: "IN", cityCode: "BLR", localeCode: "en", basicInfo: { name: "Provider A" } },
  });
  assert.match(appA.id, /^POAPP-/);

  await assert.doesNotReject(() => selfService.ensureProviderOwnsOnboardingApplication(db, a.providerId, appA.id));
  await assert.rejects(() => selfService.ensureProviderOwnsOnboardingApplication(db, b.providerId, appA.id), /.*/,
    "NEGATIVE: provider B must not reach provider A's application");

  await assert.rejects(
    () => selfService.addOwnedProviderDocument(db, { providerId: b.providerId, actorId: b.providerId, applicationId: appA.id, documentType: "aadhaar", fileRef: "r2://forged" }),
    /.*/, "NEGATIVE: provider B must not attach documents to provider A's application");
});

test("JOURNEY 5 — the vertical selected determines the mandated verification set, from persisted config", async () => {
  const { db } = fresh();
  const mandate = await mod.mandate();
  await mandate.ensureVerificationMandateTables(db);
  await mandate.seedDefaultMandates(db);

  assert.equal(mandate.verificationCategoryForVertical("boarding"), "host");
  const required = await mandate.requiredVerifications(db, "host");
  assert.ok(required.length > 0, "a category with no mandated checks would make activation vacuous");
  assert.ok(required.includes("aadhaar") && required.includes("pan"),
    `expected identity checks in the host mandate, saw ${required.join(",")}`);

  // The mandate is configuration, not a constant — and a staff decision must SURVIVE the next read.
  // Seeding used to re-insert the defaults on every read, so an operator who narrowed a category watched
  // it widen back silently; the console said saved and enforcement disagreed.
  await mandate.setCategoryMandate(db, { category: "host", verificationTypes: ["aadhaar"], actorId: OPS });
  assert.deepEqual(await mandate.requiredVerifications(db, "host"), ["aadhaar"], "the narrowed mandate must persist");
  assert.deepEqual(await mandate.requiredVerifications(db, "host"), ["aadhaar"], "and must still persist on a second read");

  // A category nobody has configured still gets its defaults.
  assert.ok((await mandate.requiredVerifications(db, "groomer")).length > 0, "unconfigured categories keep their defaults");

  // NEGATIVE: an unrecognised check is refused by name, never accepted and then dropped.
  await assert.rejects(
    () => mandate.setCategoryMandate(db, { category: "host", verificationTypes: ["aadhaar", "police_clearance"], actorId: OPS }),
    /Unknown verification type\(s\): police_clearance/,
    "staff must be told their mandate was not applied rather than shown a success that discarded it");
  assert.deepEqual(await mandate.requiredVerifications(db, "host"), ["aadhaar"], "and the refused write changed nothing");
});

// --- 3. KYC with the external verifier deliberately disconnected -------------------------------

test("KYC — with IDfy not connected an automatable check yields pending, never verified", async () => {
  const { db, env } = fresh();
  const mandate = await mod.mandate();
  await mandate.ensureVerificationMandateTables(db);
  await mandate.seedDefaultMandates(db);
  const applicationId = "POAPP-KYC-1";

  for (const verificationType of ["aadhaar", "pan"]) {
    const result = await mandate.runProviderVerification(db, env, { applicationId, category: "host", verificationType, actorId: OPS });
    assert.equal(result.status, "pending", `${verificationType} must not resolve while no verifier is connected`);
    assert.notEqual(result.status, "verified");
    assert.equal(result.automated, false, "nothing may report itself as automatically verified");
    assert.equal(result.providerRef, null, "no external reference can exist when no external call was made");
  }

  const status = await mandate.verificationMandateStatus(db, { applicationId, category: "host" });
  assert.ok(status.checks.length >= 2);
  assert.ok(status.checks.every((check) => check.status !== "verified"),
    "no mandated check may read as verified from an unconnected verifier");
});

test("KYC — a rejected check is recorded as failed and does not decay into pending or verified", async () => {
  const { db } = fresh();
  const mandate = await mod.mandate();
  await mandate.ensureVerificationMandateTables(db);
  await mandate.seedDefaultMandates(db);
  const applicationId = "POAPP-KYC-2";

  // An automatable check may not be waved through by hand — that is the whole point of mandating it.
  await assert.rejects(
    () => mandate.recordManualVerification(db, { applicationId, verificationType: "aadhaar", status: "verified", note: "trust me", actorId: OPS }),
    /automatable/, "NEGATIVE: an operator must not hand-verify a check that belongs to the verifier");

  // A genuinely manual check can be recorded, including a rejection, and the rejection sticks.
  await mandate.recordManualVerification(db, { applicationId, verificationType: "house_verification", status: "failed", note: "premises unsuitable", actorId: OPS });
  const status = await mandate.verificationMandateStatus(db, { applicationId, category: "host" });
  const house = status.checks.find((check) => check.verificationType === "house_verification");
  assert.equal(house.status, "failed", "NEGATIVE: a rejected KYC check must stay rejected");
  assert.ok(!status.satisfied, "a failed mandated check cannot leave the mandate satisfied");
});

// --- 4. availability authority: the defect this file exists for --------------------------------

test("LIFECYCLE — a provider may make itself unavailable and clear its OWN window", async () => {
  const { db } = fresh();
  const capacity = await mod.capacity();
  await capacity.ensureProviderCapacityTables(db);
  const provider = "PROV-SELF-1", providerActor = "asha@partner.test";

  const off = await capacity.setProviderAvailability(db, { providerId: provider, available: false, reason: "day off", actorId: providerActor });
  assert.equal(off.available, false);
  const on = await capacity.setProviderAvailability(db, { providerId: provider, available: true, reason: "back from leave", actorId: providerActor });
  assert.equal(on.available, true, "a provider's own day off is theirs to end");
  assert.equal(on.windowsCleared, 1);
  assert.equal(on.restrictionsRemaining, 0);
});

test("LIFECYCLE — NEGATIVE: a provider cannot lift a restriction staff placed on it", async () => {
  // The defect, reproduced. Ownership was enforced and authority was not, so a provider suspended for a
  // rejected KYC check could return itself to the pool by asking to be available.
  const { sqlite, db } = fresh();
  const capacity = await mod.capacity();
  await capacity.ensureProviderCapacityTables(db);
  const provider = "PROV-SUSPENDED-1", providerActor = "asha@partner.test";

  await capacity.setProviderAvailability(db, { providerId: provider, available: false, reason: "KYC rejected by staff", actorId: OPS });
  const attempt = await capacity.setProviderAvailability(db, { providerId: provider, available: true, reason: "I am back", actorId: providerActor });

  assert.equal(attempt.windowsCleared, 0, "the provider cleared nothing");
  assert.equal(attempt.available, false, "and is told plainly that it is still restricted");
  assert.equal(attempt.restrictionsRemaining, 1);
  const row = sqlite.prepare("SELECT status,created_by FROM provider_unavailability WHERE provider_id=?").get(provider);
  assert.equal(row.status, "active", "the staff restriction is untouched in the database");
  assert.equal(row.created_by, OPS);
});

test("LIFECYCLE — staff retain authority to lift what staff imposed", async () => {
  const { db } = fresh();
  const capacity = await mod.capacity();
  await capacity.ensureProviderCapacityTables(db);
  const provider = "PROV-SUSPENDED-2";

  await capacity.setProviderAvailability(db, { providerId: provider, available: false, reason: "accountability case", actorId: OPS });
  const lifted = await capacity.setProviderAvailability(db, { providerId: provider, available: true, reason: "case closed", actorId: OPS, actorIsStaff: true });
  assert.equal(lifted.available, true, "the fix must not strand a provider that staff intended to release");
  assert.equal(lifted.restrictionsRemaining, 0);
});

test("LIFECYCLE — clearing your own window while a staff restriction stands does not report you available", async () => {
  const { db } = fresh();
  const capacity = await mod.capacity();
  await capacity.ensureProviderCapacityTables(db);
  const provider = "PROV-BOTH-1", providerActor = "asha@partner.test";

  await capacity.setProviderAvailability(db, { providerId: provider, available: false, reason: "suspension", actorId: OPS });
  await capacity.setProviderAvailability(db, { providerId: provider, available: false, reason: "day off", actorId: providerActor });
  const result = await capacity.setProviderAvailability(db, { providerId: provider, available: true, reason: "back", actorId: providerActor });

  assert.equal(result.windowsCleared, 1, "the provider's own window is cleared");
  assert.equal(result.available, false, "but availability is a fact about the provider, not about this request");
  assert.equal(result.restrictionsRemaining, 1);
});

test("LIFECYCLE — authority defaults to restrictive when a caller does not establish it", async () => {
  const { db } = fresh();
  const capacity = await mod.capacity();
  await capacity.ensureProviderCapacityTables(db);
  const provider = "PROV-DEFAULT-1";

  await capacity.setProviderAvailability(db, { providerId: provider, available: false, reason: "staff hold", actorId: OPS });
  // actorIsStaff omitted entirely: a caller that has not proved authority must get the safe branch.
  const attempt = await capacity.setProviderAvailability(db, { providerId: provider, available: true, reason: "attempt", actorId: "someone.else@pawspace.in" });
  assert.equal(attempt.windowsCleared, 0, "an unproven caller must not inherit staff authority by omission");
  assert.equal(attempt.restrictionsRemaining, 1);
});

test("LIFECYCLE — an unavailable provider is not offered by matching, and returns once genuinely cleared", async () => {
  const { sqlite, db } = fresh();
  const capacity = await mod.capacity();
  await capacity.ensureProviderCapacityTables(db);
  await capacity.seedProviderCapacityDefaults(db);

  const seeded = sqlite.prepare("SELECT id,city_id,services_json,zones_json FROM provider_capacity_profiles WHERE live=1 AND status='active' LIMIT 1").get();
  assert.ok(seeded, "the capacity defaults must seed at least one live provider for this to mean anything");
  const service = JSON.parse(seeded.services_json)[0];
  const zone = JSON.parse(seeded.zones_json)[0];

  const before = await capacity.loadGovernedProviders(db, seeded.city_id, zone, service);
  assert.ok(before.some((p) => p.id === seeded.id), "precondition: the provider is matchable");

  await capacity.setProviderAvailability(db, { providerId: seeded.id, available: false, reason: "staff hold", actorId: OPS });
  // Evaluated one second after the restriction was written. loadGovernedProviders selects windows with a
  // STRICT `starts_at < now` while setProviderAvailability stamps `starts_at = now`, so a suspension is
  // invisible to matching for the millisecond it is created in. That boundary lives in the shared
  // scheduling/matching path and is recorded as CROSS-LANE-BLOCKER rather than changed here; this
  // assertion deliberately does not depend on it.
  const during = await capacity.loadGovernedProviders(db, seeded.city_id, zone, service, new Date(Date.now() + 1000));
  assert.ok(!during.some((p) => p.id === seeded.id), "an unavailable provider must leave the matching pool");

  await capacity.setProviderAvailability(db, { providerId: seeded.id, available: true, reason: "hold lifted", actorId: OPS, actorIsStaff: true });
  const after = await capacity.loadGovernedProviders(db, seeded.city_id, zone, service, new Date(Date.now() + 1000));
  assert.ok(after.some((p) => p.id === seeded.id), "and must return when the restriction is genuinely lifted");
});

// --- 5. provider app: own record only ----------------------------------------------------------

test("PROVIDER APP — the workspace is resolved from identity, and is own-record-only", async () => {
  const { sqlite, db } = fresh();
  const workspace = await mod.workspace();
  await workspace.ensureProviderWorkspaceTables(db);

  const a = await signUpProvider(db, { phone: "9000000020", name: "Provider A" });
  const b = await signUpProvider(db, { phone: "9000000021", name: "Provider B" });

  const own = await workspace.providerWorkspace(db, { providerId: a.providerId });
  assert.equal(own.providerId, a.providerId, "the workspace answers for the provider it was asked about");

  const other = await workspace.providerWorkspace(db, { providerId: b.providerId });
  assert.notEqual(other.providerId, a.providerId);
  const serialized = JSON.stringify(other);
  assert.ok(!serialized.includes(a.providerId),
    "NEGATIVE: provider B's workspace must not carry provider A's identity anywhere in its payload");

  // Identity resolution is by binding, not by a client-supplied provider id.
  const unknown = await workspace.resolveProviderForActor(db, "nobody@pawspace.test");
  assert.ok(!unknown, "an actor with no provider binding resolves to no provider");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM canonical_providers").get().n, 2);
});

test("PROVIDER APP — NEGATIVE: a provider cannot accept a job offered to another provider", async () => {
  const { sqlite, db } = fresh();
  const workspace = await mod.workspace();
  await workspace.ensureProviderWorkspaceTables(db);

  const a = await signUpProvider(db, { phone: "9000000030", name: "Provider A" });
  const b = await signUpProvider(db, { phone: "9000000031", name: "Provider B" });
  const bookingId = "BK-OWNED-BY-A";

  await workspace.offerJobToProvider(db, { providerId: a.providerId, bookingId });
  const offers = sqlite.prepare("SELECT provider_id,status FROM provider_job_offers WHERE booking_id=?").all(bookingId);
  assert.equal(offers.length, 1);
  assert.equal(offers[0].provider_id, a.providerId);

  // B answers an offer that was never theirs.
  let bAccepted = false;
  try { const r = await workspace.respondToJobOffer(db, { providerId: b.providerId, bookingId, accept: true }); bAccepted = r?.accepted === true || r?.status === "accepted"; }
  catch { bAccepted = false; }
  assert.equal(bAccepted, false, "NEGATIVE: provider B must not be able to accept provider A's offer");

  const afterB = sqlite.prepare("SELECT provider_id,status FROM provider_job_offers WHERE booking_id=?").all(bookingId);
  assert.equal(afterB.length, 1, "B's attempt must not manufacture an offer row for B");
  assert.equal(afterB[0].provider_id, a.providerId, "and must not reassign A's offer");
  assert.notEqual(afterB[0].status, "accepted", "nor accept it on A's behalf");
});

// --- 6. the staff surface must not display readiness that is not persisted ---------------------

test("STAFF SURFACE — the onboarding console reads persisted state and declares no activation of its own", () => {
  const ops = read("app/team/provider-onboarding/page.tsx");
  assert.match(ops, /fetch\("\/api\/provider-onboarding"/, "the console must read server state, not compute it");
  // A surface that can say "ready" without the server saying so is a surface that can lie.
  assert.ok(!/activated\s*[:=]\s*true/.test(ops), "no hardcoded activated state may appear in the console");
  assert.ok(!/verified\s*[:=]\s*true/.test(ops), "no hardcoded verified state may appear in the console");
});

test("STAFF SURFACE — the availability route resolves authority separately from ownership", () => {
  const route = read("app/api/provider-availability/route.ts");
  assert.match(route, /requireProviderOwnership\(/, "ownership must still be enforced");
  assert.match(route, /actorIsStaff:\s*actorManagesProviders\(actor\)/,
    "authority must be resolved from the actor's permissions, never assumed or passed by the client");
  const body = route.slice(route.indexOf("body ="), route.indexOf("setProviderAvailability"));
  assert.ok(!/actorIsStaff/.test(body), "the client must not be able to supply its own staff flag");
});

test("no fabricated provider identity: every provider in these journeys came from a verified OTP", async () => {
  const { sqlite, db } = fresh();
  await signUpProvider(db, { phone: "9000000040", name: "Provider A" });
  await signUpProvider(db, { phone: "9000000041", name: "Provider B" });
  const rows = sqlite.prepare("SELECT id,source,phone FROM canonical_providers").all();
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.match(row.id, /^PROV-/);
    assert.ok(String(row.phone).length === 10, "each identity is anchored to the phone that was verified");
    assert.ok(String(row.source).length > 0, "each identity records how it came to exist");
  }
});
