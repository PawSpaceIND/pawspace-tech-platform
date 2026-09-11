import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { makeCountingD1 } from "./helpers/d1-harness.mjs";
import { preauthorizeVerifiedPayoutBeneficiary } from "../lib/payout-beneficiary-verification.ts";

test("level-2 payout beneficiary preauthorisation repairs the legacy verification schema before reading it", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const { db } = makeCountingD1(sqlite);
  const now = Date.now();

  sqlite.exec(`
    CREATE TABLE provider_compensation_profiles (provider_id TEXT PRIMARY KEY,status TEXT,razorpayx_contact_id TEXT,razorpayx_fund_account_id TEXT);
    CREATE TABLE provider_onboarding_applications (id TEXT PRIMARY KEY,provider_id TEXT,updated_at INTEGER);
    CREATE TABLE provider_verifications (id TEXT PRIMARY KEY,application_id TEXT,verification_type TEXT,status TEXT,updated_at INTEGER,created_at INTEGER);
    CREATE TABLE partner_payout_instructions (id TEXT PRIMARY KEY,provider_id TEXT,status TEXT,updated_at INTEGER);
  `);
  sqlite.prepare("INSERT INTO provider_compensation_profiles VALUES ('P1','active','cont_1','fa_1')").run();
  sqlite.prepare("INSERT INTO provider_onboarding_applications VALUES ('A1','P1',?)").run(now);
  sqlite.prepare("INSERT INTO provider_verifications VALUES ('V1','A1','bank_kyc','verified',?,?)").run(now - 1000, now - 2000);
  sqlite.prepare("INSERT INTO partner_payout_instructions VALUES ('I1','P1','awaiting_approval_2',?)").run(now);

  const beneficiary = await preauthorizeVerifiedPayoutBeneficiary(db, { providerId: "P1", scopeType: "instruction", scopeId: "I1", asOf: now });
  const columns = new Set(sqlite.prepare("PRAGMA table_info(provider_verifications)").all().map((row) => row.name));
  const verification = sqlite.prepare("SELECT verified_at,expires_at FROM provider_verifications WHERE id='V1'").get();
  const instruction = sqlite.prepare("SELECT beneficiary_snapshot_sha256,razorpayx_contact_id,razorpayx_fund_account_id FROM partner_payout_instructions WHERE id='I1'").get();

  assert.ok(columns.has("verified_at"));
  assert.ok(columns.has("expires_at"));
  assert.equal(Number(verification.verified_at), now - 1000);
  assert.ok(beneficiary.snapshotSha256);
  assert.ok(instruction.beneficiary_snapshot_sha256);
  assert.equal(instruction.razorpayx_contact_id, "cont_1");
  assert.equal(instruction.razorpayx_fund_account_id, "fa_1");
});
