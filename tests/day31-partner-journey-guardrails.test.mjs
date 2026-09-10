/*
 * Day-31 cross-module test 3: the partner lifecycle where it touches WORK and MONEY.
 *
 * onboarding application -> mandatory verifications -> assignment eligibility -> expiry boundary ->
 * revocation -> payout beneficiary authorisation -> maker/checker separation on the payout itself.
 *
 * Two separate questions are deliberately asked of the same partner, because the platform answers
 * them in two different modules and they must not drift:
 *
 *   may this partner take NEW WORK?     lib/provider-assignment-eligibility.ts
 *   may MONEY leave to this partner?    lib/payout-beneficiary-verification.ts
 *
 * They are correctly NOT the same answer - a lapsed police verification must stop new jobs without
 * confiscating pay already earned - so each is pinned separately rather than assumed to follow the
 * other.
 *
 * NOTE ON ENVIRONMENT: this suite runs WITHOUT PAWSPACE_LOCAL_PREVIEW. lib/provider-assignment-
 * eligibility.ts grants an "uat_seed_fixture_exemption" to any provider carrying a capacity profile
 * when NODE_ENV=test AND PAWSPACE_LOCAL_PREVIEW=on, so a suite that sets that flag would let an
 * entirely unverified partner through and prove nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world } from "./helpers/execution-harness.mjs";

installWorkersHooks("__D31_PARTNER_DB__", "__D31_PARTNER_ENV__");

const PROVIDER = "PRV-D31-001";
const APPLICATION = "APP-D31-001";
const DAY = 86400000;

async function seedPartner({ vertical = "grooming" } = {}) {
  const { sqlite, db } = world("__D31_PARTNER_DB__", "__D31_PARTNER_ENV__");
  const mandate = await import("../lib/provider-verification-mandate.ts");
  const eligibility = await import("../lib/provider-assignment-eligibility.ts");
  await mandate.ensureVerificationMandateTables(db);
  await mandate.seedDefaultMandates(db);

  const now = Date.now();
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_onboarding_applications (id TEXT PRIMARY KEY,provider_id TEXT,vertical_key TEXT NOT NULL,country_code TEXT NOT NULL,region_code TEXT,city_code TEXT,status TEXT NOT NULL,locale_code TEXT NOT NULL,basic_info_json TEXT NOT NULL,policy_ref TEXT,quiz_version_ref TEXT,verification_status TEXT NOT NULL DEFAULT 'not_started',quiz_status TEXT NOT NULL DEFAULT 'not_started',interview_status TEXT NOT NULL DEFAULT 'not_started',human_decision TEXT,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO provider_onboarding_applications (id,provider_id,vertical_key,country_code,city_code,status,locale_code,basic_info_json,created_by,created_at,updated_at) VALUES (?,?,?,'IN','blr','approved','en','{}','ops@pawspace.in',?,?)")
    .run(APPLICATION, PROVIDER, vertical, now, now);

  const { ensureProviderCapacityTables } = await import("../lib/provider-capacity-governance.ts");
  await ensureProviderCapacityTables(db);
  sqlite.prepare("INSERT OR REPLACE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,effective_from,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(PROVIDER, "blr", "Kiran G", "in_house", '["grooming"]', '["blr-east"]', String(now), "ops@pawspace.in", now);

  const category = mandate.verificationCategoryForVertical(vertical);
  const required = await mandate.requiredVerifications(db, category);
  return { sqlite, db, mandate, eligibility, required, now };
}

/** Bring every mandatory verification current, the way onboarding sign-off does. */
async function verifyAll(db, mandate, required, expiresAt) {
  for (const type of required) {
    await mandate.recordVerificationValidity(db, {
      applicationId: APPLICATION, verificationType: type, status: "verified",
      expiresAt, actorId: "ops@pawspace.in", note: "Day-31 onboarding sign-off",
    });
  }
}

test("a partner with no verification on file cannot be given work", async () => {
  const { db, eligibility } = await seedPartner();
  const verdict = await eligibility.providerAssignmentBlock(db, PROVIDER);
  assert.equal(verdict.blocked, true);
  assert.ok(verdict.outstanding.length > 0 || verdict.reasons.length > 0);
});

test("a fully verified partner is assignable, and every mandate is genuinely evaluated", async () => {
  const { db, mandate, eligibility, required, now } = await seedPartner();
  assert.ok(required.length > 0, "the vertical must actually mandate something");
  await verifyAll(db, mandate, required, now + 180 * DAY);

  const verdict = await eligibility.providerAssignmentBlock(db, PROVIDER);
  assert.equal(verdict.blocked, false, `blocked for: ${JSON.stringify(verdict.outstanding)}`);
  assert.equal(verdict.evaluated, true, "an exemption is not an evaluation");
  assert.equal(verdict.reasons[0], "all_mandatory_verifications_current");
});

