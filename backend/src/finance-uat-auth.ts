import { createHmac, timingSafeEqual } from "node:crypto";

export const FINANCE_UAT_BRANCH = "cert/finance-e2e-razorpay";
export const FINANCE_UAT_PROOF_DOMAIN = "pawspace-finance-uat-proof-v1";
const FINANCE_UAT_SESSION_DOMAIN = "pawspace-finance-uat-session-v1";
const MAX_PROOF_AGE_SECONDS = 120;

type Env = Record<string, string | undefined>;
export interface FinanceUatProof { timestamp: number; nonce: string; sha: string; signature: string; }

const value = (env: Env, name: string) => String(env[name] ?? "").trim();

export function financeUatDeploymentMatches(env: Env = process.env) {
  const sha = value(env, "VERCEL_GIT_COMMIT_SHA");
  return value(env, "NODE_ENV") === "production"
    && value(env, "VERCEL_ENV") === "preview"
    && value(env, "VERCEL_GIT_COMMIT_REF") === FINANCE_UAT_BRANCH
    && /^[0-9a-f]{40}$/.test(sha);
}

export function financeUatConfigurationBlockers(env: Env = process.env) {
  const blockers: string[] = [];
  if (value(env, "DATABASE_DRIVER") !== "mongodb") blockers.push("DATABASE_DRIVER");
  if (value(env, "MONGODB_DATABASE") !== "pawspace_finance_uat") blockers.push("MONGODB_DATABASE");
  if (value(env, "MONGODB_URI").length < 16) blockers.push("MONGODB_URI");
  if (value(env, "RAZORPAY_MODE") !== "test") blockers.push("RAZORPAY_MODE");
  if (!value(env, "RAZORPAY_KEY_ID").startsWith("rzp_test_")) blockers.push("RAZORPAY_KEY_ID");
  if (!value(env, "RAZORPAY_KEY_SECRET")) blockers.push("RAZORPAY_KEY_SECRET");
  if (value(env, "RAZORPAY_WEBHOOK_SECRET").length < 16) blockers.push("RAZORPAY_WEBHOOK_SECRET");
  if (value(env, "RAZORPAYX_MODE") !== "test") blockers.push("RAZORPAYX_MODE");
  if (!value(env, "RAZORPAYX_KEY_ID").startsWith("rzp_test_")) blockers.push("RAZORPAYX_KEY_ID");
  if (!value(env, "RAZORPAYX_KEY_SECRET")) blockers.push("RAZORPAYX_KEY_SECRET");
  if (!value(env, "RAZORPAYX_ACCOUNT_NUMBER")) blockers.push("RAZORPAYX_ACCOUNT_NUMBER");
  const mapRaw = value(env, "RAZORPAYX_FUND_ACCOUNT_MAP");
  try {
    const map = JSON.parse(mapRaw || "null") as Record<string, unknown> | null;
    if (!map || typeof map !== "object" || typeof map.pro_arjun !== "string" || !map.pro_arjun.startsWith("fa_")) blockers.push("RAZORPAYX_FUND_ACCOUNT_MAP");
  } catch {
    blockers.push("RAZORPAYX_FUND_ACCOUNT_MAP");
  }
  return [...new Set(blockers)];
}

export function financeUatEnabled(env: Env = process.env) {
  return financeUatDeploymentMatches(env) && financeUatConfigurationBlockers(env).length === 0;
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
  if (!financeUatEnabled(env)) throw new Error("Finance UAT session signing is disabled outside the isolated configured Test preview");
  return createHmac("sha256", value(env, "MONGODB_URI"))
    .update(`${FINANCE_UAT_SESSION_DOMAIN}\0${value(env, "RAZORPAY_WEBHOOK_SECRET")}`)
    .digest("hex");
}
