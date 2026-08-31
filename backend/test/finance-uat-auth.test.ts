import assert from "node:assert/strict";
import { test } from "node:test";
import { createFinanceUatProof, deriveFinanceUatSessionSecret, financeUatConfigurationBlockers, financeUatDeploymentMatches, financeUatEnabled, verifyFinanceUatProof } from "../src/finance-uat-auth.js";

const sha = "a".repeat(40);
const baseEnv = {
  NODE_ENV: "production", VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "cert/finance-e2e-razorpay", VERCEL_GIT_COMMIT_SHA: sha,
  DATABASE_DRIVER: "mongodb", MONGODB_DATABASE: "pawspace_finance_uat", MONGODB_URI: "mongodb+srv://finance-uat.invalid/example",
  RAZORPAY_MODE: "test", RAZORPAY_KEY_ID: "rzp_test_example", RAZORPAY_KEY_SECRET: "payment-secret", RAZORPAY_WEBHOOK_SECRET: "w".repeat(32),
  RAZORPAYX_MODE: "test", RAZORPAYX_KEY_ID: "rzp_test_x_example", RAZORPAYX_KEY_SECRET: "payout-secret", RAZORPAYX_ACCOUNT_NUMBER: "23232300232323", RAZORPAYX_FUND_ACCOUNT_MAP: JSON.stringify({ pro_arjun: "fa_test_example" }),
};

test("finance UAT deployment identity is exact Preview branch and SHA", () => {
  assert.equal(financeUatDeploymentMatches(baseEnv), true);
  assert.equal(financeUatDeploymentMatches({ ...baseEnv, VERCEL_ENV: "production" }), false);
  assert.equal(financeUatDeploymentMatches({ ...baseEnv, VERCEL_GIT_COMMIT_REF: "main" }), false);
  assert.equal(financeUatDeploymentMatches({ ...baseEnv, VERCEL_GIT_COMMIT_SHA: "short" }), false);
});

test("finance UAT configuration reports names only and remains fail closed", () => {
  assert.deepEqual(financeUatConfigurationBlockers(baseEnv), []);
  const missing = financeUatConfigurationBlockers({ ...baseEnv, RAZORPAY_WEBHOOK_SECRET: "", RAZORPAY_KEY_ID: "", RAZORPAYX_FUND_ACCOUNT_MAP: "bad-json" });
  assert.deepEqual(missing.sort(), ["RAZORPAY_KEY_ID", "RAZORPAY_WEBHOOK_SECRET", "RAZORPAYX_FUND_ACCOUNT_MAP"].sort());
  assert.equal(financeUatEnabled({ ...baseEnv, RAZORPAY_WEBHOOK_SECRET: "" }), false);
  assert.equal(financeUatEnabled({ ...baseEnv, RAZORPAY_MODE: "live" }), false);
  assert.equal(financeUatEnabled({ ...baseEnv, MONGODB_DATABASE: "pawspace" }), false);
});

test("finance UAT proof is exact-SHA, short-lived and tamper evident", () => {
  const nowMs = Date.now(); const timestamp = Math.floor(nowMs / 1000); const nonce = "nonce_for_finance_uat_1234"; const signature = createFinanceUatProof(baseEnv, timestamp, nonce, sha);
  assert.equal(verifyFinanceUatProof(baseEnv, { timestamp, nonce, sha, signature }, nowMs), true);
  assert.equal(verifyFinanceUatProof(baseEnv, { timestamp, nonce, sha: "b".repeat(40), signature }, nowMs), false);
  assert.equal(verifyFinanceUatProof(baseEnv, { timestamp, nonce, sha, signature: "0".repeat(64) }, nowMs), false);
  assert.equal(verifyFinanceUatProof(baseEnv, { timestamp: timestamp - 121, nonce, sha, signature }, nowMs), false);
});

test("finance UAT session secret is deterministic but isolated from the proof secret", () => {
  const first = deriveFinanceUatSessionSecret(baseEnv); const second = deriveFinanceUatSessionSecret(baseEnv); const rotated = deriveFinanceUatSessionSecret({ ...baseEnv, MONGODB_URI: `${baseEnv.MONGODB_URI}-rotated` });
  assert.equal(first.length, 64); assert.equal(first, second); assert.notEqual(first, rotated); assert.notEqual(first, createFinanceUatProof(baseEnv, 1, "nonce_for_finance_uat_1234", sha));
});
