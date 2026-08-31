import { createHmac, timingSafeEqual } from "node:crypto";

export const FINANCE_UAT_BRANCH = "cert/finance-e2e-razorpay";
export const FINANCE_UAT_PROOF_DOMAIN = "pawspace-finance-uat-proof-v1";
const FINANCE_UAT_SESSION_DOMAIN = "pawspace-finance-uat-session-v1";
const MAX_PROOF_AGE_SECONDS = 120;

type Env = Record<string, string | undefined>;
export interface FinanceUatProof { timestamp: number; nonce: string; sha: string; signature: string; }

const value = (env: Env, name: string) => String(env[name] ?? "").trim();

export function financeUatEnabled(env: Env = process.env) {
  const sha = value(env, "VERCEL_GIT_COMMIT_SHA");
  return value(env, "NODE_ENV") === "production"
    && value(env, "VERCEL_ENV") === "preview"
    && value(env, "VERCEL_GIT_COMMIT_REF") === FINANCE_UAT_BRANCH
    && value(env, "DATABASE_DRIVER") === "mongodb"
    && value(env, "MONGODB_DATABASE") === "pawspace_finance_uat"
    && value(env, "RAZORPAY_MODE") === "test"
    && value(env, "RAZORPAYX_MODE") === "test"
    && value(env, "RAZORPAY_WEBHOOK_SECRET").length >= 16
    && value(env, "MONGODB_URI").length >= 16
    && /^[0-9a-f]{40}$/.test(sha);
}

function proofKey(env: Env) {
  return createHmac("sha256", value(env, "RAZORPAY_WEBHOOK_SECRET"))
    .update(FINANCE_UAT_PROOF_DOMAIN)
    .digest();
}

export function createFinanceUatProof(env: Env, timestamp: number, nonce: string, sha: string) {
  return createHmac("sha256", proofKey(env))
    .update(`${FINANCE_UAT_PROOF_DOMAIN}\n${timestamp}\n${nonce}\n${sha}`)
    .digest("hex");
}

export function verifyFinanceUatProof(env: Env, proof: FinanceUatProof, nowMs = Date.now()) {
  if (!financeUatEnabled(env)) return false;
  if (!Number.isInteger(proof.timestamp)) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - proof.timestamp) > MAX_PROOF_AGE_SECONDS) return false;
  if (proof.sha !== value(env, "VERCEL_GIT_COMMIT_SHA")) return false;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(proof.nonce)) return false;
  const signature = String(proof.signature ?? "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createFinanceUatProof(env, proof.timestamp, proof.nonce, proof.sha);
  const actualBytes = Buffer.from(signature, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function deriveFinanceUatSessionSecret(env: Env = process.env) {
  if (!financeUatEnabled(env)) throw new Error("Finance UAT session signing is disabled outside the isolated Test preview");
  return createHmac("sha256", value(env, "MONGODB_URI"))
    .update(`${FINANCE_UAT_SESSION_DOMAIN}\0${value(env, "RAZORPAY_WEBHOOK_SECRET")}`)
    .digest("hex");
}