test("verification expiry blocks new work at the boundary, not a day late", async () => {
  /*
   * The instant a mandate lapses is the interesting one. A partner whose police verification
   * expires at 09:00 must not be handed a 09:00 job.
   */
  const { db, mandate, eligibility, required, now } = await seedPartner();
  const expiry = now + 30 * DAY;
  await verifyAll(db, mandate, required, expiry);

  assert.equal((await eligibility.providerAssignmentBlock(db, PROVIDER, expiry - 1)).blocked, false,
    "still current one millisecond before expiry");
  const atExpiry = await eligibility.providerAssignmentBlock(db, PROVIDER, expiry);
  assert.equal(atExpiry.blocked, true, "an expired mandate must block work the moment it expires");
  assert.ok(atExpiry.outstanding.some((item) => item.state === "expired"));
});

test("candidate matching fails closed - a blocked partner never survives the filter", async () => {
  const { db, mandate, eligibility, required, now } = await seedPartner();
  await verifyAll(db, mandate, required, now + 30 * DAY);
  const pool = [{ id: PROVIDER }, { id: "PRV-D31-GHOST" }, { id: "" }];
  const assignable = await eligibility.filterAssignableProviders(db, pool, now);
  assert.deepEqual(assignable.map((p) => p.id), [PROVIDER],
    "only the genuinely verified partner may stay in the candidate set");
});

test("revoking a mandate removes the partner from new work immediately", async () => {
  const { db, mandate, eligibility, required, now } = await seedPartner();
  await verifyAll(db, mandate, required, now + 180 * DAY);
  assert.equal((await eligibility.providerAssignmentBlock(db, PROVIDER, now)).blocked, false);

  const outcome = await eligibility.revokeProviderVerification(db, {
    providerId: PROVIDER, verificationType: required[0],
    reason: "Day-31: background check came back adverse", actorId: "ops@pawspace.in", now,
  });
  assert.equal(outcome.removedFromMatching, true);
  assert.equal((await eligibility.providerAssignmentBlock(db, PROVIDER, now)).blocked, true,
    "a revoked mandate must stop new work at once");
});

/* ---------------------------------------------------------------------------------------------
 * MONEY SIDE. Same partner, different question: may funds leave the platform to them?
 * ------------------------------------------------------------------------------------------- */

