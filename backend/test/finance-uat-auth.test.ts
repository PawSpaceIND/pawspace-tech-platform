import assert from "node:assert/strict";
import { test } from "node:test";
import { createFinanceUatProof, deriveFinanceUatSessionSecret, financeUatEnabled, verifyFinanceUatProof } from "../src/finance-uat-auth.js";

const sha = "a".repeat(40);
const baseEnv = {
  NODE_ENV: "production",
  VERCEL_ENV: "preview",
  VERCEL_GIT_COMMIT_REF: "cert/finance-e2e-razorpay",
  VERCEL_GIT_COMMIT_SHA: sha,
  DATABASE_DRIVER: "mongodb",
  MONGODB_DATABASE: "pawspace_finance_uat",
  MONGODB_URI: "mongodb+srv://finance-uat.invalid/example",
  RAZORPAY_MODE: "test",
  RAZORPAYX_MODE: "test",
  RAZORPAY_WEBHOOK_SECRET: "w".repeat(32),
};

test("finance UAT auth is enabled only on the isolated Test preview", () => {
  assert.equal(financeUatEnabled(baseEnv), true);
  assert.equal(financeUatEnabled({ ...baseEnv, VERCEL_ENV: "production" }), false);
  assert.equal(financeUatEnabled({ ...baseEnv, VERCEL_GIT_COMMIT_REF: "main" }), false);
  assert.equal(financeUatEnabled({ ...baseEnv, MONGODB_DATABASE: "pawspace" }), false);
  assert.equal(financeUatEnabled({ ...baseEnv, RAZORPAY_MODE: "live" }), false);
  assert.equal(financeUatEnabled({ ...baseEnv, RAZORPAYX_MODE: "live" }), false);
});

test("finance UAT proof is exact-SHA, short-lived and tamper evident", () => {
  const nowMs = Date.now();
  const timestamp = Math.floor(nowMs / 1000);
  const nonce = "nonce_for_finance_uat_1234";
  const signature = createFinanceUatProof(baseEnv, timestamp, nonce, sha);
  assert.equal(verifyFinanceUatProof(baseEnv, { timestamp, nonce, sha, signature }, nowMs), true);
  assert.equal(verifyFinanceUatProof(baseEnv, { timestamp, nonce, sha: "b".repeat(40), signature }, nowMs), false);
  assert.equal(verifyFinanceUatProof(baseEnv, { timestamp, nonce, sha, signature: "0".repeat(64) }, nowMs), false);
  assert.equal(verifyFinanceUatProof(baseEnv, { timestamp: timestamp - 121, nonce, sha, signature }, nowMs), false);
});

test("finance UAT session secret is deterministic but isolated from the proof secret", () => {
  const first = deriveFinanceUatSessionSecret(baseEnv);
  const second = deriveFinanceUatSessionSecret(baseEnv);
  const rotated = deriveFinanceUatSessionSecret({ ...baseEnv, MONGODB_URI: `${baseEnv.MONGODB_URI}-rotated` });
  assert.equal(first.length, 64);
  assert.equal(first, second);
  assert.notEqual(first, rotated);
  assert.notEqual(first, createFinanceUatProof(baseEnv, 1, "nonce_for_finance_uat_1234", sha));
});