async function seedPayoutBeneficiary({ bankKycStatus = "verified", bankKycExpiresAt = null, profileStatus = "active", bindings = true } = {}) {
  const seeded = await seedPartner();
  const { sqlite, db, mandate, required, now } = seeded;
  await verifyAll(db, mandate, required, now + 180 * DAY);
  await mandate.recordVerificationValidity(db, {
    applicationId: APPLICATION, verificationType: "bank_kyc", status: bankKycStatus,
    expiresAt: bankKycExpiresAt, actorId: "finance@pawspace.in", note: "Day-31 bank KYC",
  });
  const { ensureProviderCommissionTables } = await import("../lib/provider-commission-governance.ts");
  await ensureProviderCommissionTables(db).catch(() => {});
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_compensation_profiles (provider_id TEXT PRIMARY KEY,engagement_model TEXT NOT NULL DEFAULT 'full_time',default_commission_mode TEXT,default_commission_value REAL,razorpayx_contact_id TEXT,razorpayx_fund_account_id TEXT,status TEXT NOT NULL DEFAULT 'active',reason TEXT,updated_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT OR REPLACE INTO provider_compensation_profiles (provider_id,engagement_model,razorpayx_contact_id,razorpayx_fund_account_id,status,updated_by,created_at,updated_at) VALUES (?,'commission',?,?,?,'finance@pawspace.in',?,?)")
    .run(PROVIDER, bindings ? "cont_D31TEST" : null, bindings ? "fa_D31TEST" : null, profileStatus, now, now);
  return seeded;
}

test("a fully banked, verified partner is authorised for payout and the authorisation is evidenced", async () => {
  const { db } = await seedPayoutBeneficiary();
  const { assertActiveVerifiedPayoutBeneficiary } = await import("../lib/payout-beneficiary-verification.ts");
  const beneficiary = await assertActiveVerifiedPayoutBeneficiary(db, PROVIDER);
  assert.equal(beneficiary.verificationStatus, "verified");
  assert.equal(beneficiary.razorpayxFundAccountId, "fa_D31TEST");
  assert.match(beneficiary.snapshotSha256, /^[a-f0-9]{64}$/,
    "the authorisation must carry a tamper-evident snapshot, not just a boolean");
});

test("every way a beneficiary can be unfit stops the money", async () => {
  const { assertActiveVerifiedPayoutBeneficiary } = await import("../lib/payout-beneficiary-verification.ts");
  const cases = [
    ["bank KYC never verified", { bankKycStatus: "pending" }],
    ["bank KYC failed", { bankKycStatus: "failed" }],
    ["bank KYC expired", { bankKycStatus: "verified", bankKycExpiresAt: Date.now() - DAY }],
    ["compensation profile suspended", { profileStatus: "suspended" }],
    ["no RazorpayX contact/fund account", { bindings: false }],
  ];
  for (const [label, options] of cases) {
    const { db } = await seedPayoutBeneficiary(options);
    /*
     * The expected reason is asserted, not just "it threw". An earlier revision of this case passed
     * against a schema fault - the guard was dying on a missing column for EVERY input, refusing
     * fit and unfit beneficiaries alike, and a bare assert.rejects(..., Error) called that a pass.
     */
    await assert.rejects(
      () => assertActiveVerifiedPayoutBeneficiary(db, PROVIDER),
      (error) => {
        assert.match(error.message, /beneficiary|bank_kyc/i,
          `${label}: refused for the wrong reason - ${error.message}`);
        assert.doesNotMatch(error.message, /no such column|no such table|SQLITE/i,
          `${label}: this is a schema fault, not a governance refusal - ${error.message}`);
        return true;
      },
      `money must not be released when: ${label}`,
    );
  }
});

test("the payout authorisation query matches the schema it reads", async () => {
  /*
   * The defect this pins was invisible to the build, to typecheck and to every existing test:
   * lib/payout-beneficiary-verification.ts selected and ordered by provider_verifications.
   * verified_at, and that column was created nowhere. Every call died on "no such column", which is
   * the gate app/api/partner-finance/route.ts puts in front of BOTH level-2 money approvals - so no
   * partner payout and no order commission could reach level 2 at all.
   */
  const { sqlite, db } = await seedPayoutBeneficiary();
  const columns = new Set(sqlite.prepare("PRAGMA table_info(provider_verifications)").all().map((c) => c.name));
  for (const column of ["status", "verified_at", "expires_at"]) {
    assert.ok(columns.has(column), `payout authorisation reads provider_verifications.${column}`);
  }
  const row = sqlite.prepare("SELECT verified_at,status FROM provider_verifications WHERE application_id=? AND verification_type='bank_kyc'").get(APPLICATION);
  assert.equal(row.status, "verified");
  assert.ok(Number(row.verified_at) > 0, "a verified check must record WHEN it passed, for the payout evidence trail");
});

test("a lapsed SAFETY mandate stops new work without confiscating pay already earned", async () => {
  /*
   * These two answers are deliberately different and both matter. Blocking the payout as well
   * would mean the platform withholds wages for a paperwork lapse; not blocking the work would
   * mean sending an unverified person to a customer's home.
   */
  const { db, eligibility, required, now } = await seedPayoutBeneficiary();
  const { assertActiveVerifiedPayoutBeneficiary } = await import("../lib/payout-beneficiary-verification.ts");
  const safetyMandate = required.find((type) => type !== "bank_kyc");
  assert.ok(safetyMandate, "the vertical must mandate something other than banking");

  await eligibility.revokeProviderVerification(db, {
    providerId: PROVIDER, verificationType: safetyMandate,
    reason: "Day-31: safety document lapsed", actorId: "ops@pawspace.in", now,
  });

  assert.equal((await eligibility.providerAssignmentBlock(db, PROVIDER, now)).blocked, true,
    "no new work while a safety mandate is lapsed");
  const stillPayable = await assertActiveVerifiedPayoutBeneficiary(db, PROVIDER, now);
  assert.equal(stillPayable.verificationStatus, "verified",
    "earned pay must not be held hostage to an unrelated document lapse");
});

test("revoking BANK KYC does stop the money", async () => {
  const { db, eligibility, now } = await seedPayoutBeneficiary();
  const { assertActiveVerifiedPayoutBeneficiary } = await import("../lib/payout-beneficiary-verification.ts");
  await eligibility.revokeProviderVerification(db, {
    providerId: PROVIDER, verificationType: "bank_kyc",
    reason: "Day-31: bank account reported compromised", actorId: "finance@pawspace.in", now,
  });
  await assert.rejects(() => assertActiveVerifiedPayoutBeneficiary(db, PROVIDER, now), Error,
    "a revoked bank account must not receive a payout");
});
